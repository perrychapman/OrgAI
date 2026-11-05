import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLI_RUNTIME_PACKAGES, isCliExternal } from './packaging'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const posixOnly = process.platform === 'win32' ? it.skip : it

describe('isCliExternal', () => {
  it('keeps builtins, electron, the runtime packages and their natives external', () => {
    for (const id of [
      'fs',
      'node:fs',
      'fs/promises',
      'node:fs/promises',
      'child_process',
      'node:test',
      'electron',
      '@anthropic-ai/claude-agent-sdk',
      '@anthropic-ai/claude-agent-sdk/core',
      '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
      '@openai/codex',
      '@openai/codex/package.json',
      '@openai/codex-win32-x64',
      'zod',
      'zod/v4'
    ]) {
      expect(isCliExternal(id), id).toBe(true)
    }
  })

  it('bundles everything else', () => {
    for (const id of ['ink', 'react', 'react/jsx-runtime', 'react-reconciler', 'chalk', 'signal-exit', 'yoga-layout', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'zodiac', '@openai/codexx', '@anthropic-ai/claude-agent-sdk-', './x', '', 'electron-store']) {
      expect(isCliExternal(id), id).toBe(false)
    }
  })
})

describe('electron-builder.yml', () => {
  const yml = readFileSync(join(repo, 'electron-builder.yml'), 'utf8')
  /** The list items under a top-level key (two-space `- ` lines until the next top-level key). */
  const topList = (key: string): string[] => {
    const lines = yml.split(/\r?\n/)
    const start = lines.findIndex((l) => l === `${key}:`)
    expect(start, key).toBeGreaterThanOrEqual(0)
    const out: string[] = []
    for (const l of lines.slice(start + 1)) {
      if (/^\S/.test(l)) break
      const m = /^ {2}- (.+)$/.exec(l)
      if (m) out.push(m[1].trim())
    }
    return out
  }
  /** `from -> to` pairs of extraResources under a platform section. */
  const extraResources = (platform: string): string[] => {
    const lines = yml.split(/\r?\n/)
    const start = lines.findIndex((l) => l === `${platform}:`)
    expect(start, platform).toBeGreaterThanOrEqual(0)
    const out: string[] = []
    let inside = false
    for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
      const l = lines[i]
      if (l === '  extraResources:') inside = true
      else if (/^ {2}\S/.test(l)) inside = false
      else if (inside) {
        const from = /^ {4}- from: (.+)$/.exec(l)
        const to = /^ {6}to: (.+)$/.exec(lines[i + 1] ?? '')
        if (from && to) out.push(`${from[1].trim()} -> ${to[1].trim()}`)
      }
    }
    return out
  }

  it('unpacks out/cli and every CLI runtime package (and keeps the native entries)', () => {
    const unpack = topList('asarUnpack')
    expect(unpack).toContain('out/cli/**')
    for (const p of CLI_RUNTIME_PACKAGES) expect(unpack, p).toContain(`node_modules/${p}/**`)
    expect(unpack).toContain('node_modules/@anthropic-ai/claude-agent-sdk-*/**')
    expect(unpack).toContain('node_modules/@openai/codex-*/**')
  })

  it('copies the launchers to Resources/bin per platform', () => {
    expect(extraResources('mac')).toEqual(['build/bin/orgai -> bin/orgai'])
    expect(extraResources('linux')).toEqual(['build/bin/orgai -> bin/orgai'])
    expect(extraResources('win')).toEqual(['build/bin/orgai.cmd -> bin/orgai.cmd'])
  })

  it('adds no publish, signing identity or fuse settings', () => {
    expect(yml).not.toMatch(/^publish:/m)
    expect(yml).not.toMatch(/^\s*electronFuses:/m)
    expect(yml).not.toMatch(/^\s*identity:\s*\S/m)
  })
})

