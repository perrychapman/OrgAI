/**
 * The shell of the real App (issues #27-#32): input queued across a focus change ("/runs\r" in one chunk), overlays that
 * wrap and show where you are, `?` on the composer, the run named in the placeholder, the one-time "needs you" notice,
 * Tab in inline mode and the frame at four terminal sizes. Real Composer, palette and slash commands over a hand-built
 * state; nothing talks to a host.
 */
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest, RunEvent } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { App, KEY_DROPPED_NOTICE, INPUT_QUEUE_FULL_NOTICE, overlayCue, placeholderFor, wrapOverlayLines } from './App'
import { DEFAULT_TUI_ENV } from './context'
import { KeyParser } from './input/keys'
import { textWidth } from './panes/text'
import { addNotice, applyEvent, applyRecord, createInitialState, setActiveRun } from './state'
import type { InputEvent, KeyEvent, TuiEnv, TuiLaunch, TuiState } from './types'

const key = (ch: string, extra: Partial<KeyEvent> = {}): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch, ...extra })
const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40))
// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

let seq = 0
function stateWith(opts: { title?: string; waiting?: boolean; second?: boolean } = {}): TuiState {
  let s: TuiState = { ...createInitialState('/work'), project: project('p1', '/work', { name: 'Demo' }), connection: 'live' }
  s = applyRecord(s, record(summary('run1', { status: 'idle', prompt: 'Build the thing', ...(opts.title ? { title: opts.title } : {}) })))
  if (opts.second) s = applyRecord(s, record(summary('run2', { status: 'idle', prompt: 'Another' })))
  s = setActiveRun(s, 'run1')
  if (opts.waiting) {
    const request = { id: 'perm1', runId: 'run1', agentId: 'root', toolName: 'Bash', input: { command: 'npm test' }, summary: 'Run npm test' } as PermissionRequest
    s = applyEvent(s, { seq: ++seq, event: { type: 'permission.request', runId: 'run1', request } as RunEvent })
  }
  return s
}

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

function mount(opts: { cols: number; rows: number; env?: Partial<TuiEnv>; inline?: boolean; inproc?: boolean; state?: TuiState; launch?: TuiLaunch; now?: () => number }) {
  let state = opts.state ?? stateWith()
  const listeners = new Set<(e: InputEvent) => void>()
  // A live store: notify() adds a notice and tells subscribers, so notice lifetimes can be watched in frames.
  const subs = new Set<() => void>()
  const setState = (next: TuiState): void => {
    state = next
    for (const f of [...subs]) f()
  }
  const session = {
    getState: () => state,
    getStaged: () => ({}),
    stage: vi.fn(),
    setPermissionMode: vi.fn(async () => ({ run: {}, applied: true })),
    setState,
    subscribe: (cb: () => void) => (subs.add(cb), () => void subs.delete(cb)),
    hostKind: 'daemon',
    hostInstanceId: 'h1',
    focusRun: vi.fn(async () => undefined),
    setComposeTarget: vi.fn(),
    submitPrompt: vi.fn(async () => undefined),
    startQuick: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    decide: vi.fn(async () => ({ status: 'decided' })),
    worktreeDiff: vi.fn(async () => ({ stat: '', patch: '' })),
    listRuns: vi.fn(async () => []),
    startRetro: vi.fn(),
    openInDesktop: vi.fn(),
    resync: vi.fn(async () => undefined),
    notify: vi.fn((text: string, tone?: 'dim' | 'warn' | 'danger') => setState(addNotice(state, text, tone, (opts.now ?? (() => 1_000_000))()))),
    close: vi.fn(async () => undefined)
  }
  const terminal = {
    bufferMode: opts.inline ? ('inline' as const) : ('fullscreen' as const),
    bracketedPaste: false,
    enter: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    restore: vi.fn(),
    size: () => ({ cols: opts.cols, rows: opts.rows }),
    onResize: () => () => undefined
  }
  const env: TuiEnv = { ...DEFAULT_TUI_ENV, bufferMode: terminal.bufferMode, unicode: true, ...opts.env }
  const r = render(
    <App
      session={session as never}
      terminal={terminal as never}
      env={env}
      launch={opts.launch ?? {}}
      conn={{ client: {} as never, hello: { grantedScopes: ['read', 'operate', 'decide'] } as never, started: false, ...(opts.inproc ? { inproc: {} } : {}) } as never}
      input={{ subscribe: (fn) => (listeners.add(fn), () => void listeners.delete(fn)) }}
      processEnv={{}}
      now={opts.now ?? (() => 1_000_000)}
      onExit={() => undefined}
    />
  )
  mounted.push(r)
  const emit = (...events: InputEvent[]): void => {
    for (const e of events) for (const fn of [...listeners]) fn(e)
  }
  const send = async (...events: InputEvent[]): Promise<void> => {
    for (const e of events) {
      emit(e)
      await tick()
    }
  }
  return { r, session, emit, send, frame: () => plain(r.lastFrame() ?? '') }
}

