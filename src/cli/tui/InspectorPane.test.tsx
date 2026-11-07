import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { TeamMessageRow } from './collaboration'
import { InputBus } from './context'
import { InspectorPane } from './InspectorPane'
import { Providers, env } from './panes/testUtil'
import type { InspectorView, TranscriptRow } from './types'

const view: InspectorView = {
  id: 'a1',
  runId: 'r1',
  label: 'writer-1',
  role: 'Writer',
  state: 'thinking',
  stateWord: 'Thinking',
  waiting: 0,
  msgOut: [],
  msgIn: []
}

const rows: TranscriptRow[] = [{ key: 't1', runId: 'r1', agentId: 'a1', agentLabel: 'writer-1', kind: 'text', text: 'transcript line' }]

describe('InspectorPane message previews', () => {
  it('shows the newest three real exchanges for the inspected agent and excludes unrelated traffic', () => {
    const messages: TeamMessageRow[] = [
      { key: 'm1', runId: 'r1', fromId: 'a1', toId: 'a2', fromLabel: 'writer-1', toLabel: 'lead', text: 'old exchange', at: 1 },
      { key: 'm2', runId: 'r1', fromId: 'a1', toId: 'a2', fromLabel: 'writer-1', toLabel: 'lead', text: 'second exchange', at: 2 },
      { key: 'm3', runId: 'r1', fromId: 'a2', toId: 'a1', fromLabel: 'lead', toLabel: 'writer-1', text: 'third exchange', at: 3 },
      { key: 'm4', runId: 'r1', fromId: 'a1', toId: null, fromLabel: 'writer-1', toLabel: 'you', text: 'newest exchange', at: 4 },
      { key: 'other', runId: 'r1', fromId: 'a9', toId: 'a8', fromLabel: 'other', toLabel: 'elsewhere', text: 'unrelated', at: 5 }
    ]
    const out = render(
      <Providers env={env({ color: false })} bus={new InputBus()}>
        <InspectorPane width={90} height={14} focused={false} view={view} rows={rows} partials={[]} showThinking messages={messages} />
      </Providers>
    )
    const frame = out.lastFrame() ?? ''
    expect(frame).toContain('second exchange')
    expect(frame).toContain('third exchange')
    expect(frame).toContain('newest exchange')
    expect(frame).not.toContain('old exchange')
    expect(frame).not.toContain('unrelated')
    expect(frame).toContain('transcript (this agent)')
    out.unmount()
  })
})
