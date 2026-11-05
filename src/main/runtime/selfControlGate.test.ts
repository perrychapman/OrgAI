import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controlProtectedPaths } from './selfControlGate'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('controlProtectedPaths', () => {
  it('lists run, secrets.json and codex, plus the runtime dir when given', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const data = join(base, 'data')
    mkdirSync(data)
    const paths = controlProtectedPaths(data)
    expect(paths).toEqual([join(data, 'run'), join(data, 'secrets.json'), join(data, 'codex')])
    const rt = join(base, 'rt')
    expect(controlProtectedPaths(data, rt)).toContain(rt)
  })

  it('carries both spellings through a dir symlink, deduped', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const real = join(base, 'real')
    mkdirSync(join(real, 'run'), { recursive: true })
    const link = join(base, 'link')
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    const paths = controlProtectedPaths(link)
    for (const p of ['run', 'secrets.json', 'codex']) {
      expect(paths).toContain(join(link, p))
      expect(paths).toContain(join(real, p))
    }
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toHaveLength(6)
  })

  it('never includes the data dir itself, quick/, project-skills/ or skills/', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-scg-')))
    dirs.push(base)
    const data = join(base, 'data')
    const paths = controlProtectedPaths(data, join(base, 'rt'))
    for (const p of [data, join(data, 'quick'), join(data, 'project-skills'), join(data, 'skills')]) expect(paths).not.toContain(p)
    for (const p of paths) expect(p.startsWith(join(data, 'quick')) || p.startsWith(join(data, 'skills')) || p.startsWith(join(data, 'project-skills'))).toBe(false)
  })
})
