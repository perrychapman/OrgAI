/**
 * Two real processes start the in-process host on one folder at the same moment (cli-standalone-default.md 4.2): exactly
 * one owns it, the other is refused at once with exit 6, and the loser writes nothing into the owner's logs.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT } from './types'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const viteNode = join(root, 'node_modules', 'vite-node', 'vite-node.mjs')

interface Child {
  proc: ChildProcess
  line: Promise<{ owned: boolean; exitCode?: number; ms?: number; message?: string }>
  exited: Promise<number | null>
}

const children: ChildProcess[] = []
let dir = ''

function spawnChild(userDataDir: string, goFile: string): Child {
  const proc = spawn(process.execPath, [viteNode, '-c', join(root, 'vitest.config.ts'), join(here, 'inprocHostRace.child.ts'), userDataDir, goFile], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1', ORGAI_VAULT_NO_OS_KEYSTORE: '1' }
  })
  children.push(proc)
  let out = ''
  let err = ''
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()))
  const line = new Promise<Awaited<Child['line']>>((resolve, reject) => {
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /^(\{.*\})$/m.exec(out)
      if (m) resolve(JSON.parse(m[1]!))
    })
    proc.once('exit', () => reject(new Error(`child ended without a result: ${out} ${err}`)))
  })
  line.catch(() => undefined)
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)))
  return { proc, line, exited }
}

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('two orgai processes starting at once', () => {
  it('exactly one owns the folder, the other exits 6 at once and leaves the owner main.log alone', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'inp-race-')))
    const goFile = join(dir, 'go')
    const userDataDir = join(dir, 'cli')
    const a = spawnChild(userDataDir, goFile)
    const b = spawnChild(userDataDir, goFile)
    // Both are loaded and polling: let them go together.
    await new Promise((r) => setTimeout(r, 4000))
    writeFileSync(goFile, 'go')
    const [ra, rb] = await Promise.all([a.line, b.line])
    const owners = [ra, rb].filter((r) => r.owned)
    const refused = [ra, rb].filter((r) => !r.owned)
    expect(owners).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.exitCode).toBe(EXIT.hostBusy)
    expect(EXIT.hostBusy).toBe(6)
    // "At once": a refusal, not a wait for the owner (which stays up) to finish.
    expect(refused[0]!.ms!).toBeLessThan(15_000)
    const loser = ra.owned ? b : a
    expect(await loser.exited).toBe(EXIT.hostBusy)
    // One session started in main.log: the refused process never installed logging or rotated the file.
    const log = join(userDataDir, 'logs', 'main.log')
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log, 'utf8').match(/starting \(/g) ?? []).toHaveLength(1)
    expect(existsSync(join(userDataDir, 'logs', 'main.1.log'))).toBe(false)
    const winner = ra.owned ? a : b
    winner.proc.stdin!.end()
    expect(await winner.exited).toBe(0)
  }, 60_000)
})
