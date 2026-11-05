/**
 * Windows DPAPI custodian (cli-standalone.md 5.3, scheme 'dpapi-user'): the data key is wrapped with
 * `ProtectedData.Protect(dek, entropy, CurrentUser)` and the blob is kept in vault.json `custody.wrapped`; nothing is
 * stored in the OS. Every call is one Windows PowerShell 5.1 by absolute path
 * (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command -`) with the
 * whole script, the key or blob inside it, on stdin as one line. The script answers with markers on stdout (`OK`,
 * `OK:<b64>`, `LANG:<mode>`, `ADDTYPE`, `ERR:crypto`, `ERR:other`), so the result never depends on how PowerShell maps
 * `exit` codes when it reads commands from stdin.
 *
 * - probe: LanguageMode must be FullLanguage (else 'denied', naming Constrained Language Mode) and
 *   `Add-Type -AssemblyName System.Security` must load (else 'denied').
 * - create: a fresh key, Protect with entropy UTF-8 `orgai.vault/1:<vaultId>` (dpapiEntropy).
 * - open: Unprotect; a CryptographicException is 'missing' (another user or machine).
 *
 * UNVERIFIED on Windows (never run from this code): the scripts themselves, the latency (estimated 0.3-3 s cold),
 * AppLocker policies, and whether a one-line script on stdin always runs (it ends with CRLF).
 */
import { randomBytes } from 'node:crypto'
import { windowsPowerShellPath } from '../../host/systemBinaries'
import { CustodyError, VAULT_DEK_BYTES, dpapiEntropy, type CustodianCreated, type CustodianProbe, type CustodyFailureKind, type VaultCustody } from '../vaultTypes'
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

function cryptoScript(op: 'Protect' | 'Unprotect', dataB64: string, vaultId: string): string {
  return (
    PRELUDE +
    `try { $d=[Convert]::FromBase64String(${psLiteral(dataB64)}); $e=[Text.Encoding]::UTF8.GetBytes(${psLiteral(dpapiEntropy(vaultId))}); ` +
    `$r=[Security.Cryptography.ProtectedData]::${op}($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Array]::Clear($d,0,$d.Length); Write-Output ('OK:' + [Convert]::ToBase64String($r)); [Array]::Clear($r,0,$r.Length) } ` +
    `catch [Security.Cryptography.CryptographicException] { Write-Output 'ERR:crypto' } catch { Write-Output 'ERR:other' }\r\n`
  )
}

/** The create script (contains the key: never log it). */
export function dpapiProtectScript(dekB64: string, vaultId: string): string {
  return cryptoScript('Protect', dekB64, vaultId)
}

/** The open script. */
export function dpapiUnprotectScript(wrapped: string, vaultId: string): string {
  return cryptoScript('Unprotect', wrapped, vaultId)
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
    const dek = randomBytes(VAULT_DEK_BYTES)
    const r = await this.run(dpapiProtectScript(dek.toString('base64'), vaultId))
    const p = parseDpapiResult(r, 'protect')
    if (!p.ok) {
      dek.fill(0)
      throw new CustodyError(p.kind, p.reason)
    }
    const wrapped = p.value ?? ''
    if (!isStrictBase64(wrapped)) {
      dek.fill(0)
      throw new CustodyError('denied', 'Windows data protection returned an unexpected blob; the vault was not created.')
    }
    return { dek, wrapped }
  }

  async open(vaultId: string, custody: VaultCustody): Promise<Buffer> {
    if (this.platform !== 'win32') throw wrongPlatform('Windows data protection', this.platform, 'open')
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    const wrapped = custody.wrapped
    // vault.json is a file on disk: the blob is checked before it goes into a script.
    if (typeof wrapped !== 'string' || !isStrictBase64(wrapped)) throw new CustodyError('missing', "The vault does not record a protected key for Windows data protection.")
    const r = await this.run(dpapiUnprotectScript(wrapped, vaultId))
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
