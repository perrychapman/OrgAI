import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ancestryOf, checkPeerAncestry, parsePsTable, socketFdOf, socketPeersOf } from './peerCheck'

const table = new Map<number, number>([
  [1, 0],
  [100, 1], // host
  [200, 100], // claude subprocess
  [300, 200], // agent shell
  [400, 1], // user terminal
  [500, 400] // user's orgai
])
const psTable = async (): Promise<Map<number, number>> => table

describe('checkPeerAncestry', () => {
  it('a descendant of the host is refused', async () => {
    expect(await checkPeerAncestry(300, { hostPid: 100, platform: 'darwin', psTable })).toBe('descendant')
    expect(await checkPeerAncestry(200, { hostPid: 100, platform: 'linux', psTable })).toBe('descendant')
  })

  it('an unrelated process is ok, and so is the host pid itself', async () => {
    expect(await checkPeerAncestry(500, { hostPid: 100, platform: 'darwin', psTable })).toBe('ok')
    expect(await checkPeerAncestry(100, { hostPid: 100, platform: 'darwin', psTable })).toBe('ok')
  })

  it('a missing pid, a ps failure, win32 and a timeout are unavailable', async () => {
    expect(await checkPeerAncestry(999, { hostPid: 100, platform: 'darwin', psTable })).toBe('unavailable')
    expect(await checkPeerAncestry(500, { hostPid: 100, platform: 'darwin', psTable: () => Promise.reject(new Error('no ps')) })).toBe('unavailable')
    expect(await checkPeerAncestry(500, { hostPid: 100, platform: 'win32' })).toBe('unavailable')
    const slow = (): Promise<Map<number, number>> => new Promise((r) => setTimeout(() => r(table), 200))
    expect(await checkPeerAncestry(300, { hostPid: 100, platform: 'darwin', psTable: slow, timeoutMs: 20 })).toBe('unavailable')
    expect(await checkPeerAncestry(-1, { hostPid: 100, platform: 'darwin', psTable })).toBe('unavailable')
  })

  it('a cycle in the table ends after at most 64 hops', () => {
    expect(
      ancestryOf(
        new Map([
          [10, 11],
          [11, 10]
        ]),
        10,
        100
      )
    ).toBe('ok')
  })

  it('parses ps output', () => {
    expect([...parsePsTable('  1     0\n 42  1\njunk\n\n 7 42 \n').entries()]).toEqual([
      [1, 0],
      [42, 1],
      [7, 42]
    ])
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('the real ps: this process descends from its parent', async () => {
    // Token-free: one local `ps`. A generous timeout so a busy CI box does not read as unavailable too often.
    const unrelated = await checkPeerAncestry(process.pid, { hostPid: 2 ** 30, timeoutMs: 2000 })
    expect(['ok', 'unavailable']).toContain(unrelated)
    const child = await checkPeerAncestry(process.pid, { hostPid: process.ppid, timeoutMs: 2000 })
    expect(['descendant', 'unavailable']).toContain(child)
  })

  // lsof -F pfdn as seen on Darwin 25: host 100 serves fd 13 (device 0xaa..), the agent's shell 300 holds the other end.
  const lsof = ['p100', 'f12', 'd0x48d5', 'n/tmp/s/t.sock', 'f13', 'd0xAAbb', 'n/tmp/s/t.sock', 'p300', 'f12', 'd0xbb12', 'n->0xaabb', 'p500', 'f4', 'd0xcc', 'n->0x48d5'].join('\n')

  it('socketPeersOf finds the process holding the other end of the host fd', () => {
    expect(socketPeersOf(lsof, 100, 13)).toEqual([300])
    expect(socketPeersOf(lsof, 100, 99)).toEqual([])
    expect(socketPeersOf('junk', 100, 13)).toEqual([])
  })

  it('the mapped peer pid wins over the claimed pid on darwin', async () => {
    // The client claims 500 (unrelated) but the socket belongs to 300, an agent's shell: refused.
    expect(await checkPeerAncestry(500, { hostPid: 100, platform: 'darwin', psTable, socketFd: 13, lsofText: async () => lsof })).toBe('descendant')
    // A mapping that finds nothing (or fails) falls back to the claimed pid.
    expect(await checkPeerAncestry(500, { hostPid: 100, platform: 'darwin', psTable, socketFd: 99, lsofText: async () => lsof })).toBe('ok')
    expect(await checkPeerAncestry(300, { hostPid: 100, platform: 'darwin', psTable, socketFd: 13, lsofText: () => Promise.reject(new Error('no lsof')) })).toBe('descendant')
    // Linux has no mapping: the claimed pid is walked.
    expect(await checkPeerAncestry(500, { hostPid: 100, platform: 'linux', psTable, socketFd: 13, lsofText: async () => lsof })).toBe('ok')
  })

  it.runIf(process.platform === 'darwin')('the real lsof maps an accepted socket to the child process that connected', async () => {
    // Token-free: a local unix socket, one child node process and one lsof.
    const dir = mkdtempSync('/tmp/orgai-peer-')
    const path = join(dir, 's.sock')
    const after: (() => void)[] = []
    const accepted = new Promise<Socket>((resolve) => {
      const server = createServer((s) => resolve(s))
      server.listen(path)
      after.push(() => server.close())
    })
    const child = spawn(process.execPath, ['-e', `require('net').connect(${JSON.stringify(path)}); setTimeout(() => {}, 10000)`], { stdio: 'ignore' })
    try {
      const sock = await accepted
      const fd = socketFdOf(sock)
      expect(typeof fd).toBe('number')
      // The mapping itself (no timeout pressure): lsof names the child as the holder of the other end.
      const text = execFileSync('lsof', ['-nP', '-U', '-F', 'pfdn'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      expect(socketPeersOf(text, process.pid, fd!)).toEqual([child.pid])
      const asHost = await checkPeerAncestry(424242, { hostPid: process.pid, socketFd: fd!, timeoutMs: 3000 })
      // With this process as the host, the mapped peer (the child) is a descendant although the claimed pid is not.
      expect(asHost).toBe('descendant')
      sock.destroy()
    } finally {
      child.kill()
      for (const f of after) f()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
