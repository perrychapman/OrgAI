import { app as electronApp, type App, type WebContents } from 'electron'
import { log } from './log'

/**
 * The Electron-only crash and hang hooks that used to live in log.ts (moved so log.ts loads in plain Node, cli-spec
 * 3.1.1). Called once by the Electron entry right after installLogging. This module imports electron at runtime, so
 * only the Electron entry may import it (noElectronImport.test.ts checks that importing it fails without electron).
 */
export function installElectronLogHooks(app: App = electronApp): void {
  app.on('render-process-gone', (_e, contents, details) => {
    log.error(`Renderer gone (${details.reason}, exit ${details.exitCode}) url=${safeUrl(contents)}`)
  })
  app.on('child-process-gone', (_e, details) => {
    const name = details.name ?? details.serviceName ?? ''
    log.error(`Child process gone: ${details.type} ${name} (${details.reason}, exit ${details.exitCode})`)
  })
  app.on('web-contents-created', (_e, contents) => {
    contents.on('unresponsive', () => log.warn(`WebContents unresponsive url=${safeUrl(contents)}`))
    contents.on('responsive', () => log.info(`WebContents responsive again url=${safeUrl(contents)}`))
  })
}

function safeUrl(contents: WebContents): string {
  try {
    return contents.getURL()
  } catch {
    return '?'
  }
}
