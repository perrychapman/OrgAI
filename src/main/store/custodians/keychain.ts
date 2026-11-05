/**
 * macOS keychain custodian (cli-standalone.md 5.3): the vault's data key is a generic password item, service
 * "OrgAI Vault", account <vaultId>, in the user's default keychain, written and read through `/usr/bin/security`.
 *
 * - probe: `security default-keychain` names the default keychain (its quoted path on stdout), then
 *   `security show-keychain-info <path>` (exit 0 = usable; 36 / "User interaction is not allowed" / a timeout = locked).
 *   Without a path show-keychain-info asks about a NULL keychain reference (`Keychain "<NULL>" no-timeout`, exit 0,
 *   seen on macOS 26), which says nothing about the default keychain's lock state (review round 1).
 * - create: refuses when an item for vaultId exists (find-generic-password without -w), then `security -i -q` with the
 *   add-generic-password command on stdin (never argv, no -U), then reads the item back and compares it, because the
 *   exit status of an interactive session is not a reliable signal of one command's failure.
 * - open: `find-generic-password -s "OrgAI Vault" -a <vaultId> -w`: 44 = missing; 36, 51, a user cancel (128) and a
 *   timeout = locked, never missing.
 *
 * UNVERIFIED (never run from this code; the probe script checks it with the user's consent): `-i -q` reading a pipe
 * with no TTY and no echo, the exit codes above (the low byte of errSecItemNotFound -25300, errSecInteractionNotAllowed
 * -25308, errSecAuthFailed -25293, userCanceledErr -128), the absence of a prompt for an item `security` created, and the
 * locked wording over SSH.
 *
 * Threat model (5.8): an item created through /usr/bin/security is readable without a prompt by anything that runs
 * /usr/bin/security as this user.
 */
import { randomBytes } from 'node:crypto'
import { CustodyError, KEYCHAIN_SERVICE, VAULT_DEK_BYTES, type CustodianCreated, type CustodianProbe, type CustodyFailureKind, type VaultCustody } from '../vaultTypes'
import { BAD_ITEM_REASON, BAD_VAULT_ID_REASON, EXISTS_REASON, KEY_FILE_HINT, sameKey, wrongPlatform, type HelperCustodianOptions, type RemovableKeyCustodian } from './common'
import { custodianEnvFor } from './env'
import { decodeKeyBase64, defaultSpawner, isVaultId, runHelper, stdoutText, type HelperResult } from './run'

export const SECURITY_PATH = '/usr/bin/security'

export const KEYCHAIN_LOCKED_REASON =
  'The macOS keychain is locked or cannot ask in this session. Run `security unlock-keychain`, or use ORGAI_VAULT_KEY_FILE.'
export const KEYCHAIN_MISSING_REASON = 'The macOS keychain has no OrgAI Vault item for this vault (it was removed, or the vault was made on another Mac or account).'

type Classified = { kind: CustodyFailureKind | 'exists'; reason: string }

/** Reduces a `security` result to a failure (null = success). stderr is read here and dropped. */
export function classifyKeychain(r: HelperResult): Classified | null {
  if (r.spawnError) return { kind: 'unavailable', reason: `${SECURITY_PATH} could not be run, so the macOS keychain cannot hold the vault's key; ${KEY_FILE_HINT}.` }
  if (r.timedOut) return { kind: 'locked', reason: `${KEYCHAIN_LOCKED_REASON} (The keychain did not answer within 10 seconds.)` }
  if (r.overflow) return { kind: 'denied', reason: 'The macOS keychain tool answered with unexpected output.' }
  const err = r.stderr
  if (r.code === 0 && !/already exists|could not be found|not allowed|cancel/i.test(err)) return null
  if (r.code === 50 || /default keychain|no such keychain/i.test(err)) {
    return { kind: 'unavailable', reason: `There is no default macOS keychain for this user; ${KEY_FILE_HINT}.` }
  }
  if (r.code === 45 || /already exists/i.test(err)) return { kind: 'exists', reason: EXISTS_REASON }
  if (r.code === 44 || /could not be found/i.test(err)) return { kind: 'missing', reason: KEYCHAIN_MISSING_REASON }
  if (r.code === 36 || r.code === 51 || r.code === 128 || /interaction is not allowed|user interaction|cancel|passphrase|locked/i.test(err)) {
    return { kind: 'locked', reason: KEYCHAIN_LOCKED_REASON }
  }
  return { kind: 'unavailable', reason: `The macOS keychain tool failed (exit ${r.code ?? 'signal'}); ${KEY_FILE_HINT}.` }
}

/**
 * The default keychain's path from `security default-keychain` stdout (`    "/Users/me/Library/Keychains/login.keychain-db"`),
 * else undefined: exactly one quoted absolute path, no control characters.
 */
export function parseDefaultKeychain(stdout: string): string | undefined {
  const paths = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (paths.length !== 1) return undefined
  const m = /^"(\/[^"]*)"$/.exec(paths[0]!)
  // eslint-disable-next-line no-control-regex
  if (!m || /[\u0000-\u001f\u007f]/.test(m[1]!)) return undefined
  return m[1]!
}