describe('conversation-first layout', () => {
  it.each([
    { cols: 80, status: 'active' as const, hasSteps: true, shown: false },
    { cols: 80, status: 'blocked' as const, hasSteps: true, shown: true },
    { cols: 120, status: 'active' as const, hasSteps: false, shown: false }
  ])('preserves compact screens and ignores empty checklists: %j', async ({ cols, status, hasSteps, shown }) => {
    const run = record(summary('run1', { status: 'running' }), {
      plan: { goal: 'Unique checklist goal', status, autoContinues: 0, updatedAt: 1,
        steps: hasSteps ? [{ id: 'p1', title: 'Check the work', status: 'pending' }] : [] }
    })
    const m = mount({ cols, rows: 40, state: applyRecord(stateWith(), run) })
    await tick()
    expect(m.frame().includes('Tasks')).toBe(shown)
  })

  it('keeps every team member visible when focusing the roster above a plan', async () => {
    const run = record(summary('run1', { status: 'running' }))
    run.agents.root = { ...run.agents.root, state: 'tool', activity: '$ npm test' }
    for (let i = 1; i <= 4; i++) run.agents[`agent${i}`] = { ...run.agents.root, id: `agent${i}`, parentId: 'root', name: `Member ${i}`, handle: `member-${i}` }
    run.plan = { goal: 'Complete the work', status: 'active', autoContinues: 0, updatedAt: 1, steps: [{ id: 'p1', title: 'Check the result', status: 'pending' }] }
    const m = mount({ cols: 120, rows: 40, state: applyRecord(stateWith(), run) })
    await tick()
    await m.send(named('tab'), named('tab'))
    const roster = m.frame().split('Tasks')[0]
    for (let i = 1; i <= 4; i++) expect(roster).toContain(`member-${i}`)
    expect(m.frame()).toContain('Check the result')
  })

  it('uses the available sidebar height for all eleven tasks beneath a five-agent team', async () => {
    const run = record(summary('run1', { status: 'running' }))
    for (let i = 1; i <= 4; i++) run.agents[`agent${i}`] = { ...run.agents.root, id: `agent${i}`, parentId: 'root', name: `Member ${i}`, handle: `member-${i}` }
    run.plan = { goal: 'Complete the work', status: 'active', autoContinues: 0, updatedAt: 1,
      steps: Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, title: `Checklist task ${i + 1}`, status: i === 7 ? 'in_progress' as const : 'pending' as const })) }
    const m = mount({ cols: 120, rows: 52, state: applyRecord(stateWith(), run) })
    await tick()
    const checklist = m.frame().split('Tasks')[1] ?? ''
    for (let i = 1; i <= 11; i++) expect(checklist).toContain(`Checklist task ${i}`)
    expect(checklist).not.toContain('Tab to view')
    expect(checklist).toContain('0% · Estimating')
  })

  it.each(['active', 'blocked', 'done'] as const)('shows the %s run plan beneath the team automatically', async (status) => {
    const state = applyRecord(stateWith(), record(summary('run1', { status: 'running' }), {
      plan: { goal: 'Build the dashboard', status, autoContinues: 0, updatedAt: 1, steps: [
        { id: 'p1', title: 'Inspect the project', status: 'done' },
        { id: 'p2', title: 'Build the dashboard', status: 'in_progress' },
        { id: 'p3', title: 'Review the result', status: 'pending' }
      ] }
    }))
    const m = mount({ cols: 120, rows: 40, state })
    await tick()
    const lines = m.frame().split('\n')
    const team = lines.findIndex(line => /Agents|Team/.test(line))
    const plan = lines.findIndex(line => /Tasks/.test(line))
    expect(plan).toBeGreaterThan(team)
    expect(plan - team).toBeLessThanOrEqual(5)
    expect(m.frame()).toContain('1/3 done')
    expect(m.frame()).toContain('✓ Inspect the project')
    expect(m.frame()).toContain('◐ Build the dashboard')
    expect(m.frame()).toContain('○ Review the result')
  })

  it.each([{ cols: 120, rows: 40 }, { cols: 80, rows: 24 }])('keeps quit confirmation compact and the conversation visible at $cols columns', async ({ cols, rows }) => {
    const state = applyRecord(stateWith(), record(summary('run1', { status: 'idle' }), {
      transcript: [{ id: 'answer', agentId: 'root', at: 1, block: { kind: 'text', text: 'Keep this conversation visible.' } }]
    }))
    const m = mount({ cols, rows, state, inproc: true })
    await tick()
    await m.send(key('d', { ctrl: true }))
    const frame = m.frame().split('\n')
    expect(m.frame()).toContain('Quit and stop 1 active run?')
    expect(m.frame()).toContain('Keep this conversation visible.')
    const question = frame.findIndex(line => line.includes('Quit and stop'))
    const prompt = frame.findIndex(line => line.includes('Message R1'))
    expect(prompt - question).toBeGreaterThan(0)
    expect(prompt - question).toBeLessThanOrEqual(5)
    expect(frame).toHaveLength(rows)
    await m.send(named('escape'))
    expect(m.frame()).not.toContain('Quit and stop')
    expect(m.frame()).toContain('Keep this conversation visible.')
  })

  it('expands tool details with Ctrl+O without changing the composer draft', async () => {
    const state = applyRecord(stateWith(), record(summary('run1', { status: 'idle' }), {
      transcript: [
        { id: 'call', agentId: 'root', at: 1, block: { kind: 'tool_use', id: 'tool1', name: 'Bash', input: { command: '/bin/zsh -lc pwd' } } },
        { id: 'result', agentId: 'root', at: 2, block: { kind: 'tool_result', toolUseId: 'tool1', content: '/work/expanded-details-marker', isError: false } }
      ]
    }))
    const m = mount({ cols: 120, rows: 40, state })
    await tick()
    expect(m.frame()).toContain('Ran pwd')
    expect(m.frame()).not.toContain('expanded-details-marker')
    await m.send(key('h'), key('i'), key('o', { ctrl: true }))
    expect(m.frame()).toContain('expanded-details-marker')
    expect(m.frame()).toContain('/bin/zsh -lc pwd')
    await m.send(key('o', { ctrl: true }))
    expect(m.frame()).not.toContain('expanded-details-marker')
    await m.send(named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('hi')
  })

  it('tabs through the conversation before the right sidebar', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(named('tab'), key('?'))
    expect(m.frame()).toContain('Keys: Transcript')
    await m.send(named('escape'), named('tab'), key('?'))
    expect(m.frame()).toContain('Keys: Agents')
  })

  it('keeps arriving approvals inline when the user recently typed, even after clearing the draft', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 120, rows: 40, now: () => clock.t })
    await tick()
    await m.send(key('x'), key('c', { ctrl: true }))
    m.session.setState(stateWith({ waiting: true }))
    await tick()
    clock.t += 1000
    await m.send(key('s'), key('u'), key('r'), key('e'))
    expect(m.session.decide).not.toHaveBeenCalled()
    expect(m.frame()).toContain('Shift+Tab to choose')
    await m.send(named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('sure')
    await m.send(named('backtab'))
    await m.send(key('y'))
    expect(m.session.decide).toHaveBeenCalledTimes(1)
  })

  it('focuses a new approval on an empty idle prompt, guards Enter, and returns to typing', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 120, rows: 40, now: () => clock.t })
    await tick()
    m.session.setState(stateWith({ waiting: true }))
    await tick()
    expect(m.frame()).toContain('> [y] Allow once')
    expect(m.frame()).toContain('Enter confirm')
    await m.send(named('enter'))
    expect(m.session.decide).not.toHaveBeenCalled()
    clock.t += 1000
    await m.send(named('enter'))
    expect(m.session.decide).toHaveBeenCalledTimes(1)
    m.session.setState(stateWith())
    await tick()
    await m.send(key('o'), key('k'), named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('ok')
  })

  it('does not reclaim focus after Escape dismisses an automatically focused card', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 120, rows: 40, now: () => clock.t })
    await tick()
    m.session.setState(stateWith({ waiting: true }))
    await tick()
    await m.send(named('escape'))
    clock.t += 1000
    m.session.setState({ ...m.session.getState() })
    await tick()
    await m.send(key('y'), named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('y')
    expect(m.session.decide).not.toHaveBeenCalled()
  })

  it.each([{ inline: true }, { env: { dumbTerminal: true } }])('does not automatically focus when approval interaction is unavailable: %j', async (opts) => {
    const m = mount({ cols: 120, rows: 40, ...opts })
    await tick()
    m.session.setState(stateWith({ waiting: true }))
    await tick()
    await m.send(key('x'), named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('x')
    expect(m.session.decide).not.toHaveBeenCalled()
  })

  it('keeps a draft in the composer when a request arrives', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 120, rows: 40, now: () => clock.t })
    await tick()
    await m.send(key('y'), key('e'), key('s'))
    clock.t += 5000 // The draft itself protects focus even after typing has been idle.
    m.session.setState(stateWith({ waiting: true }))
    await tick()
    expect(m.frame()).toContain('Shift+Tab to choose')
    await m.send(named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('yes')
    expect(m.session.decide).not.toHaveBeenCalled()
  })

  it('shows inline approval choices without requiring a reveal shortcut', async () => {
    const m = mount({ cols: 120, rows: 40, state: stateWith({ waiting: true, title: 'Review this command' }) })
    await tick()
    expect(m.frame()).toContain('Approval needed')
    expect(m.frame()).toContain('Allow once')
    expect(m.frame()).toContain('Command: npm test')
    expect(m.frame()).not.toContain('R1*!')
    expect(m.frame()).not.toContain('1 needs you')
    expect(m.frame().split('Review this command')).toHaveLength(2)
    await m.send(named('backtab'))
    expect(m.frame()).toContain('Esc to type')
    expect(m.frame()).toContain('Command: npm test')
    expect(m.frame()).not.toContain('Alt+D to review')
    expect(m.session.decide).not.toHaveBeenCalled()
    await m.send(named('escape'))
    expect(m.frame()).toContain('Allow once')
    expect(m.frame()).toContain('Command: npm test')
  })

  it('keeps the agent room on the right and the last message just above the composer', async () => {
    let state = stateWith({ title: 'Layout preview' })
    state = applyRecord(state, record(summary('run1', { status: 'idle', title: 'Layout preview' }), {
      transcript: [{ id: 't1', agentId: 'root', at: 1, block: { kind: 'text', text: 'The updated layout is ready to try.' } }]
    }))
    const m = mount({ cols: 120, rows: 40, state })
    await tick()
    const rows = m.frame().split('\n')
    expect(rows[0].indexOf('Agents')).toBeGreaterThan(70)
    const message = rows.findIndex(row => row.includes('The updated layout is ready'))
    const prompt = rows.findIndex(row => row.includes('Message R1'))
    expect(message).toBeGreaterThan(25)
    expect(prompt - message).toBeGreaterThan(0)
    expect(prompt - message).toBeLessThanOrEqual(4)
    expect(rows[message].indexOf('The updated layout')).toBeLessThan(25)
    expect(rows.at(-1)).toContain('? keys')
    expect(rows.at(-1)).toContain('Idle')
    expect(rows.filter(row => row.includes('Ctrl+O tools'))).toHaveLength(1)
    expect(m.frame()).not.toContain('Alt+D decisions')
  })
})

