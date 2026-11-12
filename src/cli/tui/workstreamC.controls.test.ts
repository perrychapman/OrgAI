import { describe, expect, it, vi } from 'vitest'
import type { ProviderModel, RunSummary } from '../../shared/types'
import { copyToClipboard, clipboardCommands, fencedBlocks, lastAssistantText, latestCodeBlock, osc52 } from './clipboard'
import { editorCommand, editInExternalEditor } from './externalEditor'
import { DraftStore, EMPTY_HISTORY, HISTORY_MAX, historyNext, historyPrev, pushHistory } from './input/promptHistory'
import { EMPTY_BUFFER, wordLeft, wordRight } from './input/textBuffer'
import { composerReduce } from './Composer'
import { modeChoices, modelSwitchBlock, nextMode, pickModel } from './runControls'
import { SLASH_COMMANDS } from './slashCommands'
import type { SlashContext, TuiSessionApi, TuiState } from './types'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (over: Partial<RunSummary> = {}): RunSummary => ({ id: 'r1', projectId: 'p1', kind: 'work', prompt: 'x', status: 'idle', startedAt: 1, totalCostUsd: 0, ...over }) as RunSummary

function state(over: Partial<RunSummary> = {}, texts: string[] = [], hasRun = true): TuiState {
  const transcript = texts.map((text, i) => ({ id: `e${i}`, agentId: 'root', at: i, block: { kind: 'text' as const, text } }))
  return {
    connection: 'live', folder: '/tmp/proj', runs: hasRun ? { r1: { summary: run(over), agents: {}, transcript, partials: {}, cards: { permissions: [], proposals: [], questions: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] }, recordLoaded: true } } : {},
    runOrder: ['r1'], activeChain: hasRun ? ['r1'] : [], activeRunId: hasRun ? 'r1' : undefined, composeTarget: 'active', notices: [], resolved: [], cardSeq: 0
  } as unknown as TuiState
}

const model = (id: string, connection: string, tier?: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, label: id.toUpperCase(), connection, tier, family: 'claude', adapter: 'claude', source: 'builtin', ...extra }) as unknown as ProviderModel

function fakeCtx(s: TuiState, staged: Record<string, unknown> = {}) {
  const session = {
    getStaged: vi.fn(() => staged),
    stage: vi.fn(),
    listModels: vi.fn(async () => [model('haiku', 'anthropic', 'fast'), model('opus', 'anthropic', 'top'), model('gpt', 'openai', 'deep')]),
    switchModel: vi.fn(async () => ({ run: run(), applied: true })),
    promoteQuick: vi.fn(async () => ({ kind: 'created', project: { id: 'p2', name: 'Saved' }, run: run({ id: 'r1', projectId: 'p2' }) }))
  }
  const ctx = { session: session as unknown as TuiSessionApi, state: () => s, notify: vi.fn(), setMode: vi.fn(async () => {}), copyText: vi.fn(async () => ['terminal']), openProject: vi.fn(async () => {}), setFocus: vi.fn(), togglePane: vi.fn(), newRun: vi.fn(), switchRun: vi.fn(), confirm: vi.fn(async () => true), openText: vi.fn(async () => {}), quit: vi.fn() } satisfies SlashContext
  return { ctx, session }
}
const cmd = (n: string) => SLASH_COMMANDS.find((c) => c.name === n)!

describe('slash /model', () => {
  it('resolves a tier and switches an idle run on the same connection', async () => {
    const { ctx, session } = fakeCtx(state({ modelSelection: { model: 'opus', connection: 'anthropic' } }))
    await cmd('model').run(ctx, 'fast')
    expect(session.switchModel).toHaveBeenCalledWith({ model: 'haiku', connection: 'anthropic' })
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('Now using'))
  })
  it('does not switch a working run, a run with decisions, or across connections', async () => {
    for (const s of [state({ status: 'running' }), state({ modelSelection: { model: 'opus', connection: 'anthropic' } })]) {
      const { ctx, session } = fakeCtx(s)
      await cmd('model').run(ctx, s.runs.r1.summary.status === 'running' ? 'haiku' : 'gpt')
      expect(session.switchModel).not.toHaveBeenCalled()
      expect(ctx.notify).toHaveBeenCalledWith(expect.any(String), 'warn')
    }
    const withCard = state()
    ;(withCard.runs.r1.cards.permissions as unknown[]).push({ id: 'c' })
    expect(modelSwitchBlock(withCard, { connection: 'anthropic' })).toMatch(/decisions/)
  })
  it('stages for the next run when none is followed; applied false says saved for the next message', async () => {
    const none = fakeCtx(state({}, [], false))
    await cmd('model').run(none.ctx, 'opus')
    expect(none.session.stage).toHaveBeenCalledWith({ model: { model: 'opus', connection: 'anthropic' } })
    expect(none.session.switchModel).not.toHaveBeenCalled()
    const saved = fakeCtx(state({ status: 'finished' }))
    saved.session.switchModel.mockResolvedValueOnce({ run: run(), applied: false, reason: 'Applies when you continue.' } as never)
    await cmd('model').run(saved.ctx, 'opus')
    expect(saved.ctx.notify).toHaveBeenCalledWith(expect.stringContaining('saved for the next message'), 'warn')
  })
  it('pickModel prefers the current connection and reports unknown models', () => {
    const list = [model('a', 'x', 'fast'), model('b', 'y', 'fast', { recommended: true })]
    expect((pickModel(list, 'fast', 'x') as ProviderModel).id).toBe('a')
    expect((pickModel(list, 'fast') as ProviderModel).id).toBe('b')
    expect(pickModel(list, 'nope')).toHaveProperty('error')
  })
})

