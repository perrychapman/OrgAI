import { describe, expect, it } from 'vitest'
import { CHANNEL_JSON_FIELDS, decodeRequest, encodeRequest, parseJsonSafe, PUSH_CHANNELS, requestChannels, stringifyJson } from './jsonCodec'

/** Build an object that has an own property at `path` (dot segments, '[]' = a one-element array) set to `leaf`. */
function withLeaf(path: string, leaf: unknown): unknown {
  if (path === '') return leaf
  const [head, ...rest] = path.split('.')
  const inner = withLeaf(rest.join('.'), leaf)
  if (head === '[]') return [inner]
  return { [head]: inner, keep: 'x' }
}

/** Walk to the parent of the leaf at `path` and report whether the leaf is an own property and its value. */
function leafAt(value: unknown, path: string): { own: boolean; value: unknown } {
  const segs = path.split('.')
  let cur: unknown = value
  for (let i = 0; i < segs.length - 1; i++) cur = segs[i] === '[]' ? (cur as unknown[])[0] : (cur as Record<string, unknown>)[segs[i]]
  const last = segs[segs.length - 1]
  const obj = cur as Record<string, unknown>
  return { own: Object.hasOwn(obj, last), value: obj[last] }
}

describe('parseJsonSafe', () => {
  it('strips __proto__, constructor and prototype at every depth without polluting prototypes', () => {
    const parsed = parseJsonSafe('{"a":{"__proto__":{"polluted":1},"b":[{"constructor":{"prototype":{"x":1}},"ok":2}]},"prototype":3}') as Record<
      string,
      unknown
    >
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined()
    const a = parsed.a as Record<string, unknown>
    expect(Object.hasOwn(a, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype)
    expect((a as { polluted?: unknown }).polluted).toBeUndefined()
    const b0 = (a.b as Record<string, unknown>[])[0]
    expect(Object.hasOwn(b0, 'constructor')).toBe(false)
    expect(b0.ok).toBe(2)
    expect(Object.hasOwn(parsed, 'prototype')).toBe(false)
  })

  it('the exact spec case leaves ({}).polluted undefined', () => {
    const parsed = parseJsonSafe('{"a":{"__proto__":{"polluted":1}}}') as { a: object }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.hasOwn(parsed.a, '__proto__')).toBe(false)
    expect(Object.keys(parsed.a)).toEqual([])
  })

  it('parses ordinary JSON unchanged and rejects malformed JSON', () => {
    expect(parseJsonSafe('{"x":[1,null,"s"],"y":{"z":true}}')).toEqual({ x: [1, null, 's'], y: { z: true } })
    expect(() => parseJsonSafe('{')).toThrow()
  })
})

describe('stringifyJson', () => {
  it('throws on a bigint', () => {
    expect(() => stringifyJson({ a: { n: 10n } })).toThrow(/bigint.*a\.n/)
  })
  it('throws on a circular structure', () => {
    const o: Record<string, unknown> = { a: 1 }
    o.self = { back: o }
    expect(() => stringifyJson(o)).toThrow(/circular/)
  })
  it('throws on a function', () => {
    expect(() => stringifyJson({ f: () => 1 })).toThrow(/function/)
  })
  it('allows shared (non-circular) references and plain values', () => {
    const shared = { v: 1 }
    expect(stringifyJson({ a: shared, b: [shared] })).toBe('{"a":{"v":1},"b":[{"v":1}]}')
    expect(stringifyJson(null)).toBe('null')
  })
})

describe('channel tables', () => {
  it('has an entry for every request channel and none for push channels', () => {
    const keys = new Set(Object.keys(CHANNEL_JSON_FIELDS))
    for (const ch of requestChannels()) expect(keys.has(ch), ch).toBe(true)
    for (const ch of PUSH_CHANNELS) expect(keys.has(ch), ch).toBe(false)
  })
  it('never lists one path as both nullable and clearable', () => {
    for (const [ch, f] of Object.entries(CHANNEL_JSON_FIELDS)) {
      const clear = new Set(f.clearable ?? [])
      for (const p of f.nullable ?? []) expect(clear.has(p), `${ch} ${p}`).toBe(false)
    }
  })
})

