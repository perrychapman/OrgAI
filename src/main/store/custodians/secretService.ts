/**
 * Linux Secret Service custodian (cli-standalone.md 5.3, scheme 'secret-service'): the data key (base64) is a secret
 * with attributes `service orgai vault <vaultId>` and label "OrgAI vault", read and written by `secret-tool`
 * (libsecret) found on the absolute PATH entries.
 *
 * - probe: secret-tool on PATH (else 'unavailable'), a session bus (DBUS_SESSION_BUS_ADDRESS, or the systemd default
 *   `$XDG_RUNTIME_DIR/bus`; else 'unavailable'), and `secret-tool search service orgai-vault-probe` answering within
 *   10 s (a timeout = 'locked').
 * - create: `lookup` first (an existing item refuses), then `store --label="OrgAI vault" service orgai vault <id>` with
 *   the key on stdin, then `lookup` again and compare.
 * - open: `lookup service orgai vault <id>` (empty = 'missing').
 *
 * UNVERIFIED (never run from this code): whether `search` on a locked collection prompts or fails, a desktop unlock
 * prompt during create, the exit codes and stderr wording classified below, and whether `lookup` adds a newline when
 * stdout is a pipe (trimmed either way).
 */
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { findOnPath } from '../../host/systemBinaries'
import { CustodyError, SECRET_SERVICE_ATTRIBUTE, SECRET_SERVICE_LABEL, VAULT_DEK_BYTES, type CustodianCreated, type CustodianProbe, type CustodyFailureKind, type VaultCustody } from '../vaultTypes'
import { randomBytes } from 'node:crypto'
import { BAD_ITEM_REASON, BAD_VAULT_ID_REASON, EXISTS_REASON, KEY_FILE_HINT, sameKey, wrongPlatform, type HelperCustodianOptions, type RemovableKeyCustodian } from './common'
import { custodianEnvFor } from './env'
import { decodeKeyBase64, defaultSpawner, isVaultId, runHelper, stdoutText, type HelperResult } from './run'

/** The probe's search attribute value (never matches a real vault item). */
export const SECRET_SERVICE_PROBE_VALUE = 'orgai-vault-probe'

export const SECRET_SERVICE_LOCKED_REASON =
  'The desktop keyring is locked or did not answer (it may be waiting for an unlock prompt). Unlock it and try again, or use ORGAI_VAULT_KEY_FILE.'
export const SECRET_SERVICE_MISSING_REASON = 'The desktop keyring has no OrgAI vault item for this vault (it was removed, or the vault was made on another machine or account).'
export const SECRET_TOOL_MISSING_REASON = `secret-tool (libsecret-tools) is not installed, so the desktop keyring cannot hold the vault's key; install it, ${KEY_FILE_HINT}.`
export const NO_SESSION_BUS_REASON = `There is no desktop session bus here (for example over SSH), so the keyring cannot be reached; ${KEY_FILE_HINT}.`

export interface SecretServiceCustodianOptions extends HelperCustodianOptions {
  /** existsSync stand-in for the `$XDG_RUNTIME_DIR/bus` check (tests). */
  exists?: (p: string) => boolean
  /** findOnPath stand-in's file check (tests). */
  isFile?: (p: string) => boolean
}

/** Reduces a `secret-tool` result to a failure (null = success). stderr is read here and dropped. */
export function classifySecretTool(r: HelperResult, phase: 'probe' | 'lookup' | 'store' | 'clear'): { kind: CustodyFailureKind; reason: string } | null {
  if (r.spawnError) return { kind: 'unavailable', reason: SECRET_TOOL_MISSING_REASON }
  if (r.timedOut) return { kind: 'locked', reason: SECRET_SERVICE_LOCKED_REASON }
  if (r.overflow) return { kind: 'denied', reason: 'secret-tool answered with unexpected output.' }
  const err = r.stderr
  if (/not provided by any|autolaunch|could not connect|cannot connect|connection refused|no such (interface|object)|was not provided|ServiceUnknown/i.test(err)) {
    return { kind: 'unavailable', reason: `No desktop keyring (Secret Service) answered on this session bus; ${KEY_FILE_HINT}.` }
  }
  if (/locked|dismissed|cancel|prompt/i.test(err)) return { kind: 'locked', reason: SECRET_SERVICE_LOCKED_REASON }
  if (r.code === 0) return null
  // search and lookup exit 1 with nothing on stderr when no item matches: that is an answer, not a failure.
  if ((phase === 'probe' || phase === 'lookup' || phase === 'clear') && r.code === 1 && err.trim() === '') return null
  return { kind: 'unavailable', reason: `secret-tool failed (exit ${r.code ?? 'signal'}); ${KEY_FILE_HINT}.` }
}

export class SecretServiceCustodian implements RemovableKeyCustodian {
  readonly scheme = 'secret-service' as const
  private readonly hostEnv: Readonly<Record<string, string | undefined>>
  private readonly env: Record<string, string>
  private readonly platform: NodeJS.Platform
  private readonly opts: SecretServiceCustodianOptions

  constructor(opts: SecretServiceCustodianOptions = {}) {
    this.opts = opts
    this.platform = opts.platform ?? process.platform
    this.hostEnv = opts.env ?? process.env
    this.env = custodianEnvFor('secret-service', this.hostEnv, this.platform)
  }

