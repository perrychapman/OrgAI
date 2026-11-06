// Pure helper for scripts/mac-dev-app-name.mjs: on macOS the dev Electron shows "Electron" in the menu bar and Dock
// because the name comes from Electron.app's Info.plist. Runner is injected: (file, args) => Promise<{ stdout }>.
import path from 'node:path'

export const APP_NAME = 'OrgAI'
export const PLUTIL = '/usr/bin/plutil'
export const CODESIGN = '/usr/bin/codesign'
export const NAME_KEYS = ['CFBundleName', 'CFBundleDisplayName']

/** electron's require() value is <app>/Contents/MacOS/Electron; returns <app>.app, or null if it does not look right. */
export function appBundleOf(electronBinary) {
  if (typeof electronBinary !== 'string') return null
  const macos = path.posix.dirname(electronBinary)
  const contents = path.posix.dirname(macos)
  if (path.posix.basename(macos) !== 'MacOS' || path.posix.basename(contents) !== 'Contents') return null
  const app = path.posix.dirname(contents)
  return app.endsWith('.app') ? app : null
}

export const plistPath = (app) => `${app}/Contents/Info.plist`
export const readArgs = (app, key) => ['-extract', key, 'raw', '-o', '-', plistPath(app)]
export const replaceArgs = (app, key) => ['-replace', key, '-string', APP_NAME, plistPath(app)]
export const signArgs = (app) => ['--force', '--deep', '--sign', '-', app]

export const MANUAL_FIX = (app) =>
  `Manual fix: for k in CFBundleName CFBundleDisplayName; do /usr/bin/plutil -replace $k -string ${APP_NAME} "${app}/Contents/Info.plist"; done; /usr/bin/codesign --force --deep --sign - "${app}"`

/** Returns { action: 'skipped' | 'unchanged' | 'renamed', message }. Throws on runner errors (caller prints a warning). */
export async function applyDevAppName({ platform, electronBinary, run }) {
  if (platform !== 'darwin') return { action: 'skipped', message: '' }
  const app = appBundleOf(electronBinary)
  if (!app) throw new Error(`Unexpected Electron path: ${String(electronBinary)}`)
  const stale = []
  for (const key of NAME_KEYS) {
    let current = ''
    try {
      current = String((await run(PLUTIL, readArgs(app, key))).stdout ?? '').trim()
    } catch {
      current = '' // key missing: set it
    }
    if (current !== APP_NAME) stale.push(key)
  }
  if (stale.length === 0) return { action: 'unchanged', message: `mac-dev-app-name: dev Electron already named ${APP_NAME}.` }
  for (const key of stale) await run(PLUTIL, replaceArgs(app, key))
  await run(CODESIGN, signArgs(app))
  return { action: 'renamed', message: `mac-dev-app-name: set ${stale.join(' and ')} to ${APP_NAME} in ${app} and re-signed it ad hoc.` }
}
