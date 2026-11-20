import { describe, expect, it } from 'vitest'
import { LABEL_CAP, labelKey, placeLabels, type LabelCandidate, type LabelReason } from './labels'

const STAGE = { width: 1000, height: 600 }
const at = (x: number, y: number, w = 100, h = 30) => ({ left: x, top: y, right: x + w, bottom: y + h })
const plate = (id: string, reason: LabelReason, x: number, y: number, order = 0): LabelCandidate => ({ id, kind: 'nameplate', reason, rect: at(x, y), order })

describe('placeLabels (section 6.2)', () => {
  it('everyone else shows only from ppm 18', () => {
    const c = [plate('a', 'other', 0, 0), plate('b', 'failed', 200, 0)]
    expect(placeLabels(c, { ppm: 17.9, stage: STAGE })).toEqual(['nameplate:b'])
    expect(placeLabels(c, { ppm: 18, stage: STAGE })).toEqual(['nameplate:b', 'nameplate:a'])
  })

  it('priority order: selected, focused, hovered, needs you, failed, conflict, other', () => {
    const reasons: LabelReason[] = ['other', 'conflict', 'failed', 'needs-you', 'hovered', 'focused', 'selected']
    const c = reasons.map((r, i) => plate(r, r, i * 120, 0))
    expect(placeLabels(c, { ppm: 30, stage: STAGE })).toEqual(['selected', 'focused', 'hovered', 'needs-you', 'failed', 'conflict', 'other'].map((r) => `nameplate:${r}`))
  })

  it('a lower plate that overlaps a placed one is skipped; never-skipped kinds show even when they overlap', () => {
    const c = [plate('sel', 'selected', 0, 0), plate('foc', 'focused', 50, 10), plate('fail', 'failed', 60, 5), plate('far', 'other', 400, 0)]
    expect(placeLabels(c, { ppm: 30, stage: STAGE })).toEqual(['nameplate:sel', 'nameplate:foc', 'nameplate:far'])
  })

  it('caps nameplates at 24, but the never-skipped kinds always show', () => {
    const many: LabelCandidate[] = []
    for (let i = 0; i < 40; i++) many.push(plate(`w${i}`, 'other', (i % 8) * 120, Math.floor(i / 8) * 40, i))
    const shown = placeLabels(many, { ppm: 30, stage: STAGE })
    expect(shown).toHaveLength(LABEL_CAP)
    expect(shown[0]).toBe('nameplate:w0')
    const needs: LabelCandidate[] = []
    for (let i = 0; i < 30; i++) needs.push(plate(`n${i}`, 'needs-you', (i % 8) * 120, Math.floor(i / 8) * 40, i))
    expect(placeLabels([...needs, plate('x', 'failed', 900, 500)], { ppm: 30, stage: STAGE })).toHaveLength(30)
  })

  it('off-stage labels never show', () => {
    expect(placeLabels([plate('sel', 'selected', -300, 0), plate('b', 'failed', 0, 700)], { ppm: 30, stage: STAGE })).toEqual([])
  })

  it('signs, dock and board come after nameplates and skip on overlap', () => {
    const c: LabelCandidate[] = [
      { id: 'line-1-0', kind: 'sign', rect: at(0, 0), order: 0 },
      { id: 'dock', kind: 'dock', rect: at(300, 0), order: 0 },
      { id: 'board', kind: 'board', rect: at(600, 0), order: 0 },
      plate('a', 'other', 50, 10)
    ]
    expect(placeLabels(c, { ppm: 30, stage: STAGE })).toEqual(['nameplate:a', 'dock:dock', 'board:board'])
    expect(placeLabels(c, { ppm: 10, stage: STAGE })).toEqual(['sign:line-1-0', 'dock:dock', 'board:board'])
  })

  it('reading order breaks ties', () => {
    const c = [plate('b', 'other', 0, 0, 2), plate('a', 'other', 50, 0, 1)]
    expect(placeLabels(c, { ppm: 30, stage: STAGE })).toEqual(['nameplate:a'])
    expect(labelKey({ kind: 'sign', id: 'x' })).toBe('sign:x')
  })
})
