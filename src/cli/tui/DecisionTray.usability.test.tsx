/** Tray usability (issues #25, #28, #31, #32): focus cue, long permission cards, hints, notices, the height clamp. */
import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'
import type { CardKind, DecisionOutcome, PermissionRequest, UserQuestion } from '../../shared/types'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from './context'
import { cardFullText, hintPhrases, wrapPhrases } from './decisions'
import { DecisionTray } from './DecisionTray'
import { cardKey, type CardRef, type DecisionTrayProps, type InputEvent, type TrayCard, type TuiEnv } from './types'

const RUN = 'run_1'
const key = (ch: string): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch })
const named = (name: 'enter' | 'escape' | 'down' | 'up' | 'pagedown'): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

function tray(kind: CardKind, id: string, card: unknown): TrayCard {
  const ref: CardRef = { hostInstanceId: 'h1', runId: RUN, requestId: id, kind, revision: 1 }
  return { key: cardKey(ref), ref, runTag: 'R1', runKind: 'work', arrivedSeq: 1, kind, card } as TrayCard
}

function permission(id: string, command: string, extra: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id,
    runId: RUN,
    agentId: 'root',
    toolName: 'Bash',
    input: { command },
    summary: `Run ${id}`,
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }],
    ruleLabels: ['Bash(npm test:*)'],
    ...extra
  }
}

const LONG = Array.from({ length: 120 }, (_, i) => `echo step${i}`).join(' && ')

