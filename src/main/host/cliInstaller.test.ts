import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  OutputTail,
  buildNpmCommand,
  cleanOutput,
  createCliInstallService,
  installCommandText,
  installTag,
  prefixHint,
  systemExe,
  resolveNpm,
  scrubEnv,
  type CliInstallDeps,
  type SpawnLike
} from './cliInstaller'
import type { OrgaiOnPathEntry } from './orgaiOnPath'
import type { OldShimService } from './shimInstaller'

const quiet = { info: () => {}, warn: () => {} }
const posixOnly = process.platform === 'win32' ? it.skip : it

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  killed: string[] = []
  kill(sig?: string): boolean {
    this.killed.push(sig ?? 'SIGTERM')
    // A killed process closes with no exit code.
    setImmediate(() => this.emit('close', null))
    return true
  }
}

function oldShim(kind: 'none' | 'ours' | 'foreign' = 'none'): OldShimService & { removed: number } {
  const o = {
    removed: 0,
    kind,
    path: () => '/h/.local/bin/orgai',
    inspect: () => o.kind,
    remove: () => {
      o.removed++
      if (o.kind === 'ours') {
        o.kind = 'none'
        return { ok: true, message: 'Removed.' }
      }
      return o.kind === 'none' ? { ok: true, message: 'Gone.' } : { ok: false, message: 'Not OrgAI.' }
    }
  }
  return o as never
}

function make(over: Partial<CliInstallDeps> = {}) {
  const calls: { file: string; args: string[]; opts: Parameters<SpawnLike>[2] }[] = []
  const children: FakeChild[] = []
  const spawn: SpawnLike = (file, args, opts) => {
    calls.push({ file, args, opts })
    const c = new FakeChild()
    children.push(c)
    return c as never
  }
  const shim = oldShim()
  const svc = createCliInstallService({
    platform: 'darwin',
    home: '/h',
    env: { PATH: '/n/bin:/usr/bin' },
    loginPath: '/usr/bin',
    appVersion: '0.2.0',
    oldShim: shim,
    fs: { stat: (p) => ({ isFile: () => p === '/n/bin/npm', mode: 0o755 }) },
    findOnPath: () => [],
    spawn,
    log: quiet,
    ...over
  })
  return { svc, calls, children, shim }
}

describe('tag and command text', () => {
  it('latest for a stable app, next for a prerelease', () => {
    expect(installTag('0.2.0')).toBe('latest')
    expect(installTag('0.1.7-dev1')).toBe('next')
    expect(installTag('1.0.0-rc.1')).toBe('next')
    expect(installCommandText('next')).toBe('npm install -g orgai-cli@next')
  })
})

describe('scrubEnv', () => {
  it('drops ORGAI_, ANTHROPIC_, OPENAI_, CLAUDE_, CODEX_, AWS_, GOOGLE_ and AZURE_ variables, case-insensitively, and keeps npm settings', () => {
    const out = scrubEnv({
      PATH: '/bin',
      HOME: '/h',
      npm_config_registry: 'https://registry.example',
      NPM_CONFIG_PROXY: 'http://p',
      ORGAI_DATA_DIR: '/d',
      ORGAI_CLI_VAULT_KEY_FILE: '/k',
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      CODEX_HOME: '/c',
      AWS_SECRET_ACCESS_KEY: 's',
      GOOGLE_APPLICATION_CREDENTIALS: '/g',
      AZURE_CLIENT_SECRET: 's',
      azure_tenant: 'lower',
      GOOGLEFOO: 'no underscore, kept',
      UNDEF: undefined
    })
    expect(out).toEqual({ PATH: '/bin', HOME: '/h', npm_config_registry: 'https://registry.example', NPM_CONFIG_PROXY: 'http://p', GOOGLEFOO: 'no underscore, kept' })
  })
})

