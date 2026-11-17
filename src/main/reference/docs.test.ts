import { describe, expect, it } from 'vitest'
import { bundledDocs, loadBundledDocs } from './docs'

describe('bundled docs load lazily', () => {
  it('refuses a sync read before the load and serves the same map after it', async () => {
    expect(() => bundledDocs()).toThrow(/loadBundledDocs/)
    const docs = await loadBundledDocs()
    expect(Object.keys(docs)).toContain('README')
    expect(bundledDocs()).toBe(docs)
    expect(await loadBundledDocs()).toBe(docs)
  })
})
