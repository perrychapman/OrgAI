import { describe, expect, it } from 'vitest'
import { factoryTestState, motionState, p95 } from './snapshot'
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
      mode: 'team',
      motion: 'reduced',
      workers: [],
      lines: [],
      vacant: 0,
      cues: [],
      cuesStarted: 0,
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
    expect(s.workers[2]).toEqual({ id: 'b', line: 1, row: 0, slot: 1, x: 10, z: 1.5, lamp: 'failed', pose: 'down', statusWord: 'Failed', fenced: false, ambient: 'none' })
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
      { id: 'root', line: 0, row: -1, slot: 0, x: 7, z: -6, lamp: 'running', pose: 'rest', statusWord: 'Running', fenced: false, ambient: 'none' },
      { id: 'a', line: 1, row: 0, slot: 0, x: 6, z: 1.5, lamp: 'needs-you', pose: 'rest', statusWord: 'Needs you', fenced: false, ambient: 'none' }
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
      perf: { drawCalls: 5, shadowCalls: 4, triangles: 120, geometries: 4, textures: 1, frameP95Ms: 1.23456, intervalP95Ms: 0, firstFrameMs: 88.888, gpu: 'ANGLE (Test GPU)' },
      cues: [{ id: 'c1', kind: 'capsule', from: 'a', to: null, start: 0, duration: 500, progress: 0.5 }],
      cuesStarted: 2,
      messageCursor: '1|a|b|hi'
    })
    expect(s.view).toEqual({ ppm: 19.67, targetX: 15, targetZ: -4 })
    expect(s.perf).toEqual({ drawCalls: 5, shadowCalls: 4, triangles: 120, geometries: 4, textures: 1, frameP95Ms: 1.23, intervalP95Ms: 0, firstFrameMs: 88.89, gpu: 'ANGLE (Test GPU)' })
    expect(s.cues).toEqual([{ kind: 'capsule', from: 'a', to: null }])
    expect(s.cuesStarted).toBe(2)
    expect(s.messageCursor).toBe('1|a|b|hi')
  })

  it('omits an unknown GPU string', () => {
    const s = factoryTestState({
      renderer: 'webgl2', quality: 'high', mode: 'live', motion: 'full', loop: 'idle', frames: 1, engines: 1,
      perf: { drawCalls: 1, shadowCalls: 0, triangles: 2, geometries: 1, textures: 0, frameP95Ms: 0, intervalP95Ms: 0, firstFrameMs: 0 }
    })
    expect(s.perf && 'gpu' in s.perf).toBe(false)
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