describe('input across a focus change (issue #31 M9)', () => {
  it('"/runs" then Enter pushed with no render between runs /runs and sends nothing to the agent', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await tick()
    m.emit(key('/'), key('r'), key('u'), key('n'), key('s'), named('enter'))
    await tick()
    await tick()
    expect(m.session.listRuns).toHaveBeenCalledTimes(1)
    expect(m.session.submitPrompt).not.toHaveBeenCalled()
    expect(m.frame()).not.toContain('/runs')
  })

  it('#35 L2: a paste queued behind Alt+D is dropped, not replayed into the tray', async () => {
    const m = mount({ cols: 120, rows: 40, state: stateWith({ waiting: true }) })
    await tick()
    m.emit(key('d', { alt: true }), { type: 'paste', text: 'secret-looking text' })
    await tick()
    await tick()
    // The drop notice fires although no printable key was queued: only the paste was dropped.
    expect(m.session.notify.mock.calls.map((c) => String(c[0]))).toContain(KEY_DROPPED_NOTICE)
    expect(m.session.decide).not.toHaveBeenCalled()
  })

  it('#35 L3: overflowing the 512-event input queue says so once, in dim', async () => {
    const m = mount({ cols: 120, rows: 40, state: stateWith({ waiting: true }) })
    await tick()
    m.emit(key('d', { alt: true }), ...Array.from({ length: 700 }, () => key('x')))
    await tick()
    await tick()
    const calls = m.session.notify.mock.calls.filter((c) => c[0] === INPUT_QUEUE_FULL_NOTICE)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toBe('dim')
  })

  it('one KeyParser chunk "/runs\\r" does the same', async () => {
    const m = mount({ cols: 100, rows: 30 })
    await tick()
    const p = new KeyParser({ bracketedPaste: false })
    m.emit(...p.feed('/runs\r'), ...p.flush())
    await tick()
    await tick()
    expect(m.session.listRuns).toHaveBeenCalledTimes(1)
    expect(m.session.submitPrompt).not.toHaveBeenCalled()
  })
})

