/**
 * An org chart card that changes the LIVE run's team: its compact body carries the values that move, and y waits until
 * the whole body was scrolled to its end (or v showed it). A cut full view never unlocks y. A card that applies from
 * the next run keeps today's behaviour.
 */
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { DecisionOutcome, OrgChartProposalPayload, Proposal, Role } from '../../shared/types'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from './context'
import { DecisionTray } from './DecisionTray'
import { trayHeight } from './trayLayout'
import { cardKey, type CardRef, type InputEvent, type TrayCard } from './types'

const key = (ch: string): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch })
const named = (name: string): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' }) as InputEvent
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1))

const role = (id: string, over: Partial<Role> = {}): Role => ({
  id,
  slug: id,
  name: id === 'lead' ? 'Lead' : 'Dev',
  description: `desc ${id}`,
  responsibilities: [],
  prompt: '',
  tools: ['Read'],
  model: 'claude-sonnet-5',
  canSpawn: false,
  spawnable: [],
  reportsTo: id === 'lead' ? null : 'lead',
  position: { x: 0, y: 0 },
  color: '#ffffff',
  ...over
})

function orgCard(effect: Proposal['effect'], prompt: string): TrayCard {
  const payload: OrgChartProposalPayload = { roles: [role('lead'), role('dev', { tools: ['Bash', 'Write'], prompt })], rationale: '', runBaseline: [role('lead')] }
  const proposal: Proposal = { id: 'req_1', runId: 'run_1', agentId: 'root', title: 'Grow the team', createdAt: 1, kind: 'orgChart', effect, payload }
  const ref: CardRef = { hostInstanceId: 'h1', runId: 'run_1', requestId: 'req_1', kind: 'proposal', revision: 1 }
  return { key: cardKey(ref), ref, runTag: 'R1', runKind: 'work', arrivedSeq: 1, kind: 'proposal', card: proposal } as TrayCard
}

const longPrompt = (lines: number): string => Array.from({ length: lines }, (_, i) => `step ${i} of the prompt`).join('\n')

async function mount(c: TrayCard, viewed: string[] = []) {
  const bus = new InputBus()
  const clock = { t: 10_000 }
  const calls: unknown[] = []
  const notices: string[] = []
  const height = trayHeight([c], 100, 24, false)
  const r = render(
    <TuiEnvContext.Provider value={DEFAULT_TUI_ENV}>
      <InputBusContext.Provider value={bus}>
        <DecisionTray
          width={100}
          height={height}
          compact
          focused
          variant="full"
          cards={[c]}
          resolved={[]}
          onDecide={async (_c, call): Promise<DecisionOutcome> => {
            calls.push(call)
            return { status: 'applied', runId: 'run_1', requestId: 'req_1' }
          }}
          onViewText={async (_t, text) => void viewed.push(text)}
          onLeave={() => {}}
          onNotice={(text) => void notices.push(text)}
          now={() => clock.t}
        />
      </InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
  await tick()
  clock.t += 1000
  const press = async (e: InputEvent): Promise<void> => {
    bus.dispatch(e, 'tray')
    await tick()
    clock.t += 1000
  }
  return { r, press, calls, notices }
}

describe('a live team change waits until its body was read', () => {
  it('shows the values, refuses y until the end was reached, then asks and sends on the second y', async () => {
    const { r, press, calls, notices } = await mount(orgCard('now', longPrompt(60)))
    await press(key('y'))
    expect(notices.at(-1)).toContain('Read the whole team change first')
    expect(r.lastFrame()).not.toContain('to confirm')
    expect(calls).toHaveLength(0)
    await press(named('end'))
    expect(r.lastFrame()).toContain('step 59 of the prompt')
    await press(key('y'))
    expect(r.lastFrame()).toContain('to confirm')
    expect(calls).toHaveLength(0)
    await press(key('y'))
    expect(calls).toHaveLength(1)
    r.unmount()
  })

  it('v opens the full view and unlocks y', async () => {
    const viewed: string[] = []
    const { r, press } = await mount(orgCard('now', longPrompt(60)), viewed)
    await press(key('v'))
    expect(viewed[0]).toContain('step 59 of the prompt')
    await press(key('y'))
    expect(r.lastFrame()).toContain('to confirm')
    r.unmount()
  })

  it('a full view cut at 64 KB never unlocks y', async () => {
    const { r, press, calls, notices } = await mount(orgCard('now', `${'x'.repeat(100)}\n`.repeat(900)))
    await press(key('v'))
    expect(r.lastFrame()).toContain('cut at 64 KB')
    await press(key('y'))
    expect(notices.at(-1)).toContain('too long to read here')
    expect(r.lastFrame()).not.toContain('to confirm')
    await press(named('end'))
    await press(key('y'))
    expect(r.lastFrame()).not.toContain('to confirm')
    expect(calls).toHaveLength(0)
    r.unmount()
  })

  it('a card that applies from the next run still answers y at once', async () => {
    const { r, press, calls } = await mount(orgCard('next-run', longPrompt(60)))
    await press(key('y'))
    expect(calls).toHaveLength(1)
    r.unmount()
  })
})
