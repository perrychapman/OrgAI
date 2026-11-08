import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBus } from './context'
import { PlanPane, stepMarker } from './PlanPane'
import { ESC_RE, Providers, env, key, press, withInkColor } from './panes/testUtil'
import { textWidth } from './panes/text'
import type { PlanPaneProps, PlanStepView, PlanView, TuiEnv } from './types'

const step = (id: string, status: PlanStepView['status'], over: Partial<PlanStepView> = {}): PlanStepView => ({
  id,
  title: `Step ${id}`,
  status,
  ...over
})

const PLAN: PlanView = {
  goal: 'Ship the login page',
  statusWord: 'Running',
  done: 1,
  total: 5,
  steps: [
    step('1', 'done', { owner: 'dev-1' }),
    step('2', 'in_progress', { owner: 'dev-2', note: 'halfway' }),
    step('3', 'pending'),
    step('4', 'blocked', { owner: 'qa' }),
    step('5', 'skipped')
  ]
}

function mount(props: Partial<PlanPaneProps> = {}, e: TuiEnv = env()) {
  const bus = new InputBus()
  let current: PlanPaneProps = { width: 50, height: 12, focused: false, plan: PLAN, ...props }
  const tree = (p: PlanPaneProps) => (
    <Providers env={e} bus={bus}>
      <PlanPane {...p} />
    </Providers>
  )
  const out = render(tree(current))
  const rerender = (p: Partial<PlanPaneProps>): void => {
    current = { ...current, ...p }
    out.rerender(tree(current))
  }
  return { ...out, bus, rerender }
}

const lines = (f: string | undefined): string[] => (f ?? '').split('\n')

describe('PlanPane', () => {
  it('shows the goal, progress with the status word and every step with glyph and owner', () => {
    const t = mount()
    const out = lines(t.lastFrame())
    expect(out[0]).toContain('Plan')
    expect(out[1]).toBe('Ship the login page')
    expect(out[2]).toBe('1/5 done  Running')
    expect(out[3]).toContain('40%')
    expect(out[4].startsWith('✓ Step 1')).toBe(true)
    expect(out[4].trimEnd().endsWith('dev-1')).toBe(true)
    expect(out[5].startsWith('◐ Step 2')).toBe(true)
    expect(out[6]).toContain('halfway')
    expect(out.some((l) => l.startsWith('○ Step 3'))).toBe(true)
    expect(out.some((l) => l.startsWith('! Step 4'))).toBe(true)
    expect(out.some((l) => l.startsWith('– Step 5'))).toBe(true)
    t.unmount()
  })

  it('keeps a step visible in a short pane and uses text progress for screen readers', () => {
    const short = mount({ height: 4 })
    expect(short.lastFrame()).toContain('Step 1')
    short.unmount()
    const accessible = mount({}, env({ screenReader: true }))
    expect(accessible.lastFrame()).toContain('Progress 40%. Blocked')
    accessible.unmount()
  })

  it('shows "No plan yet" without a plan', () => {
    const t = mount({ plan: undefined })
    expect(t.lastFrame()).toContain('No plan yet')
    t.unmount()
  })

  it('scrolls the steps only while focused, keeping the goal in place', () => {
    const many: PlanView = { ...PLAN, steps: Array.from({ length: 20 }, (_, i) => step(String(i), 'pending')), total: 20 }
    const t = mount({ plan: many, height: 6 })
    expect(press(t.bus, 'plan', key('down'))).toEqual([false])
    t.rerender({ focused: true })
    press(t.bus, 'plan', key('down'), key('down'))
    t.rerender({})
    let out = lines(t.lastFrame())
    expect(out[1]).toBe('Ship the login page')
    expect(out[4]).toContain('Step 2')
    press(t.bus, 'plan', key('end'))
    t.rerender({})
    out = lines(t.lastFrame())
    expect(out.at(-1)).toContain('Step 19')
    press(t.bus, 'plan', key('home'))
    t.rerender({})
    expect(lines(t.lastFrame())[4]).toContain('Step 0')
    t.unmount()
  })

  it('cuts to the width with wide characters, ASCII markers and no colour when asked, words for a screen reader', async () => {
    const wide: PlanView = { ...PLAN, goal: '目標'.repeat(30), steps: [step('w', 'done', { title: '手順'.repeat(30), owner: 'owner' })] }
    const t = mount({ plan: wide, width: 21 })
    for (const l of lines(t.lastFrame())) expect(textWidth(l)).toBeLessThanOrEqual(21)
    t.unmount()
    await withInkColor(() => {
      const c = mount({}, env())
      expect(c.lastFrame()).toMatch(ESC_RE)
      c.unmount()
      const plain = mount({}, env({ unicode: false, color: false }))
      expect(plain.lastFrame()).not.toMatch(ESC_RE)
      expect(plain.lastFrame()).toContain('[x] Step 1')
      expect(plain.lastFrame()).toContain('[>] Step 2')
      plain.unmount()
    })
    expect(stepMarker('in_progress', env({ screenReader: true }))).toBe('in progress:')
  })

  it('survives width or height 0 and 1', () => {
    for (const [width, height] of [
      [0, 0],
      [1, 1],
      [0, 3],
      [3, 0]
    ]) {
      const t = mount({ width, height, focused: true })
      press(t.bus, 'plan', key('down'), key('end'), key('pageup'))
      t.unmount()
    }
  })
})
