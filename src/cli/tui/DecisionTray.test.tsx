import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { CardKind, DecisionOutcome, McpInstallRequest, PermissionRequest, UserQuestion } from '../../shared/types'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from './context'
import { DecisionTray } from './DecisionTray'
import { trayHeight } from './trayLayout'
import { textWidth } from './panes/text'
import { cardKey, type CardRef, type DecisionCall, type DecisionTrayProps, type InputEvent, type ResolvedCardInfo, type TrayCard, type TuiEnv } from './types'

const RUN = 'run_1'

const key = (ch: string): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch })
const named = (name: 'enter' | 'escape' | 'backtab' | 'down' | 'backspace'): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: name === 'backtab', raw: '' })

function permission(id: string, extra: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id,
    runId: RUN,
    agentId: 'root',
    toolName: 'Bash',
    input: { command: `npm test ${id}` },
    summary: `Run npm test ${id}`,
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }],
    ruleLabels: ['Bash(npm test:*)'],
    ...extra
  }
}

function tray(kind: CardKind, id: string, card: unknown, revision = 1): TrayCard {
  const ref: CardRef = { hostInstanceId: 'h1', runId: RUN, requestId: id, kind, revision }
  return { key: cardKey(ref), ref, runTag: 'R1', runKind: 'work', arrivedSeq: 1, kind, card } as TrayCard
}

const applied = (requestId: string): DecisionOutcome => ({ status: 'applied', runId: RUN, requestId })