  /** secret-tool on the absolute PATH entries (never the cwd), or undefined. */
  executable(): string | undefined {
    return findOnPath('secret-tool', { platform: this.platform, env: this.hostEnv, ...(this.opts.isFile ? { isFile: this.opts.isFile } : {}) })
  }

  /** A session bus address, or the systemd default socket. */
  hasSessionBus(): boolean {
    if ((this.hostEnv.DBUS_SESSION_BUS_ADDRESS ?? '').trim()) return true
    const runtime = (this.hostEnv.XDG_RUNTIME_DIR ?? '').trim()
    if (!runtime || !posix.isAbsolute(runtime)) return false
    try {
      return (this.opts.exists ?? existsSync)(posix.join(runtime, 'bus'))
    } catch {
      return false
    }
  }

  /** The first failure that stops every step before a child is spawned. */
  private precheck(phase: 'probe' | 'create' | 'open'): { file: string } | CustodyError {
    if (this.platform === 'win32' || this.platform === 'darwin') return wrongPlatform('the desktop keyring (Secret Service)', this.platform, phase)
    const file = this.executable()
    if (!file) return new CustodyError('unavailable', SECRET_TOOL_MISSING_REASON)
    if (!this.hasSessionBus()) return new CustodyError('unavailable', NO_SESSION_BUS_REASON)
    return { file }
  }

  private run(file: string, args: readonly string[], stdin?: string): Promise<HelperResult> {
    return runHelper(file, args, {
      spawner: this.opts.spawner ?? defaultSpawner,
      env: this.env,
      label: 'custodian:secret-service',
      platform: this.platform,
      ...(stdin !== undefined ? { stdin } : {}),
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {})
    })
  }

  private attrs(vaultId: string): string[] {
    return ['service', SECRET_SERVICE_ATTRIBUTE, 'vault', vaultId]
  }

  async probe(): Promise<CustodianProbe> {
    const pre = this.precheck('probe')
    if (pre instanceof CustodyError) return { ok: false, kind: pre.kind, reason: pre.reason }
    const c = classifySecretTool(await this.run(pre.file, ['search', 'service', SECRET_SERVICE_PROBE_VALUE]), 'probe')
    return c ? { ok: false, ...c } : { ok: true }
  }

  /** The stored key, undefined when there is none. Throws CustodyError on a failure. */
  private async lookup(file: string, vaultId: string): Promise<Buffer | undefined> {
    const r = await this.run(file, ['lookup', ...this.attrs(vaultId)])
    const c = classifySecretTool(r, 'lookup')
    if (c) {
      r.stdout.fill(0)
      throw new CustodyError(c.kind, c.reason)
    }
    const text = stdoutText(r).trim()
    r.stdout.fill(0)
    if (!text) return undefined
    const key = decodeKeyBase64(text)
    if (!key || key.length !== VAULT_DEK_BYTES) throw new CustodyError('denied', BAD_ITEM_REASON)
    return key
  }

  async create(vaultId: string): Promise<CustodianCreated> {
    const pre = this.precheck('create')
    if (pre instanceof CustodyError) throw pre
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    let existing: Buffer | undefined
    try {
      existing = await this.lookup(pre.file, vaultId)
    } catch (e) {
      // An item that holds something other than a key still exists: never overwrite it.
      if (e instanceof CustodyError && e.reason === BAD_ITEM_REASON) throw new CustodyError('denied', EXISTS_REASON)
      throw e
    }
    if (existing) {
      existing.fill(0)
      throw new CustodyError('denied', EXISTS_REASON)
    }
    const dek = randomBytes(VAULT_DEK_BYTES)
    const stored = classifySecretTool(await this.run(pre.file, ['store', `--label=${SECRET_SERVICE_LABEL}`, ...this.attrs(vaultId)], dek.toString('base64')), 'store')
    if (stored) {
      dek.fill(0)
      throw new CustodyError(stored.kind, stored.reason)
    }
    let back: Buffer | undefined
    try {
      back = await this.lookup(pre.file, vaultId)
    } catch (e) {
      dek.fill(0)
      throw e
    }
    const same = back !== undefined && sameKey(dek, back)
    back?.fill(0)
    if (!same) {
      dek.fill(0)
      throw new CustodyError('unavailable', `The key could not be stored in the desktop keyring; ${KEY_FILE_HINT}.`)
    }
    return { dek }
  }

  async open(vaultId: string, custody: VaultCustody): Promise<Buffer> {
    void custody
    const pre = this.precheck('open')
    if (pre instanceof CustodyError) throw pre
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    const key = await this.lookup(pre.file, vaultId)
    if (!key) throw new CustodyError('missing', SECRET_SERVICE_MISSING_REASON)
    return key
  }

  async removeItem(vaultId: string, custody: VaultCustody): Promise<void> {
    void custody
    const pre = this.precheck('open')
    if (pre instanceof CustodyError) throw pre
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    const c = classifySecretTool(await this.run(pre.file, ['clear', ...this.attrs(vaultId)]), 'clear')
    if (c) throw new CustodyError(c.kind, c.reason)
  }
}
