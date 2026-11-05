import { describe, expect, it } from 'vitest'
import { ancestryOf, checkPeerAncestry, parsePsTable } from './peerCheck'

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
})
