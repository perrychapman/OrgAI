import { describe, expect, it } from 'vitest'
import { ATLAS_SURFACE_IDS, atlasSurface } from '@shared/view/atlas'
import { navigationFor, plainLabel, SURFACE_TARGETS } from './appNavigate'

const PROJECTS = [
  { id: 'p1', name: 'Notes API', kind: 'code' as const },
  { id: 'e1', name: 'Acme audit', kind: 'engagement' as const }
]
const ev = (surfaceId: string, extra: Record<string, unknown> = {}): never => ({ surfaceId, runId: 'r1', agentLabel: 'Assistant', ...extra }) as never

describe('SURFACE_TARGETS', () => {
  it('has a target for every atlas surface, menus only for menu surfaces', () => {
    for (const id of ATLAS_SURFACE_IDS) {
      const t = SURFACE_TARGETS[id]
      expect(t, id).toBeDefined()
      expect(t.kind === 'menu', id).toBe(atlasSurface(id).kind === 'menu')
    }
  })
  it('app-scope surfaces never need a project; project-scope ones never go to App settings', () => {
    for (const id of ATLAS_SURFACE_IDS) {
      const s = atlasSurface(id)
      const t = SURFACE_TARGETS[id]
      if (s.scope === 'project' || s.scope === 'engagement') expect(['project', 'run'], id).toContain(t.kind)
      if (t.kind === 'app') expect(s.scope, id).toBe('app')
    }
  })
})

describe('navigationFor', () => {
  it('opens App settings > General > Appearance with the banner sentence', () => {
    const plan = navigationFor(ev('app-settings-general-appearance'), { projects: PROJECTS })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.target).toEqual({ kind: 'app', target: 'appsettings-section-appearance' })
    expect(plan.message).toBe('Assistant opened App settings › General › Appearance for you.')
    expect(plan.projectId).toBeUndefined()
  })
  it('names the project instead of "Project" and selects it', () => {
    const plan = navigationFor(ev('project-settings-limits', { projectId: 'p1' }), { projects: PROJECTS })
    expect(plan.ok && plan.projectId).toBe('p1')
    expect(plan.ok && plan.message).toBe('Assistant opened Notes API › Settings › Limits for you.')
  })
  it('refuses an unknown or missing project and an engagement place on a code project', () => {
    expect(navigationFor(ev('project-team', { projectId: 'nope' }), { projects: PROJECTS }).ok).toBe(false)
    expect(navigationFor(ev('project-team'), { projects: PROJECTS }).ok).toBe(false)
    expect(navigationFor(ev('project-team', { projectId: 'quick' }), { projects: [...PROJECTS, { id: 'quick', name: 'Chat' }] }).ok).toBe(false)
    const eng = navigationFor(ev('project-knowledge', { projectId: 'p1' }), { projects: PROJECTS })
    expect(eng.ok).toBe(false)
    expect(navigationFor(ev('project-knowledge', { projectId: 'e1' }), { projects: PROJECTS }).ok).toBe(true)
  })
  it('names the menu path for menu surfaces and moves nothing', () => {
    const plan = navigationFor(ev('menu-help'), { projects: PROJECTS })
    expect(plan).toEqual({ ok: false, path: 'Help', message: 'Assistant pointed you to Help in the menu bar.' })
  })
  it('opens a run part in the asking run when no project is named', () => {
    const plan = navigationFor(ev('run-usage'), { projects: PROJECTS, runProjectId: 'quick' })
    expect(plan.ok && plan.projectId).toBe('quick')
    expect(plan.ok && plan.message).toBe('Assistant opened This conversation › Live › Side panel › Usage for you.')
  })
  it('refuses an unknown surface and cleans the agent label', () => {
    expect(navigationFor(ev('nowhere'), { projects: PROJECTS })).toEqual({ ok: false, message: 'Assistant tried to open a place OrgAI does not know.' })
    const plan = navigationFor(ev('dashboard', { agentLabel: 'Ar‮chi\ntect' }), { projects: PROJECTS })
    expect(plan.ok && plan.message).toBe('Ar chi tect opened Dashboard for you.')
    expect(navigationFor(ev('dashboard', { agentLabel: '' }), { projects: [] }).message).toBe('The assistant opened Dashboard for you.')
  })
  it('plainLabel clips', () => {
    expect(plainLabel('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`)
  })
})
