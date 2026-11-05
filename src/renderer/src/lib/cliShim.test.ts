import { describe, expect, it } from 'vitest'
import type { CliShimResult, CliShimStatus } from '@shared/types'
import {
  CLI_SHIM_CHECKING,
  CLI_SHIM_INSTALL_LABEL,
  CLI_SHIM_LOAD_FAILED,
  CLI_SHIM_PATH_HINT_ID,
  CLI_SHIM_UNAVAILABLE,
  CLI_SHIM_UPDATE_LABEL,
  TERMINAL_ACCESS_TRUST,
  askTerminalAccessAfter,
  cleanShown,
  cliShimDescribedBy,
  cliShimFocusAfter,
  cliShimLine,
  cliShimNotice,
  cliShimView,
  displayPath,
  hasCliShimApi,
  singleFlight
} from './cliShim'

describe('row wiring (review Lows, H2)', () => {
  const view = { line: 'Installed at ~/.local/bin/orgai.', remove: true }
  it('names the PATH hint in aria-describedby only while it is shown', () => {
    expect(cliShimDescribedBy('cli-shim-row-desc', null)).toBe('cli-shim-row-desc')
    expect(cliShimDescribedBy('cli-shim-row-desc', view)).toBe('cli-shim-row-desc')
    expect(cliShimDescribedBy('cli-shim-row-desc', { ...view, pathHint: 'Add it' })).toBe(`cli-shim-row-desc ${CLI_SHIM_PATH_HINT_ID}`)
  })
  it('says Checking while loading and a failure once the status could not be read', () => {
    expect(cliShimLine(null, false)).toBe(CLI_SHIM_CHECKING)
    expect(cliShimLine(null, true)).toBe(CLI_SHIM_LOAD_FAILED)
    expect(cliShimLine(view, true)).toBe(view.line)
  })
  it('asks to turn Terminal access on only after a successful install or update while it is off', () => {
    const ok = { ok: true, message: 'Installed.', status: { state: 'installed' } } as unknown as CliShimResult
    const bad = { ...ok, ok: false } as CliShimResult
    expect(askTerminalAccessAfter('install', ok, false)).toBe(true)
    expect(askTerminalAccessAfter('update', ok, false)).toBe(true)
    expect(askTerminalAccessAfter('install', ok, true)).toBe(false)
    expect(askTerminalAccessAfter('install', bad, false)).toBe(false)
    expect(askTerminalAccessAfter('install', null, false)).toBe(false)
    expect(askTerminalAccessAfter('remove', ok, false)).toBe(false)
  })
  it('the trust sentence names agent shells', () => {
    expect(TERMINAL_ACCESS_TRUST).toMatch(/any program you run/)
    expect(TERMINAL_ACCESS_TRUST).toMatch(/agent shells/)
  })
})

const PLATFORMS = ['darwin', 'linux', 'win32'] as const
type Platform = (typeof PLATFORMS)[number]

const HOME: Record<Platform, string> = { darwin: '/Users/ann', linux: '/home/ann', win32: 'C:\\Users\\ann' }
function paths(p: Platform): { path: string; binDir: string; shownPath: string; shownBin: string } {
  if (p === 'win32') {
    const binDir = 'C:\\Users\\ann\\AppData\\Local\\OrgAI\\bin'
    return { path: `${binDir}\\orgai.cmd`, binDir, shownPath: `${binDir}\\orgai.cmd`, shownBin: binDir }
  }
  const binDir = `${HOME[p]}/.local/bin`
  return { path: `${binDir}/orgai`, binDir, shownPath: '~/.local/bin/orgai', shownBin: '~/.local/bin' }
}
function st(p: Platform, state: CliShimStatus['state'], extra: Partial<CliShimStatus> = {}): CliShimStatus {
  const { path, binDir } = paths(p)
  return { state, path, binDir, ...extra }
}
function expectedHint(p: Platform): string {
  const { shownBin } = paths(p)
  return p === 'win32'
    ? `Add ${shownBin} to your user Path in Windows settings.`
    : `${shownBin} is not on your PATH. Add this line to your shell profile: export PATH="${shownBin}:$PATH"`
}

