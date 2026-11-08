/**
 * The key custodians (cli-standalone.md 5.3) and the factory openSecretStore uses by default. A vault opens only with
 * its recorded scheme; a new vault uses 'key-file' when ORGAI_VAULT_KEY_FILE is set or `secrets init --key-file` asked
 * for it, else the platform's OS scheme (macOS keychain, Windows dpapi-user, Linux secret-service; none elsewhere).
 * Electron-free; relative imports only.
 */
import { CustodyError, vaultNames, type CustodianCreated, type CustodianFactory, type CustodianProbe, type CustodianRequest, type KeyCustodian, type VaultCustody, type VaultCustodyScheme, type VaultProduct } from '../vaultTypes'
import type { RemovableKeyCustodian } from './common'
import { DpapiCustodian } from './dpapi'
import { KeychainCustodian } from './keychain'
import { KeyFileCustodian } from './keyFile'
import type { CustodianSpawner } from './run'
import { SecretServiceCustodian } from './secretService'

export { custodianEnvFor, CUSTODIAN_ENV_ALLOWLIST } from './env'
export { KeychainCustodian } from './keychain'
export { DpapiCustodian } from './dpapi'
export { SecretServiceCustodian } from './secretService'
export { KeyFileCustodian, keyFilePathProblem, parseKeyFileContent } from './keyFile'
export type { RemovableKeyCustodian, HelperCustodianOptions } from './common'
export type { CustodianSpawner, CustodianChild, CustodianSpawnOptions } from './run'

type Env = Readonly<Record<string, string | undefined>>

/** The OS scheme of a platform, or null when it has none (only a key file works there). */
export function platformCustodyScheme(platform: NodeJS.Platform = process.platform): Exclude<VaultCustodyScheme, 'key-file'> | null {
  if (platform === 'darwin') return 'keychain'
  if (platform === 'win32') return 'dpapi-user'
  if (platform === 'linux') return 'secret-service'
  return null
}

export interface ChooseCustodySchemeInput {
  /** The vault on disk's custody (or scheme): it always wins. */
  recorded?: VaultCustody | VaultCustodyScheme | null
  /** `secrets init --key-file` was given. */
  keyFileRequested?: boolean
  env?: Env
  platform?: NodeJS.Platform
  /** Whose key-file variable decides (default 'desktop'). */
  product?: VaultProduct
}

/** The scheme to use (5.3 "Choice of scheme"); null when none is usable for a new vault on this platform. */
export function chooseCustodyScheme(input: ChooseCustodySchemeInput = {}): VaultCustodyScheme | null {
  const recorded = typeof input.recorded === 'string' ? input.recorded : input.recorded?.scheme
  if (recorded) return recorded
  const env = input.env ?? process.env
  if (input.keyFileRequested || (env[vaultNames(input.product).keyFileEnv] ?? '').trim() !== '') return 'key-file'
  return platformCustodyScheme(input.platform ?? process.platform)
}

export interface CustodianFactoryOptions {
  /** `<userData>/data` and `<userData>`: a key file inside either is refused (5.3.1). */
  dataDir: string
  userDataDir: string
  /** The host's environment (each custodian keeps only its allowlist; ORGAI_VAULT_KEY_FILE is read here). */
  env?: Env
  platform?: NodeJS.Platform
  /** child_process.spawn stand-in (tests). */
  spawner?: CustodianSpawner
  timeoutMs?: number
  /** Whose names and variables the custodians use (default 'desktop'). */
  product?: VaultProduct
  /** `secrets init --key-file <path>`: the key file asked for now. */
  keyFile?: string
  /** `secrets init --key-file <path> --import`. */
  importKeyFile?: boolean
  /** custody.keyFile of the vault on disk, for a key-file probe. Fixed when the options are built: see currentCustody. */
  recordedKeyFile?: string
  /** A vault exists on disk: a key-file probe reports a missing file as 'missing'. Fixed: see currentCustody. */
  vaultExists?: boolean
  /**
   * Read on every factory call (review round 2): the custody of the vault on disk now, or null / undefined while there
   * is none. A custody makes the custodian treat the vault as existing and gives a key-file custodian its recorded
   * path, so a long-lived factory built before the vault was created probes a gone key file as 'missing' afterwards.
   * A store that does not pass it must build a new factory after it creates or resets a vault.
   */
  currentCustody?: () => VaultCustody | null | undefined
}

/** One custodian per scheme (the store asks for the recorded scheme, or for chooseCustodyScheme's answer). */
export function createCustodian(scheme: VaultCustodyScheme, opts: CustodianFactoryOptions): RemovableKeyCustodian {
  const inner = createRawCustodian(scheme, opts)
  return opts.product === 'cli' ? cliTexts(inner) : inner
}