interface Harness {
  bus: InputBus
  clock: { t: number }
  calls: { card: TrayCard; call: DecisionCall }[]
  onLeave: ReturnType<typeof vi.fn>
  onViewText: ReturnType<typeof vi.fn>
  frame(): string
  press(e: InputEvent | string): Promise<void>
  set(p: Partial<DecisionTrayProps>): Promise<void>
  unmount(): void
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

async function mount(initial: Partial<DecisionTrayProps> & { cards: TrayCard[]; compact?: boolean }, env: Partial<TuiEnv> = {}, outcome?: (call: DecisionCall) => Promise<DecisionOutcome>): Promise<Harness> {
  const bus = new InputBus()
  const clock = { t: 10_000 }
  const calls: Harness['calls'] = []
  const onLeave = vi.fn()
  const onViewText = vi.fn(async () => {})
  let props: DecisionTrayProps = {
    width: 100,
    height: 20,
    focused: true,
    variant: 'full',
    resolved: [],
    onDecide: async (card, call) => {
      calls.push({ card, call })
      return outcome ? outcome(call) : applied(card.ref.requestId)
    },
    onViewText,
    onLeave,
    now: () => clock.t,
    ...initial
  }
  const tree = (p: DecisionTrayProps) => (
    <TuiEnvContext.Provider value={{ ...DEFAULT_TUI_ENV, ...env }}>
      <InputBusContext.Provider value={bus}>
        <DecisionTray {...p} />
      </InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
  const r = render(tree(props))
  await tick()
  return {
    bus,
    clock,
    calls,
    onLeave,
    onViewText,
    frame: () => r.lastFrame() ?? '',
    press: async (e) => {
      bus.dispatch(typeof e === 'string' ? key(e) : e, 'tray')
      await tick()
    },
    set: async (p) => {
      props = { ...props, ...p }
      r.rerender(tree(props))
      await tick()
    },
    unmount: () => r.unmount()
  }
}

describe('compact proposal preview', () => {
  it.each([70, 120, 200])('keeps a bounded proposal card with full review at %s columns', async (width) => {
    const c = tray('proposal', 'architecture', {
      id: 'architecture', kind: 'architecture', title: 'Desktop and terminal architecture',
      payload: { summary: 'Keep the existing application boundaries. '.repeat(20), stack: ['STACK-DETAIL-MARKER'], modules: [], conventions: ['FULL-REVIEW-MARKER'], commands: [], risks: [] }
    })
    const height = trayHeight([c], width, 50, false)
    expect(height).toBeLessThanOrEqual(7)
    const h = await mount({ cards: [c], compact: true, width, height })
    expect(h.frame()).toContain('Desktop and terminal architecture')
    expect(h.frame()).toContain('[v] Review')
    expect(h.frame()).toContain('[y] Approve')
    expect(h.frame()).toContain('Review architecture')
    expect(h.frame()).not.toContain('Approve architecture proposal')
    expect(h.frame().split('\n').every(line => textWidth(line) <= Math.min(width, 96))).toBe(true)
    expect(h.frame()).not.toContain('STACK-DETAIL-MARKER')
    expect(h.frame()).not.toContain('Esc Back')
    expect(h.frame().split('Esc to type')).toHaveLength(2)
    h.clock.t += 1000
    await h.press('v')
    expect(h.onViewText.mock.calls[0]?.[1]).toContain('STACK-DETAIL-MARKER')
    expect(h.onViewText.mock.calls[0]?.[1]).toContain('FULL-REVIEW-MARKER')
    expect(h.calls).toHaveLength(0)
    h.unmount()
  })
})

describe('DecisionTray: card-swap guard', () => {
  it('ignores a key within 750 ms of a swap and decides the new card with the same key after it', async () => {
    const a = tray('permission', 'a', permission('a'))
    const b = tray('permission', 'b', permission('b'))
    const h = await mount({ cards: [a] })
    // The tray just appeared: inside the window.
    await h.press('y')
    expect(h.calls).toHaveLength(0)
    h.clock.t += 750
    await h.press('y')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].call.payload).toMatchObject({ requestId: 'a', decision: { behavior: 'allow', scope: 'once' } })

    // The card swaps to b; a key 100 ms later is ignored.
    await h.set({ cards: [b] })
    h.clock.t += 100
    await h.press('y')
    expect(h.calls).toHaveLength(1)
    expect(h.frame()).toContain('...')
    h.clock.t += 650
    await h.press('y')
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].call.payload).toMatchObject({ requestId: 'b', expectedRevision: 1 })
    h.unmount()
  })

  it('measures a key that arrives before the new frame against the new card', async () => {
    const a = tray('permission', 'a', permission('a'))
    const h = await mount({ cards: [a] })
    h.clock.t += 1000
    // A revision change of the same request restarts the window too.
    await h.set({ cards: [tray('permission', 'a', permission('a'), 2)] })
    await h.press('y')
    expect(h.calls).toHaveLength(0)
    h.clock.t += 750
    await h.press('y')
    expect(h.calls[0].call.payload).toMatchObject({ requestId: 'a', expectedRevision: 2 })
    h.unmount()
  })

  it('takes keys only while focused; Esc and Shift+Tab leave', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))], focused: false })
    h.clock.t += 1000
    expect(h.bus.dispatch(key('y'), 'tray')).toBe(false)
    await h.set({ focused: true })
    await h.press(named('escape'))
    expect(h.onLeave).toHaveBeenCalledTimes(1)
    await h.press(named('backtab'))
    expect(h.onLeave).toHaveBeenCalledTimes(2)
    expect(h.calls).toHaveLength(0)
    h.unmount()
  })
})