describe('resolveNpm', () => {
  const fs = (files: Record<string, number | undefined>) => ({
    stat: (p: string) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isFile: () => true, mode: files[p] }
    }
  })
  it('takes the first executable npm in PATH order, as an absolute path', () => {
    expect(resolveNpm('darwin', '/a:/b:/c', fs({ '/b/npm': 0o755, '/c/npm': 0o755 }))).toBe('/b/npm')
  })
  it('skips relative entries, empty entries and a file without an execute bit', () => {
    expect(resolveNpm('linux', '.:::bin:/a:/b', fs({ '/a/npm': 0o644, '/b/npm': 0o755 }))).toBe('/b/npm')
    expect(resolveNpm('linux', 'bin:./x', fs({ 'bin/npm': 0o755, './x/npm': 0o755 }))).toBeUndefined()
    expect(resolveNpm('linux', undefined)).toBeUndefined()
  })
  it('finds npm.cmd on Windows, in a folder with spaces, and skips a quote or percent in the path', () => {
    const files = { 'C:\\Program Files\\nodejs\\npm.cmd': undefined, 'C:\\Evil%PATH%\\npm.cmd': undefined, 'C:\\Q"x\\npm.cmd': undefined }
    expect(resolveNpm('win32', 'C:\\Evil%PATH%;C:\\Q"x;"C:\\Program Files\\nodejs"', fs(files))).toBe('C:\\Program Files\\nodejs\\npm.cmd')
    expect(resolveNpm('win32', 'C:\\Evil%PATH%', fs(files))).toBeUndefined()
    expect(resolveNpm('win32', '\\\\server\\share', fs({ '\\\\server\\share\\npm.cmd': undefined }))).toBeUndefined()
  })
})

