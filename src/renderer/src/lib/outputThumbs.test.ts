import { describe, expect, it } from 'vitest'
import type { OutputThumb, OutputVersionRef } from '@shared/types'
import { createThumbLoader, safeImageDataUrl } from './outputThumbs'

const ref = (id: string, version = 1): OutputVersionRef => ({ projectId: 'p', outputId: id, version })

function gate() {
  const calls: { ref: OutputVersionRef; done: (t: OutputThumb | Error) => void }[] = []
  const fetch = (r: OutputVersionRef): Promise<OutputThumb> =>
    new Promise((resolve, reject) => calls.push({ ref: r, done: (t) => (t instanceof Error ? reject(t) : resolve(t)) }))
  return { calls, fetch }
}

describe('thumb loader', () => {
  it('keeps at most 3 calls in flight and starts queued ones as slots free', async () => {
    const g = gate()
    const l = createThumbLoader(g.fetch)
    const ps = ['a', 'b', 'c', 'd', 'e'].map((id) => l.load(ref(id)))
    expect(g.calls).toHaveLength(3)
    expect(l.inFlight()).toBe(3)
    g.calls[0].done({ kind: 'lines', lines: ['x'] })
    await ps[0]
    expect(g.calls).toHaveLength(4)
    expect(l.inFlight()).toBe(3)
  })

  it('caches by id and version and shares an in-flight call', async () => {
    const g = gate()
    const l = createThumbLoader(g.fetch)
    const p1 = l.load(ref('a'))
    const p2 = l.load(ref('a'))
    expect(g.calls).toHaveLength(1)
    g.calls[0].done({ kind: 'image', dataUrl: 'data:image/png;base64,AA' })
    await Promise.all([p1, p2])
    expect(l.peek(ref('a'))?.kind).toBe('image')
    await l.load(ref('a'))
    expect(g.calls).toHaveLength(1)
    void l.load(ref('a', 2))
    expect(g.calls).toHaveLength(2)
  })

  it('caches a failure as none', async () => {
    const g = gate()
    const l = createThumbLoader(g.fetch)
    const p = l.load(ref('a'))
    g.calls[0].done(new Error('boom'))
    expect((await p).kind).toBe('none')
    await l.load(ref('a'))
    expect(g.calls).toHaveLength(1)
  })

  it('cancel drops a queued request without caching', async () => {
    const g = gate()
    const l = createThumbLoader(g.fetch, 1)
    void l.load(ref('a'))
    const q = l.load(ref('b'))
    l.cancel(ref('b'))
    expect((await q).kind).toBe('none')
    expect(l.peek(ref('b'))).toBeUndefined()
    g.calls[0].done({ kind: 'none' })
    await Promise.resolve()
    expect(g.calls).toHaveLength(1)
  })

  it('evicts the oldest past the cache size', async () => {
    const l = createThumbLoader(async () => ({ kind: 'none' }), 3, 2)
    await l.load(ref('a'))
    await l.load(ref('b'))
    await l.load(ref('c'))
    expect(l.peek(ref('a'))).toBeUndefined()
    expect(l.peek(ref('c'))).toBeDefined()
  })

  it('only small raster data URLs are drawn', () => {
    expect(safeImageDataUrl('data:image/png;base64,iVBOR')).toBe(true)
    expect(safeImageDataUrl('data:image/svg+xml;base64,AA')).toBe(false)
    expect(safeImageDataUrl('javascript:alert(1)')).toBe(false)
  })
})