describe('keys queued behind a move to the tray never answer a card (issue #25 / #31 review M3, L6)', () => {
  function withMerge(): TuiState {
    const review = { id: 'mr1', runId: 'run1', agentId: 'w', agentName: 'impl', branch: 'worktree-agent-1', path: '/x', changedFiles: ['a.ts'], stat: ' a.ts | 1 +', patch: '+x', createdAt: 1 }
    return applyEvent(stateWith(), { seq: ++seq, event: { type: 'merge.request', runId: 'run1', review } as RunEvent })
  }

  it('"/inbox\\ry" on a permission card answers nothing and says to press again', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 120, rows: 40, state: stateWith({ waiting: true }), now: () => clock.t })
    await tick()
    const p = new KeyParser({ bracketedPaste: false })
    m.emit(...p.feed('/inbox\ry'), ...p.flush())
    await tick()
    await tick()
    expect(m.session.decide).not.toHaveBeenCalled()
    // The tray has focus now, and a key pressed on its own (past the card-swap window) does act.
    clock.t += 5000
    await m.send(key('y'))
    expect(m.session.decide).toHaveBeenCalledTimes(1)
  })

  it('"/inbox\\rm" on a merge review does not merge', async () => {
    const m = mount({ cols: 120, rows: 40, state: withMerge() })
    await tick()
    const p = new KeyParser({ bracketedPaste: false })
    m.emit(...p.feed('/inbox\rm'), ...p.flush())
    await tick()
    await tick()
    expect(m.session.decide).not.toHaveBeenCalled()
  })

  it('Alt+D followed by a key in one chunk answers nothing, and the key is not typed into the composer either', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 120, rows: 40, state: stateWith({ waiting: true }), now: () => clock.t })
    await tick()
    m.emit(key('d', { alt: true }), key('y'))
    await tick()
    await tick()
    expect(m.session.decide).not.toHaveBeenCalled()
    expect(m.session.notify.mock.calls.map((c) => String(c[0]))).toContain(KEY_DROPPED_NOTICE)
    expect(m.frame()).not.toMatch(/❯ y/)
    clock.t += 5000
    await m.send(key('y'))
    expect(m.session.decide).toHaveBeenCalledTimes(1)
  })

  it('navigation and Esc still replay after the move', async () => {
    const m = mount({ cols: 120, rows: 40, state: stateWith({ waiting: true }) })
    await tick()
    m.emit(key('d', { alt: true }), named('escape'))
    await tick()
    await tick()
    expect(m.frame()).not.toContain('> Needs you')
  })
})