describe('DecisionTray: two-step confirmations', () => {
  it("'a' sends nothing until confirmed, then sends allow project", async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))] })
    h.clock.t += 1000
    await h.press('a')
    expect(h.calls).toHaveLength(0)
    expect(h.frame()).toContain('Always allow for project (saved to permission rules)? a/y to confirm | Esc cancels')
    await h.press('a')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].call).toEqual({ channel: 'runs:decide', payload: { runId: RUN, requestId: 'a', expectedRevision: 1, decision: { behavior: 'allow', scope: 'project' } } })
    h.unmount()
  })

  it('y confirms too; Esc cancels', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))] })
    h.clock.t += 1000
    await h.press('a')
    await h.press(named('escape'))
    expect(h.frame()).not.toContain('to confirm')
    expect(h.onLeave).not.toHaveBeenCalled()
    await h.press('a')
    await h.press('y')
    expect(h.calls).toHaveLength(1)
    h.unmount()
  })

  it("closes with 'Resolved in another window' when the card is removed and the desktop decided it", async () => {
    const a = tray('permission', 'a', permission('a'))
    const h = await mount({ cards: [a] })
    h.clock.t += 1000
    await h.press('a')
    expect(h.frame()).toContain('to confirm')
    const resolved: ResolvedCardInfo[] = [{ key: a.key, ref: a.ref, cancelled: false, decidedBy: { surface: 'desktop' }, at: h.clock.t }]
    await h.set({ cards: [], resolved })
    expect(h.frame()).not.toContain('to confirm')
    expect(h.frame()).toContain('Resolved in another window (the desktop app)')
    await h.press('a')
    expect(h.calls).toHaveLength(0)
    h.unmount()
  })

  it("another terminal UI's decision closes a confirmation with 'Resolved in another window' too", async () => {
    const a = tray('permission', 'a', permission('a'))
    const h = await mount({ cards: [a] })
    h.clock.t += 1000
    await h.press('a')
    expect(h.frame()).toContain('to confirm')
    const resolved: ResolvedCardInfo[] = [{ key: a.key, ref: a.ref, cancelled: false, decidedBy: { surface: 'tui' }, at: h.clock.t }]
    await h.set({ cards: [], resolved })
    expect(h.frame()).toContain('Resolved in another window (the terminal UI)')
    expect(h.calls).toHaveLength(0)
    h.unmount()
  })

  it('closes when the bound card changes revision and never sends to the new revision', async () => {
    const h = await mount({ cards: [tray('merge', 'm', { id: 'm', runId: RUN, agentId: 'x', agentName: 'impl', branch: 'b', path: '/p', changedFiles: [], stat: '', patch: '', createdAt: 1 })] })
    h.clock.t += 1000
    await h.press('x')
    expect(h.frame()).toContain("Discard this agent's worktree")
    await h.set({ cards: [tray('merge', 'm', { id: 'm', runId: RUN, agentId: 'x', agentName: 'impl', branch: 'b', path: '/p', changedFiles: [], stat: '', patch: '', createdAt: 1 }, 2)] })
    expect(h.frame()).toContain('The card changed')
    await h.press('x')
    await h.press('y')
    expect(h.calls).toHaveLength(0)
    h.unmount()
  })

  it('names a cancelled card', async () => {
    const a = tray('permission', 'a', permission('a'))
    const h = await mount({ cards: [a] })
    h.clock.t += 1000
    await h.press('a')
    await h.set({ cards: [], resolved: [{ key: a.key, ref: a.ref, cancelled: true, at: 1 }] })
    expect(h.frame()).toContain('The card was cancelled; its run ended')
    h.unmount()
  })
})

describe('DecisionTray: TERM=dumb', () => {
  it('a single key does nothing until Enter; Esc clears it', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))] }, { dumbTerminal: true })
    h.clock.t += 1000
    await h.press('y')
    expect(h.calls).toHaveLength(0)
    expect(h.frame()).toContain('Pending: y')
    await h.press(named('escape'))
    expect(h.frame()).not.toContain('Pending')
    await h.press('y')
    await h.press(named('enter'))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].call.payload).toMatchObject({ decision: { behavior: 'allow', scope: 'once' } })
    h.unmount()
  })
})

