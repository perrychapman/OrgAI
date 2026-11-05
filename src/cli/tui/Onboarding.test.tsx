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

function mount(c?: ProjectPathCheck, env: Partial<TuiEnv> = {}) {
  const bus = new InputBus()
  const choices: OnboardingChoice[] = []
  const onCancel = vi.fn()
  const r = render(
    <TuiEnvContext.Provider value={{ ...DEFAULT_TUI_ENV, ...env }}>
      <InputBusContext.Provider value={bus}>
        <Onboarding folder="/work/repo" check={c} onChoose={(x) => choices.push(x)} onCancel={onCancel} />
      </InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
  const send = async (e: InputEvent): Promise<void> => {
    bus.dispatch(e, 'onboarding')
    await new Promise((r) => setTimeout(r, 5))
  }
  return { r, choices, onCancel, send }
}

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
    expect(m.r.lastFrame()).toContain('Edits: on')
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
