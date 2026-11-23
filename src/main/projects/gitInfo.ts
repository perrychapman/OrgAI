import type { GitSummary } from '../../shared/types'

/**
 * UI overhaul (gitInfo.summary / branches): read-only git facts of a stored code project.
 * CONTRACT STUB: implemented by a Runtime Engineer (see docs/design/ui-overhaul/impl-runtime.md).
 */
export async function gitSummary(path: string, mainBranch?: string): Promise<GitSummary | null> {
  void path
  void mainBranch
  return null
}

export async function gitBranches(path: string, mainBranch?: string): Promise<string[]> {
  void path
  void mainBranch
  return []
}
