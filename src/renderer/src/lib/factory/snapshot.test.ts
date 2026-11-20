import { describe, expect, it } from 'vitest'
import { factoryTestState, motionState, p95, redactCursor } from './snapshot'
import type { FloorModel, WorkerModel } from './types'

function worker(id: string, extra: Partial<WorkerModel> = {}): WorkerModel {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'bench',
    statusWord: 'Running',
    activity: 'secret activity text',
    lamp: 'running',
    pose: 'console',
    ambient: 'screen',
    shutter: false,
    barrier: false,
    fenced: false,
    stepIds: [],
    ...extra
  }
}

const model: FloorModel = {
  mode: 'live',
  layout: {
    stations: {
      root: { id: 'root', kind: 'booth', variant: 0, line: 0, row: -1, slot: 0, center: { x: 7, z: -6 } },
      a: { id: 'a', kind: 'lead', variant: 1, line: 1, row: 0, slot: 0, center: { x: 6, z: 1.5 } },
      b: { id: 'b', kind: 'bench', variant: 2, line: 1, row: 0, slot: 1, center: { x: 10.004, z: 1.5 } }
    },
    order: ['root', 'a', 'b', 'gone'],
    lines: [{ number: 1, leadId: 'root', rows: [0], count: 2 }],
    vacant: [{ id: 'c', line: 1, row: 0, slot: 2, center: { x: 14, z: 1.5 } }],
    routes: [],
    rows: 1,
    hall: { minX: 0, maxX: 30, minZ: -10, maxZ: 8 },
    content: { minX: 4, maxX: 28, minZ: -10, maxZ: 3 },
    booth: { x: 7, z: -6 },
    dock: { x: 17, z: -6 },
    board: { x: 25, z: -9.5 }
  },
  workers: {
    root: worker('root', { kind: 'booth' }),
    a: worker('a', { kind: 'lead', fenced: true, crate: { at: 'pad', lamp: 'off' } }),
    b: worker('b', { lamp: 'failed', pose: 'down', statusWord: 'Failed', ambient: 'none' })
  },
  hall: 'on',
  dockCrates: 0,
  earlier: []
}

