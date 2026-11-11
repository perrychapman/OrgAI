import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isCliExternal } from './packaging'

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
  const yml = readFileSync(join(repo, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
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

  it('unpacks every runtime package the desktop loads (and keeps the native entries), but not out/cli', () => {
    const unpack = topList('asarUnpack')
    expect(unpack).not.toContain('out/cli/**')
    // The desktop's own list (scripts/verify-pack.mjs DESKTOP_UNPACKED_PACKAGES says the same), not the npm bundle's.
    for (const p of ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'zod']) expect(unpack, p).toContain(`node_modules/${p}/**`)
    expect(unpack).toContain('node_modules/@anthropic-ai/claude-agent-sdk-*/**')
    expect(unpack).toContain('node_modules/@openai/codex-*/**')
  })

  it('keeps the CLI out of the package: files exclude out/cli, no orgai launcher is copied', () => {
    expect(topList('files')).toContain("'!out/cli/**'")
    for (const platform of ['mac', 'linux', 'win']) expect(extraResources(platform), platform).toEqual([])
    expect(yml).not.toMatch(/build\/bin/)
    expect(existsSync(join(repo, 'build', 'bin'))).toBe(false)
  })

  it('disables Electron inspector CLI arguments while retaining RunAsNode for system certificate lookup', () => {
    expect(yml).toMatch(/^electronFuses:\n  enableNodeCliInspectArguments: false\n  # systemCerts\.ts starts this executable with ELECTRON_RUN_AS_NODE=1 to read the system trust store\.\n  runAsNode: true$/m)
  })

  it('adds no publish or signing identity', () => {
    expect(yml).not.toMatch(/^publish:/m)
    expect(yml).not.toMatch(/^\s*identity:\s*\S/m)
  })
})

describe('hardened CLI launch', () => {
  it('generates a Node shebang with SIGUSR1 inspector disabled and hardens the npm script', () => {
    const viteConfig = readFileSync(join(repo, 'vite.cli.config.ts'), 'utf8')
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string>; engines: { node: string } }
    const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as { packages: { '': { engines: { node: string } } } }
    expect(viteConfig).toContain('#!/usr/bin/env -S node --disable-sigusr1')
    expect(pkg.scripts.cli).toBe('node --disable-sigusr1 out/cli/orgai.mjs')
    expect(pkg.engines.node).toBe('>=22.19.0 <23 || >=24.5.0')
    expect(lock.packages[''].engines.node).toBe(pkg.engines.node)
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

  it.skipIf(!built)('refuses direct Node invocation without the flag and runs with the protected runtime', () => {
    const cli = join(outCli, 'orgai.mjs')
    expect(readFileSync(cli, 'utf8').split(/\r?\n/, 1)[0]).toBe('#!/usr/bin/env -S node --disable-sigusr1')
    const env = { ...process.env, NODE_OPTIONS: '' }
    const blocked = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env })
    expect(blocked.status).toBe(1)
    expect(blocked.stderr).toContain('refusing to start without Node.js --disable-sigusr1')

    const protectedRun = spawnSync(process.execPath, ['--disable-sigusr1', cli, '--version'], { encoding: 'utf8', env })
    expect(protectedRun.status).toBe(0)
    expect(protectedRun.stdout).toContain('channel dev')

    if (process.platform !== 'win32') {
      const shebangRun = spawnSync(cli, ['--version'], { encoding: 'utf8', env })
      expect(shebangRun.status).toBe(0)
      expect(shebangRun.stdout).toContain('channel dev')
    }
  })
})
