import { describe, expect, it, vi } from 'vitest'
import type { McpMutationResult, McpServerSpec, Project, Role } from '@shared/types'
import { serverGranted } from './roleCapabilities'
import {
  addRoleUnder,
  moveNotice,
  nextRoleName,
  removeRole,
  restoreRole,
  setReportsTo,
  renamePatch,
  settleRename,
  SLUG_TAKEN_TEXT,
  slugFieldEdit,
  slugPatch,
  spawnNotice,
  staleSlugServers,
  uniqueSlug,
  type RenameProject,
  withRequiredReport,
  withSpawnableToggled,
  wouldCycle,
  type SettleRenameDeps
} from './roleOps'

const role = (id: string, reportsTo: string | null, spawnable: string[] = []): Role =>
  ({ id, name: id, slug: id, reportsTo, spawnable, canSpawn: spawnable.length > 0, tools: [], responsibilities: [] }) as unknown as Role

describe('roleOps', () => {
  const roles = [role('root', null, ['a']), role('a', 'root', ['b']), role('b', 'a')]

  it('names new roles uniquely only when needed', () => {
    expect(nextRoleName(roles)).toBe('New role')
    expect(nextRoleName([...roles, role('New role', 'root')])).toBe('New role 2')
  })

  it('removes a role, re-parents its reports and restores it on undo', () => {
    const { roles: after, removed } = removeRole(roles, 'a')
    expect(after.find((r) => r.id === 'b')?.reportsTo).toBe('root')
    expect(after.find((r) => r.id === 'root')?.spawnable).toEqual([])
    const back = restoreRole(after, removed!)
    expect(back.map((r) => r.id)).toEqual(['root', 'a', 'b'])
    expect(back.find((r) => r.id === 'b')?.reportsTo).toBe('a')
    expect(back.find((r) => r.id === 'root')?.spawnable).toEqual(['a'])
  })

  it('re-parents to root and detects cycles', () => {
    const next = setReportsTo(roles, 'b', 'root')
    expect(next.find((r) => r.id === 'b')?.reportsTo).toBe('root')
    expect(next.find((r) => r.id === 'a')?.spawnable).toEqual([])
    expect(wouldCycle(roles, 'a', 'b')).toBe(true)
    expect(wouldCycle(roles, 'b', 'root')).toBe(false)
  })
})

describe('spawn rights follow delegation (D1)', () => {
  const base = (): Role[] => [role('root', null, ['a', 'b']), role('a', 'root'), role('b', 'root')]
  const get = (rs: Role[], id: string): Role => rs.find((r) => r.id === id)!
  const fresh = role('n', 'a')

  it('adding a role under a manager grants it spawn rights and says so', () => {
    const before = base()
    const after = addRoleUnder(before, fresh)
    expect(get(after, 'a')).toMatchObject({ canSpawn: true, spawnable: ['n'] })
    expect(after.map((r) => r.id)).toEqual(['root', 'a', 'b', 'n'])
    expect(spawnNotice(before, after, 'n')).toBe('a can now create subagents, because n reports to it.')
  })

  it('moving the only report away takes the right back, and moving it back grants it again', () => {
    const added = addRoleUnder(base(), fresh)
    const moved = setReportsTo(added, 'n', 'b')
    expect(get(moved, 'a')).toMatchObject({ canSpawn: false, spawnable: [] })
    expect(get(moved, 'b')).toMatchObject({ canSpawn: true, spawnable: ['n'] })
    expect(spawnNotice(added, moved, 'n')).toBe('b can now create subagents, because n reports to it. a can no longer create subagents: nobody it may delegate to is left.')
    const back = setReportsTo(moved, 'n', 'a')
    expect(get(back, 'a')).toMatchObject({ canSpawn: true, spawnable: ['n'] })
    expect(get(back, 'b')).toMatchObject({ canSpawn: false, spawnable: [] })
  })

  it('keeps a hand-ticked right on a role with no delegates until a change empties its list', () => {
    const roles = base().map((r) => (r.id === 'b' ? { ...r, canSpawn: true } : r))
    const moved = setReportsTo(roles, 'a', 'root')
    expect(get(moved, 'b').canSpawn).toBe(true)
    expect(spawnNotice(roles, moved, 'a')).toBeNull()
  })

  it('a manager that keeps other delegates keeps its right', () => {
    const moved = setReportsTo(base(), 'a', 'b')
    expect(get(moved, 'root')).toMatchObject({ canSpawn: true, spawnable: ['b'] })
  })

  it('removing the last report takes the right back; Undo restores canSpawn, spawnable and Required exactly', () => {
    const roles = addRoleUnder(base(), fresh).map((r) => (r.id === 'a' ? { ...r, requiredReports: ['n'] } : r))
    const { roles: after, removed } = removeRole(roles, 'n')
    expect(get(after, 'a')).toMatchObject({ canSpawn: false, spawnable: [] })
    expect(get(after, 'a').requiredReports).toBeUndefined()
    expect(spawnNotice(roles, after, 'n')).toBe('a can no longer create subagents: nobody it may delegate to is left.')
    const back = restoreRole(after, removed!)
    expect(back).toEqual(roles)
  })

  it('Undo after a later edit to the manager adds the role back without undoing that edit', () => {
    const roles = addRoleUnder(base(), fresh)
    const { roles: after, removed } = removeRole(roles, 'n')
    const edited = after.map((r) => (r.id === 'a' ? { ...r, spawnable: ['b'], canSpawn: true } : r))
    const back = restoreRole(edited, removed!)
    expect(get(back, 'a')).toMatchObject({ canSpawn: true, spawnable: ['b', 'n'] })
  })
})

