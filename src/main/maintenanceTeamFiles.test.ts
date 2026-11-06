import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaintenanceService } from './maintenance'
import { createProject, listOrgai, makeComputer, setRole, type Computer } from './teamFiles/service.fixture'

vi.mock('./log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let root: string
let repo: string
let c: Computer

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-maint-team-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  c = makeComputer(root, 'a', repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Remove OrgAI files and team files', () => {
  it('removes team.json, mcp.json, agents and skills, names them, keeps org.json and the empty-.orgai cleanup works', async () => {
    const p = createProject(c)
    c.svc.status(p.id)
    writeFileSync(join(repo, '.orgai', 'org.json'), '{}')
    const m = new MaintenanceService(c.projects, c.svc)
    const r = await m.uninstallRepo(p.id)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('.orgai/team.json')
    expect(r.message).toContain('.orgai/agents')
    expect(readdirSync(join(repo, '.orgai'))).toEqual(['org.json'])
  })

  it('the empty .orgai folder is removed when only team files were in it', async () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const m = new MaintenanceService(c.projects, c.svc)
    await m.uninstallRepo(p.id)
    expect(existsSync(join(repo, '.orgai'))).toBe(false)
  })

  it('after removal a later save creates nothing; enable writes the files again', async () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const m = new MaintenanceService(c.projects, c.svc)
    await m.uninstallRepo(p.id)
    expect(c.svc.check(p.id)).toMatchObject({ state: 'off', offReason: 'removed' })
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'A change after removal.' }))
    expect(listOrgai(repo)).toEqual([])
    expect(c.svc.beforeRun(c.projects.get(p.id)!).warning).toBeUndefined()
    expect(listOrgai(repo)).toEqual([])
    const r = c.svc.enable({ projectId: p.id })
    expect(r.status.state).toBe('in-sync')
    expect(listOrgai(repo)).toContain('team.json')
    expect(listOrgai(repo).filter((f) => f.startsWith('agents/')).length).toBe(c.projects.get(p.id)!.roles.length)
    expect(c.projects.get(p.id)!.roles.find((x) => x.slug === 'reviewer')!.prompt).toBe('A change after removal.')
    // Writes work again.
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'And again.' }))
    expect(listOrgai(repo)).toContain('agents/reviewer.md')
  })

  it('works without a team files service (older wiring)', async () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const m = new MaintenanceService(c.projects)
    const r = await m.uninstallRepo(p.id)
    expect(r.ok).toBe(true)
    expect(existsSync(join(repo, '.orgai', 'team.json'))).toBe(false)
  })

  it('an engagement is untouched', async () => {
    const e = c.projects.create({ name: 'Eng', path: repo, brief: '', kind: 'engagement' }, undefined, {})
    const m = new MaintenanceService(c.projects, c.svc)
    expect(await m.uninstallRepo(e.id)).toEqual({ ok: true, message: 'Nothing to remove.' })
  })
})
