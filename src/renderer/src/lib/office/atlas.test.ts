import { describe, expect, it } from 'vitest'
import atlas from '../../assets/pocket-office/atlas.json'

// Living office rework, slice S0 (docs/design/pocket-office.md section 6): 96 worker frames and 7 prop frames appended to
// the generated sheets. Sheet sizes are the ones generate-atlas.py writes; the PNGs are not decoded here.
const SILHOUETTES = ['crop', 'part', 'bun', 'wide', 'long', 'cap', 'afro', 'ponytail', 'bob', 'bald', 'braid', 'vest']
const DIRECTIONS = ['down', 'left', 'right', 'up']
const NEW_POSES = ['type', 'hand']
const WORKER_SHEET = { w: 144, h: 1152 }
const PROP_SHEET = { w: 128, h: 208 }
const PALETTES = ['color', 'neutral', 'green']

type Frame = { x: number; y: number; w: number; h: number }
const workerFrames = atlas.sheets.workers.frames as Record<string, Frame>
const propFrames = atlas.sheets.props.frames as Record<string, Frame>

const newWorkerNames = SILHOUETTES.flatMap(s => DIRECTIONS.flatMap(d => NEW_POSES.map(p => `worker.${s}.${d}.${p}`)))
const newPropNames = ['prop.crt-b', 'prop.crt-off', 'prop.crt-error', 'prop.mark-wait', 'prop.mark-done', 'prop.mark-error', 'prop.mark-talk']

function inside(f: Frame, sheet: { w: number; h: number }): boolean {
  return f.x >= 0 && f.y >= 0 && f.x + f.w <= sheet.w && f.y + f.h <= sheet.h
}

function overlaps(a: Frame, b: Frame): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

describe('pocket office atlas, living office rework frames', () => {
  it('lists 96 new worker names and 7 new prop names', () => {
    expect(newWorkerNames).toHaveLength(96)
    expect(new Set(newWorkerNames).size).toBe(96)
    expect(newPropNames).toHaveLength(7)
  })

  it('has every new worker frame inside the 144 x 1152 sheet, 16 x 24, in the appended columns', () => {
    for (const name of newWorkerNames) {
      const f = workerFrames[name]
      expect(f, name).toBeDefined()
      expect(inside(f, WORKER_SHEET), name).toBe(true)
      expect([f.w, f.h], name).toEqual([16, 24])
      expect(f.x, name).toBe(name.endsWith('.type') ? 112 : 128)
    }
  })

  it('has every new prop frame inside the props sheet with the right size', () => {
    for (const name of newPropNames) {
      const f = propFrames[name]
      expect(f, name).toBeDefined()
      expect(inside(f, PROP_SHEET), name).toBe(true)
      const size = name.startsWith('prop.mark-') ? 16 : 32
      expect([f.w, f.h], name).toEqual([size, size])
    }
    expect(propFrames['prop.crt-b']).toEqual({ x: 0, y: 160, w: 32, h: 32 })
    expect(propFrames['prop.crt-off']).toEqual({ x: 32, y: 160, w: 32, h: 32 })
    expect(propFrames['prop.crt-error']).toEqual({ x: 64, y: 160, w: 32, h: 32 })
    expect(propFrames['prop.mark-wait']).toEqual({ x: 0, y: 192, w: 16, h: 16 })
    expect(propFrames['prop.mark-done']).toEqual({ x: 16, y: 192, w: 16, h: 16 })
    expect(propFrames['prop.mark-error']).toEqual({ x: 32, y: 192, w: 16, h: 16 })
    expect(propFrames['prop.mark-talk']).toEqual({ x: 48, y: 192, w: 16, h: 16 })
  })

  it('keeps old frames at their original coordinates', () => {
    expect(workerFrames['worker.crop.down.idle']).toEqual({ x: 0, y: 0, w: 16, h: 24 })
    expect(workerFrames['worker.crop.down.error']).toEqual({ x: 96, y: 0, w: 16, h: 24 })
    expect(workerFrames['worker.crop.up.work']).toEqual({ x: 48, y: 72, w: 16, h: 24 })
    expect(workerFrames['worker.vest.up.error']).toEqual({ x: 96, y: 1128, w: 16, h: 24 })
    expect(propFrames['prop.desk']).toEqual({ x: 0, y: 0, w: 32, h: 32 })
    expect(propFrames['prop.crt']).toEqual({ x: 64, y: 0, w: 32, h: 32 })
    expect(propFrames['prop.side-table']).toEqual({ x: 96, y: 128, w: 32, h: 32 })
  })

  it('never overlaps two frames of the same sheet', () => {
    const clashes: string[] = []
    for (const frames of [Object.entries(workerFrames), Object.entries(propFrames)]) {
      for (let i = 0; i < frames.length; i++) {
        for (let j = i + 1; j < frames.length; j++) if (overlaps(frames[i][1], frames[j][1])) clashes.push(`${frames[i][0]} / ${frames[j][0]}`)
      }
    }
    expect(clashes).toEqual([])
  })

  it('declares the crt frames like crt and the marks as overlays', () => {
    for (const n of ['crt-b', 'crt-off', 'crt-error'] as const) {
      expect(atlas.props[n]).toEqual({ ...atlas.props.crt, frame: `prop.${n}` })
    }
    for (const n of ['mark-wait', 'mark-done', 'mark-error', 'mark-talk'] as const) {
      expect(atlas.props[n].placement).toBe('overlay')
      expect(atlas.props[n].footprint).toEqual([])
      expect(atlas.props[n].frame).toBe(`prop.${n}`)
    }
  })

  it('shares one set of coordinates across the three palettes', () => {
    for (const sheet of [atlas.sheets.workers, atlas.sheets.props]) {
      expect(Object.keys(sheet.files).sort()).toEqual([...PALETTES].sort())
    }
    expect(Object.keys(atlas.palettes).sort()).toEqual([...PALETTES].sort())
  })
})
