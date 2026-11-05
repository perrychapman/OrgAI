import { app, BrowserWindow } from 'electron'

/**
 * Hidden windows for e2e runs (ORGAI_E2E_HIDDEN=1, which e2e/lib.mjs sets unless E2E_SHOW=1), so a test run never
 * takes over the screen. Windows are created and rendered as usual but never shown or focused, and on macOS the app
 * has no Dock icon (so it never becomes the active app). Playwright drives the page over CDP, so input, focus
 * emulation and screenshots keep working; `backgroundThrottling: false` keeps timers and animation frames running in
 * the never-shown window. Honoured only in unpackaged builds: a packaged OrgAI always shows its windows.
 */
export function hiddenWindowsFor(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  return !packaged && env.ORGAI_E2E_HIDDEN === '1'
}

let cached: boolean | undefined

/** hiddenWindowsFor(process.env, app.isPackaged), read once. */
export function hiddenWindows(): boolean {
  if (cached === undefined) {
    try {
      cached = hiddenWindowsFor(process.env, app.isPackaged)
    } catch {
      cached = false
    }
  }
  return cached
}

/**
 * The focused window, or with hidden windows (nothing is ever focused) the first live window, so menu routing and
 * enablement behave as they do with a visible, focused main window.
 */
export function focusedOrPrimaryWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused || !hiddenWindows()) return focused
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}