/** One `security -i` argument, double-quoted. Only a safe alphabet is accepted, so nothing needs escaping. */
export function securityInteractiveArg(v: string): string {
  if (!/^[A-Za-z0-9 +/=._-]+$/.test(v)) throw new CustodyError('denied', 'A keychain argument held a character OrgAI does not pass to `security`.')
  return `"${v}"`
}

/** The stdin line of the create step (contains the key: never log it). */
export function addGenericPasswordLine(vaultId: string, keyB64: string): string {
  return `add-generic-password -s ${securityInteractiveArg(KEYCHAIN_SERVICE)} -a ${securityInteractiveArg(vaultId)} -w ${securityInteractiveArg(keyB64)}\n`
}

export class KeychainCustodian implements RemovableKeyCustodian {
  readonly scheme = 'keychain' as const
  private readonly env: Record<string, string>
  private readonly platform: NodeJS.Platform
  private readonly opts: HelperCustodianOptions

  constructor(opts: HelperCustodianOptions = {}) {
    this.opts = opts
    this.platform = opts.platform ?? process.platform
    this.env = custodianEnvFor('keychain', opts.env ?? process.env, this.platform)
  }

  private run(args: readonly string[], stdin?: string): Promise<HelperResult> {
    return runHelper(SECURITY_PATH, args, {
      spawner: this.opts.spawner ?? defaultSpawner,
      env: this.env,
      label: 'custodian:keychain',
      platform: this.platform,
      ...(stdin !== undefined ? { stdin } : {}),
      ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {})
    })
  }

  async probe(): Promise<CustodianProbe> {
    if (this.platform !== 'darwin') {
      const e = wrongPlatform('the macOS keychain', this.platform, 'probe')
      return { ok: false, kind: e.kind, reason: e.reason }
    }
    const d = await this.run(['default-keychain'])
    const dc = classifyKeychain(d)
    const path = dc ? undefined : parseDefaultKeychain(stdoutText(d))
    if (dc && dc.kind !== 'exists' && dc.kind !== 'missing') return { ok: false, kind: dc.kind, reason: dc.reason }
    if (path === undefined) return { ok: false, kind: 'unavailable', reason: `There is no default macOS keychain for this user; ${KEY_FILE_HINT}.` }
    const c = classifyKeychain(await this.run(['show-keychain-info', path]))
    if (!c) return { ok: true }
    // No item is read here, so 'missing' or 'exists' can only mean the keychain itself is not usable.
    return { ok: false, kind: c.kind === 'exists' || c.kind === 'missing' ? 'unavailable' : c.kind, reason: c.reason }
  }

  async create(vaultId: string): Promise<CustodianCreated> {
    if (this.platform !== 'darwin') throw wrongPlatform('the macOS keychain', this.platform, 'create')
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    // Refuse when an item exists (no -w: the attributes only, never the value).
    const found = classifyKeychain(await this.run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', vaultId]))
    if (!found) throw new CustodyError('denied', EXISTS_REASON)
    if (found.kind !== 'missing') throw new CustodyError(found.kind === 'exists' ? 'denied' : found.kind, found.reason)

    const dek = randomBytes(VAULT_DEK_BYTES)
    const added = classifyKeychain(await this.run(['-i', '-q'], addGenericPasswordLine(vaultId, dek.toString('base64'))))
    if (added) {
      dek.fill(0)
      throw new CustodyError(added.kind === 'exists' ? 'denied' : added.kind === 'missing' ? 'unavailable' : added.kind, added.reason)
    }
    let back: Buffer
    try {
      back = await this.read(vaultId)
    } catch (e) {
      dek.fill(0)
      if (e instanceof CustodyError && e.kind === 'missing') throw new CustodyError('unavailable', `The key could not be stored in the macOS keychain; ${KEY_FILE_HINT}.`)
      throw e
    }
    const same = sameKey(dek, back)
    back.fill(0)
    if (!same) {
      dek.fill(0)
      throw new CustodyError('denied', 'The macOS keychain returned a different key than the one stored; the vault was not created.')
    }
    return { dek }
  }

  async open(vaultId: string, custody: VaultCustody): Promise<Buffer> {
    void custody
    if (this.platform !== 'darwin') throw wrongPlatform('the macOS keychain', this.platform, 'open')
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    return this.read(vaultId)
  }

  private async read(vaultId: string): Promise<Buffer> {
    const r = await this.run(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', vaultId, '-w'])
    const c = classifyKeychain(r)
    if (c) {
      r.stdout.fill(0)
      // An 'exists' wording cannot come from a read; treat anything odd as denied.
      throw new CustodyError(c.kind === 'exists' ? 'denied' : c.kind, c.reason)
    }
    const text = stdoutText(r).trim()
    r.stdout.fill(0)
    const key = decodeKeyBase64(text)
    if (!key || key.length !== VAULT_DEK_BYTES) throw new CustodyError('denied', BAD_ITEM_REASON)
    return key
  }

  async removeItem(vaultId: string, custody: VaultCustody): Promise<void> {
    void custody
    if (this.platform !== 'darwin') throw wrongPlatform('the macOS keychain', this.platform, 'open')
    if (!isVaultId(vaultId)) throw new CustodyError('denied', BAD_VAULT_ID_REASON)
    const c = classifyKeychain(await this.run(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', vaultId]))
    if (c && c.kind !== 'missing') throw new CustodyError(c.kind === 'exists' ? 'denied' : c.kind, c.reason)
  }
}
