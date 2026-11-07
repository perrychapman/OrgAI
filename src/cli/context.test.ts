import { describe, expect, it } from 'vitest'
import { buildContext, reusableInproc } from './context'
import { fakeInproc } from './testing/fakeContext'
import type { InprocStartOptions } from './types'

describe('reusableInproc', () => {
  it('shares one start while the host runs, starts a new one after it closed, and forgets a failed start', async () => {
    const handles = [fakeInproc(), fakeInproc(), fakeInproc()]
    const opts: (InprocStartOptions | undefined)[] = []
    let fail = false
    let next = 0
    const start = reusableInproc(async (o) => {
      opts.push(o)
      if (fail) throw new Error('owned by another host')
      return handles[next++]
    })
    const a = start({ background: { modelDiscovery: false } })
    const b = start()
    expect(await a).toBe(await b)
    expect(opts).toEqual([{ background: { modelDiscovery: false } }])
    // withHost stopped it (init's first step); the Architect's ensureHost gets a fresh host.
    await (await a).stop(true)
    const c = await start()
    expect(c).toBe(handles[1])
    expect(opts).toEqual([{ background: { modelDiscovery: false } }, {}])
    await c.stop(true)
    fail = true
    await expect(start()).rejects.toThrow('owned by another host')
    fail = false
    expect(await start()).toBe(handles[2])
  })
})

describe('buildContext', () => {
  it('carries the environment secret facts for ensureHost, only when given', () => {
    const base = {
      globals: { host: 'auto' as const, outputFormat: 'text' as const, color: false, secretEnv: [] },
      env: { ORGAI_DATA_DIR: '/tmp/orgai-ctx-test' },
      cwd: '/tmp',
      platform: 'linux' as const,
      io: { stdout: { write: () => true }, stderr: { write: () => true }, stdinIsTTY: false }
    }
    expect(buildContext(base).secretEnv).toBeUndefined()
    const use = { explicit: false, ambient: true, usesSecrets: true }
    expect(buildContext({ ...base, secretEnv: use }).secretEnv).toEqual(use)
  })
})
