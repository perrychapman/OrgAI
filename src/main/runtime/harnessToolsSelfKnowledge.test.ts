import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, Project, QuickRunInfo, RunKind } from '@shared/types'
import { APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL, PROPOSE_APP_SETTINGS_TOOL, PROPOSE_PROJECT_SETTINGS_TOOL } from '@shared/types'
import { DEFAULT_APPEARANCE, DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { harnessToolCatalog, harnessToolsFor, isBlockingHarnessTool, type HarnessTool, type HarnessToolRunKind } from './harnessTools'
import { fakeCtx, project, runSummary } from './testHelpers'
import type { RuntimeContext } from './types'

const byName = (tools: HarnessTool[], name: string): HarnessTool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}
const names = (tools: HarnessTool[]): string[] => tools.map((t) => t.name)

const quick: QuickRunInfo = { folder: '/x', team: 'single', allowEdits: false, gitRepo: false }
const SETTINGS: AppSettings = { ...DEFAULT_APP_SETTINGS, appearance: { ...DEFAULT_APPEARANCE, theme: 'dark' } }

function chatCtx(over: Partial<RuntimeContext> = {}): RuntimeContext & { events: unknown[] } {
  return fakeCtx({ run: runSummary({ kind: 'work', projectId: 'quick', quick }), appSettings: () => SETTINGS, ...over })
}

describe('offering', () => {
  const cases: [string, () => RuntimeContext, boolean, string[]][] = [
    ['work', () => fakeCtx(), false, [APP_REFERENCE_TOOL]],
    ['single', () => fakeCtx({ run: runSummary({ kind: 'work', team: 'single' }) }), false, [APP_REFERENCE_TOOL]],
    ['engagement work', () => fakeCtx({ project: project({ kind: 'engagement' }) }), false, [APP_REFERENCE_TOOL]],
    ['quick', () => chatCtx(), true, [APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL, PROPOSE_APP_SETTINGS_TOOL, PROPOSE_PROJECT_SETTINGS_TOOL]],
    ['setup', () => fakeCtx({ run: runSummary({ kind: 'setup' }) }), true, [APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL]],
    ['mcp-assist', () => fakeCtx({ run: runSummary({ kind: 'mcp-assist' }) }), true, [APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL]],
    ['skill-assist', () => fakeCtx({ run: runSummary({ kind: 'skill-assist' }) }), true, [APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL]]
  ]
  it.each(cases)('%s runs get exactly the right self-knowledge tools', (_label, make, _root, expected) => {
    const all = [APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL, PROPOSE_APP_SETTINGS_TOOL, PROPOSE_PROJECT_SETTINGS_TOOL]
    const got = names(harnessToolsFor(make())).filter((n) => all.includes(n))
    expect(got).toEqual(expected)
  })

  it('app_reference reaches every agent (audience all) and never blocks; the rest are root-only', () => {
    const tools = harnessToolsFor(chatCtx())
    expect(byName(tools, APP_REFERENCE_TOOL).audience).toBe('all')
    for (const n of [OPEN_IN_APP_TOOL, PROPOSE_APP_SETTINGS_TOOL, PROPOSE_PROJECT_SETTINGS_TOOL]) expect(byName(tools, n).audience).toBe('root')
    expect(isBlockingHarnessTool(APP_REFERENCE_TOOL)).toBe(false)
    expect(isBlockingHarnessTool(OPEN_IN_APP_TOOL)).toBe(false)
    expect(isBlockingHarnessTool(PROPOSE_APP_SETTINGS_TOOL)).toBe(true)
    expect(isBlockingHarnessTool(PROPOSE_PROJECT_SETTINGS_TOOL)).toBe(true)
  })

  it('the catalog lists every tool harnessToolsFor returns for each run kind, with that kind', () => {
    const catalog = new Map(harnessToolCatalog().map((e) => [e.name, e]))
    const kinds: [HarnessToolRunKind, RuntimeContext][] = [
      ['work', fakeCtx()],
      ['engagement-work', fakeCtx({ project: project({ kind: 'engagement' }) })],
      ['single', fakeCtx({ run: runSummary({ kind: 'work', team: 'single' }) })],
      ['quick', chatCtx()],
      ['setup', fakeCtx({ run: runSummary({ kind: 'setup' }) })],
      ['mcp-assist', fakeCtx({ run: runSummary({ kind: 'mcp-assist' as RunKind }) })],
      ['skill-assist', fakeCtx({ run: runSummary({ kind: 'skill-assist' as RunKind }) })]
    ]
    for (const [kind, ctx] of kinds) {
      for (const t of harnessToolsFor(ctx)) {
        const entry = catalog.get(t.name)
        expect(entry, `${t.name} missing from the catalog`).toBeDefined()
        // 'engagement-work' lists only what engagement work runs add on top of 'work'.
        const ok = kind === 'engagement-work' ? entry!.runKinds.some((k) => k === 'work' || k === 'engagement-work') : entry!.runKinds.includes(kind)
        expect(ok, `${t.name} on ${kind}`).toBe(true)
      }
    }
    expect(catalog.get(OPEN_IN_APP_TOOL)!.runKinds).not.toContain('work')
    expect(catalog.get(PROPOSE_APP_SETTINGS_TOOL)!.runKinds).toEqual(['quick'])
  })
})