describe('inline footer: the card body is printed before its keys unlock (review M2)', () => {
  function withCommand(command: string): TuiState {
    const request = { id: 'perm2', runId: 'run1', agentId: 'root', toolName: 'Bash', input: { command }, summary: 'Run it' } as PermissionRequest
    return applyEvent(stateWith(), { seq: ++seq, event: { type: 'permission.request', runId: 'run1', request } as RunEvent })
  }

  it('a short command is printed into scrollback and y then answers', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 100, rows: 30, inline: true, state: withCommand('npm test'), now: () => clock.t })
    await tick()
    expect(m.frame()).toContain('Command: npm test')
    clock.t += 5000
    await m.send(key('d', { alt: true }))
    await m.send(key('y'))
    expect(m.session.decide).toHaveBeenCalledTimes(1)
  })

  for (const [cols, rows] of [
    [80, 24],
    [120, 40]
  ] as const) {
    it(`R2-M2 ${cols}x${rows}: the focused footer shows every key (n, v, Esc, ?) on rows of their own`, async () => {
      const clock = { t: 1_000_000 }
      const m = mount({ cols, rows, inline: true, state: withCommand('npm test'), now: () => clock.t })
      await tick()
      clock.t += 5000
      await m.send(key('d', { alt: true }))
      const f = m.frame()
      for (const k of ['y Allow once', 'n Deny (note)', 'v Full view', 'Esc Back', '? Keys']) expect(f).toContain(k)
      expect(f).not.toContain('Alwa…')
    })
  }

  it('R2-M2: a long (not cut) command is printed in full, and only then does y answer', async () => {
    const clock = { t: 1_000_000 }
    const cmd = 'echo ' + Array.from({ length: 40 }, (_, i) => `part${i}`).join(' ') + ' TAIL_MARK'
    const m = mount({ cols: 70, rows: 24, inline: true, state: withCommand(cmd), now: () => clock.t })
    await tick()
    expect(m.frame()).toContain('TAIL_MARK')
    clock.t += 5000
    await m.send(key('d', { alt: true }))
    await m.send(key('y'))
    expect(m.session.decide).toHaveBeenCalledTimes(1)
  })

  it('a cut command needs v even though it was printed', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 100, rows: 30, inline: true, state: withCommand('echo ' + 'x'.repeat(1500)), now: () => clock.t })
    await tick()
    expect(m.frame()).toContain('v shows all')
    clock.t += 5000
    await m.send(key('d', { alt: true }))
    await m.send(key('y'))
    expect(m.session.decide).not.toHaveBeenCalled()
  })
})

