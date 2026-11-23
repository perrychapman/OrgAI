import type { SupportDetails } from '../shared/types'

/**
 * UI overhaul, About page: support details text, the "Report a problem" issue URL and the bundled licences file.
 * CONTRACT STUB: implemented by a Runtime Engineer (see docs/design/ui-overhaul/impl-runtime.md).
 */
export interface AboutDeps {
  version: string
  platform: string
  arch: string
  /** Connection id -> plain state word ('connected', 'disconnected', ...). No names, paths or secrets. */
  connectionStates(): Promise<Record<string, string>>
}

export async function supportDetails(deps: AboutDeps): Promise<SupportDetails> {
  return { text: `OrgAI ${deps.version} on ${deps.platform} ${deps.arch}` }
}

/** The prefilled GitHub new-issue URL (version and platform only). Always https://github.com/perrychapman/OrgAI/issues/new?... */
export function reportProblemUrl(deps: Pick<AboutDeps, 'version' | 'platform' | 'arch'>): string {
  void deps
  return 'https://github.com/perrychapman/OrgAI/issues/new'
}

/** Candidate paths of the bundled third-party licences file, best first (only paths inside the install). */
export function licencePaths(appPath: string, exeDir: string): string[] {
  void appPath
  void exeDir
  return []
}
