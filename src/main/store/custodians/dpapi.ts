/**
 * Windows DPAPI custodian (cli-standalone.md 5.3, scheme 'dpapi-user'): the data key is wrapped with
 * `ProtectedData.Protect(dek, entropy, CurrentUser)` and the blob is kept in vault.json `custody.wrapped`; nothing is
 * stored in the OS. Every call is one Windows PowerShell 5.1 by absolute path
 * (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command -`) with the
 * whole script on stdin as one line. The script answers with markers on stdout (`OK`, `OK:<b64>`, `OK:<b64>:<b64>`,
 * `LANG:<mode>`, `ADDTYPE`, `ERR:crypto`, `ERR:other`), so the result never depends on how PowerShell maps `exit` codes
 * when it reads commands from stdin.
 *
 * The data key NEVER appears in script text (review round 1 blocker): PowerShell 5.1 logs any script block holding
 * words such as `Add-Type` or `FromBase64String` as event 4104 in Microsoft-Windows-PowerShell/Operational even with
 * Script Block Logging off, and the same text goes to AMSI. So create lets PowerShell draw the key itself
 * (`RandomNumberGenerator`), protects it and hands back the blob and the key; open puts only the protected blob (also
 * in vault.json, useless without the user's DPAPI credentials) in the script. A key leaves PowerShell only through
 * `[Console]::Out.Write`, never Write-Output, so neither the formatting system nor a transcription GPO
 * (Start-Transcript) copies it.
 *
 * - probe: LanguageMode must be FullLanguage (else 'denied', naming Constrained Language Mode) and
 *   `Add-Type -AssemblyName System.Security` must load (else 'denied').
 * - create: a fresh key from .NET's CSPRNG, Protect with entropy UTF-8 `orgai.vault/1:<vaultId>` (dpapiEntropy).
 * - open: Unprotect; a CryptographicException is 'missing' (another user or machine).
 *
 * UNVERIFIED on Windows (never run from this code): the scripts themselves, the latency (estimated 0.3-3 s cold),
 * AppLocker policies, whether a one-line script on stdin always runs (it ends with CRLF), and that `[Console]::Out`
 * bypasses transcription in every host configuration.
 */
import { windowsPowerShellPath } from '../../host/systemBinaries'
import { CustodyError, VAULT_DEK_BYTES, dpapiEntropy, type VaultProduct, type CustodianCreated, type CustodianProbe, type CustodyFailureKind, type VaultCustody } from '../vaultTypes'
import { BAD_VAULT_ID_REASON, KEY_FILE_HINT, wrongPlatform, type HelperCustodianOptions, type RemovableKeyCustodian } from './common'
import { custodianEnvFor } from './env'
import { decodeKeyBase64, defaultSpawner, isStrictBase64, isVaultId, runHelper, stdoutText, type HelperResult } from './run'

export const DPAPI_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'] as const

export const DPAPI_CLM_REASON =
  `PowerShell runs in Constrained Language Mode here (a system policy), so OrgAI cannot use Windows data protection for the vault's key; ${KEY_FILE_HINT}.`
export const DPAPI_ADDTYPE_REASON = `PowerShell could not load System.Security (Windows data protection) here; ${KEY_FILE_HINT}.`
export const DPAPI_MISSING_REASON = "This vault's key was protected by another Windows user or on another machine, so it cannot be unwrapped here."

/** The guard every script starts with: FullLanguage and System.Security, else a marker and stop. */
const PRELUDE =
  "$ErrorActionPreference='Stop'; $m=$ExecutionContext.SessionState.LanguageMode; if ($m -ne 'FullLanguage') { Write-Output ('LANG:' + $m); exit 3 }; " +
  "try { Add-Type -AssemblyName System.Security } catch { Write-Output 'ADDTYPE'; exit 4 }; "

/** Single-quoted PowerShell literal of a value from a safe alphabet (base64, the entropy string). */
function psLiteral(v: string): string {
  if (!/^[A-Za-z0-9+/=.:_-]*$/.test(v)) throw new CustodyError('denied', 'A value held a character OrgAI does not pass to PowerShell.')
  return `'${v}'`
}