describe('? on the composer (issue #30 L5)', () => {
  it('any other printable key closes the keys overlay and is typed into the composer (L3)', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(key('?'))
    expect(m.frame()).toContain('Keys: Composer')
    await m.send(key('h'))
    expect(m.frame()).not.toContain('Keys: Composer')
    await m.send(named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('h')
  })

  it('opens the composer keys on an empty composer, types ? when there is text', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(key('?'))
    expect(m.frame()).toContain('Keys: Composer')
    await m.send(named('escape'))
    await m.send(key('a'), key('?'))
    expect(m.frame()).not.toContain('Keys: Composer')
    expect(m.frame()).toContain('a?')
  })
})

describe('text overlays wrap and show a position cue (issue #30 M8)', () => {
  const box = (f: string): string => f.slice(f.indexOf('┌'), f.indexOf('└'))
  it('80x24: no line is cut, the hint row says where you are and PgDn reaches the end', async () => {
    const m = mount({ cols: 80, rows: 24 })
    await m.send(key('?'))
    const f = m.frame()
    expect(f).toContain('Keys: Composer')
    expect(f).toMatch(/lines 1-[0-9]+ of [0-9]+ · more below/)
    expect(box(f)).not.toContain('…')
    for (let i = 0; i < 12; i++) await m.send(named('pagedown'))
    expect(m.frame()).toMatch(/of [0-9]+ · end/)
  })

  it('120x40: everything fits, wrapped, with no cue', async () => {
    const m = mount({ cols: 120, rows: 40 })
    await m.send(key('?'))
    const f = m.frame()
    expect(f).toContain('Keys: Composer')
    expect(box(f)).not.toContain('…')
    expect(f).not.toMatch(/lines 1-/)
    expect(f).toContain('back (/focus)')
  })

  it('inline mode draws the overlay without a border', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true })
    await m.send(key('?'))
    expect(m.frame()).toContain('Keys: Composer')
    expect(m.frame()).not.toMatch(/[┌┐└┘│]/)
  })

  it('pure helpers', () => {
    expect(wrapOverlayLines(['a '.repeat(30)], 20).every((l) => l.length <= 20)).toBe(true)
    expect(overlayCue(0, 10, 5, ' · ')).toBe('')
    expect(overlayCue(0, 10, 40, ' · ')).toBe('lines 1-10 of 40 · more below')
    expect(overlayCue(30, 10, 40, ' · ')).toBe('lines 31-40 of 40 · end')
  })
})

