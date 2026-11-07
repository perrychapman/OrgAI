import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectPathCheck } from '../../shared/types'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from './context'
import { Onboarding, QUICK_NOTE, importSummary, type OnboardingChoice } from './Onboarding'
import type { InputEvent, KeyEvent, TuiEnv } from './types'

const key = (ch: string, extra: Partial<KeyEvent> = {}): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch, ...extra })
const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })

const check = (agentSources?: ProjectPathCheck['agentSources']): ProjectPathCheck => ({
  exists: true,
  isDirectory: true,
  isGitRepo: true,
  suggestedName: 'repo',
  empty: false,
  ...(agentSources ? { agentSources } : {})
})

function mount(c?: ProjectPathCheck, env: Partial<TuiEnv> = {}, layout: { width?: number; height?: number; accessNotice?: string; decisionsInDesktop?: boolean; busy?: string; checking?: boolean } = {}) {
  const bus = new InputBus()
  const choices: OnboardingChoice[] = []
  const onCancel = vi.fn()
  const r = render(
    <TuiEnvContext.Provider value={{ ...DEFAULT_TUI_ENV, ...env }}>
      <InputBusContext.Provider value={bus}>
        <Onboarding folder="/work/repo" check={c} {...layout} onChoose={(x) => choices.push(x)} onCancel={onCancel} />
      </InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
  const send = async (e: InputEvent): Promise<void> => {
    bus.dispatch(e, 'onboarding')
    await new Promise((r) => setTimeout(r, 5))
  }
  return { r, choices, onCancel, send, bus }
}

describe('Onboarding copy (#30 L8, L2)', () => {
  it('explains the Architect and what Esc and q do', () => {
    const a = mount(check())
    const f = a.r.lastFrame() ?? ''
    expect(f).toContain('built-in setup assistant')
    expect(f).toContain('uses tokens')
    expect(f).toContain('Esc or q leaves without creating a project')
    a.r.unmount()
  })

  it('a rejected key shows a one-line hint naming the valid keys; a valid key clears it', async () => {
    const a = mount(check())
    await a.send(key('x'))
    expect(a.r.lastFrame()).toContain('"x" is not a choice. Keys: 1, 2 or 3, e (edits), Esc or q (leave).')
    expect(a.choices).toEqual([])
    await a.send(key('e'))
    expect(a.r.lastFrame()).not.toContain('is not a choice')
    a.r.unmount()
    const b = mount(check([{ source: 'claude-code', label: 'Claude Code', agentCount: 2 }] as never))
    await b.send(key('x'))
    expect(b.r.lastFrame()).toContain('Keys: 1, 2, 3, i,')
    b.r.unmount()
  })

  it('has no SGR codes with colour off', () => {
    const a = mount(check(), { color: false })
    // eslint-disable-next-line no-control-regex
    expect(a.r.lastFrame()).not.toMatch(/\x1b\[/)
    a.r.unmount()
  })
})

describe('Onboarding', () => {
  it('shows the folder and the three options with the quick-run note; [i] only with agent sources', () => {
    const a = mount(check())
    const f = a.r.lastFrame() ?? ''
    expect(f).toContain('/work/repo')
    expect(f).toContain('[1] Quick run in this folder')
    expect(f).toContain(QUICK_NOTE)
    expect(f).toContain('[2] Set up project with the Architect')
    expect(f).toContain('[3] Create project with default team')
    expect(f).not.toContain('[i]')
    a.r.unmount()

    const b = mount(
      check([
        { source: 'claude', label: 'Claude Code', agentCount: 2 },
        { source: 'codex', label: 'Co\x1b[31mdex', agentCount: 1 }
      ])
    )
    const g = b.r.lastFrame() ?? ''
    expect(g).toContain('[i] Import 3 detected agent definitions')
    expect(g).toContain('Codex')
    expect(g).not.toContain('\x1b[31m')
    b.r.unmount()
  })

  it('e toggles edits for the quick run; each choice is reported', async () => {
    const m = mount(check([{ source: 'claude', label: 'Claude Code', agentCount: 2 }]))
    await m.send(key('1'))
    await m.send(key('e'))
    expect(m.r.lastFrame()).toContain('Edits: allowed')
    await m.send(key('1'))
    await m.send(key('2'))
    await m.send(key('3'))
    await m.send(key('i'))
    expect(m.choices).toEqual([
      { kind: 'quick', allowEdits: false },
      { kind: 'quick', allowEdits: true },
      { kind: 'architect' },
      { kind: 'default' },
      { kind: 'import', sources: ['claude'] }
    ])
    m.r.unmount()
  })

  it('i does nothing without agent sources', async () => {
    const m = mount(check())
    await m.send(key('i'))
    expect(m.choices).toEqual([])
    m.r.unmount()
  })

  it('Esc and q cancel', async () => {
    const m = mount(check())
    await m.send(named('escape'))
    await m.send(key('q'))
    expect(m.onCancel).toHaveBeenCalledTimes(2)
    m.r.unmount()
  })

  it('TERM=dumb: a key picks, Enter confirms', async () => {
    const m = mount(check(), { dumbTerminal: true })
    await m.send(key('3'))
    expect(m.choices).toEqual([])
    await m.send(named('enter'))
    expect(m.choices).toEqual([{ kind: 'default' }])
    m.r.unmount()
  })

  it('defaults to quick and moves the selection with arrows before Enter', async () => {
    const m = mount(check())
    await m.send(named('enter'))
    await m.send(named('down'))
    await m.send(named('enter'))
    await m.send(named('down'))
    await m.send(named('enter'))
    await m.send(named('up'))
    await m.send(named('enter'))
    expect(m.choices).toEqual([
      { kind: 'quick', allowEdits: false },
      { kind: 'architect' },
      { kind: 'default' },
      { kind: 'architect' }
    ])
    expect(m.r.lastFrame()).toContain('> [2] Set up project with the Architect')
    m.r.unmount()
  })

  it('uses the latest selection when navigation events arrive in one input burst', async () => {
    const m = mount(check())
    m.bus.dispatch(named('down'), 'onboarding')
    m.bus.dispatch(named('down'), 'onboarding')
    m.bus.dispatch(named('enter'), 'onboarding')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(m.choices).toEqual([{ kind: 'default' }])
    m.r.unmount()
  })

  it('uses a compact layout at 60x16 without hiding a choice', () => {
    const m = mount(check(), {}, { width: 60, height: 16 })
    const frame = m.r.lastFrame() ?? ''
    expect(frame).toContain('OrgAI')
    expect(frame).toContain('Your team starts here.')
    expect(frame).toContain('Folder: /work/repo')
    expect(frame).toContain('[1] Quick run in this folder')
    expect(frame).toContain('[2] Set up project with the Architect')
    expect(frame).toContain('[3] Create project with default team')
    expect(frame).not.toContain(QUICK_NOTE)
    expect(frame.split('\n').length).toBeLessThanOrEqual(16)
    expect(Math.max(...frame.split('\n').map((line) => line.length))).toBeLessThanOrEqual(60)
    m.r.unmount()
  })

  it('wraps a capability notice in the bounded panel and keeps the full warning', () => {
    const notice = 'Terminal decisions stay in the desktop app. Use Settings > Terminal access > Full control to answer here.'
    const m = mount(check(), {}, { width: 60, height: 16, accessNotice: notice })
    const frame = m.r.lastFrame() ?? ''
    expect(frame).toContain('Before you begin')
    for (const word of notice.split(' ')) expect(frame).toContain(word)
    expect(frame).toContain('[1] Quick run in this folder')
    expect(frame).toContain('[2] Set up project with the Architect')
    expect(frame).toContain('[3] Create project with default team')
    expect(frame.split('\n').length).toBeLessThanOrEqual(16)
    m.r.unmount()
  })

  it('adds the desktop approval path without changing the selected action', async () => {
    const m = mount(check(), {}, { width: 60, height: 16, decisionsInDesktop: true })
    const before = m.r.lastFrame() ?? ''
    expect(before).toContain('Approvals')
    expect(before).toContain('What terminals may do')
    await m.send(named('enter'))
    expect(m.choices).toEqual([{ kind: 'quick', allowEdits: false }])
    m.r.unmount()
  })

  it('keeps every choice visible during a tiny resize with an approval notice', () => {
    const m = mount(check(), {}, { width: 60, height: 8, decisionsInDesktop: true })
    const frame = m.r.lastFrame() ?? ''
    expect(frame).toContain('Before you begin')
    expect(frame).toContain('[1] Quick run in this folder')
    expect(frame).toContain('[2] Set up project with the Architect')
    expect(frame).toContain('[3] Create project with default team')
    expect(frame.split('\n').length).toBeLessThanOrEqual(8)
    m.r.unmount()
  })

  it('keeps pasted text inert and gives screen readers an explicit selection cue', async () => {
    const m = mount(check(), { screenReader: true, unicode: false }, { width: 60, height: 16 })
    await m.send({ type: 'paste', text: '3\n' })
    expect(m.choices).toEqual([])
    await m.send(named('down'))
    expect(m.r.lastFrame()).toContain('Selected: [2] Set up project with the Architect')
    expect(m.r.lastFrame()).not.toContain('✦')
    expect(m.r.lastFrame()).not.toContain('›')
    await m.send(named('enter'))
    expect(m.choices).toEqual([{ kind: 'architect' }])
    m.r.unmount()
  })

  it('retains the options in a wide but very short layout', () => {
    const m = mount(check(), {}, { width: 200, height: 8 })
    const frame = m.r.lastFrame() ?? ''
    expect(frame).toContain('[1] Quick run in this folder')
    expect(frame).toContain('[2] Set up project with the Architect')
    expect(frame).toContain('[3] Create project with default team')
    expect(Math.max(...frame.split('\n').map((line) => line.length))).toBeLessThanOrEqual(200)
    m.r.unmount()
  })

  it.each([{ width: 160, height: 40 }, { width: 210, height: 40 }, { width: 120, height: 40 }])('keeps imports and permission guidance visible at $width x $height', (layout) => {
    const m = mount(check([{ source: 'claude', label: 'Claude Code', agentCount: 3 }]), { unicode: true }, {
      ...layout,
      decisionsInDesktop: true,
      accessNotice: 'The CLI and host versions differ. Restart the desktop app after updating to make sure both versions match.'
    })
    const frame = m.r.lastFrame() ?? ''
    for (const label of ['[1]', '[2]', '[3]', '[i]', 'Full control', 'Enter']) expect(frame.replace(/\s+/g, ' ')).toContain(label)
    expect(frame.split('\n').length).toBeLessThanOrEqual(layout.height)
    expect(Math.max(...frame.split('\n').map(row => row.length))).toBeLessThanOrEqual(layout.width)
    m.r.unmount()
  })

  it('keeps a large screen-reader view linear and consumes choices while setup is busy', async () => {
    const m = mount(check(), { screenReader: true }, { width: 120, height: 40, busy: 'Creating your project', decisionsInDesktop: true })
    const frame = m.r.lastFrame() ?? ''
    expect(frame).toContain('Selected: [1]')
    expect(frame).not.toContain('QUICK RUN')
    expect(frame).toContain('Please wait')
    expect(frame).not.toContain('Enter to continue')
    expect(frame.replace(/\s+/g, ' ')).toContain('Full control')
    await m.send(key('3'))
    await m.send(named('enter'))
    expect(m.choices).toEqual([])
    m.r.unmount()
  })

  it('importSummary sums counts and keeps each source once', () => {
    expect(
      importSummary(
        check([
          { source: 'claude', label: 'A', agentCount: 2 },
          { source: 'claude', label: 'B', agentCount: 3 }
        ])
      )
    ).toEqual({ count: 5, sources: ['claude'], labels: ['A', 'B'] })
  })
})
