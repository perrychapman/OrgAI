import { join } from 'node:path'
import { isConnectionId } from '@shared/defaults'
import type { SupportDetails } from '@shared/types'

/**
 * UI overhaul, About page: support details text, the "Report a problem" issue URL and the bundled licences file.
 * Everything here is data the user may paste into a public issue, so it holds the app version, the platform and the
 * state of each connection and nothing else: no project names, paths, accounts, model names or secrets.
 */
export interface AboutDeps {
  version: string
  platform: string
  arch: string
  /** Connection id -> plain state word ('connected', 'disconnected', ...). No names, paths or secrets. */
  connectionStates(): Promise<Record<string, string>>
}

/** Where "Report a problem" goes. The host check in overhaulIpc.ts compares against this prefix. */
export const REPORT_PROBLEM_BASE = 'https://github.com/perrychapman/OrgAI/issues/new'

/** Most connections listed (a runaway list cannot grow the text). */
const SUPPORT_CONNECTIONS_MAX = 50

/** A short word made of letters, digits, dots and dashes (a version, a platform, an architecture), else the fallback. */
function plainWord(value: unknown, max: number, fallback: string): string {
  const t = typeof value === 'string' ? value.trim() : ''
  return t && t.length <= max && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(t) ? t : fallback
}

/** A state word: lowercase letters, spaces and dashes, short; anything else is 'unknown'. */
function stateWord(value: unknown): string {
  const t = typeof value === 'string' ? value.trim() : ''
  return /^[a-z][a-z -]{0,31}$/.test(t) ? t : 'unknown'
}

export async function supportDetails(deps: AboutDeps): Promise<SupportDetails> {
  let states: Record<string, unknown> = {}
  try {
    const read = await deps.connectionStates()
    if (read && typeof read === 'object') states = read
  } catch {
    // A failed read still gives the version lines.
  }
  const ids = Object.keys(states)
    .filter((id) => isConnectionId(id))
    .sort()
    .slice(0, SUPPORT_CONNECTIONS_MAX)
  const lines = [
    `OrgAI ${plainWord(deps.version, 40, 'unknown')}`,
    `Platform: ${plainWord(deps.platform, 20, 'unknown')} ${plainWord(deps.arch, 20, 'unknown')}`,
    ids.length ? 'Connections:' : 'Connections: none'
  ]
  for (const id of ids) lines.push(`- ${id}: ${stateWord(states[id])}`)
  return { text: lines.join('\n') }
}

/**
 * The prefilled GitHub new-issue URL: always `https://github.com/perrychapman/OrgAI/issues/new` with a title and a body
 * query parameter (URL-encoded) that hold the version and platform only. Nothing is sent by OrgAI; the browser opens it.
 */
export function reportProblemUrl(deps: Pick<AboutDeps, 'version' | 'platform' | 'arch'>): string {
  const version = plainWord(deps.version, 40, 'unknown')
  const platform = `${plainWord(deps.platform, 20, 'unknown')} ${plainWord(deps.arch, 20, 'unknown')}`
  const params = new URLSearchParams()
  params.set('title', `Problem report (OrgAI ${version})`)
  params.set('body', `What happened:\n\nWhat I expected:\n\nOrgAI ${version} on ${platform}\n`)
  // URLSearchParams writes a space as '+'; GitHub reads both, but %20 is unambiguous everywhere.
  return `${REPORT_PROBLEM_BASE}?${params.toString().replace(/\+/g, '%20')}`
}

/**
 * Candidate paths of the bundled third-party licences file, best first. Only paths inside the install: Electron's
 * `LICENSES.chromium.html` and its licence file next to the executable (electron-builder names the latter
 * `LICENSE.electron.txt`; an unpackaged Electron has `LICENSE`), then a `THIRD_PARTY` or `LICENSE` file in the app path
 * when the build has one (electron-builder.yml packs only out/** and package.json today, so none is expected inside the
 * archive; a path inside an `.asar` cannot be opened by the shell, so those are left out). The caller picks the first
 * that exists.
 */
export function licencePaths(appPath: string, exeDir: string): string[] {
  const out: string[] = []
  const add = (dir: unknown, names: string[]): void => {
    if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0')) return
    for (const name of names) {
      const path = join(dir, name)
      if (!out.includes(path)) out.push(path)
    }
  }
  add(exeDir, ['LICENSES.chromium.html', 'LICENSE.electron.txt', 'LICENSE'])
  if (typeof appPath === 'string' && !/\.asar([\\/]|$)/i.test(appPath)) add(appPath, ['THIRD_PARTY_LICENSES.txt', 'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY', 'LICENSE'])
  return out
}
