import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// build/bin/orgai, the packaged sh launcher (review Low: a link loop must not hang it; LF endings pinned).
const SCRIPT = join(__dirname, '..', '..', '..', 'build', 'bin', 'orgai')
const CMD = join(__dirname, '..', '..', '..', 'build', 'bin', 'orgai.cmd')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('build/bin/orgai', () => {
  it('stops after 40 symbolic link hops instead of looping forever', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-sh-')))
    dirs.push(base)
    symlinkSync(join(base, 'b'), join(base, 'a'))
    symlinkSync(join(base, 'a'), join(base, 'b'))
    // Run the script text with $0 set to the loop (the kernel itself refuses to exec through a loop).
    const r = spawnSync('sh', ['-c', readFileSync(SCRIPT, 'utf8'), join(base, 'a')], { encoding: 'utf8', timeout: 10_000 })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('too many symbolic links')
  })

  it('follows a relative link chain to its resources folder', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-sh-')))
    dirs.push(base)
    const res = join(base, 'Contents', 'Resources')
    mkdirSync(join(res, 'bin'), { recursive: true })
    mkdirSync(join(base, 'links'))
    const real = join(res, 'bin', 'orgai')
    writeFileSync(real, readFileSync(SCRIPT))
    chmodSync(real, 0o755)
    symlinkSync(real, join(base, 'links', 'one'))
    symlinkSync('one', join(base, 'links', 'two'))
    const r = spawnSync(join(base, 'links', 'two'), [], { encoding: 'utf8', timeout: 10_000 })
    // No app beside it: the error names the app path under the resolved resources folder.
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('is missing')
    expect(r.stderr).toContain(res)
  })

  it('is stored with LF endings and the .cmd launcher with CRLF', () => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toContain('\r')
    const cmd = readFileSync(CMD, 'utf8')
    expect(cmd.split('\n').slice(0, -1).every((line) => line.endsWith('\r'))).toBe(true)
  })
})
