// The pack scripts (scripts/lib/packLayout.mjs) and the app (packagedLayout.ts) must agree on where the packaged
// orgai command lives, or `npm run pack:verify` would check a different layout from the one the app installs.
import { describe, expect, it } from 'vitest'
import { packagedPaths } from '../../../scripts/lib/packLayout.mjs'
import { packagedLayout } from './packagedLayout'

const cases: { platform: string; arch: string; release: string; resources: string }[] = [
  { platform: 'darwin', arch: 'arm64', release: '/repo/release', resources: '/repo/release/mac-arm64/OrgAI.app/Contents/Resources' },
  { platform: 'darwin', arch: 'x64', release: '/repo/release', resources: '/repo/release/mac/OrgAI.app/Contents/Resources' },
  { platform: 'win32', arch: 'x64', release: 'C:\\repo\\release', resources: 'C:\\repo\\release\\win-unpacked\\resources' },
  { platform: 'linux', arch: 'x64', release: '/repo/release', resources: '/repo/release/linux-unpacked/resources' }
]

describe('pack layout parity', () => {
  for (const c of cases) {
    it(`${c.platform} ${c.arch}: the scripts and the app name the same paths`, () => {
      const scripts = packagedPaths(c.platform, c.arch, c.release)
      expect(scripts.resourcesDir).toBe(c.resources)
      const app = packagedLayout(c.platform, scripts.resourcesDir)
      expect(scripts.resourcesDir).toBe(app.resourcesDir)
      expect(scripts.launcher).toBe(app.launcher)
      expect(scripts.cliBundleDir).toBe(app.cliBundleDir)
      expect(scripts.appBinary).toBe(app.appBinary)
    })
  }
})
