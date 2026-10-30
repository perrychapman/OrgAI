import type { FocusRunTarget } from '@shared/types'

/**
 * Multi-window helpers, pure so they are unit-testable without Electron. A window is either the main (unscoped)
 * window or scoped to one run; a run-scoped window loads the renderer at `#/run/<projectId>/<runId>`
 * (runWindowHash in src/shared/types.ts). index.ts keeps the Map<BrowserWindow, FocusRunTarget | undefined>.
 */

/** Ids from the renderer: newId() output (and older hand-made ids) never exceed this or contain other characters. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Validate a window:openRun target against the stores. Throws on anything malformed, unknown or mismatched. */
export function checkRunTarget(
  input: unknown,
  lookup: { project(id: string): unknown; runProject(runId: string): string | undefined }
): FocusRunTarget {
  const t = (input && typeof input === 'object' ? input : {}) as Partial<FocusRunTarget>
  const projectId = typeof t.projectId === 'string' ? t.projectId : ''
  const runId = typeof t.runId === 'string' ? t.runId : ''
  if (!ID_PATTERN.test(projectId) || !ID_PATTERN.test(runId)) throw new Error('Invalid run target')
  if (!lookup.project(projectId)) throw new Error('Project not found')
  const owner = lookup.runProject(runId)
  if (!owner) throw new Error('Run not found')
  if (owner !== projectId) throw new Error('Run belongs to another project')
  return { projectId, runId }
}

/** The window already scoped to this run, if any. */
export function scopedWindow<W>(windows: Iterable<[W, FocusRunTarget | undefined]>, runId: string): W | undefined {
  for (const [w, scope] of windows) if (scope?.runId === runId) return w
  return undefined
}

/**
 * The window a notification click for `target` should focus: one scoped to that run, else the main (unscoped)
 * window, else any window. `windows` holds only live windows.
 */
export function pickFocusWindow<W>(windows: Iterable<[W, FocusRunTarget | undefined]>, target: FocusRunTarget): W | undefined {
  const list = [...windows]
  return scopedWindow(list, target.runId) ?? list.find(([, scope]) => !scope)?.[0] ?? list[0]?.[0]
}

/** setWindowOpenHandler: only http(s) links may leave the app, opened in the user's browser. Anything else is denied. */
export function isExternalWebUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Whether a navigation target is the app's own renderer: the dev server's origin (ELECTRON_RENDERER_URL) in
 * development, the bundled index.html file in production. Hash and query are ignored, so `#/run/...` stays in.
 * File paths are compared as URL-normalised pathnames, never decoded (a malformed escape such as `%zz` must not
 * throw), and case-folded on Windows only. Call it through shouldBlockNavigation, which fails closed.
 */
export function appUrlMatcher(
  rendererUrl: string | undefined,
  indexFileUrl: string,
  platform: NodeJS.Platform = process.platform
): (url: string) => boolean {
  const parse = (url: string): URL | null => {
    try {
      return new URL(url)
    } catch {
      return null
    }
  }
  if (rendererUrl) {
    const origin = parse(rendererUrl)?.origin
    return (url) => {
      const u = parse(url)
      return !!u && !!origin && origin !== 'null' && u.origin === origin
    }
  }
  const index = parse(indexFileUrl)
  // Windows paths are case-insensitive and Chromium may report the drive letter in either case; elsewhere case matters.
  const key = (u: URL): string => (platform === 'win32' ? u.pathname.toLowerCase() : u.pathname)
  return (url) => {
    const u = parse(url)
    return !!u && !!index && u.protocol === 'file:' && index.protocol === 'file:' && u.host === index.host && key(u) === key(index)
  }
}

/**
 * The will-navigate / will-redirect / will-frame-navigate guard: true when the navigation must be cancelled.
 * Anything but the app's own renderer is blocked; subframes may also load about:blank and about:srcdoc. A matcher
 * that throws blocks (fails closed), since the throw would otherwise skip preventDefault().
 */
export function shouldBlockNavigation(isAppUrl: (url: string) => boolean, url: string, isMainFrame = true): boolean {
  try {
    if (!isMainFrame && (url === 'about:blank' || url === 'about:srcdoc')) return false
    return !isAppUrl(url)
  } catch {
    return true
  }
}