const CLI_TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bORGAI_VAULT_/g, 'ORGAI_CLI_VAULT_'],
  [/OrgAI Vault item/g, 'OrgAI CLI Vault item'],
  [/OrgAI vault item/g, 'OrgAI CLI vault item']
]

/** The CLI's wording of a custodian's reason: its variables and item names (the shared texts name the desktop's). */
export function cliWording(text: string): string {
  return CLI_TEXT_RULES.reduce((t, [re, to]) => t.replace(re, to), text)
}

/** Wraps a custodian so every reason it reports uses the CLI's names (spec 3.3: no app references). */
function cliTexts(c: RemovableKeyCustodian): RemovableKeyCustodian {
  const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (e) {
      if (e instanceof CustodyError) throw new CustodyError(e.kind, cliWording(e.reason))
      throw e
    }
  }
  // A prototype link keeps every other member (a key-file custodian's path helpers) reachable.
  const wrapped = Object.create(c) as RemovableKeyCustodian
  wrapped.probe = async (): Promise<CustodianProbe> => {
    const r = await wrap(() => c.probe())
    return r.ok ? r : { ...r, reason: cliWording(r.reason) }
  }
  wrapped.create = (vaultId: string): Promise<CustodianCreated> => wrap(() => c.create(vaultId))
  wrapped.open = (vaultId: string, custody: VaultCustody): Promise<Buffer> => wrap(() => c.open(vaultId, custody))
  wrapped.removeItem = (vaultId: string, custody: VaultCustody): Promise<void> => wrap(() => c.removeItem(vaultId, custody))
  return wrapped
}

function createRawCustodian(scheme: VaultCustodyScheme, opts: CustodianFactoryOptions): RemovableKeyCustodian {
  const helper = {
    ...(opts.product ? { product: opts.product } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.spawner ? { spawner: opts.spawner } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
  }
  switch (scheme) {
    case 'keychain':
      return new KeychainCustodian(helper)
    case 'dpapi-user':
      return new DpapiCustodian(helper)
    case 'secret-service':
      return new SecretServiceCustodian(helper)
    case 'key-file':
      return new KeyFileCustodian({
        ...helper,
        dataDir: opts.dataDir,
        userDataDir: opts.userDataDir,
        ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
        ...(opts.importKeyFile ? { importExisting: true } : {}),
        ...(opts.recordedKeyFile !== undefined ? { recordedKeyFile: opts.recordedKeyFile } : {}),
        ...(opts.vaultExists ? { vaultExists: true } : {})
      })
  }
}

/**
 * The CustodianFactory openSecretStore uses by default (tests inject fakes instead). Each call builds a fresh custodian
 * from `opts` plus `opts.currentCustody()` as it is at that moment.
 */
export function createCustodianFactory(opts: CustodianFactoryOptions): CustodianFactory {
  return (scheme: VaultCustodyScheme, request?: CustodianRequest): KeyCustodian => {
    const custody = opts.currentCustody?.() ?? null
    // The store resolves ORGAI_VAULT_KEY_FILE itself and hands the path over in `request`. A path that is just the
    // environment's own stays an environment path for the custodian (an existing file is then imported when a new
    // vault is made); only a path asked for with `secrets init --key-file` is passed as `keyFile`.
    const envKeyFile = ((opts.env ?? process.env)[vaultNames(opts.product).keyFileEnv] ?? '').trim()
    const asked = request?.keyFile !== undefined && request.keyFile !== envKeyFile ? request.keyFile : undefined
    const base: CustodianFactoryOptions = {
      ...opts,
      ...(asked !== undefined ? { keyFile: asked } : {}),
      ...(asked !== undefined && request?.importKeyFile ? { importKeyFile: true } : {})
    }
    if (!custody) return createCustodian(scheme, base)
    return createCustodian(scheme, {
      ...base,
      vaultExists: true,
      ...(custody.scheme === 'key-file' && custody.keyFile ? { recordedKeyFile: custody.keyFile } : {})
    })
  }
}

/** The custodian for a vault (recorded custody) or for a new one; null when no scheme is usable here. */
export function custodianFor(opts: CustodianFactoryOptions & { recorded?: VaultCustody | null }): RemovableKeyCustodian | null {
  const scheme = chooseCustodyScheme({
    recorded: opts.recorded ?? null,
    keyFileRequested: opts.keyFile !== undefined,
    ...(opts.product ? { product: opts.product } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.platform ? { platform: opts.platform } : {})
  })
  if (!scheme) return null
  return createCustodian(scheme, {
    ...opts,
    ...(opts.recorded ? { vaultExists: true } : {}),
    ...(opts.recorded?.keyFile ? { recordedKeyFile: opts.recorded.keyFile } : {})
  })
}