describe('cliShimView', () => {
  for (const p of PLATFORMS) {
    describe(p, () => {
      const { shownPath, shownBin } = paths(p)

      it('unavailable without a reason', () => {
        expect(cliShimView({ state: 'unavailable', path: '', binDir: '' }, p)).toEqual({ line: CLI_SHIM_UNAVAILABLE, remove: false })
      })
      it('unavailable with a reason', () => {
        const v = cliShimView({ state: 'unavailable', path: '', binDir: '', reason: 'This is a development build.' }, p)
        expect(v).toEqual({ line: 'This is a development build.', remove: false })
      })
      it('not-installed offers install', () => {
        const v = cliShimView(st(p, 'not-installed', { onPath: false }), p)
        expect(v.line).toBe(`Not installed. Adds a small orgai command in ${shownBin}.`)
        expect(v.primary).toEqual({ action: 'install', label: CLI_SHIM_INSTALL_LABEL })
        expect(v.remove).toBe(false)
        expect(v.pathHint).toBeUndefined()
      })
      for (const onPath of [true, false, undefined]) {
        it(`installed, onPath ${String(onPath)}`, () => {
          const v = cliShimView(st(p, 'installed', { onPath }), p)
          expect(v.line).toBe(`Installed at ${shownPath}.`)
          expect(v.primary).toBeUndefined()
          expect(v.remove).toBe(true)
          expect(v.pathHint).toBe(onPath === false ? expectedHint(p) : undefined)
        })
        it(`outdated, onPath ${String(onPath)}`, () => {
          const v = cliShimView(st(p, 'outdated', { onPath, target: '/Applications/Old OrgAI.app/x' }), p)
          expect(v.line).toBe(`Installed at ${shownPath}, but it runs another copy of OrgAI.`)
          expect(v.primary).toEqual({ action: 'update', label: CLI_SHIM_UPDATE_LABEL })
          expect(v.remove).toBe(true)
          expect(v.pathHint).toBe(onPath === false ? expectedHint(p) : undefined)
        })
      }
      it('foreign shows the reason and no actions', () => {
        const v = cliShimView(st(p, 'foreign', { onPath: false, reason: 'Another program owns this file.' }), p)
        expect(v).toEqual({ line: 'Another program owns this file.', remove: false })
      })
    })
  }

  it('foreign without a reason still says something', () => {
    expect(cliShimView(st('darwin', 'foreign'), 'darwin').line).toMatch(/orgai/)
  })
})

describe('home shortening', () => {
  it('shortens /Users/<name> and /home/<name> to ~', () => {
    expect(displayPath('/Users/ann/.local/bin', 'darwin')).toBe('~/.local/bin')
    expect(displayPath('/home/ann/.local/bin/orgai', 'linux')).toBe('~/.local/bin/orgai')
    expect(displayPath('/root/.local/bin', 'linux')).toBe('~/.local/bin')
    expect(displayPath('/Users/ann', 'darwin')).toBe('~')
  })
  it('leaves other paths and Windows paths alone', () => {
    expect(displayPath('/usr/local/bin', 'darwin')).toBe('/usr/local/bin')
    expect(displayPath('/Usersx/ann/bin', 'darwin')).toBe('/Usersx/ann/bin')
    expect(displayPath('C:\\Users\\ann\\bin', 'win32')).toBe('C:\\Users\\ann\\bin')
  })
  it('takes an explicit home', () => {
    expect(displayPath('/opt/ann/.local/bin', 'linux', '/opt/ann/')).toBe('~/.local/bin')
    expect(displayPath('/opt/annie/bin', 'linux', '/opt/ann')).toBe('/opt/annie/bin')
  })
})

