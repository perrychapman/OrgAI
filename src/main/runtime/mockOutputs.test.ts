import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutputProduceInput, OutputRegisterInput, RunEvent, RunOutput } from '@shared/types'
import { RunManager } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { createOutputsService } from '../outputs/service'
import { OUTPUT_TOOLS } from '@shared/types'
import {
  MOCK_OUTPUTS_DONE,
  MOCK_OUTPUTS_NONE,
  MOCK_OUTPUTS_START,
  MOCK_OUTPUT_DOCX_MARKDOWN,
  MOCK_OUTPUT_MERMAID,
  MOCK_OUTPUT_PNG_PATH,
  MOCK_OUTPUT_SUMMARY,
  MOCK_OUTPUT_WORKBOOK,
  MockAdapter,
  OUTPUTS_TOKEN
} from './mock'
import { ROOT_AGENT_ID, type KnowledgeCaller, type RuntimeContext } from './types'
import { fakeCtx, project } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

type Outputs =NonNullable<RuntimeContext['outputs']>

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A recording RuntimeContext.outputs: produce always succeeds, register refuses a path with '..' like main does. */
function fakeOutputs(projectPath: string) {
  const calls: { fn: 'produce' | 'register'; input: OutputProduceInput | OutputRegisterInput; caller: KnowledgeCaller }[] = []
  let seq = 0
  const entry = (kind: RunOutput['kind'], title: string, rel: string, source: RunOutput['source']): RunOutput => ({
    id: `out_${String(++seq).padStart(16, '0')}`,
    projectId: 'p1',
    runId: 'run1',
    kind,
    title,
    fileName: rel.split('/').at(-1)!,
    path: join(projectPath, rel),
    relPath: rel,
    bytes: 10,
    createdAt: 1,
    source
  })
  const outputs: Outputs & { calls: typeof calls } = {
    calls,
    produce: async (input, caller) => {
      calls.push({ fn: 'produce', input, caller })
      return entry(input.kind, input.title, `outputs/${input.fileName ?? input.title}`, 'produced')
    },
    register: async (input, caller) => {
      calls.push({ fn: 'register', input, caller })
      if (input.path.includes('..')) throw new Error('That file is outside the project folder and its allowed folders.')
      return entry(input.kind ?? 'image', input.title, input.path, 'registered')
    }
  }
  return outputs
}

async function play(over: Parameters<typeof fakeCtx>[0] = {}) {
  const ctx = fakeCtx({ autoContinue: false, prompt: `Write the deliverables ${OUTPUTS_TOKEN}`, ...over })
  const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
  const statuses = (): string[] => ctx.events.flatMap((e) => (e.type === 'run.status' ? [e.status] : []))
  for (let i = 0; i < 300 && !statuses().includes('idle'); i++) await new Promise((r) => setTimeout(r, 10))
  expect(statuses()).toContain('idle')
  await session.stop()
  await session.finished
  expect(statuses().at(-1)).toBe('finished')
  return ctx
}

const rootBlocks = (ctx: ReturnType<typeof fakeCtx>) => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID ? [e.entry.block] : []))
const rootTexts = (ctx: ReturnType<typeof fakeCtx>) => rootBlocks(ctx).flatMap((b) => (b.kind === 'text' ? [b.text] : []))
const outputCalls = (ctx: ReturnType<typeof fakeCtx>) =>
  rootBlocks(ctx).flatMap((b) => (b.kind === 'tool_use' && (b.name === OUTPUT_TOOLS.produce || b.name === OUTPUT_TOOLS.register) ? [{ name: b.name, input: b.input }] : []))

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-mock-outputs-'))
  dirs.push(dir)
  return dir
}

