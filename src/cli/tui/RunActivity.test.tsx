import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBus } from './context'
import { Providers, env } from './panes/testUtil'
import { textWidth } from './panes/text'
import { RunActivity, activityLabelSegments, workLabel, workLabelParts, runTokenCount } from './RunActivity'
import type { OrgTreeRow, TuiEnv, TuiRun } from './types'

const row = (over: Partial<OrgTreeRow> = {}): OrgTreeRow => ({
  id: 'root', runId: 'run', label: 'Orchestrator', role: 'orchestrator', depth: 0,
  state: 'thinking', stateWord: 'Thinking', activity: 'Planning the dashboard', isRoot: true, costText: '', ...over
})
const rows = [row(), row({ id: 'dev', isRoot: false, state: 'tool', stateWord: 'Using a tool', activity: 'Reading the app' })]
function mount(over: Partial<Parameters<typeof RunActivity>[0]> = {}, environment: TuiEnv = env({ color: false })) {
  return render(<Providers env={environment} bus={new InputBus()}><RunActivity width={120} status="running" rows={rows} canInterrupt {...over} /></Providers>)
}

describe('RunActivity', () => {
  it('places elapsed time and total reported tokens beside the compact working label', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(60_000)
    try {
      const app = mount({ compact: true, tokenCount: 1800, startedAt: 15_000 })
      expect(app.lastFrame()).toContain('Planning the dashboard · 45s · 1.8k tokens')
      expect(app.lastFrame()).not.toContain('Thinking')
      app.unmount()
    } finally { clock.mockRestore() }
  })

  it('counts uncached, output and cache tokens once, preferring the run aggregate', () => {
    const tokens = { input: 100, output: 50, cacheRead: 200, cacheWrite: 25 }
    const agents = { root: { inputTokens: 999, outputTokens: 888, usage: { tokens } }, other: { inputTokens: 10, outputTokens: 5 } }
    expect(runTokenCount({ summary: {}, agents } as unknown as TuiRun)).toBe(390)
    expect(runTokenCount({ summary: { usage: { tokens } }, agents } as unknown as TuiRun)).toBe(375)
    expect(runTokenCount(undefined)).toBeUndefined()
  })

  it('uses actual current work and excludes waiting and earlier agents from the count', () => {
    const label = workLabel([...rows, row({ earlier: true }), row({ state: 'waiting' })], 'running')
    expect(label).toBe('Planning the dashboard · 2 agents working')
    expect(workLabel([], 'starting')).toBe('Starting the run')
  })

  it('shimmers the reported activity, leaving team counts static', () => {
    const thinking = activityLabelSegments(rows, 'running', env(), true)
    expect(thinking[0]?.text).toBe('Planning the dashboard')
    expect(thinking[0]?.shimmer).toBe(true)
    expect(thinking[1]?.text).toContain('2 agents working')
    expect(thinking[1]?.shimmer).not.toBe(true)

    const toolRows = [row({ state: 'tool', stateWord: 'Using a tool', activity: '$ npm test' }), rows[1]]
    const tool = activityLabelSegments(toolRows, 'running', env(), true)
    expect(tool[0]?.text).toBe('Running tests')
    expect(tool[0]?.shimmer).toBe(true)
    expect(workLabelParts(toolRows, 'running').details).toEqual(['2 agents working'])
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