describe('DecisionTray: notes, questions and secrets', () => {
  it('deny takes an optional note typed or pasted; blank sends the default', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a')), tray('permission', 'b', permission('b'))] })
    h.clock.t += 1000
    await h.press('n')
    // Characters go to the field, never to actions.
    await h.press('y')
    await h.press('a')
    await h.press({ type: 'paste', text: ' use\nyarn' })
    expect(h.frame()).toContain('ya use yarn')
    await h.press(named('enter'))
    expect(h.calls[0].call.payload).toMatchObject({ requestId: 'a', decision: { behavior: 'deny', message: 'ya use yarn' } })
    h.unmount()

    const h2 = await mount({ cards: [tray('permission', 'a', permission('a'))] })
    h2.clock.t += 1000
    await h2.press('n')
    await h2.press(named('enter'))
    expect(h2.calls[0].call.payload).toMatchObject({ decision: { behavior: 'deny', message: 'Denied by user' } })
    h2.unmount()
  })

  it('question: pick and submit (single), toggle and submit (multiple), custom text', async () => {
    const q: UserQuestion = {
      id: 'q',
      runId: RUN,
      agentId: 'root',
      question: 'Which DB?',
      options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'DuckDB' }],
      allowMultiple: false,
      allowFreeText: true,
      createdAt: 1
    }
    const h = await mount({ cards: [tray('question', 'q', q)] })
    h.clock.t += 1000
    await h.press(named('enter'))
    expect(h.calls).toHaveLength(0)
    expect(h.frame()).toContain('Pick an option first')
    await h.press('2')
    expect(h.frame()).toContain('(*) 2. SQLite')
    await h.press(named('enter'))
    expect(h.calls[0].call).toEqual({ channel: 'setup:answer', payload: { runId: RUN, questionId: 'q', expectedRevision: 1, answer: { selected: ['SQLite'] } } })
    h.unmount()

    const hm = await mount({ cards: [tray('question', 'q', { ...q, allowMultiple: true })] })
    hm.clock.t += 1000
    await hm.press('1')
    await hm.press(' ')
    await hm.press('3')
    await hm.press(' ')
    await hm.press('2')
    await hm.press(' ')
    await hm.press(' ')
    expect(hm.frame()).toContain('[x] 1. Postgres')
    await hm.press(named('enter'))
    expect(hm.calls[0].call.payload).toMatchObject({ answer: { selected: ['Postgres', 'DuckDB'] } })
    hm.unmount()

    const hc = await mount({ cards: [tray('question', 'q', q)] })
    hc.clock.t += 1000
    await hc.press('c')
    for (const ch of 'Mongo') await hc.press(ch)
    await hc.press(named('enter'))
    expect(hc.calls[0].call.payload).toMatchObject({ answer: { selected: [], text: 'Mongo' } })
    hc.unmount()
  })

  it('mcp install secrets are masked in every frame and sent once', async () => {
    const req: McpInstallRequest = {
      id: 'i',
      runId: RUN,
      agentId: 'root',
      reason: 'need it',
      spec: { id: 's', name: 'srv', transport: 'stdio', command: 'npx', args: ['srv@1.0.0'], source: 'agent' } as never,
      requiredSecrets: ['API_KEY'],
      createdAt: 1
    }
    const h = await mount({ cards: [tray('mcpInstall', 'i', req)] })
    h.clock.t += 1000
    await h.press('p')
    expect(h.frame()).toContain('save it to the project')
    await h.press('p')
    expect(h.frame()).toContain('Secret 1/1 API_KEY')
    await h.press(named('enter'))
    expect(h.calls).toHaveLength(0)
    expect(h.frame()).toContain('is required')
    for (const ch of 'hunter2') await h.press(ch)
    await h.press({ type: 'paste', text: 'XYZ' })
    expect(h.frame()).toContain('**********')
    await h.press(named('enter'))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].call).toEqual({
      channel: 'mcp:answerInstall',
      payload: { runId: RUN, requestId: 'i', expectedRevision: 1, decision: { approved: true, scope: 'project', secrets: { API_KEY: 'hunter2XYZ' } } }
    })
    expect(h.frame()).not.toContain('hunter2')
    h.unmount()
  })

  it('never sends twice while a call is in flight', async () => {
    let release: (o: DecisionOutcome) => void = () => {}
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))] }, {}, () => new Promise((r) => (release = r)))
    h.clock.t += 1000
    await h.press('y')
    await h.press('y')
    await h.press('s')
    expect(h.calls).toHaveLength(1)
    release(applied('a'))
    await tick()
    h.unmount()
  })
})

