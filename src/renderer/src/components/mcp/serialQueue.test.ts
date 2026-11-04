import { describe, expect, it } from 'vitest'
import { createSerialQueue } from './serialQueue'
import { nextOverrides } from './mcpHelpers'

describe('createSerialQueue', () => {
  it('runs one task at a time, in order, and keeps going after a failure', async () => {
    const q = createSerialQueue()
    const log: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const a = q.enqueue(async () => {
      log.push('a start')
      await gate
      log.push('a end')
    })
    const b = q.enqueue(async () => {
      log.push('b')
      throw new Error('nope')
    })
    const c = q.enqueue(async () => {
      log.push('c')
      return 3
    })
    await Promise.resolve()
    expect(log).toEqual(['a start'])
    expect(q.busy()).toBe(true)
    release()
    await a
    await expect(b).rejects.toThrow('nope')
    expect(await c).toBe(3)
    expect(log).toEqual(['a start', 'a end', 'b', 'c'])
    await Promise.resolve()
    await Promise.resolve()
    expect(q.busy()).toBe(false)
  })

  it('keeps both values when two saves are queued, each map built from the last confirmed one', async () => {
    const q = createSerialQueue()
    let confirmed: Record<string, string> = {}
    const sent: Array<Record<string, string>> = []
    const save = (name: string, value: string): Promise<void> =>
      q.enqueue(async () => {
        const map = nextOverrides(confirmed, name, value)
        sent.push(map)
        await Promise.resolve()
        confirmed = map
      })
    await Promise.all([save('A', '1'), save('B', '2')])
    expect(sent).toEqual([{ A: '1' }, { A: '1', B: '2' }])
  })
})