describe('factoryTestState', () => {
  it('fills what slice 1 knows with empty model fields', () => {
    const s = factoryTestState({
      renderer: 'floor-plan',
      reason: 'forced',
      quality: 'high',
      mode: 'team',
      motion: 'reduced',
      loop: 'stopped',
      frames: 0,
      engines: 0
    })
    expect(s).toEqual({
      renderer: 'floor-plan',
      reason: 'forced',
      quality: 'high',
      qualityStart: 'high',
      mode: 'team',
      motion: 'reduced',
      workers: [],
      hall: 'on',
      board: null,
      dockCrates: 0,
      earlier: 0,
      lines: [],
      vacant: 0,
      cues: [],
      cuesStarted: 0,
      recentCues: [],
      cuePeaks: { carriers: 0, perSender: 0, parts: 0, crates: 0, arrivalsPerSecond: 0, ambient: 0 },
      logEntries: 0,
      messageCursor: null,
      view: { ppm: 0, targetX: 0, targetZ: 0 },
      loop: 'stopped',
      frames: 0,
      engines: 0
    })
    expect('perf' in s).toBe(false)
  })

  it('lists workers in reading order with rounded coordinates and no text', () => {
    const s = factoryTestState({ renderer: 'webgl2', quality: 'high', mode: 'live', motion: 'full', model, loop: 'idle', frames: 3, engines: 1 })
    expect(s.workers.map((w) => w.id)).toEqual(['root', 'a', 'b'])
    expect(s.workers[2]).toEqual({ id: 'b', line: 1, row: 0, slot: 1, x: 10, z: 1.5, lamp: 'failed', pose: 'down', statusWord: 'Failed', fenced: false, ambient: 'none', shutter: false, barrier: false, stepIds: [] })
    expect(s.workers[1].crate).toBe('pad')
    expect(s.lines).toEqual([{ number: 1, leadId: 'root', rows: [0] }])
    expect(s.vacant).toBe(1)
    expect(JSON.stringify(s)).not.toContain('secret activity text')
    expect(s.reason).toBeUndefined()
  })

  it('without a model, lists the layout with summaries (slice 2: pose rest, ambient none)', () => {
    const s = factoryTestState({
      renderer: 'floor-plan', quality: 'high', mode: 'live', motion: 'full', loop: 'stopped', frames: 0, engines: 0,
      layout: model.layout,
      summaries: { root: { lamp: 'running', statusWord: 'Running' }, a: { lamp: 'needs-you', statusWord: 'Needs you' } }
    })
    expect(s.workers).toEqual([
      { id: 'root', line: 0, row: -1, slot: 0, x: 7, z: -6, lamp: 'running', pose: 'rest', statusWord: 'Running', fenced: false, ambient: 'none', shutter: false, barrier: false, stepIds: [] },
      { id: 'a', line: 1, row: 0, slot: 0, x: 6, z: 1.5, lamp: 'needs-you', pose: 'rest', statusWord: 'Needs you', fenced: false, ambient: 'none', shutter: false, barrier: false, stepIds: [] }
    ])
    expect(s.lines).toEqual([{ number: 1, leadId: 'root', rows: [0] }])
    expect(s.vacant).toBe(1)
  })

  it('rounds view and perf numbers and keeps the GPU string when known', () => {
    const s = factoryTestState({
      renderer: 'webgl2',
      quality: 'minimal',
      mode: 'live',
      motion: 'paused',
      view: { ppm: 19.6666, targetX: 15.004, targetZ: -4.0049 },
      loop: 'running',
      frames: 1,
      engines: 1,
      perf: { drawCalls: 5, shadowCalls: 4, triangles: 120, geometries: 4, textures: 1, frameP95Ms: 1.23456, intervalP95Ms: 0, firstFrameMs: 88.888, gpu: 'ANGLE (Test GPU)', memoryBytes: 16_777_216, pixelRatio: 1.5 },
      cues: [{ id: 'c1', kind: 'capsule', from: 'a', to: null, start: 0, duration: 500, progress: 0.5, opacity: 1 }],
      cuesStarted: 2,
      messageCursor: '1|a|b|hi'
    })
    expect(s.view).toEqual({ ppm: 19.67, targetX: 15, targetZ: -4 })
    expect(s.perf).toEqual({ drawCalls: 5, shadowCalls: 4, triangles: 120, geometries: 4, textures: 1, frameP95Ms: 1.23, intervalP95Ms: 0, firstFrameMs: 88.89, gpu: 'ANGLE (Test GPU)', memoryBytes: 16_777_216, pixelRatio: 1.5 })
    expect(s.qualityStart).toBe('minimal')
    expect(s.cues).toEqual([{ kind: 'capsule', from: 'a', to: null }])
    expect(s.cuesStarted).toBe(2)
    // The cursor keeps time and ids; the message text is replaced by a hash.
    expect(s.messageCursor).toMatch(/^1\|a\|b\|#[0-9a-f]{8}$/)
    expect(s.messageCursor).not.toContain('hi')
  })

  it('omits an unknown GPU string', () => {
    const s = factoryTestState({
      renderer: 'webgl2', quality: 'high', mode: 'live', motion: 'full', loop: 'idle', frames: 1, engines: 1,
      perf: { drawCalls: 1, shadowCalls: 0, triangles: 2, geometries: 1, textures: 0, frameP95Ms: 0, intervalP95Ms: 0, firstFrameMs: 0, memoryBytes: 0, pixelRatio: 1 }
    })
    expect(s.perf && 'gpu' in s.perf).toBe(false)
  })
})

describe('redactCursor', () => {
  it('keeps time and ids, hashes the text, and changes when the text does', () => {
    expect(redactCursor(null)).toBeNull()
    const a = redactCursor('17|lead|w1|Please run the tests now')
    expect(a).toMatch(/^17\|lead\|w1\|#[0-9a-f]{8}$/)
    expect(redactCursor('17|lead|w1|Please run the tests now')).toBe(a)
    expect(redactCursor('17|lead|w1|Please run the tests later')).not.toBe(a)
    // A text with its own bars, a missing recipient and a malformed cursor.
    expect(redactCursor('5|a||x|y|z')).toMatch(/^5\|a\|\|#[0-9a-f]{8}$/)
    expect(redactCursor('garbage')).toMatch(/^#[0-9a-f]{8}$/)
  })
})

describe('the test state carries no agent text (guard)', () => {
  // Every free-text field an agent or a user can fill, each with a marker that must never reach the test state.
  const MARK = 'zqxj'
  const textModel: FloorModel = {
    ...model,
    workers: {
      root: worker('root', { kind: 'booth', name: `${MARK} root name`, activity: `${MARK} root activity` }),
      a: worker('a', { kind: 'lead', name: `${MARK} lead name`, activity: `${MARK} reading C:\\secret\\${MARK}.txt`, stepIds: ['p1'] }),
      b: worker('b', { name: `${MARK} bench name`, activity: `${MARK} $ rm -rf ${MARK}` })
    },
    board: { total: 2, done: 1, blocked: 0, lamps: ['done', 'active'], overflow: 0 },
    earlier: [{ id: 'old', name: `${MARK} earlier name`, statusWord: 'Finished' }]
  }
  const s = factoryTestState({
    renderer: 'webgl2',
    quality: 'low',
    qualityStart: 'high',
    mode: 'live',
    motion: 'full',
    model: textModel,
    cues: [
      { id: 'c1', kind: 'capsule', from: 'a', to: 'b', count: 3, start: 0, duration: 500, progress: 0.5, opacity: 1 },
      { id: 'c2', kind: 'tote', from: 'a', to: 'b', start: 0, duration: 500, progress: 0.1, opacity: 1 }
    ],
    recentCues: [{ kind: 'capsule', from: 'a', to: null }],
    ambient: new Map([['b', { kind: 'machine' as const, phase: 0 }]]),
    messageCursor: `99|a|b|${MARK} the message text ${MARK}`,
    view: { ppm: 30, targetX: 1, targetZ: 2 },
    loop: 'running',
    frames: 10,
    engines: 1,
    perf: { drawCalls: 40, shadowCalls: 14, triangles: 50_000, geometries: 61, textures: 5, frameP95Ms: 0.7, intervalP95Ms: 8.8, firstFrameMs: 120, gpu: 'ANGLE (NVIDIA, Test GPU)', memoryBytes: 16_803_157, pixelRatio: 1 }
  })
  const json = JSON.stringify(s)

  it('has none of the names, activities, paths, commands or message text', () => {
    expect(json).not.toContain(MARK)
    expect(json.toLowerCase()).not.toContain(MARK)
  })

  it('holds only ids, fixed words, numbers, booleans, the GPU string and the redacted cursor', () => {
    const ids = new Set(['root', 'a', 'b', 'p1'])
    const words = new Set([
      'webgl2', 'floor-plan', 'high', 'low', 'minimal', 'live', 'team', 'full', 'reduced', 'paused', 'on', 'ended',
      'off', 'running', 'needs-you', 'failed', 'console', 'machine', 'dispatch', 'signal', 'rest', 'docked', 'down',
      'none', 'screen', 'pad', 'hold', 'hold-striped', 'dock', 'parent-pad', 'pending', 'active', 'done', 'blocked',
      'skipped', 'arrive', 'leave', 'tote', 'capsule', 'part', 'crate', 'shutter', 'barrier', 'pose', 'hall', 'idle',
      'stopped', 'Running', 'Needs you', 'Idle', 'Paused', 'Finished', 'Stopped', 'Failed', 'Role'
    ])
    const bad: string[] = []
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'string') {
        const ok = ids.has(v) || words.has(v) || (path === '.perf.gpu' && v === 'ANGLE (NVIDIA, Test GPU)') || (path === '.messageCursor' && /^\d+\|[^|]*\|[^|]*\|#[0-9a-f]{8}$/.test(v))
        if (!ok) bad.push(`${path}=${v}`)
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
      else if (!(v === null || typeof v === 'number' || typeof v === 'boolean')) bad.push(`${path}: ${typeof v}`)
    }
    walk(JSON.parse(json), '')
    expect(bad).toEqual([])
  })
})

describe('motionState', () => {
  it('prefers paused, then reduced', () => {
    expect(motionState(false, false)).toBe('full')
    expect(motionState(true, false)).toBe('reduced')
    expect(motionState(true, true)).toBe('paused')
    expect(motionState(false, true)).toBe('paused')
  })
})

describe('p95', () => {
  it('uses the nearest rank', () => {
    expect(p95([])).toBe(0)
    expect(p95([4])).toBe(4)
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95)
    expect(p95([3, 1, 2])).toBe(3)
  })
})