describe('the composer names the run (issue #29 M3)', () => {
  it('placeholderFor', () => {
    const s = stateWith({ title: 'Fix the login bug' })
    expect(placeholderFor('send', s, 80)).toBe('Message R1 · Fix the login bug')
    expect(placeholderFor('send', s, 24)).toMatch(/^Message R1/)
    expect(placeholderFor('send', s, 24).length).toBeLessThanOrEqual(24)
    expect(placeholderFor('continue', s, 80)).toBe('Send to continue R1 with its memory')
    expect(placeholderFor('start', s, 80)).toBe('Describe the work to start a run')
  })

  it('placeholderFor follows the separator and ellipsis rules of the env (L1)', () => {
    const s = stateWith({ title: 'Fix the login bug in the billing module for everyone' })
    const env = (extra: Partial<TuiEnv>): TuiEnv => ({ ...DEFAULT_TUI_ENV, unicode: true, ...extra })
    expect(placeholderFor('send', s, 40, env({}))).toMatch(/^Message R1 · .*…$/)
    expect(placeholderFor('send', s, 40, env({ unicode: false }))).toMatch(/^Message R1 \| .*\.\.\.$/)
    const sr = placeholderFor('send', s, 40, env({ screenReader: true }))
    expect(sr).toMatch(/^Message R1, /)
    expect(sr).not.toContain('·')
  })

  it('shows it in the frame', async () => {
    const m = mount({ cols: 100, rows: 30, state: stateWith({ title: 'Fix the login bug' }) })
    await tick()
    expect(m.frame()).toContain('Message R1 · Fix the login bug')
  })

  it('says once that the opened run needs you when it is not the newest', async () => {
    const m = mount({ cols: 100, rows: 30, state: stateWith({ waiting: true, second: true }) })
    await tick()
    const said = m.session.notify.mock.calls.filter((c) => String(c[0]).startsWith('Opened R1: it needs you'))
    expect(said.length).toBe(1)
  })

  it('stays quiet when the launch named a run', async () => {
    const m = mount({ cols: 100, rows: 30, state: stateWith({ waiting: true, second: true }), launch: { runId: 'run1' } })
    await tick()
    expect(m.session.notify.mock.calls.filter((c) => String(c[0]).startsWith('Opened R1')).length).toBe(0)
  })
})

describe('inline Tab (issue #27)', () => {
  it('stays on the composer and explains once', async () => {
    const m = mount({ cols: 80, rows: 24, inline: true })
    await m.send(named('tab'), named('tab'), named('backtab'))
    expect(m.session.notify.mock.calls.filter((c) => String(c[0]).startsWith('Panes need a full-screen')).length).toBe(1)
    await m.send(key('h'))
    expect(m.frame()).toContain('h')
  })
})

describe('the shell at four sizes', () => {
  for (const [cols, rows] of [
    [120, 40],
    [100, 30],
    [80, 24],
    [70, 24]
  ] as const) {
    it(`${cols}x${rows}: status, composer with the run name and no line wider than the terminal`, async () => {
      const m = mount({ cols, rows, state: stateWith({ title: 'Fix the login bug' }) })
      await tick()
      const f = m.frame()
      expect(f).toContain('Message R1')
      for (const l of f.split('\n')) expect(textWidth(l)).toBeLessThanOrEqual(cols)
      expect(f.split('\n').length).toBeLessThanOrEqual(rows)
    })
  }

  it('screen reader: no box glyphs in an overlay', async () => {
    const m = mount({ cols: 80, rows: 24, env: { screenReader: true, unicode: false } })
    await m.send(key('?'))
    expect(m.frame()).toContain('Keys: Composer')
    expect(m.frame()).not.toMatch(/[┌┐└┘│─·]/)
  })
})