describe('buildNpmCommand', () => {
  it('POSIX: the absolute npm with a fixed argument list, a path with spaces untouched', () => {
    expect(buildNpmCommand('darwin', '/Users/me/My Tools/bin/npm', 'latest')).toEqual({
      file: '/Users/me/My Tools/bin/npm',
      args: ['install', '-g', 'orgai-cli@latest', '--ignore-scripts'],
      verbatim: false
    })
  })
  it('Windows: npm.cmd through cmd.exe /d /s /c with one quoted command line', () => {
    const c = buildNpmCommand('win32', 'C:\\Program Files\\nodejs\\npm.cmd', 'next', 'C:\\Windows\\System32\\cmd.exe')
    expect(c.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(c.verbatim).toBe(true)
    expect(c.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" install -g orgai-cli@next --ignore-scripts"'])
    // A ComSpec that is not absolute is ignored.
    expect(buildNpmCommand('win32', 'C:\\n\\npm.cmd', 'latest', 'cmd.exe & calc', { SystemRoot: 'D:\\Win' }).file).toBe('D:\\Win\\System32\\cmd.exe')
    // No usable SystemRoot (missing, relative, network): the fixed C:\\Windows.
    expect(buildNpmCommand('win32', 'C:\\n\\npm.cmd', 'latest', undefined, {}).file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(systemExe({ SystemRoot: '\\\\evil\\share' }, 'taskkill.exe')).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(systemExe({ SystemRoot: 'win' }, 'taskkill.exe')).toBe('C:\\Windows\\System32\\taskkill.exe')
  })
})

describe('output', () => {
  it('strips control characters and escape sequences, keeps line breaks', () => {
    expect(cleanOutput('a\u001b[31mred\u001b[0m\u0007b\r\nc\rd\te\u202ef')).toBe('ared' + 'b\nc\nd ef')
  })
  it('keeps the last 200 lines', () => {
    const t = new OutputTail()
    for (let i = 1; i <= 500; i++) t.push(`line ${i}\n`)
    const lines = t.value().split('\n')
    expect(lines).toHaveLength(OUTPUT_MAX_LINES)
    expect(lines[0]).toBe('line 301')
    expect(lines.at(-1)).toBe('line 500')
  })
  it('caps at 64 KB, keeping the end', () => {
    const t = new OutputTail()
    t.push('x'.repeat(10) + '\n')
    for (let i = 0; i < 10; i++) t.push(`${'y'.repeat(30000)}\n`)
    t.push('THE END')
    const v = t.value()
    expect(Buffer.byteLength(v)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES)
    expect(v.endsWith('THE END')).toBe(true)
  })
  it('does not split a multi-byte character at the cap', () => {
    const t = new OutputTail()
    t.push('é'.repeat(OUTPUT_MAX_BYTES))
    const v = t.value()
    expect(v).not.toContain('\ufffd')
    expect(Buffer.byteLength(v)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES)
  })
})

describe('install', () => {
  it('runs the fixed command once, with cwd = home and a scrubbed environment', async () => {
    const { svc, calls, children } = make({
      env: { PATH: '/n/bin:/usr/bin', HOME: '/h', ORGAI_DATA_DIR: '/d', ANTHROPIC_API_KEY: 'k', npm_config_registry: 'https://r.example' }
    })
    const p = svc.install()
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('/n/bin/npm')
    expect(calls[0].args).toEqual(['install', '-g', 'orgai-cli@latest', '--ignore-scripts'])
    expect(calls[0].opts.cwd).toBe('/h')
    expect(calls[0].opts.env).toEqual({ PATH: '/n/bin:/usr/bin', HOME: '/h', npm_config_registry: 'https://r.example' })
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    children[0].stdout.emit('data', Buffer.from('added 1 package\n'))
    children[0].emit('close', 0)
    const r = await p
    expect(r).toMatchObject({ ok: true, output: 'added 1 package' })
    expect(r.hint).toBeUndefined()
  })

  it('uses the next tag for a prerelease app', async () => {
    const { svc, calls, children } = make({ appVersion: '0.1.7-dev1' })
    const p = svc.install()
    expect(calls[0].args[2]).toBe('orgai-cli@next')
    children[0].emit('close', 0)
    await p
    expect(svc.status().command).toBe('npm install -g orgai-cli@next')
  })

  it('refuses a second install while one runs', async () => {
    const { svc, calls, children } = make()
    const p = svc.install()
    expect(svc.status().installing).toBe(true)
    expect(await svc.install()).toMatchObject({ ok: false, message: 'An install is already running.' })
    expect(calls).toHaveLength(1)
    children[0].emit('close', 0)
    await p
    expect(svc.status().installing).toBe(false)
  })

  it('says where to get npm when none is on PATH, and runs nothing', async () => {
    const { svc, calls } = make({ env: { PATH: '/usr/bin' } })
    const r = await svc.install()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/could not find npm/)
    expect(r.message).toContain('npm install -g orgai-cli@latest')
    expect(calls).toHaveLength(0)
    expect(svc.status().npmFound).toBe(false)
  })

  it('EACCES shows npm output and the --prefix hint, and never elevates', async () => {
    const { svc, calls, children } = make()
    const p = svc.install()
    children[0].stderr.emit('data', 'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules\n')
    children[0].emit('close', 243)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not allowed to write/)
    expect(r.output).toContain('code EACCES')
    expect(r.hint).toBe(prefixHint('darwin', 'latest'))
    expect(r.hint).toContain('--prefix ~/.local')
    expect(calls[0].file).not.toMatch(/sudo|osascript|pkexec/)
  })

  it('the --prefix hint says to remove the old command first when it is there', async () => {
    const shim = oldShim('ours')
    const { svc, children } = make({ oldShim: shim })
    const p = svc.install()
    children[0].stderr.emit('data', 'npm error code EACCES\n')
    children[0].emit('close', 243)
    expect((await p).hint).toContain('Remove the old orgai command first')
  })

  it('a taskkill that fails to start is logged, not thrown', async () => {
    const warn = vi.fn()
    const { svc, children } = make({
      platform: 'win32',
      home: 'C:\\Users\\me',
      env: { PATH: 'C:\\Program Files\\nodejs', SystemRoot: 'C:\\Windows' },
      loginPath: 'C:\\Program Files\\nodejs',
      fs: { stat: (p) => ({ isFile: () => p === 'C:\\Program Files\\nodejs\\npm.cmd' }) },
      log: { info: () => {}, warn }
    })
    const p = svc.install()
    svc.cancel()
    // children[1] is the taskkill child: an error event must have a listener.
    expect(() => children[1].emit('error', new Error('spawn ENOENT'))).not.toThrow()
    expect(warn).toHaveBeenCalled()
    children[0].emit('close', 1)
    await p
  })

  it('another failure shows npm last line', async () => {
    const { svc, children } = make()
    const p = svc.install()
    children[0].stderr.emit('data', 'npm error code E404\nnpm error 404 Not Found - orgai-cli\n')
    children[0].emit('close', 1)
    const r = await p
    expect(r.message).toBe('npm failed (exit 1): npm error 404 Not Found - orgai-cli')
    expect(r.hint).toBeUndefined()
  })

  it('a spawn that throws or errors is a plain failure', async () => {
    const throwing = make({
      spawn: () => {
        throw new Error('spawn EACCES')
      }
    })
    expect(await throwing.svc.install()).toMatchObject({ ok: false, message: 'OrgAI could not start npm: spawn EACCES' })
    expect(throwing.svc.status().installing).toBe(false)
    const { svc, children } = make()
    const p = svc.install()
    children[0].emit('error', new Error('ENOENT'))
    expect(await p).toMatchObject({ ok: false, message: 'OrgAI could not start npm: ENOENT' })
  })

  it('cancel stops the child and reports cancelled', async () => {
    const { svc, children } = make()
    expect(svc.cancel()).toBe(false)
    const p = svc.install()
    expect(svc.cancel()).toBe(true)
    const r = await p
    expect(children[0].killed).toContain('SIGTERM')
    expect(r).toMatchObject({ ok: false, cancelled: true, message: 'Install cancelled.' })
    expect(svc.status().installing).toBe(false)
    // A new install can start afterwards.
    const q = svc.install()
    children[1].emit('close', 0)
    expect((await q).ok).toBe(true)
  })

  it('Windows runs npm.cmd through cmd.exe verbatim and kills the tree with taskkill', async () => {
    const { svc, calls, children } = make({
      platform: 'win32',
      home: 'C:\\Users\\me',
      env: { PATH: 'C:\\Program Files\\nodejs', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      loginPath: 'C:\\Program Files\\nodejs',
      fs: { stat: (p) => ({ isFile: () => p === 'C:\\Program Files\\nodejs\\npm.cmd' }) }
    })
    const p = svc.install()
    expect(calls[0].file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(calls[0].args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(calls[0].args[3]).toBe('""C:\\Program Files\\nodejs\\npm.cmd" install -g orgai-cli@latest --ignore-scripts"')
    expect(calls[0].opts.windowsVerbatimArguments).toBe(true)
    expect(svc.cancel()).toBe(true)
    expect(calls[1].file).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(win32.isAbsolute(calls[0].file) && win32.isAbsolute(calls[1].file)).toBe(true)
    expect(calls[1].args).toEqual(['/pid', '4242', '/T', '/F'])
    children[0].emit('close', 1)
    expect((await p).cancelled).toBe(true)
  })

  it('stops an install that runs too long', async () => {
    vi.useFakeTimers()
    try {
      const { svc, children } = make({ timeoutMs: 1000 })
      const p = svc.install()
      await vi.advanceTimersByTimeAsync(1001)
      expect(children[0].killed).toContain('SIGTERM')
      await vi.advanceTimersByTimeAsync(10)
      expect(await p).toMatchObject({ ok: false, message: 'npm did not finish within 1 seconds; OrgAI stopped it.' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('status classification', () => {
  const entry = (e: Partial<OrgaiOnPathEntry> & { kind: OrgaiOnPathEntry['kind'] }): OrgaiOnPathEntry => ({ path: '/x/orgai', ...e })
  const statusFor = (entries: OrgaiOnPathEntry[], shim: ReturnType<typeof oldShim> = oldShim()) => make({ findOnPath: () => entries, oldShim: shim }).svc.status()

  it('npm with its version', () => {
    expect(statusFor([entry({ kind: 'npm', version: '0.2.1' })])).toMatchObject({ state: 'npm', version: '0.2.1', path: '/x/orgai', oldShim: false, npmFound: true })
  })
  it('the old app shim or launcher', () => {
    expect(statusFor([entry({ kind: 'app-shim' })]).state).toBe('old-shim')
    expect(statusFor([entry({ kind: 'app-launcher' })]).state).toBe('old-shim')
  })
  it('another program, an archive or a dev checkout', () => {
    for (const kind of ['unknown', 'archive', 'dev'] as const) expect(statusFor([entry({ kind })]).state).toBe('other')
  })
  it('not installed when nothing is on PATH and no shim file exists', () => {
    expect(statusFor([])).toMatchObject({ state: 'not-installed', oldShim: false })
  })
  it('an old shim file off PATH still reads as the old command; behind an npm install it is only offered for removal', () => {
    expect(statusFor([], oldShim('ours'))).toMatchObject({ state: 'old-shim', oldShim: true })
    expect(statusFor([entry({ kind: 'npm', version: '1.0.0' })], oldShim('ours'))).toMatchObject({ state: 'npm', oldShim: true })
    expect(statusFor([], oldShim('foreign')).oldShim).toBe(false)
  })
  it('the first entry in PATH order wins', () => {
    expect(statusFor([entry({ kind: 'unknown', path: '/a/orgai' }), entry({ kind: 'npm', path: '/b/orgai' })])).toMatchObject({ state: 'other', path: '/a/orgai' })
  })
  it('a PATH reader that throws reads as not installed', () => {
    const { svc } = make({
      findOnPath: () => {
        throw new Error('boom')
      }
    })
    expect(svc.status().state).toBe('not-installed')
  })
})

describe('removing the old shim', () => {
  it('removes through the ownership-checked service, then re-classifies', async () => {
    const shim = oldShim('ours')
    let entries: OrgaiOnPathEntry[] = [{ path: '/s/orgai', kind: 'app-shim' }]
    const { svc } = make({ oldShim: shim, findOnPath: () => entries })
    expect(svc.status()).toMatchObject({ state: 'old-shim', oldShim: true })
    entries = [{ path: '/n/orgai', kind: 'npm', version: '0.2.0' }]
    const r = await svc.removeOldShim()
    expect(r.ok).toBe(true)
    expect(shim.removed).toBe(1)
    expect(r.status).toMatchObject({ state: 'npm', oldShim: false, path: '/n/orgai' })
  })
  it('a foreign file is refused and reported', async () => {
    const shim = oldShim('foreign')
    const r = await make({ oldShim: shim }).svc.removeOldShim()
    expect(r).toMatchObject({ ok: false, message: 'Not OrgAI.' })
  })
})

describe('status never runs a PATH candidate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orgai-hostile-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  posixOnly('a hostile orgai on PATH is read, not executed', () => {
    const bin = join(root, 'bin with space')
    mkdirSync(bin)
    const mark = join(root, 'ran')
    writeFileSync(join(bin, 'orgai'), `#!/bin/sh\ntouch "${mark}"\n`)
    chmodSync(join(bin, 'orgai'), 0o755)
    const svc = createCliInstallService({
      platform: process.platform,
      home: root,
      env: { PATH: bin },
      loginPath: bin,
      appVersion: '0.2.0',
      oldShim: oldShim(),
      log: quiet
    })
    expect(svc.status()).toMatchObject({ state: 'other', path: join(bin, 'orgai') })
    expect(existsSync(mark)).toBe(false)
  })
})