describe('app_reference', () => {
  it('says so when the reference is missing', async () => {
    const ctx = chatCtx()
    expect(await byName(harnessToolsFor(ctx), APP_REFERENCE_TOOL).call({ action: 'search', query: 'theme' })).toBe('The OrgAI reference is not available in this run.')
  })

  it('passes a clean query through and returns the service text', async () => {
    const appReference = vi.fn(async () => ({ text: 'ANSWER' }))
    const ctx = chatCtx({ appReference })
    expect(await byName(harnessToolsFor(ctx), APP_REFERENCE_TOOL).call({ action: 'search', query: 'theme', budget: 800 })).toBe('ANSWER')
    expect(appReference).toHaveBeenCalledWith({ action: 'search', query: 'theme', budget: 800 })
  })

  it('refuses hidden characters, overlong text and missing fields without calling the service', async () => {
    const appReference = vi.fn(async () => ({ text: 'x' }))
    const tool = byName(harnessToolsFor(chatCtx({ appReference })), APP_REFERENCE_TOOL)
    expect(await tool.call({ action: 'search', query: 'a‮b' })).toMatch(/^REFUSED: query contains a hidden character/)
    expect(await tool.call({ action: 'read', id: 'x​y' })).toMatch(/^REFUSED: id contains a hidden character/)
    expect(await tool.call({ action: 'search', query: 'q'.repeat(501) })).toMatch(/^REFUSED: query is longer/)
    expect(await tool.call({ action: 'read', id: 'i'.repeat(201) })).toMatch(/^REFUSED: id is longer/)
    expect(await tool.call({ action: 'locate' })).toMatch(/^REFUSED: locate needs a query/)
    expect(await tool.call({ action: 'read' })).toMatch(/^REFUSED: read needs an id/)
    expect(appReference).not.toHaveBeenCalled()
    await expect(tool.call({ action: 'nope' })).rejects.toThrow()
    await expect(tool.call({ action: 'search', query: 'q', budget: 10 })).rejects.toThrow()
    // status needs nothing else.
    expect(await tool.call({ action: 'status' })).toBe('x')
  })
})