describe('slash /effort /mode /goal', () => {
  it('/effort validates and stages', async () => {
    const { ctx, session } = fakeCtx(state())
    await cmd('effort').run(ctx, 'xhigh')
    expect(session.stage).toHaveBeenCalledWith({ effort: 'xhigh' })
    await cmd('effort').run(ctx, 'turbo')
    expect(session.stage).toHaveBeenCalledTimes(1)
  })
  it('/mode hands valid modes to setMode and refuses others', async () => {
    const { ctx } = fakeCtx(state())
    await cmd('mode').run(ctx, 'acceptEdits')
    expect(ctx.setMode).toHaveBeenCalledWith('acceptEdits')
    await cmd('mode').run(ctx, 'bogus')
    expect(ctx.setMode).toHaveBeenCalledTimes(1)
  })
  it('/goal stages balanced|speed|cost', async () => {
    const { ctx, session } = fakeCtx(state())
    await cmd('goal').run(ctx, 'cost')
    expect(session.stage).toHaveBeenCalledWith({ goal: 'cost' })
    await cmd('goal').run(ctx, 'fast')
    expect(session.stage).toHaveBeenCalledTimes(1)
  })
  it('mode helpers: chat runs offer fewer modes, nextMode cycles', () => {
    expect(modeChoices(state({ quick: {} as never }))).toEqual(['default', 'plan'])
    expect(modeChoices(state({ kind: 'setup' }))).toEqual([])
    expect(nextMode('plan', ['default', 'acceptEdits', 'plan', 'auto'])).toBe('auto')
    expect(nextMode('auto', ['default', 'acceptEdits', 'plan', 'auto'])).toBe('default')
    expect(nextMode(undefined, [])).toBeUndefined()
  })
})

describe('slash /save-project and /copy', () => {
  it('/save-project needs a quick run that has ended, then follows the new project', async () => {
    const live = fakeCtx(state({ quick: {} as never, status: 'idle' }))
    await cmd('save-project').run(live.ctx, 'Mine')
    expect(live.session.promoteQuick).not.toHaveBeenCalled()
    const done = fakeCtx(state({ quick: {} as never, status: 'finished' }))
    await cmd('save-project').run(done.ctx, 'Mine')
    expect(done.session.promoteQuick).toHaveBeenCalledWith('Mine')
    expect(done.ctx.openProject).toHaveBeenCalledWith({ id: 'p2', name: 'Saved' }, 'r1')
    expect(cmd('save-project').available?.(state())).toBe(false)
  })
  it('/copy copies the last message or its code block through ctx.copyText', async () => {
    const s = state({}, ['first', 'Here:\n```ts\nconst a = 1\n```\ndone'])
    const { ctx } = fakeCtx(s)
    await cmd('copy').run(ctx, '')
    expect(ctx.copyText).toHaveBeenLastCalledWith('Here:\n```ts\nconst a = 1\n```\ndone')
    await cmd('copy').run(ctx, 'code')
    expect(ctx.copyText).toHaveBeenLastCalledWith('const a = 1')
    expect(cmd('copy').available?.(state({}, [], true))).toBe(false)
  })
  it('/quit no longer claims runs keep going', () => expect(cmd('quit').summary).not.toMatch(/keep going/))
})

