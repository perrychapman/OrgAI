import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpInstallRequest, McpServerSpec, PermissionRequest, RunEvent } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { MCP_HARNESS_TOOLS } from '@shared/types'
import { QuickRunService } from '../quick/quickRuns'
import { ProjectStore } from '../store/projects'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { QUICK_TOOL_DEFS } from './harnessTools'
import {
  CHAT_EDIT_TOKEN,
  CHAT_MCP_TOKEN,
  MOCK_CHAT_EDIT_DENIED,
  MOCK_CHAT_EDIT_DONE,
  MOCK_CHAT_MCP_ADDED,
  MOCK_CHAT_MCP_DECLINED,
  MOCK_CHAT_NOTES,
  MOCK_CHAT_TEST_DENIED,
  MOCK_CHAT_TEST_DONE,
  MOCK_MIDRUN_SERVER,
  MockAdapter
} from './mock'
import { QUICK_SESSION_EDIT_LABEL, quickEditFree } from './quickEditCard'
import { RunManager } from './runManager'
import type { RuntimeAdapter, RuntimeContext } from './types'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/** Chat asks for permissions, end to end: QuickRunService -> real RunManager -> real MockAdapter, temp data dir. */
let dir: string
let data: string
let work: string
let events: RunEvent[]
let ctxs: RuntimeContext[]
let runs: RunManager
let svc: QuickRunService
const persistInstall = vi.fn()

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-quick-chat-')))
  data = join(dir, 'data')
  work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  events = []
  ctxs = []
  persistInstall.mockReset()
  const mock = new MockAdapter({ script: { delayMs: 0 } })
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: (...a) => mock.complete(...a),
    start: (ctx) => {
      ctxs.push(ctx)
      return mock.start(ctx)
    }
  }
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const store = new RunStore(data)
  const mcp = { enabledServers: () => [], resolve: vi.fn(), persistInstall, searchRegistry: vi.fn(), libraryEntries: () => [] }
  runs = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: data, mcp: mcp as never, listProjects: () => [] })
  svc = new QuickRunService({ dataDir: data, settings: () => DEFAULT_APP_SETTINGS, runs, store, projects: new ProjectStore(data), prepare: (p) => p, broadcast: (e) => void events.push(e), mock: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

type Req = Extract<RunEvent, { type: 'permission.request' }>
const cards = (): Req[] => events.filter((e): e is Req => e.type === 'permission.request')
const resolved = () => events.filter((e) => e.type === 'permission.resolved')
const texts = (): string[] => events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
const harnessRows = (): string[] => events.flatMap((e) => (e.type === 'transcript' && e.entry.source === 'harness' && e.entry.block.kind === 'system' ? [e.entry.block.text] : []))
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 5000 })

async function startEdit(): Promise<string> {
  const run = await svc.start({ prompt: `Write notes ${CHAT_EDIT_TOKEN}`, folder: work, team: 'single', allowEdits: false })
  return run.id
}

