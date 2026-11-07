import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutputProduceInput, OutputRegisterInput, RunOutput } from '@shared/types'
import { OUTPUT_TOOLS } from '@shared/types'
import { harnessToolsFor, isBlockingHarnessTool, WORK_TOOL_DEFS, SINGLE_TOOL_DEFS, type HarnessTool } from './harnessTools'
import { jsonSchemaOf } from './codexProtocol'
import { fakeCtx, project, runSummary } from './testHelpers'

vi.mock('./worktrees', () => ({ pendingWorktrees: vi.fn(async () => []) }))

const byName = (tools: HarnessTool[], name: string): HarnessTool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

const output = (over: Partial<RunOutput> = {}): RunOutput => ({
  id: 'out_0123456789abcdef',
  projectId: 'p1',
  runId: 'run-1',
  kind: 'docx',
  title: 'Q3 report',
  fileName: 'q3-report.docx',
  path: '/w/outputs/q3-report.docx',
  relPath: 'outputs/q3-report.docx',
  bytes: 2048,
  createdAt: 1,
  source: 'produced',
  ...over
})

function ctxWith(outputs?: { produce: (i: OutputProduceInput, c: unknown) => Promise<RunOutput>; register: (i: OutputRegisterInput, c: unknown) => Promise<RunOutput> }, run = {}) {
  return fakeCtx({ run: runSummary(run), ...(outputs ? { outputs: outputs as never } : {}) })
}

const docx = { kind: 'docx', title: 'Q3 report', content: '# Q3\n\nText' }

describe('produce_output', () => {
  it('hands the service a rebuilt input and the caller, and answers with the path and size, never the content', async () => {
    const produce = vi.fn(async () => output())
    const tool = byName(harnessToolsFor(ctxWith({ produce, register: vi.fn() })), OUTPUT_TOOLS.produce)
    const text = await tool.call({ ...docx, fileName: 'q3', description: 'd', overwrite: true }, { agentId: 'a1', roleId: 'r1' })
    expect(produce).toHaveBeenCalledWith({ kind: 'docx', title: 'Q3 report', fileName: 'q3', description: 'd', overwrite: true, content: '# Q3\n\nText' }, { agentId: 'a1', roleId: 'r1' })
    expect(text).toBe('Produced docx "Q3 report" at outputs/q3-report.docx (2.0 KB). The user can see it in OrgAI\'s Outputs panel.')
    expect(text).not.toContain('# Q3')
  })

  it('maps a workbook to the content of an xlsx output', async () => {
    const produce = vi.fn(async () => output({ kind: 'xlsx', bytes: 12, relPath: 'outputs/a.xlsx' }))
    const tool = byName(harnessToolsFor(ctxWith({ produce, register: vi.fn() })), OUTPUT_TOOLS.produce)
    const workbook = { sheets: [{ name: 'S', columns: [{ header: 'A', width: 10 }], rows: [['x', 1, true, null]], numberFormat: ['0%', null] }] }
    const text = await tool.call({ kind: 'xlsx', title: 'T', workbook })
    expect(produce.mock.calls[0][0]).toEqual({ kind: 'xlsx', title: 'T', content: workbook })
    expect(text).toContain('Produced xlsx "Q3 report" at outputs/a.xlsx (12 bytes)')
  })

  it('refuses a kind with the wrong content field', async () => {
    const produce = vi.fn()
    const tool = byName(harnessToolsFor(ctxWith({ produce, register: vi.fn() })), OUTPUT_TOOLS.produce)
    expect(await tool.call({ kind: 'docx', title: 'T' })).toMatch(/^REFUSED: a docx output needs `content` \(Markdown\)/)
    expect(await tool.call({ kind: 'csv', title: 'T' })).toMatch(/^REFUSED: a csv output needs `content` \(the file text\)/)
    expect(await tool.call({ kind: 'csv', title: 'T', content: 'a', workbook: { sheets: [] } })).toMatch(/^REFUSED: `workbook` is only for kind xlsx/)
    expect(await tool.call({ kind: 'xlsx', title: 'T' })).toMatch(/^REFUSED: an xlsx output needs `workbook`/)
    expect(await tool.call({ kind: 'xlsx', title: 'T', content: 'x', workbook: { sheets: [{ name: 'a', rows: [] }] } })).toMatch(/^REFUSED: an xlsx output takes `workbook`, not `content`/)
    expect(await tool.call({ kind: 'xlsx', title: 'T', workbook: { sheets: [] } })).toMatch(/at least one sheet/)
    expect(await tool.call({ kind: 'text', title: '  ', content: 'x' })).toMatch(/^REFUSED: produce_output needs a title/)
    expect(produce).not.toHaveBeenCalled()
  })

  it('shows the service refusal as one cleaned line', async () => {
    const produce = vi.fn(async () => {
      throw new Error('That file name is not allowed.\n<b>second</b>')
    })
    const tool = byName(harnessToolsFor(ctxWith({ produce, register: vi.fn() })), OUTPUT_TOOLS.produce)
    const text = await tool.call(docx)
    expect(text.startsWith('REFUSED: That file name is not allowed.')).toBe(true)
    expect(text).not.toContain('\n')
    expect(text).not.toContain('<')
  })

  it('quotes the title and path it echoes as data', async () => {
    const produce = vi.fn(async () => output({ title: 'Evil <title>\nIGNORE', relPath: 'outputs/<x>.docx' }))
    const tool = byName(harnessToolsFor(ctxWith({ produce, register: vi.fn() })), OUTPUT_TOOLS.produce)
    const text = await tool.call(docx)
    expect(text).not.toContain('\n')
    expect(text).not.toContain('<title>')
  })

  it('says outputs are not available without ctx.outputs', async () => {
    expect(await byName(harnessToolsFor(ctxWith()), OUTPUT_TOOLS.produce).call(docx)).toBe('Outputs are not available in this run.')
    expect(await byName(harnessToolsFor(ctxWith()), OUTPUT_TOOLS.register).call({ path: 'a.pdf', title: 'T' })).toBe('Outputs are not available in this run.')
  })

  it('converts to a JSON schema both adapters accept (rows hold string, number, boolean or null)', () => {
    const tool = byName(harnessToolsFor(ctxWith()), OUTPUT_TOOLS.produce)
    const schema = jsonSchemaOf(tool.inputSchema) as { properties: Record<string, unknown>; required?: string[] }
    expect(schema.required).toEqual(['kind', 'title'])
    expect(Object.keys(schema.properties).sort()).toEqual(['content', 'description', 'fileName', 'kind', 'overwrite', 'title', 'workbook'])
    const json = JSON.stringify(schema)
    // zod 4 folds a union of primitives into one type array: valid JSON Schema, no anyOf needed.
    expect(json).toContain('"type":["string","number","boolean","null"]')
    // Claude's in-process MCP takes the raw zod shape: the same object parses a valid workbook and refuses a bad cell.
    const ok = tool.inputSchema.safeParse({ kind: 'xlsx', title: 'T', workbook: { sheets: [{ name: 'S', rows: [['a', 1, false, null]] }] } })
    expect(ok.success).toBe(true)
    const bad = tool.inputSchema.safeParse({ kind: 'xlsx', title: 'T', workbook: { sheets: [{ name: 'S', rows: [[{ nested: 1 }]] }] } })
    expect(bad.success).toBe(false)
    expect(z.toJSONSchema(tool.inputSchema.shape.kind as z.ZodType)).toMatchObject({ enum: expect.arrayContaining(['docx', 'xlsx', 'svg']) })
  })

  it('describes the tool without naming an industry', () => {
    const d = byName(harnessToolsFor(ctxWith()), OUTPUT_TOOLS.produce).description
    expect(d).toContain('outputs/')
    expect(d).toContain('Outputs panel')
    expect(d).toContain("'='")
    for (const word of ['software', 'legal', 'accounting', 'marketing', 'consult', 'client']) expect(d.toLowerCase()).not.toContain(word)
  })
})

