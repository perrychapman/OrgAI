/**
 * The orgai command shim (cli-spec 7(3), Wave 6): a user-level file on PATH that runs the packaged launcher.
 * SKELETON: the contracts step lands the names and signatures; the desktop task replaces the body of
 * createCliShimService with the real installer (packagedLayout.ts holds the pure layout, render and parse helpers).
 * No electron import: index.ts passes the facts in CliShimDeps.
 */
import type { CliShimResult, CliShimStatus } from '@shared/types'

export interface CliShimDeps {
  platform: NodeJS.Platform
  /** app.isPackaged */
  isPackaged: boolean
  /** ORGAI_DATA_DIR was set at launch (a test or second profile: never install a shim for it). */
  dataDirOverride: boolean
  /** process.resourcesPath */
  resourcesPath: string
  /** app.getPath('userData'), never <userData>/data. */
  userDataDir: string
  home: string
  env: NodeJS.ProcessEnv
  /** The login shell PATH when known. */
  loginPath?: string
  /** Called after a successful install (index.ts turns Terminal access on). */
  onInstalled?: () => void | Promise<void>
}

export interface CliShimService {
  status(): CliShimStatus
  install(): Promise<CliShimResult>
  uninstall(): Promise<CliShimResult>
  /** At launch: rewrite an OrgAI shim that points at another launcher of this install. */
  refreshOnLaunch(): Promise<'refreshed' | 'unchanged' | 'skipped'>
}

export const CLI_SHIM_UNAVAILABLE: CliShimStatus = {
  state: 'unavailable',
  path: '',
  binDir: '',
  reason: 'The orgai command can be installed only from the installed OrgAI app.'
}

export function createCliShimService(deps: CliShimDeps): CliShimService {
  void deps
  const status = (): CliShimStatus => ({ ...CLI_SHIM_UNAVAILABLE })
  const refused = async (): Promise<CliShimResult> => {
    const s = status()
    return { ok: false, message: s.reason ?? '', status: s }
  }
  return {
    status,
    install: refused,
    uninstall: refused,
    refreshOnLaunch: async () => 'skipped'
  }
}