describe('[mock:chat-edit] under the real RunManager', () => {
  it('(a)+(b) the first Edit asks read-only and session-only; a session allow writes the file, records it and covers the folder', async () => {
    const id = await startEdit()
    await waitFor(() => expect(cards()).toHaveLength(1))
    const card: PermissionRequest = cards()[0]!.request
    expect(card.toolName).toBe('Edit')
    expect(card.quickReadOnly).toBe(true)
    expect(card.maxScope).toBe('session')
    expect(card.workingFolder).toBe(work)
    expect(card.workingFolderScratch).toBeUndefined()
    expect(card.ruleLabels).toEqual([QUICK_SESSION_EDIT_LABEL])
    expect(card.suggestions?.some((s) => s.type === 'setMode' && s.destination === 'session')).toBe(true)
    // No project-scope offer: only a session mode suggestion, nothing aimed at the project's files.
    expect(card.suggestions?.some((s) => (s as { destination?: string }).destination === 'projectSettings' || (s as { destination?: string }).destination === 'localSettings')).toBe(false)
    expect(existsSync(join(work, 'notes.md'))).toBe(false)

    runs.decide(id, card.id, { behavior: 'allow', scope: 'session' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_EDIT_DONE))
    expect(readFileSync(join(work, 'notes.md'), 'utf8')).toBe(MOCK_CHAT_NOTES)
    expect(resolved()[0]).toMatchObject({ type: 'permission.resolved', requestId: card.id, scope: 'session' })
    expect(harnessRows()).toContain("You allowed edits in this chat's folder for this chat.")
    // The harness row sits on the root agent.
    const row = events.find((e) => e.type === 'transcript' && e.entry.block.kind === 'system' && e.entry.block.text.startsWith('You allowed edits'))
    expect(row?.type === 'transcript' && row.entry.agentId).toBe('root')

    // The run's flag now covers a second edit: the real context says so and the real pre-approval predicate agrees.
    const ctx = ctxs[0]!
    expect(ctx.quickSessionEdits?.()).toBe(true)
    expect(quickEditFree(ctx, 'Edit', { file_path: join(work, 'second.md') }, work)).toBe(true)
    expect(quickEditFree(ctx, 'Edit', { file_path: join(dir, 'outside.md') }, work)).toBe(false)
    expect(quickEditFree(ctx, 'Edit', { file_path: join(work, '.claude', 'settings.json') }, work)).toBe(false)

    // Then npm test asks on its own card: read-only flagged, a rule suggestion, no mode change.
    await waitFor(() => expect(cards()).toHaveLength(2))
    const bash = cards()[1]!.request
    expect(bash.toolName).toBe('Bash')
    expect(bash.quickReadOnly).toBe(true)
    expect(bash.suggestions?.some((s) => s.type === 'setMode')).toBe(false)
    expect(bash.ruleLabels?.length).toBeGreaterThan(0)
    runs.decide(id, bash.id, { behavior: 'allow', scope: 'session' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_TEST_DONE))
    expect(harnessRows().some((r) => r.startsWith('You allowed ') && !r.includes('edits in'))).toBe(true)
    await runs.stop(id)
  })

  it('(c) a project-scope allow resolves as session and writes nothing under .claude', async () => {
    const id = await startEdit()
    await waitFor(() => expect(cards()).toHaveLength(1))
    runs.decide(id, cards()[0]!.request.id, { behavior: 'allow', scope: 'project' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_EDIT_DONE))
    const r = resolved()[0]
    expect(r).toMatchObject({ scope: 'session' })
    expect(r && 'savedToProject' in r).toBe(false)
    expect(existsSync(join(work, '.claude'))).toBe(false)
    expect(readdirSync(work).sort()).toEqual(['notes.md'])
    expect(ctxs[0]!.quickSessionEdits?.()).toBe(true)
    await runs.stop(id)
  })

  it('(d) a deny writes nothing, the assistant says so and no Bash card follows', async () => {
    const id = await startEdit()
    await waitFor(() => expect(cards()).toHaveLength(1))
    runs.decide(id, cards()[0]!.request.id, { behavior: 'deny', message: 'No' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_EDIT_DENIED))
    await new Promise((r) => setTimeout(r, 100))
    expect(cards()).toHaveLength(1)
    expect(existsSync(join(work, 'notes.md'))).toBe(false)
    expect(ctxs[0]!.quickSessionEdits?.()).toBe(false)
    expect(harnessRows().some((r) => r.startsWith('You allowed'))).toBe(false)
    await runs.stop(id)
  })

  it('(e) after an allow-once edit the npm test card is read-only flagged; deny says so; allow once grants no session edits', async () => {
    const id = await startEdit()
    await waitFor(() => expect(cards()).toHaveLength(1))
    runs.decide(id, cards()[0]!.request.id, { behavior: 'allow', scope: 'once' })
    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(ctxs[0]!.quickSessionEdits?.()).toBe(false)
    expect(cards()[1]!.request).toMatchObject({ toolName: 'Bash', quickReadOnly: true, maxScope: 'session' })
    runs.decide(id, cards()[1]!.request.id, { behavior: 'deny', message: 'No' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_TEST_DENIED))
    await runs.stop(id)
  })

  it('(e) a session allow on the npm test card stays session, names the rule and saves nothing in the folder', async () => {
    const id = await startEdit()
    await waitFor(() => expect(cards()).toHaveLength(1))
    runs.decide(id, cards()[0]!.request.id, { behavior: 'allow', scope: 'once' })
    await waitFor(() => expect(cards()).toHaveLength(2))
    runs.decide(id, cards()[1]!.request.id, { behavior: 'allow', scope: 'session' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_TEST_DONE))
    // The rule suggestion is the mock's own session rule (the repeat itself is covered in mockQuickChat.test.ts, the
    // chat-edit script has one Bash step): here RunManager keeps the scope session and writes the harness row.
    expect(resolved()[1]).toMatchObject({ scope: 'session' })
    expect(harnessRows().some((r) => /^You allowed .*npm test.* for this chat\.$/.test(r))).toBe(true)
    expect(existsSync(join(work, '.claude'))).toBe(false)
    await runs.stop(id)
  })

  it('a scratch quick run (no folder) marks the card workingFolderScratch', async () => {
    const run = await svc.start({ prompt: `Write notes ${CHAT_EDIT_TOKEN}`, team: 'single' })
    expect(run.quick?.scratch).toBe(true)
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(cards()[0]!.request).toMatchObject({ workingFolder: run.quick!.folder, workingFolderScratch: true, quickReadOnly: true })
    await runs.stop(run.id)
  })
})