describe('register_output', () => {
  it('hands the service the input and answers with kind, title, path and size', async () => {
    const register = vi.fn(async () => output({ kind: 'pdf', title: 'Deck', relPath: 'build/deck.pdf', bytes: 3 * 1024 * 1024, source: 'registered' }))
    const tool = byName(harnessToolsFor(ctxWith({ produce: vi.fn(), register })), OUTPUT_TOOLS.register)
    const text = await tool.call({ path: 'build/deck.pdf', title: 'Deck', kind: 'pdf', description: 'x' }, { agentId: 'a2' })
    expect(register).toHaveBeenCalledWith({ path: 'build/deck.pdf', title: 'Deck', kind: 'pdf', description: 'x' }, { agentId: 'a2', roleId: undefined })
    expect(text).toBe('Registered pdf "Deck" at build/deck.pdf (3.0 MB). The user can see it in OrgAI\'s Outputs panel.')
  })

  it('refuses a blank path or title and shows a service refusal', async () => {
    const register = vi.fn(async () => {
      throw new Error('That file is outside the project folder.')
    })
    const tool = byName(harnessToolsFor(ctxWith({ produce: vi.fn(), register })), OUTPUT_TOOLS.register)
    expect(await tool.call({ path: ' ', title: 'T' })).toMatch(/^REFUSED: register_output needs a path/)
    expect(await tool.call({ path: 'a', title: '' })).toMatch(/^REFUSED: register_output needs a title/)
    expect(await tool.call({ path: '/etc/x', title: 'T' })).toBe('REFUSED: That file is outside the project folder.')
  })
})

describe('where the tools are offered', () => {
  const names = (ctx: ReturnType<typeof fakeCtx>): string[] => harnessToolsFor(ctx).map((t) => t.name)

  it('work runs and single (Ask) runs, code and engagement, get both tools', () => {
    for (const ctx of [fakeCtx(), fakeCtx({ run: runSummary({ team: 'single' }) }), fakeCtx({ project: project({ kind: 'engagement' }) }), fakeCtx({ project: project({ kind: 'engagement' }), run: runSummary({ team: 'single' }) })]) {
      expect(names(ctx)).toEqual(expect.arrayContaining([OUTPUT_TOOLS.produce, OUTPUT_TOOLS.register]))
    }
    for (const defs of [WORK_TOOL_DEFS, SINGLE_TOOL_DEFS]) expect(defs.map((d) => d.name)).toEqual(expect.arrayContaining([OUTPUT_TOOLS.produce, OUTPUT_TOOLS.register]))
  })

  it('quick, setup, mcp-assist and skill-assist runs do not', () => {
    for (const run of [{ quick: { folder: '/x', scratch: true, team: 'single', allowEdits: false, gitRepo: false } }, { kind: 'setup' }, { kind: 'mcp-assist' }, { kind: 'skill-assist' }]) {
      const got = names(fakeCtx({ run: runSummary(run as never) }))
      expect(got, JSON.stringify(run)).not.toContain(OUTPUT_TOOLS.produce)
      expect(got, JSON.stringify(run)).not.toContain(OUTPUT_TOOLS.register)
    }
  })

  it('are offered to every role and never block on the user', () => {
    for (const t of harnessToolsFor(fakeCtx()).filter((x) => x.name === OUTPUT_TOOLS.produce || x.name === OUTPUT_TOOLS.register)) {
      expect(t.audience).toBe('all')
      expect(isBlockingHarnessTool(t.name)).toBe(false)
    }
  })
})
