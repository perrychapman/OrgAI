/**
 * hostRegistry tests. The cross-process cases run a tiny TS script through the vite-node CLI (the loader this repo
 * ships; tsx is not installed; see store/shared/testing/viteNode.ts) that imports hostRegistry.ts by absolute path,
 * claims a host and waits.
 */
import { type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LockBusyError, acquireOsLock } from '../store/shared/osLock'
import { claimHost, hostLockPath, listHosts, takeAdmission, type HostHandle, type HostInfo } from './hostRegistry'
import { killAndWait, spawnViteNode } from '../store/shared/testing/viteNode'
import { readEvidence } from './consumers'

const info = (over: Partial<HostInfo> = {}): HostInfo => ({
  pid: process.pid,
  hostKind: 'test',
  appVersion: '0.0.0',
  ownerCwd: '/tmp',
  command: 'vitest',
  startedAt: new Date().toISOString(),
  epoch: 1,
  ...over
})

let dir: string
let control: string
let handles: HostHandle[]
let children: ChildProcess[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-hostreg-'))
  control = join(dir, 'control')
  mkdirSync(control, { recursive: true })
  handles = []
  children = []
})
afterEach(async () => {
  // Wait for the children to exit first: on Windows a lock file a live child holds cannot be unlinked (EBUSY).
  await killAndWait(children)
  for (const h of handles) h.release({ clean: true })
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function claim(id: string, over: Partial<HostInfo> = {}): Promise<HostHandle> {
  const h = await claimHost({ controlDir: control, hostInstanceId: id, info: info(over) })
  handles.push(h)
  return h
}

/** Start a child process that claims a host in `control` and prints READY. */
async function childClaim(id: string): Promise<ChildProcess> {
  const script = join(dir, `child-${id}.ts`)
  writeFileSync(
    script,
    `import { claimHost } from ${JSON.stringify(resolve(__dirname, 'hostRegistry.ts'))}\n` +
      `await claimHost({ controlDir: ${JSON.stringify(control)}, hostInstanceId: ${JSON.stringify(id)}, info: { pid: process.pid, hostKind: 'child', appVersion: '0', ownerCwd: '/', command: 'child', startedAt: 'now', epoch: 1 } })\n` +
      `console.log('READY')\nsetInterval(() => {}, 1000)\n`
  )
  const c = spawnViteNode(script, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(c)
  await new Promise<void>((ok, fail) => {
    let out = ''
    const t = setTimeout(() => fail(new Error('child did not become ready: ' + out)), 20_000)
    c.stdout!.on('data', (d) => {
      out += String(d)
      if (out.includes('READY')) {
        clearTimeout(t)
        ok()
      }
    })
    c.stderr!.on('data', (d) => (out += String(d)))
    c.once('error', fail)
    c.on('exit', () => fail(new Error('child exited early: ' + out)))
  })
  return c
}

const exited = (c: ChildProcess): Promise<void> => new Promise((ok) => (c.exitCode !== null || c.signalCode ? ok() : c.once('exit', () => ok())))

describe('claimHost', () => {
  it('holds the lock and has registry and evidence on disk before it returns', async () => {
    const h = await claim('aaaaaaaaaaaa', { projectId: 'p1' })
    expect(listHosts(control).hosts[0].state).toBe('live')
    const reg = JSON.parse(readFileSync(h.registryPath, 'utf8'))
    expect(reg).toMatchObject({ hostInstanceId: 'aaaaaaaaaaaa', pid: process.pid, epoch: 1, projectId: 'p1', hostKind: 'test' })
    const ev = readEvidence(h.childrenPath)
    expect(ev).not.toBeNull()
    expect(ev!.pending).toEqual([])
    expect(ev!.descendants).toEqual([])
  })

  it('refuses a second claim of the same id and a bad id', async () => {
    await claim('bbbbbbbbbbbb')
    await expect(claim('bbbbbbbbbbbb')).rejects.toBeInstanceOf(LockBusyError)
    await expect(claim('not-an-id')).rejects.toThrow(/Invalid host instance id/)
  })

  it('clean release removes its json files and its lock file; unclean keeps them', async () => {
    const h = await claim('cccccccccccc')
    h.release({ clean: true })
    expect(existsSync(h.registryPath)).toBe(false)
    expect(existsSync(h.childrenPath)).toBe(false)
    expect(existsSync(h.lockPath)).toBe(false)
    const k = await claim('dddddddddddd')
    k.release()
    expect(existsSync(k.registryPath)).toBe(true)
    expect(existsSync(k.childrenPath)).toBe(true)
    expect(listHosts(control).hosts[0].state).toBe('dead')
    // reclaimable
    await claim('dddddddddddd')
  })
})

describe('listHosts', () => {
  it('is empty without a control folder and never writes', () => {
    const nowhere = join(dir, 'missing')
    expect(listHosts(nowhere)).toEqual({ hosts: [], unregistered: [] })
    expect(existsSync(nowhere)).toBe(false)
  })

  it('reports live then dead after kill -9 of the claiming process', async () => {
    const c = await childClaim('eeeeeeeeeeee')
    let list = listHosts(control)
    expect(list.hosts).toHaveLength(1)
    expect(list.hosts[0]).toMatchObject({ hostInstanceId: 'eeeeeeeeeeee', state: 'live' })
    expect(list.hosts[0].info?.pid).toBe(c.pid)
    c.kill('SIGKILL')
    await exited(c)
    list = listHosts(control)
    expect(list.hosts[0].state).toBe('dead')
    // the registry and evidence of a dead host remain
    expect(existsSync(list.hosts[0].childrenPath)).toBe(true)
  })

  it('reports a held host lock without a registry entry', async () => {
    mkdirSync(join(control, 'locks'), { recursive: true })
    const lock = await acquireOsLock(hostLockPath(control, 'ffffffffffff'), 'exclusive', { waitMs: 0 })
    try {
      expect(listHosts(control)).toMatchObject({ hosts: [], unregistered: ['ffffffffffff'] })
    } finally {
      lock.release()
    }
    // free and unregistered: a leftover, not a live host
    expect(listHosts(control).unregistered).toEqual([])
  })

  it('lists an unreadable registry entry with info null', async () => {
    const h = await claim('111111111111')
    writeFileSync(h.registryPath, '{not json')
    expect(listHosts(control).hosts[0]).toMatchObject({ state: 'live', info: null })
  })
})

describe('takeAdmission', () => {
  it('is shared by two holders and refuses an exclusive claim while shared is held', async () => {
    const a = await takeAdmission(control, 'shared', 100)
    const b = await takeAdmission(control, 'shared', 100)
    await expect(takeAdmission(control, 'exclusive')).rejects.toBeInstanceOf(LockBusyError)
    a.release()
    await expect(takeAdmission(control, 'exclusive')).rejects.toBeInstanceOf(LockBusyError)
    b.release()
    const x = await takeAdmission(control, 'exclusive')
    await expect(takeAdmission(control, 'shared', 50)).rejects.toBeInstanceOf(LockBusyError)
    x.release()
  })

  it('exclusive is refused while another process holds shared, and works after it is killed', async () => {
    const script = join(dir, 'adm.ts')
    writeFileSync(
      script,
      `import { takeAdmission } from ${JSON.stringify(resolve(__dirname, 'hostRegistry.ts'))}\n` +
        `await takeAdmission(${JSON.stringify(control)}, 'shared')\nconsole.log('READY')\nsetInterval(() => {}, 1000)\n`
    )
    const c = spawnViteNode(script, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(c)
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error('not ready')), 20_000)
      c.once('error', fail)
      c.once('exit', (code) => fail(new Error(`child exited early (${code})`)))
      c.stdout!.on('data', (d) => {
        if (String(d).includes('READY')) {
          clearTimeout(t)
          ok()
        }
      })
    })
    await expect(takeAdmission(control, 'exclusive')).rejects.toBeInstanceOf(LockBusyError)
    const mine = await takeAdmission(control, 'shared', 100)
    mine.release()
    c.kill('SIGKILL')
    await exited(c)
    ;(await takeAdmission(control, 'exclusive')).release()
  })
})
