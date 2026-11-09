import { act } from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import { InputBus } from './context'
import { OrgTreePane } from './OrgTreePane'
import { messageRoute } from './teamMotion'
import type { TeamMessageRow } from './collaboration'
import type { OrgTreeRow, TuiEnv } from './types'
import { Providers, env } from './panes/testUtil'
import { textWidth } from './panes/text'

const rows = (runId = 'r1'): OrgTreeRow[] => ['a', 'b'].map((id, i) => ({ id, runId, label: id === 'a' ? 'Researcher' : 'Implementer', role: id,
  depth: i, isRoot: !i, state: 'idle', stateWord: 'Idle', activity: '', costText: '' }))
const message = (key: string, runId = 'r1'): TeamMessageRow => ({ key, runId, fromId: 'a', toId: 'b', fromLabel: 'Researcher', toLabel: 'Implementer', text: 'Ready for implementation.', at: 1 })
const tree = (messages: TeamMessageRow[], environment = env(), runId = 'r1', animated = true) => <Providers env={environment} bus={new InputBus()}>
  <OrgTreePane rows={rows(runId)} messages={messages} width={42} height={12} focused={false} compact teamSize={2} animated={animated} />
</Providers>

async function timed(fn: () => Promise<void>) {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  try { await fn() } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
}
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve() })

describe('real team message pulses', () => {
  it('animates a newly received message even between idle agents, then settles without replay', async () => timed(async () => {
    let r!: ReturnType<typeof render>
    await act(async () => { r = render(tree([])) })
    try {
      await act(async () => { r.rerender(tree([message('one')])) })
      expect(r.lastFrame()).toContain('●')
      const first = r.lastFrame()
      const participant = first?.split('\n').find(line => line.includes('Researcher') && line.includes('↔'))
      await advance(400)
      expect(r.lastFrame()).toContain('●')
      expect(r.lastFrame()).not.toBe(first)
      expect(r.lastFrame()?.split('\n').find(line => line.includes('Researcher') && line.includes('↔'))).toBe(participant)
      await advance(1800)
      expect(r.lastFrame()).not.toContain('●')
      expect(r.lastFrame()).toContain('Last: Researcher')
      await act(async () => { r.rerender(tree([message('one')])) })
      await advance(200)
      expect(r.lastFrame()).not.toContain('●')
    } finally { await act(async () => { r.unmount() }) }
  }))

  it('does not pulse earlier-session agents with the same id', async () => timed(async () => {
    const renderTree = (messages: TeamMessageRow[]) => <Providers env={env()} bus={new InputBus()}>
      <OrgTreePane rows={[...rows(), ...rows('old').map(row => ({ ...row, earlier: true, label: `Earlier ${row.label}` }))]}
        messages={messages} width={42} height={22} focused={false} compact teamSize={2} />
    </Providers>
    let r!: ReturnType<typeof render>
    await act(async () => { r = render(renderTree([])) })
    try {
      await act(async () => { r.rerender(renderTree([message('new')])) })
      expect(r.lastFrame()).toContain('Researcher ↔')
      const earlier = r.lastFrame()?.split('\n').filter(line => /Earlier (Researcher|Implementer)/.test(line))
      expect(earlier).toHaveLength(2)
      expect(earlier?.join('\n')).not.toContain('↔')
    } finally { await act(async () => { r.unmount() }) }
  }))

  it('does not animate mounted history, switched runs, or replay when animation resumes', async () => timed(async () => {
    let r!: ReturnType<typeof render>
    await act(async () => { r = render(tree([message('old')])) })
    try {
      expect(r.lastFrame()).not.toContain('●')
      await act(async () => { r.rerender(tree([message('other', 'r2')], env(), 'r2')) })
      expect(r.lastFrame()).not.toContain('●')
      await act(async () => { r.rerender(tree([message('new', 'r2')], env(), 'r2')) })
      expect(r.lastFrame()).toContain('●')
      await act(async () => { r.rerender(tree([message('new', 'r2')], env(), 'r2', false)) })
      expect(r.lastFrame()).not.toContain('●')
      await act(async () => { r.rerender(tree([message('new', 'r2')], env(), 'r2', true)) })
      expect(r.lastFrame()).not.toContain('●')
    } finally { await act(async () => { r.unmount() }) }
  }))

  it.each([{ reducedMotion: true }, { screenReader: true }, { color: false }, { dumbTerminal: true }] as Partial<TuiEnv>[])
    ('uses static message cues for %j', async settings => timed(async () => {
      let r!: ReturnType<typeof render>
      await act(async () => { r = render(tree([], env(settings))) })
      try {
        await act(async () => { r.rerender(tree([message('new')], env(settings))) })
        const initial = r.lastFrame()
        expect(initial).not.toContain('●')
        expect(initial).toContain('Researcher')
        await advance(800)
        expect(r.lastFrame()).toBe(initial)
      } finally { await act(async () => { r.unmount() }) }
    }))

  it('keeps both labels and the courier within the available width', () => {
    for (const width of [0, 1, 12, 28, 42]) for (const frame of [undefined, 0, 10, 19]) {
      expect(textWidth(messageRoute(message('m'), width, env(), frame))).toBeLessThanOrEqual(width)
    }
    expect(messageRoute(message('m'), 42, env({ unicode: false }), 0)).toContain('*----->')
  })
})