describe('[mock:chat-mcp] under the real RunManager', () => {
  const installCards = () => events.filter((e): e is Extract<RunEvent, { type: 'mcpInstall.request' }> => e.type === 'mcpInstall.request')

  it('QUICK_TOOL_DEFS carries request_mcp_install', () => {
    expect(QUICK_TOOL_DEFS.some((t) => t.name === MCP_HARNESS_TOOLS.requestInstall)).toBe(true)
  })

  it('approving attaches the server to this run only', async () => {
    const run = await svc.start({ prompt: `Add a server ${CHAT_MCP_TOKEN}`, folder: work, team: 'single' })
    await waitFor(() => expect(installCards()).toHaveLength(1))
    const req: McpInstallRequest = installCards()[0]!.request
    expect(req.runOnly).toBe(true)
    expect(req.spec.roles).toEqual(['assistant'])
    runs.answerMcpInstall(run.id, req.id, { approved: true, scope: 'project' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_MCP_ADDED))
    const outcome = events.find((e) => e.type === 'mcpInstall.resolved')
    expect(outcome).toMatchObject({ outcome: { approved: true, scope: 'run' } })
    const names = (ctxs[0]!.mcpServers?.() ?? []).map((s: McpServerSpec) => s.name)
    expect(names).toEqual([MOCK_MIDRUN_SERVER])
    expect(ctxs[0]!.mcpServers?.()[0]!.roles).toEqual(['assistant'])
    // Nothing persisted anywhere.
    expect(persistInstall).not.toHaveBeenCalled()
    expect(existsSync(join(data, 'mcp-library.json'))).toBe(false)
    expect(events.some((e) => e.type === 'project.updated')).toBe(false)

    // A second quick run does not see it.
    const second = await svc.start({ prompt: 'hello', folder: work, team: 'single' })
    await waitFor(() => expect(ctxs).toHaveLength(2))
    expect(ctxs[1]!.mcpServers?.()).toEqual([])
    await runs.stop(second.id)
    await runs.stop(run.id)
  })

  it('declining answers the assistant "You declined the server." and attaches nothing', async () => {
    const run = await svc.start({ prompt: `Add a server ${CHAT_MCP_TOKEN}`, folder: work, team: 'single' })
    await waitFor(() => expect(installCards()).toHaveLength(1))
    runs.answerMcpInstall(run.id, installCards()[0]!.request.id, { approved: false, scope: 'run' })
    await waitFor(() => expect(texts()).toContain(MOCK_CHAT_MCP_DECLINED))
    expect(ctxs[0]!.mcpServers?.()).toEqual([])
    expect(persistInstall).not.toHaveBeenCalled()
    await runs.stop(run.id)
  })
})