describe('clipboard', () => {
  it('extracts assistant text and fenced blocks without harness or user rows', () => {
    const s = state({}, ['a', 'b'])
    s.runs.r1.transcript.push({ id: 'h', agentId: 'root', at: 9, source: 'harness', block: { kind: 'text', text: 'nudge' } } as never)
    expect(lastAssistantText(s)).toBe('b')
    expect(fencedBlocks('x\n```\none\ntwo\n```\n~~~\nthree\n~~~')).toEqual(['one\ntwo', 'three'])
    expect(latestCodeBlock(state({}, ['```\nold\n```', 'no code']))).toBe('old')
  })
  it('encodes OSC 52 and tries terminal plus the platform tool', async () => {
    expect(osc52('hi')).toBe('\x1b]52;c;aGk=\x07')
    const write = vi.fn()
    const run = vi.fn(async () => true)
    const via = await copyToClipboard('hi', { write, run, platform: 'darwin', env: {} })
    expect(write).toHaveBeenCalledWith('\x1b]52;c;aGk=\x07')
    expect(run).toHaveBeenCalledWith('pbcopy', [], 'hi')
    expect(via).toEqual(['terminal', 'pbcopy'])
    expect(clipboardCommands('win32', {})[0].cmd).toBe('clip')
    expect(clipboardCommands('linux', { WAYLAND_DISPLAY: 'w' })[0].cmd).toBe('wl-copy')
    expect(clipboardCommands('linux', {})[0].cmd).toBe('xclip')
  })
})

describe('composer history, word jumps and external editor', () => {
  it('history keeps the draft at the bottom', () => {
    let h = pushHistory(pushHistory(EMPTY_HISTORY, 'one'), 'two')
    const up = historyPrev(h, { text: 'draft', cursor: 5 })!
    expect(up.buffer.text).toBe('two')
    h = up.history
    const up2 = historyPrev(h, up.buffer)!
    expect(up2.buffer.text).toBe('one')
    expect(historyPrev(up2.history, up2.buffer)).toBeNull()
    const down = historyNext(up2.history, up2.buffer)!
    expect(down.buffer.text).toBe('two')
    expect(historyNext(down.history, down.buffer)!.buffer.text).toBe('draft')
    expect(historyNext(EMPTY_HISTORY, EMPTY_BUFFER)).toBeNull()
    expect(pushHistory(pushHistory(EMPTY_HISTORY, 'a'), 'a').entries).toEqual(['a'])
    let big = EMPTY_HISTORY
    for (let i = 0; i < HISTORY_MAX + 5; i++) big = pushHistory(big, `p${i}`)
    expect(big.entries).toHaveLength(HISTORY_MAX)
  })
  it('drafts are kept per run key', () => {
    const d = new DraftStore()
    d.save('r1', 'hello')
    d.save('r2', 'other')
    expect(d.load('r1').text).toBe('hello')
    expect(d.load('r2').text).toBe('other')
    expect(d.load('r3').text).toBe('')
  })
  it('Alt+B / Alt+F and Ctrl+G', () => {
    const b = { text: 'foo bar baz', cursor: 11 }
    expect(wordLeft(b).cursor).toBe(8)
    expect(wordRight({ text: b.text, cursor: 0 }).cursor).toBe(3)
    const alt = (ch: string) => ({ type: 'key', name: 'char', ch, alt: true, ctrl: false, shift: false, raw: '' }) as never
    expect(composerReduce(b, alt('b'), 'send')?.buffer.cursor).toBe(8)
    expect(composerReduce({ ...b, cursor: 0 }, alt('f'), 'send')?.buffer.cursor).toBe(3)
    const ctrlG = { type: 'key', name: 'char', ch: 'g', alt: false, ctrl: true, shift: false, raw: '' } as never
    expect(composerReduce(b, ctrlG, 'send')?.action).toBe('edit')
  })
  it('edits through a private temp file and removes it afterwards', async () => {
    expect(editorCommand({}, () => null)).toBeNull()
    expect(editorCommand({ VISUAL: 'vim;rm' }, (n) => `/bin/${n}`)).toEqual({ file: '/bin/vi', args: [] })
    const root = mkdtempSync(join(tmpdir(), 'orgai-test-'))
    const order: string[] = []
    const spawn = ((file: string, args: string[]) => {
      const path = args[args.length - 1]
      order.push(`spawn:${file}`)
      expect(readFileSync(path, 'utf8')).toBe('draft')
      writeFileSync(path, 'edited\n')
      const handlers: Record<string, (c?: unknown) => void> = {}
      queueMicrotask(() => handlers.exit?.(0))
      return { once: (e: string, f: (c?: unknown) => void) => { handlers[e] = f } }
    }) as never
    const res = await editInExternalEditor('draft', { env: { EDITOR: '/usr/bin/ed -x' }, suspend: () => order.push('suspend'), resume: () => order.push('resume'), spawn, tmp: root })
    expect(res).toEqual({ status: 'edited', text: 'edited' })
    expect(order).toEqual(['suspend', 'spawn:/usr/bin/ed', 'resume'])
    expect(existsSync(root) && readdirSync(root)).toEqual([])
    expect(await editInExternalEditor('x', { env: {}, suspend: () => {}, resume: () => {}, which: () => null })).toEqual({ status: 'no-editor' })
  })
})