describe('encodeRequest / decodeRequest', () => {
  const clearables = Object.entries(CHANNEL_JSON_FIELDS).flatMap(([ch, f]) => (f.clearable ?? []).map((p) => [ch, p] as const))

  it('has clearable paths to check', () => {
    expect(clearables.length).toBeGreaterThan(10)
  })

  it.each(clearables)('%s %s: an own undefined survives JSON as an own undefined', (channel, path) => {
    const args = [withLeaf(path, undefined)]
    const wire = JSON.parse(JSON.stringify(encodeRequest(channel, args))) as unknown[]
    expect(leafAt(wire[0], path)).toEqual({ own: true, value: null })
    const back = decodeRequest(channel, wire)
    expect(leafAt(back[0], path)).toEqual({ own: true, value: undefined })
    expect(back).toEqual(args)
  })

  it('leaves a missing clearable field missing', () => {
    const back = decodeRequest('settings:set', JSON.parse(JSON.stringify(encodeRequest('settings:set', [{ notifications: true }]))) as unknown[])
    expect(back).toEqual([{ notifications: true }])
    expect(Object.hasOwn(back[0] as object, 'defaultMaxBudgetUsd')).toBe(false)
  })

  it('keeps literal null on nullable paths both ways', () => {
    const cases: [string, unknown[]][] = [
      ['connections:setDefault', [null]],
      ['connections:setSecret', [{ id: 'litellm', apiKey: null }]],
      ['connections:removeProxy', ['proxy-0a1b2c3d']],
      ['connectors:setToken', [{ connectorId: 'github', token: null }]],
      ['mcp:setSecret', [{ projectId: 'p', serverId: 's', kind: 'env', name: 'K', value: null }]],
      ['mcpLibrary:setSecret', [{ libraryId: 'l', kind: 'header', name: 'H', value: null }]]
    ]
    for (const [ch, args] of cases) {
      const wire = JSON.parse(JSON.stringify(encodeRequest(ch, args))) as unknown[]
      expect(wire, ch).toEqual(args)
      expect(decodeRequest(ch, wire), ch).toEqual(args)
      expect(JSON.stringify(decodeRequest(ch, wire)), ch).toBe(JSON.stringify(args))
    }
  })

  it('keeps a Role.reportsTo null inside projects:save', () => {
    const args = [{ id: 'p', roles: [{ id: 'r', reportsTo: null }], maxBudgetUsd: undefined }]
    const back = decodeRequest('projects:save', JSON.parse(JSON.stringify(encodeRequest('projects:save', args))) as unknown[])
    expect((back[0] as { roles: { reportsTo: unknown }[] }).roles[0].reportsTo).toBeNull()
    expect(Object.hasOwn(back[0] as object, 'maxBudgetUsd')).toBe(true)
  })

  it('does not mutate its input', () => {
    const inner = { top: undefined, deep: 'm' }
    const arg = { id: 'litellm', openaiBaseUrl: undefined, tierModels: inner }
    const args = [arg]
    const snapshot = JSON.stringify(args)
    const out = encodeRequest('connections:update', args)
    expect(out).not.toBe(args)
    expect(args[0]).toBe(arg)
    expect(arg.openaiBaseUrl).toBeUndefined()
    expect(Object.hasOwn(arg, 'openaiBaseUrl')).toBe(true)
    expect(inner.top).toBeUndefined()
    expect(JSON.stringify(args)).toBe(snapshot)
    expect((out[0] as { openaiBaseUrl: unknown }).openaiBaseUrl).toBeNull()

    const wire = [{ id: 'litellm', openaiBaseUrl: null }]
    decodeRequest('connections:update', wire)
    expect(wire[0].openaiBaseUrl).toBeNull()
  })

  it('leaves other nulls alone on decode', () => {
    expect(decodeRequest('settings:set', [{ defaultKeepRuns: null }])).toEqual([{ defaultKeepRuns: null }])
  })

  it('throws code unknown_channel for an unknown channel', () => {
    let caught: unknown
    try {
      decodeRequest('nope:nothing', [])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('unknown_channel')
    expect(() => encodeRequest('runs:event', [])).toThrow(/Unknown channel/)
    expect(() => decodeRequest('__proto__', [])).toThrow(/Unknown channel/)
  })
})