describe('mock [mock:outputs]', () => {
  it('calls produce_output and register_output in order through the real harness tools, then plays the default script', async () => {
    const dir = tempProject()
    const outputs = fakeOutputs(dir)
    const ctx = await play({ project: project({ path: dir }), outputs })
    expect(outputCalls(ctx)).toEqual([
      { name: 'produce_output', input: { kind: 'docx', title: 'Project plan', fileName: 'project-plan', description: 'Scope, phases and owners', content: MOCK_OUTPUT_DOCX_MARKDOWN } },
      { name: 'produce_output', input: { kind: 'xlsx', title: 'Budget', workbook: MOCK_OUTPUT_WORKBOOK } },
      { name: 'produce_output', input: { kind: 'mermaid', title: 'Architecture diagram', content: MOCK_OUTPUT_MERMAID } },
      { name: 'produce_output', input: { kind: 'markdown', title: 'Summary', content: MOCK_OUTPUT_SUMMARY } },
      { name: 'register_output', input: { path: 'outputs/logo.png', title: 'Logo', description: 'Written by the mock with its own tools' } },
      { name: 'register_output', input: { path: '../outside.txt', title: 'Outside' } }
    ])
    // The context saw the same calls, with the root as caller.
    expect(outputs.calls.map((c) => c.fn)).toEqual(['produce', 'produce', 'produce', 'produce', 'register', 'register'])
    expect(outputs.calls.every((c) => c.caller.agentId === ROOT_AGENT_ID && c.caller.roleId === ctx.project.roles[0]!.id)).toBe(true)
    // The docx Markdown carries every element the renderer must handle.
    for (const part of ['# Project plan', '**', '*phases*', '- ', '| Phase | Owner | Weeks |', '1. ', '2. ', '---', '```']) expect(MOCK_OUTPUT_DOCX_MARKDOWN).toContain(part)
    // The '=SUM' cell reaches main unchanged (main is where it becomes text).
    const xlsx = outputs.calls[1]!.input as OutputProduceInput
    expect(xlsx.content).toEqual(MOCK_OUTPUT_WORKBOOK)
    expect((xlsx.content as typeof MOCK_OUTPUT_WORKBOOK).sheets[0]!.rows[3]![0]).toBe('=SUM(B2:B4)')
    // The PNG was written for real under the project's outputs folder before it was registered.
    const png = readFileSync(join(dir, MOCK_OUTPUT_PNG_PATH))
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // The refused register came back as REFUSED and did not stop the script.
    const results = rootBlocks(ctx).flatMap((b) => (b.kind === 'tool_result' ? [b.content] : []))
    expect(results.filter((r) => r.startsWith('REFUSED:'))).toHaveLength(1)
    const texts = rootTexts(ctx)
    expect(texts[0]).toBe(MOCK_OUTPUTS_START)
    const done = texts.indexOf(MOCK_OUTPUTS_DONE)
    expect(done).toBeGreaterThan(0)
    expect(texts.indexOf('Planning the work: I will read the project, delegate the change and review the result.')).toBeGreaterThan(done)
    expect(texts.at(-1)).toBe('The report finished: src/example.ts was updated. Anything else?')
    expect(texts).not.toContain(MOCK_OUTPUTS_NONE)
  })

  it('says no outputs are available without ctx.outputs, writes nothing and plays the default script', async () => {
    const dir = tempProject()
    const ctx = await play({ project: project({ path: dir }) })
    const texts = rootTexts(ctx)
    expect(texts[0]).toBe(MOCK_OUTPUTS_NONE)
    expect(outputCalls(ctx)).toEqual([])
    expect(() => readFileSync(join(dir, MOCK_OUTPUT_PNG_PATH))).toThrow()
    expect(ctx.events.some((e) => e.type === 'log' && e.level === 'info' && e.message.includes('[mock:outputs]'))).toBe(true)
    expect(texts.at(-1)).toBe('The report finished: src/example.ts was updated. Anything else?')
  })

  it('under the real RunManager and outputs service: 5 entries indexed, 5 output.created events, the =SUM cell stored as text', async () => {
    const root = realpathSync.native(tempProject())
    const work = join(root, 'work')
    const data = join(root, 'data')
    mkdirSync(work, { recursive: true })
    const stored = project({ id: 'p1', path: work, isolateWriters: false })
    const service = createOutputsService(data)
    const events: RunEvent[] = []
    const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
    const m = new RunManager({ mock: new MockAdapter({ script: { delayMs: 0 } }) }, (e) => void events.push(e), new RunStore(data), setup, () => 100, {
      dataDir: data,
      outputs: service,
      resolveProject: (id) => (id === stored.id ? stored : null)
    })
    const texts = (): string[] => events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
    const run = await m.start({ project: stored, prompt: `Write the deliverables ${OUTPUTS_TOKEN}`, kind: 'work' })
    await vi.waitFor(() => expect(texts()).toContain(MOCK_OUTPUTS_DONE), { timeout: 10000 })
    const created = events.flatMap((e) => (e.type === 'output.created' ? [e.output] : []))
    expect(created.map((o) => [o.kind, o.title, o.relPath, o.source])).toEqual([
      ['docx', 'Project plan', 'outputs/project-plan.docx', 'produced'],
      ['xlsx', 'Budget', 'outputs/Budget.xlsx', 'produced'],
      ['mermaid', 'Architecture diagram', 'outputs/Architecture-diagram.mmd', 'produced'],
      ['markdown', 'Summary', 'outputs/Summary.md', 'produced'],
      ['image', 'Logo', 'outputs/logo.png', 'registered']
    ])
    expect(service.list('p1')).toHaveLength(5)
    const results = events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [e.entry.block.content] : []))
    expect(results.filter((r) => r.startsWith('REFUSED:'))).toHaveLength(1)
    // The workbook keeps '=SUM(B2:B4)' as a string cell, never a formula.
    const budget = created.find((o) => o.kind === 'xlsx')!
    const preview = await service.preview({ projectId: 'p1', projectPath: work, allowedDirectories: [], referenceDirectories: [] }, budget.id)
    expect(JSON.stringify(preview)).toContain('=SUM(B2:B4)')
    expect(existsSync(join(work, 'outputs', 'Budget.xlsx'))).toBe(true)
    await m.stop(run.id)
  })

  it('the default script without the marker makes no output call', async () => {
    const dir = tempProject()
    const outputs = fakeOutputs(dir)
    const ctx = await play({ prompt: 'Write the deliverables', project: project({ path: dir }), outputs })
    expect(outputCalls(ctx)).toEqual([])
    expect(outputs.calls).toEqual([])
    expect(rootTexts(ctx)).not.toContain(MOCK_OUTPUTS_START)
  })
})
