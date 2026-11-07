import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBus } from './context'
import { Providers, env } from './panes/testUtil'
import { textWidth } from './panes/text'
import { RunActivity, activityLabelSegments, workLabel, workLabelParts } from './RunActivity'
import type { OrgTreeRow, TuiEnv } from './types'

const row = (over: Partial<OrgTreeRow> = {}): OrgTreeRow => ({
  id: 'root', runId: 'run', label: 'Orchestrator', role: 'orchestrator', depth: 0,
  state: 'thinking', stateWord: 'Thinking', activity: 'Planning the dashboard', isRoot: true, costText: '', ...over
})
const rows = [row(), row({ id: 'dev', isRoot: false, state: 'tool', stateWord: 'Using a tool', activity: 'Reading the app' })]
function mount(over: Partial<Parameters<typeof RunActivity>[0]> = {}, environment: TuiEnv = env({ color: false })) {
  return render(<Providers env={environment} bus={new InputBus()}><RunActivity width={120} status="running" rows={rows} canInterrupt {...over} /></Providers>)
}

describe('RunActivity', () => {
  it('uses actual current work and excludes waiting and earlier agents from the count', () => {
    const label = workLabel([...rows, row({ earlier: true }), row({ state: 'waiting' })], 'running')
    expect(label).toBe('Thinking · 2 agents working · Planning the dashboard')
    expect(workLabel([], 'starting')).toBe('Starting the run')
  })

  it('shimmers only a thinking lead prefix, leaving team and activity detail static', () => {
    const thinking = activityLabelSegments(rows, 'running', env(), true)
    expect(thinking[0]?.text).toBe('Thinking')
    expect(thinking[0]?.shimmer).toBe(true)
    expect(thinking[1]?.text).toContain('2 agents working')
    expect(thinking[1]?.text).toContain('Planning the dashboard')
    expect(thinking[1]?.shimmer).not.toBe(true)

    const toolRows = [row({ state: 'tool', stateWord: 'Using a tool' }), rows[1]]
    const tool = activityLabelSegments(toolRows, 'running', env(), true)
    expect(tool[0]?.text).toBe('Using a tool')
    expect(tool[0]?.shimmer).not.toBe(true)
    expect(workLabelParts(toolRows, 'running').details).toContain('Planning the dashboard')
  })

  it('keeps the spinner, real activity and interrupt hint in one bounded row', () => {
    const app = mount()
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Planning the dashboard')
    expect(frame).toContain('Esc interrupts')
    expect(frame.split('\n')).toHaveLength(1)
    expect(textWidth(frame)).toBeLessThanOrEqual(120)
    app.unmount()
    const narrow = mount({ width: 18 })
    expect(textWidth(narrow.lastFrame() ?? '')).toBeLessThanOrEqual(18)
    narrow.unmount()
  })

  it('finishes with a static result instead of spinning or inviting interruption', () => {
    const app = mount({ status: 'finished', startedAt: 1000, endedAt: 6000 })
    expect(app.lastFrame()).toContain('Run finished')
    expect(app.lastFrame()).toContain('5s')
    expect(app.lastFrame()).not.toContain('Esc interrupts')
    expect(app.lastFrame()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    app.unmount()
  })

  it('schedules no clocks for static, suspended or accessible sessions', () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    try {
      for (const environment of [env({ reducedMotion: true }), env({ screenReader: true }), env({ color: false }), env({ bufferMode: 'inline' }), env({ dumbTerminal: true })]) {
        const app = mount({}, environment)
        expect(intervals).not.toHaveBeenCalled()
        app.unmount()
      }
      const suspended = mount({ animated: false }, env())
      expect(intervals).not.toHaveBeenCalled()
      suspended.unmount()
      const done = mount({ status: 'finished' }, env())
      expect(intervals).not.toHaveBeenCalled()
      done.unmount()
    } finally { intervals.mockRestore() }
  })
})