describe('re-walk fixes (R2, issue #25 and #26 follow-ups)', () => {
  const NOTICE_TEXT = 'Opened R1: it needs you. /new starts a new run.'

  it('R2-M1: the first Ctrl+C shows its notice at 70x24 (and at 120x40)', async () => {
    for (const [cols, rows] of [
      [70, 24],
      [120, 40]
    ] as const) {
      const m = mount({ cols, rows, state: stateWith({ waiting: true, second: true }) })
      await tick()
      await m.send(key('c', { ctrl: true }))
      expect(m.frame(), `${cols}x${rows}`).toContain('Press Ctrl+C again to quit')
    }
  })

  it('R2-L1: a notice about the run that was open stops showing when another run is followed', async () => {
    const m = mount({ cols: 100, rows: 30, state: stateWith({ second: true }) })
    await tick()
    m.session.notify(NOTICE_TEXT)
    await tick()
    expect(m.frame()).toContain(NOTICE_TEXT)
    m.session.setState(setActiveRun(m.session.getState(), 'run2'))
    await tick()
    await tick()
    expect(m.frame()).not.toContain(NOTICE_TEXT)
    // A notice that comes after the switch shows.
    m.session.notify('Interrupting the run...', 'warn')
    await tick()
    expect(m.frame()).toContain('Interrupting the run...')
  })

  it('R2-L8: "Type the prompt for the new run." goes away once the prompt is sent', async () => {
    const m = mount({ cols: 100, rows: 30 })
    await tick()
    m.session.notify('Type the prompt for the new run.')
    await tick()
    expect(m.frame()).toContain('Type the prompt for the new run.')
    await m.send(key('h'), key('i'), named('enter'))
    expect(m.session.submitPrompt).toHaveBeenCalledWith('hi')
    expect(m.frame()).not.toContain('Type the prompt for the new run.')
  })

  it('R2-L7: with the palette open the composer draws no second input line', async () => {
    const m = mount({ cols: 100, rows: 30 })
    await tick()
    expect(m.frame()).toContain('Message R1')
    await m.send(key('/'))
    const f = m.frame()
    expect(f).toContain('/help')
    expect(f).not.toContain('Message R1')
    // Esc brings the composer back with its placeholder.
    await m.send(named('escape'))
    expect(m.frame()).toContain('Message R1')
  })

  it('R2-L6: a key that came with Alt+D is dropped with the KEY_DROPPED_NOTICE, and the swap guard does not overwrite that', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 100, rows: 30, state: stateWith({ waiting: true }), now: () => clock.t })
    await tick()
    clock.t += 100
    m.emit(key('d', { alt: true }), key('y'))
    await tick()
    await tick()
    expect(m.session.getState().notices.at(-1)?.text).toBe(KEY_DROPPED_NOTICE)
    expect(m.session.decide).not.toHaveBeenCalled()
    // y again inside the guard window: still no decision, and the dropped-key notice keeps the line.
    await m.send(key('y'))
    expect(m.session.decide).not.toHaveBeenCalled()
    expect(m.session.getState().notices.at(-1)?.text).toBe(KEY_DROPPED_NOTICE)
    expect(m.frame()).not.toContain('card just changed')
  })

  it('R2-L6: outside that moment the guard names what happened (arrived, not "changed")', async () => {
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 100, rows: 30, state: stateWith({ waiting: true }), now: () => clock.t })
    await tick()
    await m.send(key('d', { alt: true }))
    clock.t += 100
    await m.send(key('y'))
    expect(m.frame()).toContain('This card only just arrived')
    expect(m.session.decide).not.toHaveBeenCalled()
  })

  it('R2-L3: the full view opens with its own title once and a long first line is wrapped, not cut', async () => {
    const summaryLine = 'Run: cd C:\\Users\\someone\\walk\\.claude\\worktrees\\agent-abcdef0123456789 && npm test -- --reporter=verbose --run'
    const request = { id: 'p9', runId: 'run1', agentId: 'root', toolName: 'Bash', input: { command: 'npm test' }, summary: summaryLine } as PermissionRequest
    const state = applyEvent(stateWith(), { seq: ++seq, event: { type: 'permission.request', runId: 'run1', request } as RunEvent })
    const clock = { t: 1_000_000 }
    const m = mount({ cols: 70, rows: 24, state, now: () => clock.t })
    await tick()
    clock.t += 5000
    await m.send(key('d', { alt: true }))
    await m.send(key('v'))
    await tick()
    const f = m.frame()
    // The tray's own head also names the card; the overlay's title row (a line holding only the title) must appear once.
    expect(f.split('\n').filter((l) => /^[│ ]*Run npm test[│ ]*$/.test(l)).length).toBe(1)
    const joined = f.replace(/[│\n ]+/g, '')
    expect(joined).toContain(summaryLine.replace(/ /g, '').slice(0, 100))
    expect(joined).toContain(summaryLine.replace(/ /g, '').slice(-24))
  })
})
