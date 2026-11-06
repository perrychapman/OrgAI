// Dev only (npm run predev / prestart / prepreview). macOS: names the unpacked Electron.app "OrgAI" so the menu bar and
// Dock tooltip stop saying "Electron". No-op elsewhere. Never fails the dev start: any error is a warning, exit 0.
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { applyDevAppName, appBundleOf, MANUAL_FIX } from './lib/macDevAppName.mjs'

const exec = promisify(execFile)

async function main() {
  if (process.platform !== 'darwin') return
  const electronBinary = createRequire(import.meta.url)('electron')
  try {
    const r = await applyDevAppName({
      platform: process.platform,
      electronBinary,
      run: (file, args) => exec(file, args, { encoding: 'utf8' })
    })
    if (r.message) console.log(r.message)
  } catch (e) {
    const app = appBundleOf(electronBinary) ?? '<Electron.app>'
    console.warn(`mac-dev-app-name: could not rename the dev app (${e instanceof Error ? e.message : String(e)}). Dev still starts.`)
    console.warn(MANUAL_FIX(app))
  }
}

main().catch((e) => console.warn(`mac-dev-app-name: ${e instanceof Error ? e.message : String(e)}`)).finally(() => process.exit(0))