async function mount(initial: Partial<DecisionTrayProps> & { cards: TrayCard[] }, env: Partial<TuiEnv> = {}) {
  const bus = new InputBus()
  const clock = { t: 10_000 }
  const calls: unknown[] = []
  const notices: string[] = []
  const onViewText = vi.fn(async () => {})
  const onHelp = vi.fn()
  let props: DecisionTrayProps = {
    width: 100,
    height: 12,
    focused: true,
    variant: 'full',
    resolved: [],
    onDecide: async (card, call): Promise<DecisionOutcome> => {
      calls.push(call)
      return { status: 'applied', runId: RUN, requestId: card.ref.requestId }
    },
    onViewText,
    onLeave: () => {},
    onHelp,
    onNotice: (t) => notices.push(t),
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
  clock.t += 1000
  return {
    calls,
    notices,
    onViewText,
    onHelp,
    frame: () => r.lastFrame() ?? '',
    press: async (e: InputEvent | string) => {
      bus.dispatch(typeof e === 'string' ? key(e) : e, 'tray')
      await tick()
    },
    set: async (p: Partial<DecisionTrayProps>) => {
      props = { ...props, ...p }
      r.rerender(tree(props))
      await tick()
    },
    unmount: () => r.unmount()
  }
}

describe('tray focus cue (NO_COLOR, screen reader)', () => {
  for (const env of [{ color: false }, { screenReader: true }] as Partial<TuiEnv>[]) {
    it(`focused and unfocused differ in plain text (${JSON.stringify(env)})`, async () => {
      const c = tray('permission', 'a', permission('a', 'npm test'))
      const on = await mount({ cards: [c], focused: true }, env)
      const f = on.frame()
      expect(f).toContain('> Needs you')
      expect(f).toContain('y Allow once')
      expect(f).not.toContain('Alt+D to answer')
      // No colour: not one escape sequence.
      expect(f).not.toMatch(/\u001b\[/)
      on.unmount()
      const off = await mount({ cards: [c], focused: false }, env)
      const u = off.frame()
      expect(u).not.toContain('> Needs you')
      expect(u).toContain('Needs you')
      expect(u).toContain('Alt+D to answer')
      expect(u).not.toContain('y Allow once')
      off.unmount()
    })
  }

  it('the footer variant says Alt+D to answer when unfocused', async () => {
    const c = tray('permission', 'a', permission('a', 'npm test'))
    const off = await mount({ cards: [c], focused: false, variant: 'footer', height: 1 })
    expect(off.frame()).toContain('Alt+D to answer')
    off.unmount()
  })

  it('uses the env separator in hints (screen reader commas, ASCII bars, unicode dots)', async () => {
    const c = tray('permission', 'a', permission('a', 'npm test'))
    const sr = await mount({ cards: [c], width: 140 }, { screenReader: true })
    expect(sr.frame()).toContain('y Allow once, s Allow for session')
    sr.unmount()
    const uni = await mount({ cards: [c], width: 140 }, { unicode: true })
    expect(uni.frame()).toContain('y Allow once · s Allow for session')
    uni.unmount()
  })
})

describe('long permission card: scroll cue and read-first gate', () => {
  const sizes: [number, number, number][] = [
    [120, 40, 12],
    [100, 30, 10],
    [80, 24, 8]
  ]
  for (const [cols, rows, height] of sizes) {
    it(`${cols}x${rows}: y is held back until the end was shown, Down scrolls, then y decides`, async () => {
      const c = tray('permission', 'a', permission('a', LONG))
      const h = await mount({ cards: [c], width: cols, height })
      expect(h.frame()).toMatch(/\d+ more lines/)
      expect(h.frame()).toContain('Down scrolls')
      for (const k of ['y', 's', 'a']) await h.press(k)
      expect(h.calls).toHaveLength(0)
      expect(h.notices.filter((n) => n.startsWith('Read the whole command first'))).toHaveLength(3)
      for (let i = 0; i < 60 && !h.frame().includes('End of card'); i++) await h.press(named('pagedown'))
      expect(h.frame()).toContain('End of card')
      expect(h.frame()).toContain('step119')
      await h.press('y')
      expect(h.calls).toHaveLength(1)
      h.unmount()
    })
  }

  it('v unlocks and opens the whole command', async () => {
    const c = tray('permission', 'a', permission('a', LONG))
    const h = await mount({ cards: [c] })
    await h.press('v')
    expect(h.onViewText).toHaveBeenCalledTimes(1)
    const text = (h.onViewText.mock.calls[0] as unknown as [string, string])[1]
    expect(text).toContain('step119')
    expect(text).toContain(LONG)
    await h.press('y')
    expect(h.calls).toHaveLength(1)
    h.unmount()
  })

  it('a card whose body fits is not gated and shows no cue', async () => {
    const c = tray('permission', 'a', permission('a', 'npm test'))
    const h = await mount({ cards: [c] })
    expect(h.frame()).not.toMatch(/more lines/)
    await h.press('y')
    expect(h.calls).toHaveLength(1)
    h.unmount()
  })

  it('cardFullText carries a long non-Bash input whole, and says when it cut', () => {
    const big = 'a'.repeat(5000)
    const c = tray('permission', 'a', { ...permission('a', ''), toolName: 'Custom', input: { blob: big } })
    expect(cardFullText(c)).toContain(big)
    const huge = tray('permission', 'a', { ...permission('a', ''), toolName: 'Custom', input: { blob: 'b'.repeat(70000) } })
    expect(cardFullText(huge)).toContain('(cut at 65536 characters)')
  })
})

describe('cuts and hint wrapping', () => {
  it('a cut line ends with the env ellipsis', async () => {
    const title = 'x'.repeat(200)
    const c = tray('permission', 'a', permission('a', 'npm test', { summary: title, toolName: 'Custom', input: {} }))
    const uni = await mount({ cards: [c], width: 40 }, { unicode: true })
    expect(uni.frame()).toContain('…')
    uni.unmount()
    const ascii = await mount({ cards: [c], width: 40 })
    expect(ascii.frame()).toContain('...')
    ascii.unmount()
  })

  for (const width of [80, 60]) {
    it(`hints wrap only between phrases at ${width} columns`, async () => {
      const c = tray('permission', 'a', permission('a', 'npm test'))
      const h = await mount({ cards: [c], width, height: 12 })
      const lines = h.frame().split('\n').map((l) => l.trimEnd())
      for (const p of hintPhrases(c, false)) expect(lines.some((l) => l.includes(p))).toBe(true)
      for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(width)
      h.unmount()
    })
  }

  it('wrapPhrases never splits a phrase and cuts an over-wide one with the ellipsis', () => {
    expect(wrapPhrases(['aaaa bbbb', 'cccc dddd', 'eeee'], ' | ', 20)).toEqual(['aaaa bbbb', 'cccc dddd | eeee'])
    expect(wrapPhrases(['x'.repeat(30)], ' | ', 12, '...')[0]).toBe(`${'x'.repeat(9)}...`)
  })

  it('the note field hint says Esc cancels the note', async () => {
    const c = tray('permission', 'a', permission('a', 'npm test'))
    const h = await mount({ cards: [c] })
    await h.press('n')
    expect(h.frame()).toContain('Enter sends | Esc cancels the note')
    h.unmount()
  })
})

describe('rejected keys and ?', () => {
  const q: UserQuestion = { id: 'q', runId: RUN, agentId: 'root', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], allowMultiple: false, allowFreeText: false, createdAt: 1 }

  it('9 on a two-option question says Pick 1 to 2.', async () => {
    const h = await mount({ cards: [tray('question', 'q', q)] })
    await h.press('9')
    expect(h.notices).toContain('Pick 1 to 2.')
    h.unmount()
  })

  it('n while the Always-allow confirm is open says to answer it first', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a', 'npm test'))] })
    await h.press('a')
    await h.press('n')
    expect(h.notices).toContain('Answer the confirm first: a or y confirms, Esc cancels.')
    h.unmount()
  })

  it('? calls onHelp but typing ? in the note field does not', async () => {
    const h = await mount({ cards: [tray('permission', 'a', permission('a', 'npm test'))] })
    await h.press('?')
    expect(h.onHelp).toHaveBeenCalledTimes(1)
    await h.press('n')
    await h.press('?')
    expect(h.onHelp).toHaveBeenCalledTimes(1)
    expect(h.frame()).toContain('?_')
    expect(h.notices).toHaveLength(0)
    h.unmount()
  })
})

describe('height clamp', () => {
  it('never draws more lines than its height, with queued cards, status and a long body', async () => {
    const cards = Array.from({ length: 6 }, (_, i) => tray('permission', `c${i}`, permission(`c${i}`, LONG)))
    for (const height of [5, 6, 8, 12]) {
      const h = await mount({ cards, width: 60, height })
      await h.press('y')
      const lines = h.frame().split('\n')
      expect(lines.length).toBeLessThanOrEqual(height)
      expect(h.frame()).toContain('Needs you (6)')
      h.unmount()
    }
  })

  it('short rows collapse the queue to a count', async () => {
    const cards = Array.from({ length: 4 }, (_, i) => tray('permission', `c${i}`, permission(`c${i}`, LONG)))
    const h = await mount({ cards, width: 100, height: 7 })
    expect(h.frame()).toContain('+3 more cards')
    h.unmount()
  })
})
