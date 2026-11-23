import { describe, expect, it } from 'vitest'
import { createFoldGuard, listFolded } from './runMetaFold'

describe('run header fold', () => {
  it('lists every folded chip in line order, from the DOM flags, and none that is shown', () => {
    const kids = [
      { folded: false, text: 'Working' },
      { folded: true, text: 'Started 2 min ago' },
      { folded: false, text: 'claude-sonnet' },
      { folded: true, text: '3 files', button: 'run-meta-outputs' },
      { folded: true, text: '' }
    ]
    const items = listFolded(
      kids,
      (k) => k.folded,
      (k) => ({ label: k.text, interactive: !!k.button, testId: k.button })
    )
    expect(items).toEqual([
      { idx: 1, label: 'Started 2 min ago', interactive: false, testId: undefined },
      { idx: 3, label: '3 files', interactive: true, testId: 'run-meta-outputs' }
    ])
  })

  it('passes a chip title and screen-reader text through', () => {
    const items = listFolded(
      [{ t: 'Recorded 8 changes' }],
      () => true,
      (k) => ({ label: k.t, interactive: true, testId: 'run-meta-recorded', title: 'What the team recorded', srText: '(4 items; opens Knowledge)' })
    )
    expect(items[0]).toMatchObject({ title: 'What the team recorded', srText: '(4 items; opens Knowledge)' })
  })

  it('past the burst limit the guard settles once with the latest answer, then skips', () => {
    const guard = createFoldGuard(6, 200)
    const answers = [1000, 1010, 1020, 1030, 1040, 1050].map((t) => guard(t))
    expect(answers).toEqual(Array(6).fill('commit'))
    expect(guard(1060)).toBe('settle')
    expect(guard(1070)).toBe('skip')
    expect(guard(1080)).toBe('skip')
    // A change after the burst has passed starts a new one.
    expect(guard(1500)).toBe('commit')
  })
})
