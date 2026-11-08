import { describe, expect, it } from 'vitest'
import type { OutputNote, SlidePreview } from '@shared/types'
import {
  boxPercent,
  bulletLabels,
  compareSummary,
  cqwSize,
  labelsInBox,
  openNotesBySlide,
  pairName,
  safeColor,
  safeImageUrl,
  slideAspect,
  slideKey,
  thumbName,
  truncatedSlidesLine,
  visiblePairs
} from './slideStage'

const slide: SlidePreview = {
  n: 2,
  title: 'Next steps',
  shapes: [
    { type: 'text', x: 0.1, y: 0.1, w: 0.4, h: 0.2, paragraphs: [{ runs: [{ text: 'Hello ' }, { text: 'world' }] }] },
    { type: 'text', x: 0.6, y: 0.6, w: 0.3, h: 0.2, paragraphs: [{ runs: [{ text: 'Far' }] }] }
  ]
}

describe('guards', () => {
  it('accepts only #rrggbb', () => {
    expect(safeColor('#12aBcd')).toBe('#12aBcd')
    expect(safeColor('red')).toBeUndefined()
    expect(safeColor('#fff')).toBeUndefined()
    expect(safeColor('#12345; x')).toBeUndefined()
    expect(safeColor(5)).toBeUndefined()
  })
  it('accepts only safe image data URLs', () => {
    expect(safeImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(safeImageUrl('data:image/svg+xml;base64,AAAA')).toBeUndefined()
    expect(safeImageUrl('data:text/html;base64,AAAA')).toBeUndefined()
    expect(safeImageUrl('https://x/y.png')).toBeUndefined()
    expect(safeImageUrl('data:image/png;base64,AA"onerror=')).toBeUndefined()
  })
})

describe('geometry', () => {
  it('sizes', () => {
    expect(slideAspect({ w: 960, h: 540 })).toBeCloseTo(16 / 9)
    expect(slideAspect({ w: 0, h: 0 })).toBeCloseTo(16 / 9)
    expect(cqwSize(24, 960)).toBeCloseTo(2.5)
    expect(cqwSize(NaN, 960)).toBeCloseTo(1.875)
    expect(boxPercent({ x: 0.5, y: 0.25, w: 0.125, h: 1 })).toEqual({ left: '50%', top: '25%', width: '12.5%', height: '100%' })
  })
})

describe('bulletLabels', () => {
  it('numbers per level and restarts after a break', () => {
    const p = (bullet?: 'disc' | 'number', level?: number) => ({ runs: [], bullet, level })
    expect(bulletLabels([p('number'), p('number'), p('number', 1), p('number', 1), p('number'), p(), p('number')])).toEqual(['1.', '2.', '1.', '2.', '3.', '', '1.'])
    expect(bulletLabels([p('disc'), p('disc', 1)])).toEqual(['•', '•'])
  })
})

describe('names and notes', () => {
  it('names a thumbnail', () => {
    expect(thumbName(slide)).toBe('Slide 2: Next steps')
    expect(thumbName(slide, 2)).toBe('Slide 2: Next steps, has 2 open notes')
    expect(thumbName({ n: 4, shapes: [] }, 1)).toBe('Slide 4, has 1 open note')
  })
  it('counts open notes per slide for one version', () => {
    const note = (o: Partial<OutputNote> & { anchor: OutputNote['anchor'] }): OutputNote => ({ id: 'n', outputId: 'o', version: 1, text: 't', status: 'open', createdAt: 0, ...o })
    const m = openNotesBySlide(
      [
        note({ anchor: { type: 'slide', slide: 2 } }),
        note({ anchor: { type: 'region', slide: 2, shape: 'box', x: 0, y: 0, w: 1, h: 1 } }),
        note({ anchor: { type: 'slide', slide: 3 }, status: 'resolved' }),
        note({ anchor: { type: 'slide', slide: 4 }, version: 2 }),
        note({ anchor: { type: 'whole' } })
      ],
      1
    )
    expect([...m.entries()]).toEqual([[2, 2]])
  })
  it('lists the texts a region covers', () => {
    expect(labelsInBox(slide, { x: 0, y: 0, w: 0.3, h: 0.3 })).toEqual(['Hello world'])
    expect(labelsInBox(slide, { x: 0, y: 0, w: 1, h: 1 })).toEqual(['Hello world', 'Far'])
    expect(labelsInBox(slide, { x: 0.5, y: 0.35, w: 0.05, h: 0.05 })).toEqual([])
  })
})

describe('slideKey', () => {
  it('moves and clamps', () => {
    expect(slideKey('PageDown', 0, 5, true)).toBe(1)
    expect(slideKey('PageUp', 0, 5, true)).toBe(0)
    expect(slideKey('End', 0, 5, false)).toBe(4)
    expect(slideKey('Home', 3, 5, false)).toBe(0)
    expect(slideKey('ArrowDown', 1, 5, true)).toBe(2)
    expect(slideKey('ArrowDown', 1, 5, false)).toBeNull()
    expect(slideKey('ArrowRight', 4, 5, false)).toBe(4)
    expect(slideKey('a', 1, 5, true)).toBeNull()
    expect(slideKey('Home', 0, 0, true)).toBeNull()
  })
})

describe('lines', () => {
  it('truncated slides', () => {
    expect(truncatedSlidesLine(undefined)).toBeNull()
    expect(truncatedSlidesLine(1)).toBe('1 more slide is not shown. Open the file to see it.')
    expect(truncatedSlidesLine(7)).toBe('7 more slides are not shown. Open the file to see them.')
  })
  it('compare', () => {
    const pairs = [
      { a: 1, b: 1, status: 'same' as const },
      { a: 2, b: 2, status: 'changed' as const },
      { b: 3, status: 'added' as const },
      { a: 3, status: 'removed' as const }
    ]
    expect(visiblePairs(pairs, false)).toHaveLength(3)
    expect(visiblePairs(pairs, true)).toHaveLength(4)
    expect(compareSummary(pairs)).toBe('1 slide changed, 1 added, 1 removed.')
    expect(compareSummary([{ a: 1, b: 1, status: 'same' }])).toBe('No slides changed.')
    expect(pairName({ a: 2, b: 3, status: 'changed' }, 'Old', 'New')).toBe('Slide 3 (was 2): New, changed')
    expect(pairName({ a: 3, status: 'removed' }, 'Gone')).toBe('Slide 3: Gone, removed')
  })
})
