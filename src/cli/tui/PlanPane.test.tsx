import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBus } from './context'
import { PlanPane, stepMarker, taskLabel } from './PlanPane'
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
  it('keeps progress and ETA visible even in a four-row card', () => {
    const t = mount({ height: 4, width: 42, plan: { ...PLAN, status: 'blocked' } })
    expect(t.lastFrame()).toContain('40%')
    expect(t.lastFrame()).toContain('Blocked')
    expect(t.lastFrame()).not.toContain(PLAN.goal)
    t.unmount()
  })
  it('keeps a verbose printer plan to one short line per task without notes or owners', () => {
    const t = mount({ width: 42, height: 20, plan: { ...PLAN, steps: [
      step('1', 'done', { title: 'Inspect printer status, fresh imagery, and calibration configuration', owner: 'Researcher', note: 'Printer Operational, heaters off; inspect all available device telemetry.' }),
      step('2', 'blocked', { title: 'Diagnose axis or first-layer issues and physical nozzle clearance', note: 'Physical nozzle gap, gantry alignment and axis travel measurements needed.' })
    ] } })
    expect(t.lastFrame()).not.toContain('Printer Operational')
    expect(t.lastFrame()).not.toContain('Physical nozzle gap')
    expect(t.lastFrame()).not.toContain('Researcher')
    expect(lines(t.lastFrame()).filter(line => line.trim())).toHaveLength(4)
    t.unmount()
  })

  it('shows only the task count, progress and one line per task', () => {
    const t = mount()
    const out = lines(t.lastFrame())
    expect(out[0]).toContain('Tasks')
    expect(out[0]).toContain('1/5 done')
    expect(out[1]).toContain('40%')
    expect(out[1]).toContain('ETA —')
    expect(out[2].startsWith('✓ Step 1')).toBe(true)
    expect(out[3].startsWith('◐ Step 2')).toBe(true)
    expect(out.some(l => l.startsWith('○ Step 3'))).toBe(true)
    expect(out.some(l => l.startsWith('! Step 4'))).toBe(true)
    expect(out.some(l => l.startsWith('– Step 5'))).toBe(true)
    expect(t.lastFrame()).not.toContain(PLAN.goal)
    expect(t.lastFrame()).not.toContain('halfway')
    expect(t.lastFrame()).not.toContain('dev-1')
    t.unmount()
  })

  it('keeps shortened task labels bounded and marks omitted detail', () => {
    expect(taskLabel('Inspect printer status, fresh imagery and settings', 40, env())).toBe('Inspect printer status…')
    expect(taskLabel('Short task', 40, env())).toBe('Short task')
    expect(taskLabel('Update records for 1,000 users', 40, env())).toBe('Update records for 1,000 users')
    for (const width of [0, 1, 4, 12, 30]) expect(textWidth(taskLabel('Long unbroken手順手順手順手順手順手順', width, env()))).toBeLessThanOrEqual(width)
  })

  it('keeps a step visible in a short pane and uses text progress for screen readers', () => {
    const short = mount({ height: 4 })
    expect(short.lastFrame()).toContain('Step 4')
    short.unmount()
    const accessible = mount({}, env({ screenReader: true }))
    expect(accessible.lastFrame()).toContain('Progress 40%. Blocked')
    expect(accessible.lastFrame()).toContain('ETA unavailable')
    accessible.unmount()
  })

  it('shows "No plan yet" without a plan', () => {
    const t = mount({ plan: undefined })
    expect(t.lastFrame()).toContain('No plan yet')
    t.unmount()
  })

  it('scrolls the tasks only while focused, keeping progress pinned', () => {
    const many: PlanView = { ...PLAN, steps: Array.from({ length: 20 }, (_, i) => step(String(i), 'pending')), total: 20 }
    const t = mount({ plan: many, height: 6 })
    expect(press(t.bus, 'plan', key('down'))).toEqual([false])
    t.rerender({ focused: true })
    press(t.bus, 'plan', key('down'), key('down'))
    t.rerender({})
    let out = lines(t.lastFrame())
    expect(out[1]).toContain('%')
    expect(out[2]).toContain('Step 2')
    press(t.bus, 'plan', key('end'))
    t.rerender({})
    out = lines(t.lastFrame())
    expect(out.some(line => line.includes('Step 19'))).toBe(true)
    press(t.bus, 'plan', key('home'))
    t.rerender({})
    expect(lines(t.lastFrame())[2]).toContain('Step 0')
    t.unmount()
  })

  it('shows every task when the pane has room', () => {
    const many = { ...PLAN, steps: Array.from({ length: 20 }, (_, i) => step(String(i), i === 14 ? 'in_progress' : 'pending')), total: 20 }
    const t = mount({ plan: many, height: 40 })
    expect(t.lastFrame()).toContain('Step 14')
    expect(lines(t.lastFrame()).filter(line => /Step \d/.test(line))).toHaveLength(20)
    expect(t.lastFrame()).not.toContain('of 20')
    t.unmount()
  })

  it('fills an exact-fit pane and keeps the active task and progress visible after shrinking', async () => {
    const many = { ...PLAN, total: 11, steps: Array.from({ length: 11 }, (_, i) => step(String(i), i === 7 ? 'in_progress' : 'pending')) }
    const t = mount({ plan: many, height: 13 })
    expect(lines(t.lastFrame()).filter(line => /Step \d/.test(line))).toHaveLength(11)
    expect(t.lastFrame()).not.toContain('Tab to view')
    t.rerender({ height: 8 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lines(t.lastFrame()).filter(line => /Step \d/.test(line))).toHaveLength(5)
    expect(t.lastFrame()).toContain('Step 7')
    expect(t.lastFrame()).toContain('of 11')
    expect(lines(t.lastFrame())[1]).toContain('%')
    t.rerender({ height: 20 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lines(t.lastFrame()).filter(line => /Step \d/.test(line))).toHaveLength(11)
    expect(t.lastFrame()).not.toContain('Tab to view')
    t.unmount()
  })

  it('resets manual scrolling on refocus and on a different run', async () => {
    const tick = () => new Promise(r => setTimeout(r, 20))
    const many = { ...PLAN, runId: 'r1', steps: Array.from({ length: 20 }, (_, i) => step(String(i), i === 14 ? 'in_progress' : 'pending')), total: 20 }
    const t = mount({ plan: many, height: 8, focused: true })
    await tick()
    press(t.bus, 'plan', key('end'))
    await tick()
    expect(lines(t.lastFrame())[2]).toContain('Step 15')
    t.rerender({ focused: false })
    await tick()
    t.rerender({ focused: true })
    await tick()
    expect(lines(t.lastFrame())[2]).toContain('Step 13')
    press(t.bus, 'plan', key('end'))
    await tick()
    t.rerender({ plan: { ...many, runId: 'r2', steps: many.steps.map((s, i) => ({ ...s, status: i === 3 ? 'in_progress' : 'pending' })) } })
    await tick()
    expect(lines(t.lastFrame())[2]).toContain('Step 2')
    t.unmount()
  })

  it.each(['stopping', 'finished', 'error'] as const)('marks ETA unavailable for a %s run', runStatus => {
    const t = mount({ plan: { ...PLAN, runStatus, steps: [step('1', 'pending')] } })
    expect(t.lastFrame()).toContain('ETA —')
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