describe('requiredReports', () => {
  const mgr = (over: Partial<Role> = {}): Role => ({ ...role('mgr', 'root', ['p', 'e']), requiredReports: ['p'], ...over })

  it('marks and unmarks a spawnable report as required', () => {
    expect(withRequiredReport(mgr({ requiredReports: undefined }), 'e', true).requiredReports).toEqual(['e'])
    expect(withRequiredReport(mgr(), 'e', true).requiredReports).toEqual(['p', 'e'])
    expect(withRequiredReport(mgr(), 'p', false).requiredReports).toBeUndefined()
  })

  it('ignores a report outside spawnable', () => {
    expect(withRequiredReport(mgr(), 'zzz', true).requiredReports).toEqual(['p'])
  })

  it('unchecking spawnable also removes the report from requiredReports', () => {
    const patch = withSpawnableToggled(mgr(), 'p')
    expect(patch.spawnable).toEqual(['e'])
    expect(patch.requiredReports).toBeUndefined()
    expect(withSpawnableToggled(mgr(), 'e').requiredReports).toEqual(['p'])
  })

  it('removing a role or re-parenting it drops it from a manager requirement', () => {
    const roles = [role('root', null, ['mgr']), mgr(), role('p', 'mgr'), role('e', 'mgr')]
    expect(removeRole(roles, 'p').roles.find((r) => r.id === 'mgr')?.requiredReports).toBeUndefined()
    expect(setReportsTo(roles, 'p', 'root').find((r) => r.id === 'mgr')?.requiredReports).toBeUndefined()
  })
})