describe('hidden characters', () => {
  it('are never echoed in the line or the hint', () => {
    const bad = '/Users/ann/.local/\u202ebin\u200b\u0007\n'
    const v = cliShimView({ state: 'installed', path: `${bad}/orgai`, binDir: bad, onPath: false }, 'darwin')
    const all = `${v.line} ${v.pathHint ?? ''}`
    expect(all).not.toMatch(/[\u0000-\u001f\u200b\u202e]/)
    expect(v.line).toBe('Installed at ~/.local/bin/orgai.')
    expect(v.pathHint).toContain('export PATH="~/.local/bin:$PATH"')
  })
  it('are stripped from reasons and notices', () => {
    expect(cliShimView({ state: 'unavailable', path: '', binDir: '', reason: 'Dev\u2066 build\u0000.' }, 'linux').line).toBe('Dev build.')
    expect(cleanShown('a\u200fb')).toBe('ab')
    expect(cliShimNotice({ ok: true, message: 'Installed\u202e.', status: { state: 'installed', path: '', binDir: '' } })).toBe('Installed.')
  })
  it('a reason made only of hidden characters falls back to the plain sentence', () => {
    expect(cliShimView({ state: 'unavailable', path: '', binDir: '', reason: '\u200b\u200b' }, 'darwin').line).toBe(CLI_SHIM_UNAVAILABLE)
  })
})

describe('cliShimFocusAfter', () => {
  const installed = cliShimView(st('darwin', 'installed'), 'darwin')
  const notInstalled = cliShimView(st('darwin', 'not-installed'), 'darwin')
  const unavailable = cliShimView({ state: 'unavailable', path: '', binDir: '' }, 'darwin')
  it('install moves to Remove, remove moves to Install', () => {
    expect(cliShimFocusAfter('install', installed)).toBe('remove')
    expect(cliShimFocusAfter('update', installed)).toBe('remove')
    expect(cliShimFocusAfter('remove', notInstalled)).toBe('install')
  })
  it('falls back to the status line when that button is gone', () => {
    expect(cliShimFocusAfter('install', notInstalled)).toBe('status')
    expect(cliShimFocusAfter('remove', installed)).toBe('status')
    expect(cliShimFocusAfter('remove', unavailable)).toBe('status')
  })
})

describe('cliShimNotice', () => {
  it('uses the message, else a plain fallback', () => {
    expect(cliShimNotice({ ok: true, message: 'Installed the orgai command.', status: st('darwin', 'installed') })).toBe('Installed the orgai command.')
    expect(cliShimNotice({ ok: true, message: '', status: st('darwin', 'installed') })).toBe('Done.')
    expect(cliShimNotice({ ok: false, message: '', status: st('darwin', 'installed') })).toMatch(/could not/)
    expect(cliShimNotice(null)).toMatch(/could not/)
  })
})

describe('hasCliShimApi', () => {
  it('hides the row without the API', () => {
    expect(hasCliShimApi(undefined)).toBe(false)
    expect(hasCliShimApi({ cliShimStatus: () => null })).toBe(false)
    expect(hasCliShimApi({ cliShimStatus: () => null, installCliShim: () => null, uninstallCliShim: () => null })).toBe(true)
  })
})

describe('singleFlight', () => {
  it('a double click calls install once', async () => {
    const f = singleFlight<string>()
    let calls = 0
    let release: (v: string) => void = () => {}
    const install = (): Promise<string> => {
      calls++
      return new Promise((r) => (release = r))
    }
    const first = f.run(install)
    const second = f.run(install)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(f.busy()).toBe(true)
    release('ok')
    await expect(first).resolves.toBe('ok')
    expect(f.busy()).toBe(false)
    expect(calls).toBe(1)
    await f.run(() => Promise.resolve('again'))
    expect(f.busy()).toBe(false)
  })
  it('clears the flag after a failure', async () => {
    const f = singleFlight<string>()
    await expect(f.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(f.busy()).toBe(false)
    await expect(f.run(() => { throw new Error('sync') })).rejects.toThrow('sync')
    expect(f.busy()).toBe(false)
  })
})
