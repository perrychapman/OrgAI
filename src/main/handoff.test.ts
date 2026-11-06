import { describe, expect, it, vi } from 'vitest'
import type { DaemonInfo, HostHandoffFacts, HostStopResult } from '@shared/types'
import {
  DesktopHandoff,
  busyLines,
  handoffChoiceOf,
  handoffPageHtml,
  handoffUnavailableText,
  handoffView,
  ownerHasExited,
  type DesktopHandoffDeps,
  type HandoffClient,
  type HandoffConnect,
  type HandoffView
} from './handoff'

const owner = (hostKind: DaemonInfo['hostKind']): DaemonInfo => ({ hostInstanceId: 'abcdef012345', pid: 4321, endpoint: '/x', state: 'ready', startedAt: 1, hostKind })
const facts = (over: Partial<HostHandoffFacts> = {}): HostHandoffFacts => ({ workingRuns: 0, waitingRuns: 0, heldRuns: 0, pausedRuns: 0, openCards: 0, terminalSessions: 0, ...over })

/** A scripted owner: host.stop answers come from `stops` in order (the last repeats); `exitAt` flips exited. */
function rig(opts: { stops?: HostStopResult[]; status?: HostHandoffFacts; connect?: () => HandoffConnect; handoff?: boolean; stopThrows?: unknown; windowDelayMs?: number } = {}) {
  let gone = false
  const views: (HandoffView | undefined)[] = []
  const calls: { method: string; params: unknown }[] = []
  let stopIndex = 0
  const client = (): HandoffClient => ({
    handoff: opts.handoff ?? true,
    call: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params })
      if (method === 'host.stop') {
        if (opts.stopThrows) throw opts.stopThrows
        const list = opts.stops ?? [{ stopping: true }]
        const r = list[Math.min(stopIndex++, list.length - 1)]
        return r as T
      }
      return { handoff: opts.status ?? facts() } as T
    },
    close: vi.fn()
  })
  const deps: DesktopHandoffDeps = {
    connect: async () => (opts.connect ? opts.connect() : { client: client() }),
    exited: async () => gone,
    show: (v) => void views.push(v),
    exitPollMs: 2,
    windowDelayMs: opts.windowDelayMs ?? 40,
    retryMs: 15,
    answerTimeoutMs: 100
  }
  const h = new DesktopHandoff(deps)
  return { h, views, calls, exit: () => void (gone = true), kinds: () => views.map((v) => v?.kind ?? 'none') }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('DesktopHandoff (cli-standalone.md 4.4)', () => {
  it('inproc owner: never stopped; "Open when it ends" waits for its exit, then acquire', async () => {
    const r = rig()
    const run = r.h.run(owner('inproc'))
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('inproc'))
    expect(r.h.view()!.buttons.map((b) => b.choice)).toEqual(['wait', 'quit'])
    r.h.choose('force') // not offered; ignored
    r.h.choose('wait')
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('inproc-waiting'))
    r.exit()
    await expect(run).resolves.toBe('acquire')
    expect(r.calls).toEqual([])
    expect(r.kinds()).toEqual(['inproc', 'inproc-waiting', 'none'])
    expect(r.h.view()).toBeUndefined()
  })

  it('inproc owner: Quit', async () => {
    const r = rig()
    const run = r.h.run(owner('inproc'))
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('inproc'))
    r.h.choose('quit')
    await expect(run).resolves.toBe('quit')
  })

  it('node owner that hands over at once: a non-forced handoff stop, no window when it exits within the delay', async () => {
    const r = rig({ stops: [{ stopping: true }], windowDelayMs: 5_000 })
    const run = r.h.run(owner('node'))
    await vi.waitFor(() => expect(r.calls.length).toBe(1))
    r.exit()
    await expect(run).resolves.toBe('acquire')
    expect(r.calls).toEqual([{ method: 'host.stop', params: [{ force: false, handoff: true }] }])
    expect(r.kinds()).toEqual(['none'])
  })

  it('node owner that takes longer than the delay to exit: the "stopping" window appears, then acquire', async () => {
    const r = rig({ stops: [{ stopping: true }] })
    const run = r.h.run(owner('node'))
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('stopping'))
    expect(r.h.view()!.buttons.map((b) => b.choice)).toEqual(['quit'])
    r.exit()
    await expect(run).resolves.toBe('acquire')
  })

  it('refused: the busy window lists the blockers; "Stop them and open" sends a forced stop and waits for the exit', async () => {
    const r = rig({ stops: [{ stopping: false, handoffBlockers: { waitingRuns: 1, openCards: 2 } }, { stopping: true }], status: facts({ waitingRuns: 1, openCards: 2, terminalSessions: 1 }) })
    const run = r.h.run(owner('node'))
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('busy'))
    const view = r.h.view()!
    expect(view.buttons.map((b) => b.choice)).toEqual(['wait', 'force', 'quit'])
    expect(view.detail).toContain('1 run waiting for you, 2 decisions open, 1 terminal session connected')
    expect(view.detail).toContain('Ended when OrgAI closed')
    r.h.choose('force')
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('stopping'))
    expect(r.calls.filter((c) => c.method === 'host.stop').map((c) => c.params)).toEqual([[{ force: false, handoff: true }], [{ force: true }]])
    r.exit()
    await expect(run).resolves.toBe('acquire')
  })

  it('refused: "Open when they finish" retries the handoff stop until it is accepted', async () => {
    const busy: HostStopResult = { stopping: false, handoffBlockers: { workingRuns: 1 } }
    const r = rig({ stops: [busy, busy, busy, { stopping: true }] })
    const run = r.h.run(owner('node'))
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('busy'))
    await wait(60)
    // No retry before the user chose to wait.
    expect(r.calls.filter((c) => c.method === 'host.stop')).toHaveLength(1)
    r.h.choose('wait')
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('stopping'), { timeout: 2_000 })
    const stops = r.calls.filter((c) => c.method === 'host.stop')
    expect(stops).toHaveLength(4)
    expect(stops.every((c) => JSON.stringify(c.params) === JSON.stringify([{ force: false, handoff: true }]))).toBe(true)
    r.exit()
    await expect(run).resolves.toBe('acquire')
  })

  it('the owner exiting on its own while the busy window shows: acquire', async () => {
    const r = rig({ stops: [{ stopping: false, handoffBlockers: { pausedRuns: 1 } }] })
    const run = r.h.run(owner('node'))
    await vi.waitFor(() => expect(r.h.view()?.kind).toBe('busy'))
    r.exit()
    await expect(run).resolves.toBe('acquire')
  })

  it('an owner without the handoff grant (older than Wave 7), or one that does not answer: unavailable', async () => {
    await expect(rig({ handoff: false }).h.run(owner('node'))).resolves.toBe('unavailable')
    await expect(rig({ connect: () => ({ failed: 'did not answer host.hello' }) }).h.run(owner('node'))).resolves.toBe('unavailable')
    await expect(rig({ stopThrows: new Error('timed out') }).h.run(owner('node'))).resolves.toBe('unavailable')
    // Desktop and headless owners are not handed over from here (the single-instance lock routes those).
    await expect(rig().h.run(owner('headless-host'))).resolves.toBe('unavailable')
    await expect(rig().h.run(owner(undefined))).resolves.toBe('unavailable')
  })

  it('an owner already draining (refused hello or host.stop answer) is treated as stopping', async () => {
    const a = rig({ connect: () => ({ draining: true }) })
    const run = a.h.run(owner('node'))
    a.exit()
    await expect(run).resolves.toBe('acquire')
    const b = rig({ stopThrows: Object.assign(new Error('shutting down'), { data: { code: 'host_draining' } }) })
    const run2 = b.h.run(owner('node'))
    b.exit()
    await expect(run2).resolves.toBe('acquire')
  })

  it('an owner that is already gone is acquired without asking it anything', async () => {
    const r = rig({ connect: () => ({ failed: 'no host' }) })
    r.exit()
    await expect(r.h.run(owner('node'))).resolves.toBe('acquire')
    await expect(r.h.run(owner('inproc'))).resolves.toBe('acquire')
  })
})