describe('renamePatch', () => {
  const srv = (id: string, roles?: string[]) => ({ id, roles }) as unknown as McpServerSpec
  const proj = { mcpServers: [srv('s1', ['dev']), srv('s2'), srv('s3', ['other'])] }
  const dev = { ...role('d', 'root'), name: 'Dev', slug: 'dev' } as Role

  it('keeps a slug-granted server granted after the rename', () => {
    const patch = renamePatch(proj, dev, 'Developer')
    expect(patch).toMatchObject({ name: 'Developer', slug: 'developer', mcpServers: ['s1'] })
    const after = { ...dev, ...patch }
    expect(serverGranted(proj.mcpServers[0], after)).toBe(true)
    expect(serverGranted(proj.mcpServers[2], after)).toBe(false)
  })

  it('adds nothing for an every-role server and keeps id grants', () => {
    expect(renamePatch({ mcpServers: [srv('s2')] }, dev, 'Developer').mcpServers).toBeUndefined()
    const held = { ...dev, mcpServers: ['s9'] } as Role
    expect(renamePatch({ mcpServers: [srv('s9', ['dev'])] }, held, 'Developer').mcpServers).toBeUndefined()
    expect(renamePatch(proj, held, 'Developer').mcpServers).toEqual(['s9', 's1'])
  })

  it('does not duplicate when renaming twice, and a slug-only edit goes through the same path', () => {
    const once = { ...dev, ...renamePatch(proj, dev, 'Dev A') } as Role
    const twice = { ...once, ...renamePatch(proj, once, 'Dev AB') } as Role
    expect(twice.mcpServers).toEqual(['s1'])
    expect(slugPatch(proj, dev, 'dv')).toEqual({ slug: 'dv', mcpServers: ['s1'] })
    // Back at the starting slug the carried id stays (recheck M, main's rename rule).
    expect(renamePatch(proj, dev, 'DEV')).toEqual({ name: 'DEV', slug: 'dev', mcpServers: ['s1'] })
  })

  // Review H1: every keystroke is computed against the slug and grants the edit started with.
  const typeLetters = (project: RenameProject, r: Role, text: string): Role => {
    const start = { id: r.id, slug: r.slug, mcpServers: r.mcpServers }
    let cur = r
    for (let i = 1; i <= text.length; i++) cur = { ...cur, ...renamePatch(project, start, text.slice(0, i)) }
    return cur
  }
  const builder = { ...role('b', 'root'), name: 'Builder', slug: 'builder' } as Role

  it('typing a name whose in-between slug matches another role adds no connection (H1)', () => {
    // `qa` belongs to another role; "QA Lead" passes through the slug `qa` while typing.
    const project = { mcpServers: [srv('qa-db', ['qa']), srv('mine', ['builder'])] }
    const after = typeLetters(project, builder, 'QA Lead')
    expect(after.slug).toBe('qa-lead')
    expect(after.mcpServers).toEqual(['mine'])
    expect(after.mcpServers).not.toContain('qa-db')
    expect(serverGranted(project.mcpServers[0], after)).toBe(false)
  })

  it('backspacing through another role slug adds nothing either (H1)', () => {
    const project = { mcpServers: [srv('dev-db', ['dev'])] }
    const developer = { ...role('x', 'root'), name: 'developer', slug: 'developer' } as Role
    const start = { id: developer.id, slug: developer.slug, mcpServers: developer.mcpServers }
    let cur = developer
    for (const text of ['develope', 'develop', 'develo', 'devel', 'deve', 'dev', 'de']) cur = { ...cur, ...renamePatch(project, start, text) }
    expect(cur.slug).toBe('de')
    expect(cur.mcpServers ?? []).toEqual([])
    // Stopping on `dev` itself still adds nothing: that server is another role's by slug.
    const atDev = { ...developer, ...renamePatch(project, start, 'dev') }
    expect(atDev.mcpServers ?? []).toEqual([])
  })

  it('a grant held by the starting slug survives typing, and typing back to the start keeps the id grant', () => {
    const typed = typeLetters(proj, dev, 'Developer')
    expect(typed.mcpServers).toEqual(['s1'])
    const start = { id: dev.id, slug: dev.slug, mcpServers: dev.mcpServers }
    expect({ ...typed, ...renamePatch(proj, start, 'Dev') }.mcpServers).toEqual(['s1'])
  })

  it('typing back to the starting slug in the Slug field keeps the id grant (recheck M, main rename rule)', () => {
    const project = { mcpServers: [srv('db', ['builder'])], roles: [builder] }
    const start = { id: builder.id, slug: builder.slug, mcpServers: builder.mcpServers }
    let cur = builder
    for (const v of ['builde', 'build', 'b', 'bu', 'builder']) {
      const r = slugFieldEdit(project, start, v)
      if ('patch' in r) cur = { ...cur, ...r.patch }
    }
    expect(cur.slug).toBe('builder')
    expect(cur.mcpServers).toEqual(['db'])
  })

  describe('unique slugs (recheck M)', () => {
    const b = { ...role('qa', 'root'), name: 'QA', slug: 'qa' } as Role
    const project = { mcpServers: [srv('qa-db', ['qa']), srv('mine', ['builder'])], roles: [builder, b] }

    it('typing a name whose slug another role holds keeps the name and suffixes the slug; no grants of that role', () => {
      const after = typeLetters(project, builder, 'QA')
      expect(after.name).toBe('QA')
      expect(after.slug).toBe('qa-2')
      expect(after.mcpServers).toEqual(['mine'])
      expect(serverGranted(project.mcpServers[0], after)).toBe(false)
      // The next free suffix.
      const crowded = { ...project, roles: [...project.roles, { ...role('q2', 'root'), slug: 'qa-2' } as Role] }
      expect(renamePatch(crowded, builder, 'QA').slug).toBe('qa-3')
      expect(uniqueSlug(crowded.roles, 'qa', 'qa')).toBe('qa')
    })

    it('typing "QA Lead" letter by letter never produces another role slug', () => {
      const start = { id: builder.id, slug: builder.slug, mcpServers: builder.mcpServers }
      const text = 'QA Lead'
      const slugs: string[] = []
      for (let i = 1; i <= text.length; i++) slugs.push(renamePatch(project, start, text.slice(0, i)).slug!)
      expect(slugs).not.toContain('qa')
      expect(slugs.at(-1)).toBe('qa-lead')
      expect(typeLetters(project, builder, text).mcpServers).toEqual(['mine'])
    })

    it('a direct Slug edit to a taken value is refused and not applied', () => {
      const start = { id: builder.id, slug: builder.slug, mcpServers: builder.mcpServers }
      expect(slugFieldEdit(project, start, 'QA')).toEqual({ error: SLUG_TAKEN_TEXT })
      expect(SLUG_TAKEN_TEXT).toBe('Another role already uses this ID.')
      expect(slugFieldEdit(project, start, 'qa-x')).toEqual({ patch: { slug: 'qa-x', mcpServers: ['mine'] } })
      // Its own slug is never "taken".
      expect(slugFieldEdit(project, start, 'builder')).toEqual({ patch: { slug: 'builder', mcpServers: ['mine'] } })
    })
  })

  it('a double rename (two edits) does not duplicate grants', () => {
    const first = typeLetters(proj, dev, 'Dev A')
    const second = typeLetters(proj, first, 'Dev AB')
    expect(second.mcpServers).toEqual(['s1'])
  })
})