describe('open_in_app', () => {
  it('says so when the run cannot navigate', async () => {
    expect(await byName(harnessToolsFor(chatCtx()), OPEN_IN_APP_TOOL).call({ surfaceId: 'dashboard' })).toBe('This run cannot open places in the app.')
  })

  it('refuses unknown ids, URLs, bad project ids and hidden characters before navigating', async () => {
    const navigate = vi.fn(() => ({ ok: true as const, path: 'Dashboard' }))
    const tool = byName(harnessToolsFor(chatCtx({ navigate })), OPEN_IN_APP_TOOL)
    expect(await tool.call({ surfaceId: 'no-such-place' })).toMatch(/^REFUSED: .*app_reference locate/)
    expect(await tool.call({ surfaceId: 'https://example.com' })).toMatch(/^REFUSED/)
    expect(await tool.call({ surfaceId: 'dashboard', projectId: '../x' })).toMatch(/^REFUSED: projectId/)
    expect(await tool.call({ surfaceId: 'dash​board' })).toMatch(/^REFUSED: surfaceId contains a hidden character/)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('answers with the opened path, or the refusal', async () => {
    const navigate = vi.fn()
      .mockReturnValueOnce({ ok: true, path: 'App settings › General' })
      .mockReturnValueOnce({ ok: false, refusal: 'Wait a moment before opening another place.' })
    const tool = byName(harnessToolsFor(chatCtx({ navigate })), OPEN_IN_APP_TOOL)
    const text = await tool.call({ surfaceId: 'app-settings-general', projectId: 'p_1' }, { agentId: 'root' })
    expect(text).toContain('Opened')
    expect(text).toContain('App settings › General')
    expect(text).toContain('for the user.')
    expect(navigate).toHaveBeenCalledWith({ surfaceId: 'app-settings-general', projectId: 'p_1' }, { agentId: 'root' })
    expect(await tool.call({ surfaceId: 'dashboard' })).toBe('REFUSED: Wait a moment before opening another place.')
  })
})

describe('propose_app_settings', () => {
  const call = (ctx: RuntimeContext, args: Record<string, unknown>) => byName(harnessToolsFor(ctx), PROPOSE_APP_SETTINGS_TOOL).call({ title: 'T', rationale: 'R', ...args })

  it('says so without settings', async () => {
    const ctx = chatCtx({ appSettings: undefined })
    expect(await call(ctx, { changes: [{ field: 'notifications', value: false }] })).toBe('App settings are not available in this run.')
  })

  it('builds from, to and label from main\'s settings, never the agent', async () => {
    const ctx = chatCtx()
    const text = await call(ctx, { changes: [{ field: 'appearance.theme', value: 'light', from: 'bogus', label: 'Bogus' }] })
    expect(text).toMatch(/^APPROVED\. The app settings were changed\./)
    const req = vi.mocked(ctx.requestProposal).mock.calls[0][0]
    // The card title is main-written from the changes, never the agent's title (review H1).
    expect(req).toMatchObject({ kind: 'appSettings', agentId: 'root', title: 'Change app settings: Theme dark → light' })
    expect(req.payload).toEqual({ rationale: 'R', changes: [{ field: 'appearance.theme', from: 'dark', to: 'light', label: 'Theme' }] })
  })

  it('drops no-op changes and answers when nothing is left', async () => {
    const ctx = chatCtx()
    const text = await call(ctx, { changes: [{ field: 'appearance.theme', value: 'dark' }] })
    expect(text).toBe('Nothing to change: those settings already have these values.')
    expect(ctx.requestProposal).not.toHaveBeenCalled()
    await call(ctx, { changes: [{ field: 'appearance.theme', value: 'dark' }, { field: 'notifications', value: !SETTINGS.notifications }] })
    const payload = vi.mocked(ctx.requestProposal).mock.calls[0][0].payload as { changes: { field: string }[] }
    expect(payload.changes.map((c) => c.field)).toEqual(['notifications'])
  })

  it('refuses bad values, duplicates, unknown fields and hidden characters with no card', async () => {
    const ctx = chatCtx()
    expect(await call(ctx, { changes: [{ field: 'appearance.theme', value: 'purple' }] })).toMatch(/^REVISE\. .*Theme must be one of/)
    expect(await call(ctx, { changes: [{ field: 'notifications', value: 'yes' }] })).toMatch(/^REVISE/)
    expect(await call(ctx, { changes: [{ field: 'defaultPermissionMode', value: 'bypassPermissions' }] })).toMatch(/^REVISE/)
    expect(await call(ctx, { changes: [{ field: 'notifications', value: true }, { field: 'notifications', value: false }] })).toMatch(/^REVISE\. .*more than once/)
    expect(await call(ctx, { title: 'a‮b', changes: [{ field: 'notifications', value: false }] })).toMatch(/^REVISE\. .*title contains a hidden character/)
    expect(await call(ctx, { changes: [{ field: 'setupModel', value: 'x​y' }] })).toMatch(/^REVISE/)
    await expect(call(ctx, { changes: [{ field: 'connections', value: true }] })).rejects.toThrow()
    await expect(call(ctx, { changes: [] })).rejects.toThrow()
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('does not show a declined proposal again', async () => {
    const ctx = chatCtx({ requestProposal: vi.fn(async () => ({ behavior: 'decline' as const })) })
    const args = { changes: [{ field: 'appearance.theme', value: 'light' }] }
    expect(await call(ctx, args)).toMatch(/^DECLINED/)
    expect(await call(ctx, args)).toMatch(/already proposed this exact change/)
    expect(ctx.requestProposal).toHaveBeenCalledTimes(1)
  })
})

describe('propose_project_settings', () => {
  const stored = (over: Partial<Project> = {}): Project => project({ id: 'p_real', name: 'Real project', ...over })
  const call = (ctx: RuntimeContext, args: Record<string, unknown>) => byName(harnessToolsFor(ctx), PROPOSE_PROJECT_SETTINGS_TOOL).call({ title: 'T', rationale: 'R', projectId: 'p_real', ...args })

  it('refuses unknown, virtual and malformed project ids', async () => {
    const storedProject = vi.fn((id: string) => (id === 'p_real' ? stored() : id === 'quick' ? project({ id: 'quick' }) : undefined))
    const ctx = chatCtx({ storedProject })
    const none = 'REFUSED: no such project; call list_projects for ids.'
    expect(await call(ctx, { projectId: 'nope', autoContinue: true })).toBe(none)
    expect(await call(ctx, { projectId: 'quick', autoContinue: true })).toBe(none)
    expect(await call(ctx, { projectId: 'harness', autoContinue: true })).toBe(none)
    expect(await call(ctx, { projectId: '../p', autoContinue: true })).toBe(none)
    expect(await call(ctx, { projectId: 'p​real', autoContinue: true })).toBe(none)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('says so without storedProject', async () => {
    expect(await call(chatCtx(), { autoContinue: true })).toBe('Project settings are not available in this run.')
  })

  it('asks a settings card with a target from the stored project and the given fields only', async () => {
    const ctx = chatCtx({ storedProject: () => stored() })
    const text = await call(ctx, { brief: '  A brief ', permissionMode: 'acceptEdits', maxBudgetUsd: 5, autoContinue: false })
    expect(text).toMatch(/^APPROVED\. The project settings were applied; they take effect from its next run\./)
    const req = vi.mocked(ctx.requestProposal).mock.calls[0][0]
    expect(req).toMatchObject({ kind: 'settings', agentId: 'root', target: { projectId: 'p_real', projectName: 'Real project' } })
    expect(req.payload).toEqual({ rationale: 'R', brief: 'A brief', permissionMode: 'acceptEdits', maxBudgetUsd: 5, autoContinue: false })
  })

  it('never takes bypassPermissions or allowRules, and refuses hidden characters', async () => {
    const ctx = chatCtx({ storedProject: () => stored() })
    await expect(call(ctx, { permissionMode: 'bypassPermissions' })).rejects.toThrow()
    await call(ctx, { autoContinue: true, allowRules: ['Bash(rm:*)'] })
    expect(vi.mocked(ctx.requestProposal).mock.calls[0][0].payload).not.toHaveProperty('allowRules')
    expect(await call(ctx, { brief: 'a‮b' })).toMatch(/^REVISE\. .*brief contains a hidden character/)
  })

  it('the card title is main-written and names the project and every field (review H1)', async () => {
    const ctx = chatCtx({ storedProject: () => stored({ kind: 'engagement' }) })
    await call(ctx, { title: 'Harmless tweak', permissionMode: 'auto', client: 'Acme', brief: 'New brief' })
    const req = vi.mocked(ctx.requestProposal).mock.calls[0][0]
    expect(req.title).toBe('Settings for project "Real project": brief (new text); permissionMode → auto; client → Acme')
  })

  it('a decline for one project never blocks the same change for another (review L1)', async () => {
    const ctx = chatCtx({
      storedProject: (id: string) => (id === 'p_real' || id === 'p_two' ? stored({ id, name: id }) : undefined),
      requestProposal: vi.fn(async () => ({ behavior: 'decline' as const }))
    })
    await call(ctx, { autoContinue: true })
    expect(await call(ctx, { autoContinue: true })).toMatch(/already proposed this exact change/)
    await call(ctx, { projectId: 'p_two', autoContinue: true })
    expect(ctx.requestProposal).toHaveBeenCalledTimes(2)
  })

  it('says nothing to change when no field is given', async () => {
    const ctx = chatCtx({ storedProject: () => stored() })
    expect(await call(ctx, {})).toBe('Nothing to change: no setting was given for that project.')
    expect(ctx.requestProposal).not.toHaveBeenCalled()
  })

  it('client is for engagements only, and isolateWriters is dropped for them', async () => {
    const code = chatCtx({ storedProject: () => stored() })
    expect(await call(code, { client: 'Acme' })).toBe('REFUSED: client applies to engagements only.')
    const eng = chatCtx({ storedProject: () => stored({ kind: 'engagement' }) })
    await call(eng, { client: '  Acme ', isolateWriters: true, autoContinue: true })
    expect(vi.mocked(eng.requestProposal).mock.calls[0][0].payload).toEqual({ rationale: 'R', client: 'Acme', autoContinue: true })
    expect(await call(eng, { client: 'a‮b' })).toMatch(/^REVISE\. .*client contains a hidden character/)
    await expect(call(eng, { client: 'c'.repeat(200) })).rejects.toThrow()
  })
})