describe('DecisionTray: outcomes and variants', () => {
  it('shows stale-revision and already-resolved outcomes', async () => {
    const outcomes: DecisionOutcome[] = [
      { status: 'stale-revision', requestId: 'a' },
      { status: 'already-resolved', requestId: 'a', decidedBy: { surface: 'cli' } },
      { status: 'applied', requestId: 'a', applyError: 'bad role' }
    ]
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))] }, {}, async () => outcomes.shift() as DecisionOutcome)
    h.clock.t += 1000
    await h.press('y')
    expect(h.frame()).toContain('The card changed; check it again')
    await h.press('y')
    expect(h.frame()).toContain('Resolved by the CLI')
    await h.press('y')
    expect(h.frame()).toContain('It could not be applied: bad role. The agent was asked to revise.')
    h.unmount()
  })

  it('shows a rejection as its error text', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))] }, {}, async () => {
      throw Object.assign(new Error('rpc'), { data: { message: 'Scope decide is not granted' } })
    })
    h.clock.t += 1000
    await h.press('y')
    expect(h.frame()).toContain('Scope decide is not granted')
    h.unmount()
  })

  it('footer variant with one row is one line with the title and hints', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))], variant: 'footer', height: 1 })
    const lines = h.frame().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('R1 Run npm test a')
    expect(lines[0]).toContain('y Allow once')
    h.unmount()
  })

  it('R2-M2: footer variant with more rows keeps the title on one line and wraps the keys below it at separators', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a'))], variant: 'footer', height: 4, width: 60 })
    const lines = h.frame().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]).toContain('R1 Run npm test a')
    expect(lines[0]).not.toContain('y Allow once')
    const keys = lines.slice(1).join(' ')
    for (const k of ['y Allow once', 'v Full view', 'Esc Back', '? Keys']) expect(keys).toContain(k)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60)
    h.unmount()
  })

  it('full variant: header, details, hints and the next cards', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a')), tray('permission', 'b', permission('b'))] })
    const f = h.frame()
    expect(f).toContain('Needs you (2)')
    expect(f).toContain('Command: npm test a')
    expect(f).toContain('y Allow once | s Allow for session | a Always allow for project | n Deny (note)')
    expect(f).toContain('R1 Run npm test b')
    h.unmount()
  })

  it('v on a merge review opens the stat and patch', async () => {
    const h = await mount({
      cards: [tray('merge', 'm', { id: 'm', runId: RUN, agentId: 'x', agentName: 'impl', branch: 'b', path: '/p', changedFiles: ['a'], stat: ' a | 1 +', patch: '+x', createdAt: 1 })]
    })
    h.clock.t += 1000
    await h.press('v')
    expect(h.onViewText).toHaveBeenCalledTimes(1)
    const [title, text] = h.onViewText.mock.calls[0] as [string, string]
    expect(title).toBe("Merge impl's changes")
    expect(text).toContain(' a | 1 +')
    expect(text).toContain('+x')
    h.unmount()
  })
})

describe('DecisionTray: the agent and the focused card (ux-review-tui-org.md F5)', () => {
  const withAgent = (c: TrayCard, agentId: string, agentLabel: string): TrayCard => ({ ...c, agentId, agentLabel }) as TrayCard

  it('names the asking agent in the header and the footer line', async () => {
    const a = withAgent(tray('permission', 'a', permission('a')), 'r2', 'mock-lead-report-2')
    const full = await mount({ cards: [a] })
    expect(full.frame().split('\n')[0]).toBe('> Needs you (1) | R1 | mock-lead-report-2 | permission: Run npm test a')
    full.unmount()
    const footer = await mount({ cards: [a], variant: 'footer', height: 1 })
    expect(footer.frame()).toContain('R1 mock-lead-report-2: ')
    footer.unmount()
    const none = await mount({ cards: [tray('permission', 'b', permission('b'))] })
    expect(none.frame().split('\n')[0]).toBe('> Needs you (1) | R1 | permission: Run npm test b')
    none.unmount()
  })

  it('focusKey shows that card first and keeps the others in order; an unknown key changes nothing', async () => {
    const a = tray('permission', 'a', permission('a'))
    const b = tray('permission', 'b', permission('b'))
    const c = tray('permission', 'c', permission('c'))
    const h = await mount({ cards: [a, b, c], focusKey: c.key })
    expect(h.frame().split('\n')[0]).toContain('Run npm test c')
    expect(h.frame()).toContain('Run npm test a')
    h.unmount()
    const same = await mount({ cards: [a, b, c], focusKey: 'gone' })
    expect(same.frame().split('\n')[0]).toContain('Run npm test a')
    same.unmount()
    // Decisions go to the card shown on top.
    const decide = await mount({ cards: [a, b], focusKey: b.key })
    decide.clock.t += 800
    await decide.press('y')
    expect(decide.calls[0].card.ref.requestId).toBe('b')
    decide.unmount()
  })
})