export function dpapiProbeScript(): string {
  return `${PRELUDE}Write-Output 'OK'\r\n`
}

/** Writes one marker line straight to stdout (not Write-Output: a transcript never sees it). */
const OUT = (expr: string): string => `[Console]::Out.Write(${expr} + [char]13 + [char]10); [Console]::Out.Flush()`

const ENTROPY = (vaultId: string, product?: VaultProduct): string => `$e=[Text.Encoding]::UTF8.GetBytes(${psLiteral(dpapiEntropy(vaultId, product))}); `
const SCOPE = '[Security.Cryptography.DataProtectionScope]::CurrentUser'
const CATCH = `catch [Security.Cryptography.CryptographicException] { ${OUT("'ERR:crypto'")} } catch { ${OUT("'ERR:other'")} }\r\n`

/**
 * The create script: PowerShell draws the key, protects it and writes `OK:<blob b64>:<key b64>`. It holds no key; the
 * only value in it is the vault id (inside the entropy).
 */
export function dpapiProtectScript(vaultId: string, product?: VaultProduct): string {
  return (
    PRELUDE +
    `try { ${ENTROPY(vaultId, product)}$k=New-Object byte[] ${VAULT_DEK_BYTES}; $g=[Security.Cryptography.RandomNumberGenerator]::Create(); $g.GetBytes($k); $g.Dispose(); ` +
    `$r=[Security.Cryptography.ProtectedData]::Protect($k,$e,${SCOPE}); ` +
    `${OUT("'OK:' + [Convert]::ToBase64String($r) + ':' + [Convert]::ToBase64String($k)")}; [Array]::Clear($k,0,$k.Length) } ` +
    CATCH
  )
}

/** The open script: only the protected blob (checked strict base64 first) and the entropy are in it. */
export function dpapiUnprotectScript(wrapped: string, vaultId: string, product?: VaultProduct): string {
  return (
    PRELUDE +
    `try { $d=[Convert]::FromBase64String(${psLiteral(wrapped)}); ${ENTROPY(vaultId, product)}` +
    `$r=[Security.Cryptography.ProtectedData]::Unprotect($d,$e,${SCOPE}); ` +
    `${OUT("'OK:' + [Convert]::ToBase64String($r)")}; [Array]::Clear($r,0,$r.Length) } ` +
    CATCH
  )
}

type Parsed = { ok: true; value?: string } | { ok: false; kind: CustodyFailureKind; reason: string }

/** Reads the markers of one PowerShell answer. stderr is never shown. */
export function parseDpapiResult(r: HelperResult, phase: 'probe' | 'protect' | 'unprotect'): Parsed {
  if (r.spawnError) return { ok: false, kind: 'unavailable', reason: `Windows PowerShell could not be run, so Windows data protection cannot hold the vault's key; ${KEY_FILE_HINT}.` }
  if (r.timedOut) return { ok: false, kind: 'timeout', reason: 'Windows data protection did not answer within 10 seconds; try again.' }
  if (r.overflow) return { ok: false, kind: 'denied', reason: 'Windows PowerShell answered with unexpected output.' }
  const lines = stdoutText(r)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.some((l) => l.startsWith('LANG:'))) return { ok: false, kind: 'denied', reason: DPAPI_CLM_REASON }
  if (lines.includes('ADDTYPE')) return { ok: false, kind: 'denied', reason: DPAPI_ADDTYPE_REASON }
  if (lines.includes('ERR:crypto')) {
    return phase === 'unprotect'
      ? { ok: false, kind: 'missing', reason: DPAPI_MISSING_REASON }
      : { ok: false, kind: 'unavailable', reason: `Windows data protection refused to protect the key; ${KEY_FILE_HINT}.` }
  }
  if (lines.includes('ERR:other')) return { ok: false, kind: 'unavailable', reason: `Windows data protection failed; ${KEY_FILE_HINT}.` }
  if (phase === 'probe') {
    if (lines.includes('OK')) return { ok: true }
  } else {
    const hit = lines.find((l) => l.startsWith('OK:'))
    if (hit !== undefined) return { ok: true, value: hit.slice(3) }
  }
  // Policy blocks (AppLocker, a script block) end without a marker; the exit code alone does not say which.
  return { ok: false, kind: 'denied', reason: `Windows PowerShell did not run OrgAI's data-protection step (a policy may block it); ${KEY_FILE_HINT}.` }
}