describe('build/bin launchers', () => {
  const sh = join(repo, 'build', 'bin', 'orgai')
  const cmd = join(repo, 'build', 'bin', 'orgai.cmd')

  it('orgai is a POSIX sh script running the app binary as Node on the unpacked bundle', () => {
    const text = readFileSync(sh, 'utf8')
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).not.toContain('\r')
    expect(text).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(text).toContain('app.asar.unpacked/out/cli/orgai.mjs')
    expect(text).toContain('MacOS/OrgAI')
    if (process.platform !== 'win32') expect(statSync(sh).mode & 0o111).toBe(0o111)
  })

  it('orgai.cmd has CRLF endings, runs OrgAI.exe and passes every argument', () => {
    const text = readFileSync(cmd, 'utf8')
    expect(text.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true)
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text).toContain('OrgAI.exe')
    expect(text).toContain('%*')
    expect(text).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(text).toContain('app.asar.unpacked\\out\\cli\\orgai.mjs')
  })

  posixOnly('runs through a fake packaged layout: links are followed, arguments pass through intact', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-launcher-')))
    try {
      const contents = join(base, 'Apps', 'OrgAI.app', 'Contents')
      const res = join(contents, 'Resources')
      mkdirSync(join(res, 'bin'), { recursive: true })
      mkdirSync(join(res, 'app.asar.unpacked', 'out', 'cli'), { recursive: true })
      mkdirSync(join(contents, 'MacOS'), { recursive: true })
      writeFileSync(join(res, 'app.asar.unpacked', 'out', 'cli', 'orgai.mjs'), '')
      const fakeApp = '#!/bin/sh\necho "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "ARG=$a"; done\n'
      // Darwin uses <res>/../MacOS/OrgAI, everything else <res>/../orgai.
      for (const bin of [join(contents, 'MacOS', 'OrgAI'), join(contents, 'orgai')]) {
        writeFileSync(bin, fakeApp)
        chmodSync(bin, 0o755)
      }
      copyFileSync(sh, join(res, 'bin', 'orgai'))
      chmodSync(join(res, 'bin', 'orgai'), 0o755)
      // ~/.local/bin/orgai -> a relative link -> the launcher.
      mkdirSync(join(base, 'home', '.local', 'bin'), { recursive: true })
      mkdirSync(join(base, 'links'))
      symlinkSync(join(res, 'bin', 'orgai'), join(base, 'links', 'absolute'))
      symlinkSync('../../../links/absolute', join(base, 'home', '.local', 'bin', 'orgai'))
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
      const out = execFileSync(join(base, 'home', '.local', 'bin', 'orgai'), ['runs list', "it's", '--json', ''], { env, encoding: 'utf8' })
      const lines = out.trimEnd().split('\n')
      expect(lines[0]).toBe('RUN_AS_NODE=1')
      expect(lines[1]).toBe(`ARG=${join(res, 'app.asar.unpacked', 'out', 'cli', 'orgai.mjs')}`)
      expect(lines.slice(2)).toEqual(['ARG=runs list', "ARG=it's", 'ARG=--json', 'ARG='])

      // A missing bundle is a clear error, exit 1.
      rmSync(join(res, 'app.asar.unpacked'), { recursive: true })
      let failure: { status?: number; stderr?: string } = {}
      try {
        execFileSync(join(res, 'bin', 'orgai'), ['--version'], { env, encoding: 'utf8', stdio: 'pipe' })
      } catch (e) {
        failure = e as typeof failure
      }
      expect(failure.status).toBe(1)
      expect(String(failure.stderr)).toContain('bundle is missing')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('the built CLI bundle (out/cli)', () => {
  const outCli = join(repo, 'out', 'cli')
  const built = existsSync(join(outCli, 'orgai.mjs'))

  /** Bare specifiers of top-level static imports / re-exports, dynamic imports and `__require` calls. */
  const bareImports = (text: string): string[] => {
    const out = new Set<string>()
    for (const m of text.matchAll(/^(?:import|export)\s[^;'"]*?from\s*"([^"]+)";?$/gm)) out.add(m[1])
    for (const m of text.matchAll(/^import\s*"([^"]+)";?$/gm)) out.add(m[1])
    for (const m of text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) out.add(m[1])
    for (const m of text.matchAll(/\b__require\(\s*"([^"]+)"\s*\)/g)) out.add(m[1])
    return [...out].filter((s) => !s.startsWith('.') && !s.startsWith('/'))
  }

  it.skipIf(!built)('every bare import passes isCliExternal', () => {
    const files = readdirSync(outCli).filter((f) => f.endsWith('.mjs'))
    expect(files).toContain('orgai.mjs')
    expect(files).toContain('tui.mjs')
    expect(files).toContain('inprocHost.mjs')
    const bad: string[] = []
    for (const f of files) for (const spec of bareImports(readFileSync(join(outCli, f), 'utf8'))) if (!isCliExternal(spec)) bad.push(`${f}: ${spec}`)
    expect(bad).toEqual([])
  })

  it('the import scanner reads the bundler output forms', () => {
    const sample = [
      'import { a as b } from "node:fs";',
      'import * as fs$1 from "node:fs";',
      'import "./side.mjs";',
      'export { x } from "./k.mjs";',
      'const t = await import("./tui.mjs");',
      'var EE = __require("events");',
      'const s = `from "${name}"`;',
      'import { render } from "ink";'
    ].join('\n')
    expect(bareImports(sample).sort()).toEqual(['events', 'ink', 'node:fs'])
  })
})