describe('stale slug after a rename (M3 a)', () => {
  const srv = (id: string, roles?: string[]) => ({ id, name: id, transport: 'stdio', command: 'x', enabled: true, roles }) as unknown as McpServerSpec
  const renamed = { ...role('d', 'root'), name: 'Developer', slug: 'developer', mcpServers: ['s1'] } as Role
  const lead = { ...role('l', null), name: 'Lead', slug: 'lead' } as Role
  const project = (roles: Role[], servers: McpServerSpec[]): Project =>
    ({ id: 'p', name: 'P', roles, mcpServers: servers }) as unknown as Project

  it('plans to drop the old slug only from explicit lists the renamed role now holds by id', () => {
    const servers = [srv('s1', ['dev', 'lead']), srv('s2'), srv('s3', ['dev'])]
    const plan = staleSlugServers(project([lead, renamed], servers), servers, 'd', 'dev')
    // s3 is not held by id, so dropping the slug there would cut access: left alone. s2 is every role: left alone.
    expect(plan.map((p) => [p.spec.id, p.roles])).toEqual([['s1', ['lead']]])
  })

  it('removes only the renamed role old slug; another absent role slug is left alone (recheck M)', () => {
    // `ghost` belongs to no current role: a role removed with Undo on screen, or one named by team files awaiting approval.
    const servers = [srv('s1', ['dev', 'ghost', 'lead'])]
    const plan = staleSlugServers(project([lead, renamed], servers), servers, 'd', 'dev')
    expect(plan.map((p) => [p.spec.id, p.roles])).toEqual([['s1', ['ghost', 'lead']]])
  })

  it('plans nothing while another role holds the old slug', () => {
    const servers = [srv('s1', ['dev'])]
    const other = { ...role('o', 'root'), slug: 'dev' } as Role
    expect(staleSlugServers(project([lead, renamed, other], servers), servers, 'd', 'dev')).toEqual([])
  })

  const deps = (over: Partial<SettleRenameDeps> & { store: Project }): SettleRenameDeps & { upsert: ReturnType<typeof vi.fn> } => {
    const upsert = vi.fn(async (spec: McpServerSpec) => ({ project: { ...over.store, mcpServers: [spec] }, servers: [] }) as unknown as McpMutationResult)
    return {
      current: () => over.store,
      save: async (p) => p,
      servers: async () => over.store.mcpServers ?? [],
      applied: () => undefined,
      ...over,
      upsert: (over.upsert as ReturnType<typeof vi.fn>) ?? upsert
    } as SettleRenameDeps & { upsert: ReturnType<typeof vi.fn> }
  }

  it('saves first, then upserts once per stale server; returns the count', async () => {
    const order: string[] = []
    const store = project([lead, renamed], [srv('s1', ['dev', 'lead'])])
    const d = deps({ store, save: async (p) => (order.push('save'), p) })
    const upsert = d.upsert
    upsert.mockImplementation(async (spec: McpServerSpec) => (order.push(`upsert:${spec.id}`), { project: store, servers: [] }))
    const res = await settleRename('d', 'dev', d)
    expect(res).toEqual({ upserts: 1, left: 0 })
    expect(order).toEqual(['save', 'upsert:s1'])
    expect(upsert.mock.calls[0][0]).toMatchObject({ id: 's1', roles: ['lead'] })
  })

  it('save fails: no upsert is sent and the role keeps access (by id and by the old slug)', async () => {
    const store = project([lead, renamed], [srv('s1', ['dev'])])
    const d = deps({ store, save: async () => Promise.reject(new Error('disk full')) })
    const res = await settleRename('d', 'dev', d)
    expect(res).toEqual({ upserts: 0, error: 'save', left: 1 })
    expect(d.upsert).not.toHaveBeenCalled()
    expect(serverGranted(store.mcpServers![0], store.roles[1])).toBe(true)
  })

  it('sends nothing when main already dropped the old slug on save, or when the slug did not change', async () => {
    const store = project([lead, renamed], [srv('s1', ['dev'])])
    const d = deps({ store, servers: async () => [srv('s1', [])] })
    expect(await settleRename('d', 'dev', d)).toEqual({ upserts: 0, left: 0 })
    expect(d.upsert).not.toHaveBeenCalled()
    const same = deps({ store, save: vi.fn() })
    expect(await settleRename('d', 'developer', same)).toEqual({ upserts: 0, left: 0 })
    expect(same.save).not.toHaveBeenCalled()
  })

  it('an upsert failure stops and reports what is left', async () => {
    const store = project([lead, { ...renamed, mcpServers: ['s1', 's2'] }], [srv('s1', ['dev']), srv('s2', ['dev'])])
    const d = deps({ store })
    d.upsert.mockRejectedValueOnce(new Error('nope'))
    expect(await settleRename('d', 'dev', d)).toEqual({ upserts: 1, error: 'upsert', left: 2 })
  })
})

