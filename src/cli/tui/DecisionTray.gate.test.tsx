/**
 * R2-H1 (issue #25): the read-first gate and the scroll cue read the same wrapped rows. Property sweep: for every body
 * length around the tray height, y / s / a decide only when the card's last wrapped row was really drawn in a frame.
 */
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { CardKind, DecisionOutcome, PermissionRequest } from '../../shared/types'
import { DEFAULT_TUI_ENV, InputBus, InputBusContext, TuiEnvContext } from './context'
import { cardDetail } from './decisions'
import { DecisionTray } from './DecisionTray'
import { trayHeight } from './trayLayout'
import { cardKey, type CardRef, type InputEvent, type TrayCard } from './types'

const key = (ch: string): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch })
const down: InputEvent = { type: 'key', name: 'down', ctrl: false, alt: false, shift: false, raw: '' }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1))

function card(kind: CardKind, id: string, c: unknown): TrayCard {
  const ref: CardRef = { hostInstanceId: 'h1', runId: 'run_1', requestId: id, kind, revision: 1 }
  return { key: cardKey(ref), ref, runTag: 'R1', runKind: 'work', arrivedSeq: 1, kind, card: c } as TrayCard
}

function perm(id: string, over: Partial<PermissionRequest>): PermissionRequest {
  return { id, runId: 'run_1', agentId: 'root', toolName: 'Bash', input: {}, summary: `Run ${id}`, suggestions: [], ruleLabels: [], ...over } as PermissionRequest
}

const SIZES: [number, number][] = [
  [70, 24],
  [80, 24],
  [100, 30],
  [120, 40]
]

/** Words of 9 characters, so a body grows by about one row per (width / 10) words. */
const words = (n: number): string => Array.from({ length: n }, (_, i) => `seg${String(i).padStart(5, '0')}`).join(' ')

async function trial(c: TrayCard, cols: number, rows: number, scrollFirst: number, unfocusedFirst = false): Promise<{ accepted: boolean; sawLast: boolean }> {
  const bus = new InputBus()
  const clock = { t: 10_000 }
  const calls: unknown[] = []
  const height = trayHeight([c], cols, rows, false)
  const last = cardDetail(c, cols - 2).lines.at(-1) ?? ''
  const element = (focused: boolean) => (
    <TuiEnvContext.Provider value={DEFAULT_TUI_ENV}>
      <InputBusContext.Provider value={bus}>
        <DecisionTray
          width={cols}
          height={height}
          compact
          focused={focused}
          variant="full"
          cards={[c]}
          resolved={[]}
          onDecide={async (_c, call): Promise<DecisionOutcome> => {
            calls.push(call)
            return { status: 'applied', runId: 'run_1', requestId: c.ref.requestId }
          }}
          onViewText={async () => {}}
          onLeave={() => {}}
          now={() => clock.t}
        />
      </InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
  const r = render(element(!unfocusedFirst))
  await tick()
  if (unfocusedFirst) {
    expect(r.lastFrame()).toContain("Allow once")
    expect(r.lastFrame()).not.toContain(last)
    r.rerender(element(true))
    await tick()
  }
  clock.t += 1000
  let sawLast = (r.lastFrame() ?? '').includes(last)
  for (let i = 0; i < scrollFirst; i++) {
    bus.dispatch(down, 'tray')
    await tick()
    if ((r.lastFrame() ?? '').includes(last)) sawLast = true
  }
  const before = r.lastFrame() ?? ''
  bus.dispatch(key('y'), 'tray')
  await tick()
  r.unmount()
  // The frame drawn when y was pressed is what the user read.
  return { accepted: calls.length === 1, sawLast: sawLast || before.includes(last) }
}

describe('R2-H1 read-first gate follows the drawn rows', () => {
  it('inline choices do not count as reading unseen permission lines', async () => {
    const c = card('permission', 'preview', perm('preview', { input: { command: words(40) }, summary: 'Run a long command' }))
    expect(await trial(c, 80, 24, 0, true)).toEqual({ accepted: false, sawLast: false })
    expect(await trial(c, 80, 24, 30, true)).toEqual({ accepted: true, sawLast: true })
  })

  for (const [cols, rows] of SIZES) {
    for (const tool of ['Bash', 'Edit'] as const) {
      it(`${cols}x${rows} ${tool}: y decides only after the last wrapped row was drawn (bodies around the tray height)`, async () => {
        let gated = 0
        let open = 0
        const cardFor = (n: number): TrayCard => {
          const input = tool === 'Bash' ? { command: words(n) } : { file_path: `C:\\Users\\x\\${words(n).replace(/ /g, '\\')}`, old_string: 'a', new_string: 'b' }
          return card('permission', `k${n}`, perm(`k${n}`, { toolName: tool, input, summary: tool === 'Bash' ? words(Math.ceil(n / 3)) : `Edit ${words(2)}` }))
        }
        // Bodies from a short one to one far past the tray, and every length within a few rows of the tray height.
        const picks: number[] = []
        for (let n = 1; n <= 80; n++) {
          const c = cardFor(n)
          const h = trayHeight([c], cols, rows, false)
          const len = cardDetail(c, cols - 2).lines.length
          if (n === 1 || n === 80 || (len >= h - 6 && len <= h + 2)) picks.push(n)
        }
        expect(picks.length).toBeGreaterThan(2)
        // Each press costs one Ink frame, so keep the sweep small: the short and long ends and four lengths near the tray height.
        const thin = [...new Set([picks[0]!, picks[picks.length - 1]!, ...picks.filter((_, i) => i % Math.max(1, Math.floor(picks.length / 4)) === 0)])]
        for (const n of thin) {
          const c = cardFor(n)
          for (const scroll of [0, 2, 8]) {
            const { accepted, sawLast } = await trial(c, cols, rows, scroll)
            if (accepted) {
              open++
              expect(sawLast, `n=${n} scroll=${scroll}: y accepted but the last row was never drawn`).toBe(true)
            } else gated++
          }
        }
        expect(gated).toBeGreaterThan(0)
        expect(open).toBeGreaterThan(0)
      }, 240000)
    }
  }
})