describe('handoff helpers', () => {
  it('busyLines names the run facts first, then leases the facts do not cover, then terminal sessions', () => {
    expect(busyLines({ stopping: false, handoffBlockers: { workingRuns: 2, heldRuns: 1 }, refusedBecause: { liveRuns: 2, activeOAuthFlows: 1 } })).toEqual([
      '2 runs working',
      '1 run paused by you or a usage limit',
      '1 sign-in in progress'
    ])
    // A plain refusal (no handoff blockers) falls back to the status facts, else to the lease names.
    expect(busyLines({ stopping: false, refusedBecause: { liveRuns: 1 } })).toEqual(['1 run working'])
    expect(busyLines({ stopping: false, refusedBecause: { interactiveClients: 1 } }, facts({ terminalSessions: 3 }))).toEqual(['1 terminal session attached'])
    expect(busyLines({ stopping: false }, facts({ pausedRuns: 1, terminalSessions: 2 }))).toEqual(['1 run waiting to resume', '2 terminal sessions connected'])
  })

  it('handoffView: every kind has a message and its buttons', () => {
    for (const kind of ['inproc', 'inproc-waiting', 'stopping', 'busy', 'busy-waiting'] as const) {
      const v = handoffView(kind, ['1 run working'])
      expect(v.kind).toBe(kind)
      expect(v.message.length).toBeGreaterThan(10)
      expect(v.buttons.some((b) => b.choice === 'quit')).toBe(true)
    }
    expect(handoffView('inproc').message).toBe("OrgAI's data is in use by the orgai command in a terminal.")
    expect(handoffView('busy').buttons.map((b) => b.label)).toEqual(['Open when they finish', 'Stop them and open', 'Quit'])
  })

  it('handoffPageHtml escapes every text and links each button to its choice; handoffChoiceOf reads them back', () => {
    const html = handoffPageHtml({ kind: 'busy', message: '<b>x</b>', detail: 'a & "b"\nnext', buttons: [{ label: "Don't <go>", choice: 'wait' }] }, true)
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('a &amp; &quot;b&quot;<br>next')
    expect(html).toContain('href="orgai-handoff:wait">Don&#39;t &lt;go&gt;</a>')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
    expect(handoffChoiceOf('orgai-handoff:wait')).toBe('wait')
    expect(handoffChoiceOf('orgai-handoff://force')).toBe('force')
    expect(handoffChoiceOf('orgai-handoff:quit')).toBe('quit')
    expect(handoffChoiceOf('orgai-handoff:rm')).toBeUndefined()
    expect(handoffChoiceOf('https://example.com')).toBeUndefined()
  })

  it('ownerHasExited: dead by pid and start time; unconfirmed only once daemon.json no longer names it', async () => {
    const o = owner('node')
    expect(await ownerHasExited(o, { liveness: () => 'dead', currentOwner: () => o })).toBe(true)
    expect(await ownerHasExited(o, { liveness: () => 'same', currentOwner: () => null })).toBe(false)
    expect(await ownerHasExited(o, { liveness: () => 'unconfirmed', currentOwner: () => o })).toBe(false)
    expect(await ownerHasExited(o, { liveness: () => 'unconfirmed', currentOwner: () => null })).toBe(true)
    expect(
      await ownerHasExited(o, {
        liveness: () => {
          throw new Error('ps failed')
        },
        currentOwner: () => null
      })
    ).toBe(false)
  })

  it('handoffUnavailableText names the owner and the orgai daemon stop --force hint', () => {
    const t = handoffUnavailableText(owner('node'), '/data/run')
    expect(t.title).toBe('OrgAI is already running')
    expect(t.detail).toContain('a background host started from a terminal (pid 4321)')
    expect(t.detail).toContain('orgai daemon stop --force')
    expect(t.detail).toContain('/data/run')
  })
})