describe('Undo of a removal keeps later edits (M1)', () => {
  const get = (rs: Role[], id: string): Role => rs.find((r) => r.id === id)!
  const team = (): Role[] => [
    { ...role('root', null, ['a', 'x']), requiredReports: ['a', 'x'] },
    role('a', 'root'),
    role('x', 'root')
  ]

  it('an untouched manager is restored exactly', () => {
    const roles = team()
    const { roles: after, removed } = removeRole(roles, 'a')
    expect(restoreRole(after, removed!)).toEqual(roles)
  })

  it('"May create subagents" unticked after the removal stays off after Undo', () => {
    const { roles: after, removed } = removeRole(team(), 'a')
    const edited = after.map((r) => (r.id === 'root' ? { ...r, canSpawn: false } : r))
    const back = restoreRole(edited, removed!)
    expect(get(back, 'root').canSpawn).toBe(false)
    expect(get(back, 'root').spawnable).toEqual(['a', 'x'])
  })

  it('a Required box unticked after the removal stays off after Undo', () => {
    const { roles: after, removed } = removeRole(team(), 'a')
    expect(get(after, 'root').requiredReports).toEqual(['x'])
    const edited = after.map((r) => (r.id === 'root' ? { ...r, requiredReports: undefined } : r))
    const back = restoreRole(edited, removed!)
    expect(get(back, 'root').requiredReports).toBeUndefined()
    expect(get(back, 'root').canSpawn).toBe(true)
  })

  it('a manager the removal emptied gets its right back only while it is still off as the removal left it', () => {
    const roles = [role('root', null, ['a']), role('a', 'root')]
    const { roles: after, removed } = removeRole(roles, 'a')
    expect(get(after, 'root').canSpawn).toBe(false)
    expect(get(restoreRole(after, removed!), 'root').canSpawn).toBe(true)
  })
})

describe('moveNotice (L1)', () => {
  it('names every other role that no longer delegates to the moved role', () => {
    const orch = { ...role('o', null, ['m', 'x']), name: 'Orchestrator', requiredReports: ['x'] }
    const before = [orch, { ...role('m', 'o'), name: 'Manager' }, { ...role('x', 'o'), name: 'X' }]
    const after = setReportsTo(before, 'x', 'm')
    expect(moveNotice(before, after, 'x')).toBe('Orchestrator no longer delegates to X. Manager can now create subagents, because X reports to it.')
  })

  it('says nothing when only the reporting line changed', () => {
    const before = [role('o', null), role('m', 'o', ['y']), role('y', 'm'), role('x', 'o')]
    expect(moveNotice(before, setReportsTo(before, 'x', 'm'), 'x')).toBeNull()
  })
})
