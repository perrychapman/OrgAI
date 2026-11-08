import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOldShimService } from './shimInstaller'
import { renderCliShim } from './packagedLayout'

const quiet = { info: () => {}, warn: () => {} }
let root: string
let home: string
let shim: string
let binDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-oldshim-'))
  home = join(root, 'home')
  binDir = join(home, '.local', 'bin')
  shim = join(binDir, 'orgai')
  mkdirSync(binDir, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const svc = (over: Partial<Parameters<typeof createOldShimService>[0]> = {}) => createOldShimService({ platform: 'darwin', home, env: {}, log: quiet, ...over })
const writeShim = (): void => writeFileSync(shim, renderCliShim({ platform: 'darwin', launcher: '/Apps/OrgAI.app/Contents/Resources/bin/orgai', env: {} }), { mode: 0o755 })
const posixOnly = process.platform === 'win32' ? it.skip : it

describe('old shim cleanup', () => {
  it('classifies none, ours and foreign', () => {
    expect(svc().inspect()).toBe('none')
    writeShim()
    expect(svc().inspect()).toBe('ours')
    writeFileSync(shim, 'mine\n')
    expect(svc().inspect()).toBe('foreign')
  })

  posixOnly('a symlink, even to an OrgAI shim, and a folder are foreign', () => {
    writeFileSync(join(root, 'real'), renderCliShim({ platform: 'darwin', launcher: '/x/bin/orgai', env: {} }))
    symlinkSync(join(root, 'real'), shim)
    expect(svc().inspect()).toBe('foreign')
    expect(svc().remove().ok).toBe(false)
    expect(existsSync(join(root, 'real'))).toBe(true)
    rmSync(shim)
    mkdirSync(shim)
    expect(svc().inspect()).toBe('foreign')
  })

  it('removes only an own shim and keeps the bin folder and its other files', () => {
    expect(svc().remove()).toMatchObject({ ok: true })
    writeShim()
    writeFileSync(join(binDir, 'other'), 'x')
    const r = svc().remove()
    expect(r.ok).toBe(true)
    expect(existsSync(shim)).toBe(false)
    expect(readdirSync(binDir)).toEqual(['other'])
  })

  it('refuses a foreign file and leaves it untouched', () => {
    writeFileSync(shim, 'mine\n')
    const r = svc().remove()
    expect(r.ok).toBe(false)
    expect(readFileSync(shim, 'utf8')).toBe('mine\n')
  })

  it('re-checks ownership right before the removal: a file swapped in after the first look is kept', () => {
    writeShim()
    let reads = 0
    const s = svc({
      fs: {
        readFileSync: (p, e) => {
          const text = readFileSync(p, e)
          // The first look (inspect before removal) sees the shim; then the user's own file takes its place.
          if (++reads === 1) writeFileSync(shim, 'user file\n')
          return text
        }
      }
    })
    const r = s.remove()
    expect(r.ok).toBe(false)
    expect(readFileSync(shim, 'utf8')).toBe('user file\n')
  })

  it('reports an unlink failure instead of throwing', () => {
    writeShim()
    const s = svc({
      fs: {
        unlinkSync: () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
      }
    })
    expect(s.remove()).toMatchObject({ ok: false, message: expect.stringContaining('EPERM') })
  })
})