export class DpapiCustodian implements RemovableKeyCustodian {
  readonly scheme = 'dpapi-user' as const
  private readonly hostEnv: Readonly<Record<string, string | undefined>>
  private readonly env: Record<string, string>
  private readonly platform: NodeJS.Platform
  private readonly opts: HelperCustodianOptions

  constructor(opts: HelperCustodianOptions = {}) {
    this.opts = opts
    this.platform = opts.platform ?? process.platform
    this.hostEnv = opts.env ?? process.env
    this.env = custodianEnvFor('dpapi-user', this.hostEnv, this.platform)
  }

  /** The absolute powershell.exe under %SystemRoot% (never a bare name). */
  executable(): string {
    return windowsPowerShellPath(this.hostEnv)
  }

  private run(script: string): Promise<HelperResult> {
    return runHelper(this.executable(), DPAPI_ARGS, {
      spawner: this.opts.spawner ?? defaultSpawner,
      env: this.env,
      stdin: script,
      label: 'custodian:dpapi',
      platform: this.platform,
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {})
    })
  }

  async probe(): Promise<CustodianProbe> {
    if (this.platform !== 'win32') {
      const e = wrongPlatform('Windows data protection', this.platform, 'probe')
      return { ok: false, kind: e.kind, reason: e.reason }
    }
    const p = parseDpapiResult(await this.run(dpapiProbeScript()), 'probe')
    return p.ok ? { ok: true } : { ok: false, kind: p.kind, reason: p.reason }
  }

  async create(vaultId: string): Promise<CustodianCreated> {
    if (this.platform !== 'win32') throw wrongPlatform('Windows data protection', this.platform, 'create')
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    // Nothing is stored in the OS, so no item can already exist: the blob lives only in the new vault.json.
    const r = await this.run(dpapiProtectScript(vaultId, this.opts.product))
    const p = parseDpapiResult(r, 'protect')
    r.stdout.fill(0)
    if (!p.ok) throw new CustodyError(p.kind, p.reason)
    const [wrapped = '', keyB64 = '', ...rest] = (p.value ?? '').split(':')
    const dek = rest.length === 0 ? decodeKeyBase64(keyB64) : undefined
    if (!dek || !isStrictBase64(wrapped)) {
      dek?.fill(0)
      throw new CustodyError('denied', 'Windows data protection returned an unexpected answer; the vault was not created.')
    }
    return { dek, wrapped }
  }

  async open(vaultId: string, custody: VaultCustody): Promise<Buffer> {
    if (this.platform !== 'win32') throw wrongPlatform('Windows data protection', this.platform, 'open')
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    const wrapped = custody.wrapped
    // vault.json is a file on disk: the blob is checked before it goes into a script.
    if (typeof wrapped !== 'string' || !isStrictBase64(wrapped)) throw new CustodyError('missing', "The vault does not record a protected key for Windows data protection.")
    const r = await this.run(dpapiUnprotectScript(wrapped, vaultId, this.opts.product))
    const p = parseDpapiResult(r, 'unprotect')
    r.stdout.fill(0)
    if (!p.ok) throw new CustodyError(p.kind, p.reason)
    const key = decodeKeyBase64(p.value ?? '')
    if (!key) throw new CustodyError('denied', 'The unwrapped key has the wrong size.')
    return key
  }

  /** Nothing is stored in the OS: the blob goes with vault.json. */
  async removeItem(vaultId: string, custody: VaultCustody): Promise<void> {
    void vaultId
    void custody
  }
}
