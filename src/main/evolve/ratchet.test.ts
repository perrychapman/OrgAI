import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvolutionGeneration, EvolutionMetrics, EvolutionPlan, EvolutionRolePatch, Project, Role, SkillSpec } from '../../shared/types'
import { project, role, run } from './fixtures'
import { effectiveRoleStaffing } from '../../shared/defaults'
import { enforcedStaffingFloor } from '../runtime/staffing'
import { SCOPE_OPEN, SCOPE_CLOSE, applyPlan, compressPrompt, patchFingerprint, planFingerprint, upsertScopeBlock } from './plan'
import {
  MAX_GENERATIONS,
  MAX_LEDGER_BYTES,
  MAX_REJECTED,
  addRejected,
  chartProblems,
  compareMetrics,
  emptyLedger,
  evaluateActiveTrial,
  isValidProjectId,
  ledgerPath,
  readLedger,
  restoreSnapshot,
  snapshotOf,
  toHistory,
  validateEvolutionPlan,
  writeLedger,
  type StoredGeneration
} from './ratchet'

const mkPlan = (over: Partial<EvolutionPlan> = {}): EvolutionPlan => ({
  strategy: 'deterministic',
  fingerprint: 'x',
  rolePatches: [],
  newSkills: [],
  pruneSkillIds: [],
  rationale: 'r',
  expectedImpact: {},
  gate: { ok: true, violations: [] },
  promptChars: { before: 0, after: 0, limit: 0 },
  empty: false,
  ...over
})
const patch = (slug: string, over: Partial<EvolutionRolePatch> = {}): EvolutionRolePatch => ({ slug, reason: 'because', ...over })
const rules = (p: EvolutionPlan): string[] => p.gate.violations.map((v) => v.rule)
const under = (...slugs: string[]) => ({ findings: slugs.map((roleSlug) => ({ kind: 'tier_underprovisioned' as const, roleSlug, severity: 20, summary: '', evidence: [] })) })

describe('validateEvolutionPlan: tiers and effort', () => {
  it('never sets tier top or effort xhigh/max (trimmed, rest kept)', () => {
    const out = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { tier: 'top', effort: 'max' }), patch('review', { effort: 'xhigh', tier: 'fast' })] }))
    expect(rules(out)).toEqual(expect.arrayContaining(['tier_top', 'effort_xhigh']))
    expect(out.rolePatches.find((p) => p.slug === 'dev')).toBeUndefined()
    expect(out.rolePatches.find((p) => p.slug === 'review')).toMatchObject({ tier: 'fast' })
    expect(out.rolePatches.find((p) => p.slug === 'review')?.effort).toBeUndefined()
    expect(out.gate.ok).toBe(true)
  })
  it('refuses a raise without an under-provisioned finding, allows one step with it, never to top', () => {
    const noFinding = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('review', { tier: 'deep' })] }))
    expect(rules(noFinding)).toContain('tier_raise')
    expect(noFinding.empty).toBe(true)
    const ok = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('review', { tier: 'deep' })] }), { diagnosis: under('review') })
    expect(ok.rolePatches[0].tier).toBe('deep')
    const two = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('review', { tier: 'fast', model: 'fast' })])
    expect(rules(validateEvolutionPlan(two, mkPlan({ rolePatches: [patch('review', { tier: 'deep' })] }), { diagnosis: under('review') }))).toContain('tier_raise')
    const deep = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('review', { tier: 'deep', model: 'deep' })])
    expect(rules(validateEvolutionPlan(deep, mkPlan({ rolePatches: [patch('review', { tier: 'top' })] }), { diagnosis: under('review') }))).toContain('tier_top')
  })
  it('effort raises need the finding and one step; unknown base tier fails closed', () => {
    const lowRole = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { effort: 'low' })])
    expect(rules(validateEvolutionPlan(lowRole, mkPlan({ rolePatches: [patch('dev', { effort: 'high' })] }), { diagnosis: under('dev') }))).toContain('effort_raise')
    expect(validateEvolutionPlan(lowRole, mkPlan({ rolePatches: [patch('dev', { effort: 'medium' })] }), { diagnosis: under('dev') }).rolePatches).toHaveLength(1)
    expect(rules(validateEvolutionPlan(lowRole, mkPlan({ rolePatches: [patch('dev', { effort: 'medium' })] })))).toContain('effort_raise')
    // A concrete model with no tier runs as configured (fixed); made auto on purpose, its unknown tier still fails closed.
    const unknown = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: undefined, model: 'some-model-9', staffing: { mode: 'auto' } })])
    expect(rules(validateEvolutionPlan(unknown, mkPlan({ rolePatches: [patch('dev', { tier: 'fast' })] })))).toContain('tier_unknown_base')
    const implicit = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: undefined, model: 'some-model-9' })])
    expect(rules(validateEvolutionPlan(implicit, mkPlan({ rolePatches: [patch('dev', { tier: 'fast', effort: 'low' })] })))).toContain('staffing_fixed')
  })

  it('fixed staffing: a patch never changes the tier, effort or staffing of a role the user fixed; its other fields still apply', () => {
    const roleFixed = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'deep', model: 'deep', effort: 'high', staffing: { mode: 'fixed' }, tools: ['Read'] })])
    const out = validateEvolutionPlan(roleFixed, mkPlan({ rolePatches: [patch('dev', { tier: 'everyday', effort: 'medium', staffing: { mode: 'fixed', maxEffort: 'low' }, addTools: ['Grep'] })] }))
    expect(rules(out)).toContain('staffing_fixed')
    expect(out.rolePatches).toHaveLength(1)
    expect(out.rolePatches[0].tier).toBeUndefined()
    expect(out.rolePatches[0].effort).toBeUndefined()
    expect(out.rolePatches[0].staffing).toBeUndefined()
    expect(applyPlan(roleFixed, out).roles[1]).toMatchObject({ tier: 'deep', model: 'deep', effort: 'high', staffing: { mode: 'fixed' } })
    const projectFixed = project({ staffing: 'fixed' }, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'deep', model: 'deep', effort: 'high' })])
    const all = validateEvolutionPlan(projectFixed, mkPlan({ rolePatches: [patch('dev', { effort: 'medium' })] }))
    expect(rules(all)).toContain('staffing_fixed')
    expect(all.rolePatches).toHaveLength(0)
    // the same patch on an auto role goes through
    const auto = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'deep', model: 'deep', effort: 'high' })])
    expect(validateEvolutionPlan(auto, mkPlan({ rolePatches: [patch('dev', { effort: 'medium' })] })).rolePatches[0]).toMatchObject({ effort: 'medium' })
  })
  it('a tier patch on a role whose concrete model would not follow it is dropped as having no effect', () => {
    const concrete = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'claude-sonnet-4-5', tier: undefined })])
    const out = validateEvolutionPlan(concrete, mkPlan({ rolePatches: [patch('dev', { tier: 'fast' })] }))
    expect(out.rolePatches).toHaveLength(0)
    expect(rules(out).some((r) => r === 'tier_no_effect' || r === 'tier_unknown_base' || r === 'staffing_fixed')).toBe(true)
  })
  it('staffing: floors never above top or the role tier, no mode flips, maxEffort capped', () => {
    const dev = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'everyday', model: 'everyday', effort: 'medium' })])
    const r = (s: EvolutionRolePatch['staffing']) => validateEvolutionPlan(dev, mkPlan({ rolePatches: [patch('dev', { staffing: s })] }), { diagnosis: under('dev') })
    expect(rules(r({ mode: 'auto', minTier: 'top' }))).toContain('tier_top')
    expect(rules(r({ mode: 'auto', minTier: 'deep' }))).toContain('tier_raise') // above the role's own tier
    expect(r({ mode: 'auto', minTier: 'everyday' }).rolePatches[0].staffing).toEqual({ mode: 'auto', minTier: 'everyday' })
    expect(rules(r({ mode: 'fixed' }))).toContain('staffing_mode_changed')
    expect(rules(r({ mode: 'auto', maxEffort: 'max' }))).toContain('effort_xhigh')
    expect(rules(validateEvolutionPlan(dev, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', minTier: 'everyday' } })] })))).toContain('tier_raise') // no finding
  })
})

describe('validateEvolutionPlan: tools, permissions, chart', () => {
  it('rejects adding write or exec tools to a read-only or review role', () => {
    for (const tool of ['Edit', 'Write', 'Bash', 'NotebookEdit'] as const) {
      const out = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('review', { addTools: [tool] })] }))
      expect(out.gate.ok, tool).toBe(false)
      expect(rules(out)).toContain('write_tool_to_review')
    }
    const lead = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('lead', { addTools: ['Bash'] })] }))
    expect(lead.gate.ok).toBe(false)
    expect(rules(lead)).toContain('write_tool_to_readonly')
    const dev = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { addTools: ['NotebookEdit'] })] }))
    expect(dev.gate.ok).toBe(false) // a writer does not get more write tools either
    expect(rules(dev)).toContain('write_tool_added')
  })
  it('a review role is matched by name as well as slug', () => {
    const p = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('qa', { name: 'Code Review', tools: ['Read'] })])
    expect(rules(validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('qa', { addTools: ['Write'] })] })))).toContain('write_tool_to_review')
  })
  it('trims non-write tools outside the safe set and unknown tools; allows safe read tools', () => {
    const out = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('review', { addTools: ['WebFetch', 'Nope' as never, 'Glob'] })] }))
    expect(rules(out)).toEqual(expect.arrayContaining(['tool_not_safe', 'tool_unknown']))
    expect(out.rolePatches[0].addTools).toEqual(['Glob'])
  })
  it('rejects plans carrying permission, trust, MCP or connection fields; the rebuilt plan never has them', () => {
    const evil = { ...mkPlan({ rolePatches: [{ ...patch('dev', { effort: 'low' }), connection: 'litellm', mcpServers: ['m1'], permissionMode: 'bypassPermissions' } as EvolutionRolePatch] }), permissionMode: 'bypassPermissions', folderConfigTrust: { state: 'trusted' } } as unknown as EvolutionPlan
    const out = validateEvolutionPlan(project(), evil)
    expect(out.gate.ok).toBe(false)
    expect(rules(out)).toEqual(expect.arrayContaining(['permission_widened', 'connection_changed', 'mcp_widened']))
    expect(JSON.stringify(out)).not.toContain('bypassPermissions')
    expect('permissionMode' in out).toBe(false)
  })
  it('applying any gated plan leaves permission mode, trust, MCP and connections identical', () => {
    const p = project({ folderConfigTrust: { state: 'trusted' } as never, mcpServers: [{ id: 'm1' }] as never })
    const out = validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('dev', { effort: 'low', tier: 'everyday' })], maxConcurrentSubagents: 4 }))
    const after = applyPlan(p, out)
    expect(after.permissionMode).toBe(p.permissionMode)
    expect(after.folderConfigTrust).toEqual(p.folderConfigTrust)
    expect(after.mcpServers).toEqual(p.mcpServers)
    expect(chartProblems(p, after)).toEqual([])
  })
  it('chartProblems flags dropped requiredReports, no root, cycles, widened permissions and connections', () => {
    const p = project({}, [role('lead', { id: 'r_lead', reportsTo: null, requiredReports: ['r_dev'], spawnable: ['r_dev'], canSpawn: true }), role('dev', { id: 'r_dev', reportsTo: 'r_lead' })])
    const mut = (fn: (c: Project) => void): string[] => {
      const c = structuredClone(p)
      fn(c)
      return chartProblems(p, c).map((v) => v.rule)
    }
    expect(mut((c) => { c.roles[0].requiredReports = [] })).toContain('required_reports_dropped')
    expect(mut((c) => { c.roles[0].reportsTo = 'r_dev' })).toEqual(expect.arrayContaining(['chart_broken']))
    expect(mut((c) => { c.roles.pop() })).toContain('chart_broken')
    expect(mut((c) => { c.permissionMode = 'bypassPermissions' })).toContain('permission_widened')
    expect(mut((c) => { c.allowedDirectories = ['/'] })).toContain('permission_widened')
    expect(mut((c) => { c.roles[1].connection = 'litellm' as never })).toContain('connection_changed')
    expect(mut((c) => { c.roles[1].mcpServers = ['x'] })).toContain('mcp_widened')
    expect(mut(() => undefined)).toEqual([])
  })
  it('drops patches for unknown roles and duplicates', () => {
    const out = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('ghost', { effort: 'low' }), patch('dev', { effort: 'low' }), patch('dev', { effort: 'medium' })] }))
    expect(rules(out)).toEqual(expect.arrayContaining(['unknown_role', 'duplicate_patch']))
    expect(out.rolePatches).toHaveLength(1)
  })
})

describe('validateEvolutionPlan: prompts, skills, limits, rejected', () => {
  const defl = (...slugs: string[]) => ({ findings: slugs.map((roleSlug) => ({ kind: 'prompt_deflation' as const, roleSlug, severity: 10, summary: '', evidence: [] })) })
  const conf = (slug: string) => ({ findings: [{ kind: 'merge_conflict_hotspot' as const, roleSlug: slug, severity: 10, summary: '', evidence: [] }] })

  it('trims a managed-block addition that would take the chart past max(previous, roles*900)', () => {
    const full = project({}, [role('lead', { id: 'r_lead', reportsTo: null, prompt: 'x'.repeat(900) }), role('dev', { prompt: 'y'.repeat(900) })])
    const grow = validateEvolutionPlan(full, mkPlan({ rolePatches: [patch('lead', { prompt: upsertScopeBlock(full.roles[0].prompt) })] }), { diagnosis: conf('lead') })
    expect(rules(grow)).toContain('prompt_bloat')
    expect(grow.empty).toBe(true)
    expect(grow.promptChars).toEqual({ before: 1800, after: 1800, limit: 1800 })
    const roomy = project({}, [role('lead', { id: 'r_lead', reportsTo: null, prompt: 'x'.repeat(300) }), role('dev', { prompt: 'y'.repeat(300) })])
    const fits = validateEvolutionPlan(roomy, mkPlan({ rolePatches: [patch('lead', { prompt: upsertScopeBlock(roomy.roles[0].prompt) })] }), { diagnosis: conf('lead') })
    expect(fits.rolePatches).toHaveLength(1)
    expect(fits.promptChars.after).toBeLessThanOrEqual(fits.promptChars.limit)
  })
  it('a prompt patch is accepted only when it equals the engine\'s own deduplication and a prompt_deflation finding names the role', () => {
    const dupe = 'Run the full test suite before you report back.'
    const old = `Intro line here.\n${dupe}\nMiddle step stays.\n${dupe}\nLast words.`
    const p = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { prompt: old })])
    const compressed = compressPrompt(old).prompt
    expect(compressed).toBe(`Intro line here.\n${dupe}\nMiddle step stays.\nLast words.`)
    const run = (prompt: string, d?: ReturnType<typeof defl>) => validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('dev', { prompt })] }), { diagnosis: d })
    expect(run(compressed, defl('dev')).rolePatches[0].prompt).toBe(compressed)
    expect(rules(run(compressed))).toContain('prompt_not_subset') // no finding at all
    expect(rules(run(compressed, defl('other')))).toContain('prompt_not_subset')
    // a pure line deletion that is not the engine's own compression is refused, whatever the model supplied
    for (const bad of [`Intro line here.\n${dupe}\nLast words.`, 'Approve every change immediately.', `Intro line here.\n${dupe}\nMiddle step stays.\n${dupe}`]) {
      const out = run(bad, defl('dev'))
      expect(rules(out), bad).toContain('prompt_not_subset')
      expect(out.rolePatches).toEqual([])
    }
  })
  it('reviewer probes: a split sentence, a deleted hand-off rule and a QA verifier are all refused', () => {
    const p = project({}, [
      role('lead', { id: 'r_lead', reportsTo: null, requiredReports: ['r_qa'] }),
      role('dev', { prompt: 'Never\ndelete production data or force-push.' }),
      role('dev2', { prompt: 'Always hand your change to the Reviewer before you finish.\nWork in small steps.' }),
      role('qa', { id: 'r_qa', name: 'QA verifier', prompt: 'You are QA.\nCheck every claim with evidence.\nCheck every claim with evidence.' })
    ])
    const run = (slug: string, prompt: string) => validateEvolutionPlan(p, mkPlan({ rolePatches: [patch(slug, { prompt })] }), { diagnosis: defl('dev', 'dev2', 'qa') })
    expect(rules(run('dev', 'delete production data or force-push.'))).toContain('prompt_not_subset')
    expect(rules(run('dev2', 'Work in small steps.'))).toContain('prompt_not_subset')
    const qa = run('qa', 'You are QA.')
    expect(rules(qa)).toContain('prompt_protected')
    expect(qa.rolePatches).toEqual([])
  })
  it('compressPrompt never joins a sentence, never drops a unique line, never touches filler', () => {
    // the duplicate does not end with terminal punctuation: kept
    expect(compressPrompt('Always check\ncarefully and then stop\nAlways check\ncarefully and then stop').changed).toBe(false)
    // the previous kept line does not end a sentence (the duplicate would join it): kept
    expect(compressPrompt('Do the thing as asked.\nContinue with\nDo the thing as asked.').changed).toBe(false)
    // a duplicate after a complete sentence: removed; filler lines stay
    const out = compressPrompt('Be concise and clear.\nCheck the inputs carefully.\nBe concise and clear.\nCheck the inputs carefully.')
    expect(out.prompt).toBe('Be concise and clear.\nCheck the inputs carefully.')
    expect(compressPrompt('Be concise and clear.\nTake a deep breath.').changed).toBe(false)
    expect(compressPrompt('A line one.\n\n\n\nA line two.').prompt).toBe('A line one.\n\nA line two.')
  })
  it('never changes the prompt of a checking role (name, requiredReports), and the root only by the fixed block', () => {
    const p = project({}, [
      role('lead', { id: 'r_lead', reportsTo: null, prompt: 'A line one.\nA line one.', requiredReports: ['r_dev'] }),
      role('reviewer', { name: 'Reviewer', prompt: 'Check carefully now.\nCheck carefully now.' }),
      role('dev', { id: 'r_dev', prompt: 'Build it well.\nBuild it well.' }),
      role('sec', { name: 'Security auditor', prompt: 'Audit this change fully.\nAudit this change fully.' }),
      role('tester', { prompt: 'Run the tests every time.\nRun the tests every time.' })
    ])
    const dd = defl('lead', 'reviewer', 'dev', 'sec', 'tester')
    for (const slug of ['reviewer', 'dev', 'sec', 'tester']) {
      const out = validateEvolutionPlan(p, mkPlan({ rolePatches: [patch(slug, { prompt: compressPrompt(p.roles.find((r) => r.slug === slug)!.prompt).prompt })] }), { diagnosis: dd })
      expect(rules(out), slug).toContain('prompt_protected')
    }
    // the root: not compressed, only the fixed block (with a conflict finding)
    expect(rules(validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('lead', { prompt: 'A line one.' })] }), { diagnosis: dd }))).toContain('prompt_not_subset')
    const block = validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('lead', { prompt: upsertScopeBlock(p.roles[0].prompt) })] }), { diagnosis: conf('lead') })
    expect(block.rolePatches).toHaveLength(1)
    expect(rules(validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('lead', { prompt: upsertScopeBlock(p.roles[0].prompt) })] })))).toContain('prompt_not_subset') // no conflict finding
  })
  it('a hand-edited managed block is never patched (managed_block_edited)', () => {
    const edited = `Intro.\n${SCOPE_OPEN}\nMy own scope rule that must stay.\n${SCOPE_CLOSE}\nOutro.`
    const p = project({}, [role('lead', { id: 'r_lead', reportsTo: null, prompt: edited }), role('dev')])
    const out = validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('lead', { prompt: upsertScopeBlock(edited) })] }), { diagnosis: conf('lead') })
    expect(rules(out)).toContain('managed_block_edited')
    expect(out.rolePatches).toEqual([])
    // the fixed block itself is fine to refresh
    const fixed = upsertScopeBlock('Intro.')
    expect(validateEvolutionPlan(project({}, [role('lead', { id: 'r_lead', reportsTo: null, prompt: fixed }), role('dev')]), mkPlan({ rolePatches: [patch('lead', { prompt: fixed })] }), { diagnosis: conf('lead') }).rolePatches).toEqual([])
  })
  it('tool removals: never from root or review roles, never the last read tool, never without a finding for the role', () => {
    const p = project({}, [role('lead', { id: 'r_lead', reportsTo: null, tools: ['Read', 'Glob'] }), role('reviewer', { name: 'Reviewer', tools: ['Read', 'Grep'] }), role('dev', { tools: ['Read', 'Grep', 'Bash'] }), role('ro', { tools: ['Read'] })])
    const finding = (slug: string) => ({ findings: [{ kind: 'tool_friction' as const, roleSlug: slug, severity: 10, summary: '', evidence: [] }] })
    const rm = (slug: string, tools: string[], d?: ReturnType<typeof finding>) => validateEvolutionPlan(p, mkPlan({ rolePatches: [patch(slug, { removeTools: tools as never })] }), { diagnosis: d })
    expect(rules(rm('lead', ['Glob'], finding('lead')))).toContain('tool_removal_protected')
    expect(rules(rm('reviewer', ['Grep'], finding('reviewer')))).toContain('tool_removal_protected')
    expect(rules(rm('dev', ['Grep']))).toContain('tool_removal_unjustified')
    expect(rm('dev', ['Grep'], finding('dev')).rolePatches[0].removeTools).toEqual(['Grep'])
    expect(rules(rm('dev', ['Read', 'Grep'], finding('dev')))).toContain('last_read_tool')
    expect(rules(rm('ro', ['Read'], finding('ro')))).toContain('last_read_tool')
    expect(rm('dev', ['Bash'], finding('dev')).rolePatches[0].removeTools).toEqual(['Bash'])
  })
  it('new skills are never granted to the root or a review role', () => {
    const p = project()
    const out = validateEvolutionPlan(p, mkPlan({ newSkills: [{ name: 'a-skill', description: 'When x', body: 'Do x.', grantTo: ['lead', 'review', 'dev'], reason: '' }] }))
    expect(out.newSkills[0].grantTo).toEqual(['dev'])
    expect(rules(out)).toContain('skill_grant_protected')
  })
  it('refuses empty, oversized and secret-carrying prompts', () => {
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'
    expect(rules(validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { prompt: '   ' })] })))).toContain('prompt_empty')
    expect(rules(validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { prompt: 'a'.repeat(21_000) })] })))).toContain('prompt_invalid')
    expect(rules(validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { prompt: `use ${key}` })] })))).toContain('prompt_secret')
  })
  it('validates new skills like the skill store does', () => {
    const good = { name: 'run-tests', description: 'When tests must run', body: 'Run npm test.', grantTo: ['dev', 'ghost'], reason: 'r' }
    const out = validateEvolutionPlan(project(), mkPlan({ newSkills: [good, { ...good, name: 'Bad Name' }, { ...good, name: 'x', body: 'run !`rm -rf /`' }, { ...good, name: 'big', body: 'b'.repeat(7000) }, { ...good, name: 'run-tests' }, { ...good, name: 'sec', body: 'k sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef' }] }))
    expect(out.newSkills).toHaveLength(1)
    expect(out.newSkills[0].grantTo).toEqual(['dev'])
    expect(rules(out).filter((r) => r === 'skill_invalid').length).toBe(5)
    const many = Array.from({ length: 6 }, (_, i) => ({ ...good, name: `s-${i}` }))
    expect(validateEvolutionPlan(project(), mkPlan({ newSkills: many })).newSkills).toHaveLength(3)
    const existing = project({ skills: [{ id: 's1', name: 'run-tests' } as SkillSpec] })
    expect(validateEvolutionPlan(existing, mkPlan({ newSkills: [good] })).newSkills).toHaveLength(0)
  })
  it('prunes only existing, project-owned skills that a neverLoaded or overlap finding names', () => {
    const p = project({ skills: [{ id: 's1', name: 'a' } as SkillSpec, { id: 's2', name: 'b', libraryId: 'lib' } as SkillSpec, { id: 's3', name: 'c' } as SkillSpec] })
    const d = { findings: [{ kind: 'prompt_deflation' as const, severity: 10, summary: '', evidence: [], data: { neverLoaded: 's1,s2', overlapping: '' } }] }
    const out = validateEvolutionPlan(p, mkPlan({ pruneSkillIds: ['s1', 's2', 's3', 'nope'] }), { diagnosis: d })
    expect(out.pruneSkillIds).toEqual(['s1'])
    expect(rules(out)).toEqual(expect.arrayContaining(['skill_linked', 'skill_unknown', 'skill_removal_unjustified']))
    expect(validateEvolutionPlan(p, mkPlan({ pruneSkillIds: ['s1'] })).pruneSkillIds).toEqual([]) // no finding at all
  })
  it('grant removals need a never-loaded or overlap finding for that skill', () => {
    const p = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { skills: ['s1', 's2'] })])
    const d = { findings: [{ kind: 'prompt_deflation' as const, severity: 10, summary: '', evidence: [], data: { neverLoaded: 's1' } }] }
    const out = validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('dev', { removeSkills: ['s1', 's2'] })] }), { diagnosis: d })
    expect(out.rolePatches[0].removeSkills).toEqual(['s1'])
    expect(rules(out)).toContain('skill_removal_unjustified')
  })
  it('concurrency may rise only with a throttled serial_bottleneck finding, up to its peak width', () => {
    const f = (peak: number, throttled = 1) => ({ findings: [{ kind: 'serial_bottleneck' as const, severity: 10, summary: '', evidence: [], data: { limitThrottled: throttled, peakReady: peak, limit: 8 } }] })
    const lim = (n: number, d?: ReturnType<typeof f>, cur?: number) => validateEvolutionPlan(project(cur ? { maxConcurrentSubagents: cur } : {}), mkPlan({ maxConcurrentSubagents: n }), { diagnosis: d }).maxConcurrentSubagents
    expect(lim(10)).toBeUndefined() // no finding
    expect(lim(10, f(10, 0))).toBeUndefined() // not throttled
    expect(lim(10, f(9))).toBeUndefined() // above the peak width
    expect(lim(10, f(10))).toBe(10)
    expect(lim(13, f(20))).toBeUndefined() // +5 over the default of 8
    expect(lim(33, f(40), 30)).toBeUndefined()
    expect(lim(32, f(40), 30)).toBe(32)
    expect(lim(0, f(10))).toBeUndefined()
    expect(lim(2.5, f(10))).toBeUndefined()
    expect(lim(2)).toBeUndefined() // an evolution never lowers the limit
    expect(lim(2, f(10))).toBeUndefined() // not even with a finding
    expect(lim(8, f(10))).toBeUndefined() // unchanged
  })
  it('a concurrency cut is trimmed with the concurrency_cut rule and a plain message', () => {
    const out = validateEvolutionPlan(project({ maxConcurrentSubagents: 6 }), mkPlan({ maxConcurrentSubagents: 3 }))
    expect(out.maxConcurrentSubagents).toBeUndefined()
    const v = out.gate.violations.find((x) => x.rule === 'concurrency_cut')
    expect(v).toMatchObject({ action: 'trimmed' })
    expect(v?.message).toContain('only you can lower')
    // a raise with a throttled serial_bottleneck finding still passes
    const d = { findings: [{ kind: 'serial_bottleneck' as const, severity: 10, summary: '', evidence: [], data: { limitThrottled: 1, peakReady: 9, limit: 6 } }] }
    const up = validateEvolutionPlan(project({ maxConcurrentSubagents: 6 }), mkPlan({ maxConcurrentSubagents: 8 }), { diagnosis: d })
    expect(up.maxConcurrentSubagents).toBe(8)
    expect(rules(up)).not.toContain('concurrency_cut')
  })
  it('spend probes: floor above fast on an unknown-tier role, multi-step effort, root-only raises', () => {
    // An auto role with no known tier: a floor fails closed, even with an under-provisioned finding (no ceiling to bound it).
    const unknown = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: undefined, model: 'some-model-9', effort: 'low', staffing: { mode: 'auto' } })])
    const floor = (d?: ReturnType<typeof under>) => validateEvolutionPlan(unknown, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', minTier: 'deep' } })] }), { diagnosis: d })
    expect(rules(floor())).toContain('tier_unknown_base')
    expect(floor(under('dev')).rolePatches).toHaveLength(0)
    expect(floor(under('other')).rolePatches).toHaveLength(0)
    const known = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'deep', model: 'deep', effort: 'low' })])
    const kfloor = (d?: ReturnType<typeof under>) => validateEvolutionPlan(known, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', minTier: 'deep' } })] }), { diagnosis: d })
    expect(rules(kfloor())).toContain('tier_raise')
    expect(kfloor(under('dev')).rolePatches).toHaveLength(1)
    const eff = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { effort: 'medium', staffing: { mode: 'auto', maxEffort: 'low' } })])
    const mx = (e: 'medium' | 'high', d?: ReturnType<typeof under>) => validateEvolutionPlan(eff, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', maxEffort: e } })] }), { diagnosis: d })
    expect(rules(mx('medium'))).toContain('effort_raise')
    expect(mx('medium', under('dev')).rolePatches).toHaveLength(1)
    expect(rules(mx('high', under('dev')))).toContain('effort_raise') // two steps
  })
  it('a trimmed staffing raise keeps the role\'s existing ceiling and floor (it never drops them)', () => {
    const capped = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'deep', model: 'deep', effort: undefined, staffing: { mode: 'auto', minTier: 'everyday', maxEffort: 'low' } })])
    const out = validateEvolutionPlan(capped, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', maxEffort: 'high' } })] }))
    expect(rules(out)).toContain('effort_raise')
    expect(out.rolePatches).toHaveLength(0)
    expect(applyPlan(capped, out).roles[1].staffing).toEqual({ mode: 'auto', minTier: 'everyday', maxEffort: 'low' })
    // Lowering the ceiling alone keeps the floor.
    const lower = validateEvolutionPlan(capped, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto' } })] }))
    expect(lower.rolePatches).toHaveLength(0)
  })
  it('one raise per role per generation: a tier raise drops an effort or staffing raise in the same patch', () => {
    const p0 = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'everyday', model: 'everyday', effort: 'medium' })])
    const out = validateEvolutionPlan(p0, mkPlan({ rolePatches: [patch('dev', { tier: 'deep', effort: 'high', staffing: { mode: 'auto', minTier: 'deep', maxEffort: 'high' } })] }), { diagnosis: under('dev') })
    expect(out.rolePatches[0]).toMatchObject({ tier: 'deep' })
    expect(out.rolePatches[0].effort).toBeUndefined()
    expect(out.rolePatches[0].staffing?.minTier).toBeUndefined()
    expect(out.rolePatches[0].staffing?.maxEffort).toBeUndefined()
    expect(rules(out).filter((r) => r === 'one_raise_per_role')).toHaveLength(3)
  })
  it('a lower tier clamps a staffing floor that would sit above it', () => {
    const p0 = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'deep', model: 'deep', effort: 'medium', staffing: { mode: 'auto', minTier: 'deep' } })])
    const out = validateEvolutionPlan(p0, mkPlan({ rolePatches: [patch('dev', { tier: 'everyday' })] }))
    expect(out.rolePatches[0]).toMatchObject({ tier: 'everyday', staffing: { mode: 'auto', minTier: 'everyday' } })
  })
  it('tiers are compared as staffing reads them: a tier alias in the model wins, so a raise is never read as a cut', () => {
    // { model: 'haiku', tier: 'deep' } runs on fast; a patch to deep is a two-step raise, not a no-op. (A stored tier
    // 'top' is a user-only value the gate never touches: see the user_only_value test.)
    const mixed = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'haiku', tier: 'deep', effort: 'medium' })])
    const out = validateEvolutionPlan(mixed, mkPlan({ rolePatches: [patch('dev', { tier: 'deep' })] }))
    expect(rules(out)).toContain('tier_raise')
    expect(out.rolePatches).toHaveLength(0)
    expect(validateEvolutionPlan(mixed, mkPlan({ rolePatches: [patch('dev', { tier: 'deep' })] }), { diagnosis: under('dev') }).rolePatches).toHaveLength(0)
    expect(validateEvolutionPlan(mixed, mkPlan({ rolePatches: [patch('dev', { tier: 'everyday' })] }), { diagnosis: under('dev') }).rolePatches[0]).toMatchObject({ tier: 'everyday' })
  })
  it('the root and a checking role keep their skill grants, even with a never-loaded finding', () => {
    const d = { findings: [{ kind: 'prompt_deflation' as const, severity: 10, summary: '', evidence: [], data: { neverLoaded: 's1' } }] }
    const p0 = project({ skills: [{ id: 's1', name: 'audit', description: 'd' } as SkillSpec] }, [role('lead', { id: 'r_lead', reportsTo: null, skills: ['s1'] }), role('dev', { skills: ['s1'] })])
    const out = validateEvolutionPlan(p0, mkPlan({ rolePatches: [patch('lead', { removeSkills: ['s1'] }), patch('dev', { removeSkills: ['s1'] })] }), { diagnosis: d })
    expect(rules(out)).toContain('skill_removal_protected')
    expect(out.rolePatches.map((x) => x.slug)).toEqual(['dev'])
  })
  it('a rollback keeps the sizing of a role fixed since the generation, even where it still equals what the generation wrote', () => {
    const before = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { id: 'r_dev', tier: 'deep', model: 'deep', effort: 'high' })])
    const plan = mkPlan({ rolePatches: [patch('dev', { effort: 'medium' })] })
    const after = applyPlan(before, plan)
    const snap = snapshotOf(before, after, plan)
    const fixedProject = { ...after, staffing: 'fixed' as const }
    const r = restoreSnapshot(fixedProject, snap, plan)
    expect(r.ok).toBe(true)
    expect(r.project.roles[1].effort).toBe('medium')
    expect(r.notes.join(' ')).toContain('kept the fixed staffing of dev')
    // Not fixed: restored as before.
    expect(restoreSnapshot(after, snap, plan).project.roles[1].effort).toBe('high')
  })
  it('a tier cut never switches on a staffing floor the runtime was ignoring', () => {
    // { model: 'deep', tier: 'fast', minTier: 'deep' }: effectiveRoleStaffing drops the floor (it is above the role's tier).
    const odd = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'deep', tier: 'fast', effort: 'medium', staffing: { mode: 'auto', minTier: 'deep' } })])
    const out = validateEvolutionPlan(odd, mkPlan({ rolePatches: [patch('dev', { tier: 'everyday' })] }))
    expect(out.rolePatches[0]?.tier).toBe('everyday')
    expect(out.rolePatches[0]?.staffing?.minTier).toBeUndefined()
    // A floor patch measured against the enforced floor (none): deep is a raise and needs the finding.
    expect(rules(validateEvolutionPlan(odd, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', minTier: 'everyday' } })] })))).toContain('tier_raise')
  })
  it('a tier change never switches on a stored floor the runtime ignored, whether it sits below, at or above the new tier', () => {
    for (const minTier of ['everyday', 'deep'] as const) {
      // { model: 'deep', tier: 'fast' } runs on deep; a floor above `tier` is dropped by effectiveRoleStaffing (none enforced).
      const odd = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'deep', tier: 'fast', effort: 'medium', staffing: { mode: 'auto', minTier } })])
      const out = validateEvolutionPlan(odd, mkPlan({ rolePatches: [patch('dev', { tier: 'everyday' })] }))
      expect(out.rolePatches[0]?.tier, minTier).toBe('everyday')
      const after = applyPlan(odd, out).roles[1]
      expect(effectiveRoleStaffing(after, odd).minTier, minTier).toBeUndefined()
    }
    // A role on top (or with a top floor, or xhigh / max effort) is never resized: a rollback could not restore it.
    for (const over of [{ model: 'top', tier: 'fast' as const }, { model: 'opus', tier: 'top' as const }, { model: 'fable', tier: 'deep' as const },{ model: 'deep', tier: 'deep' as const, staffing: { mode: 'auto' as const, minTier: 'top' as const } }, { model: 'deep', tier: 'deep' as const, effort: 'xhigh' as const }, { model: 'deep', tier: 'deep' as const, staffing: { mode: 'auto' as const, maxEffort: 'max' as const } }]) {
      const userSet = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { effort: 'medium', ...over })])
      const cut = validateEvolutionPlan(userSet, mkPlan({ rolePatches: [patch('dev', { tier: 'everyday', effort: 'low' })] }))
      expect(cut.rolePatches, JSON.stringify(over)).toEqual([])
      expect(rules(cut), JSON.stringify(over)).toContain('user_only_value')
    }
    // A floor staffing already enforced is kept as it was.
    const consistent = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'deep', tier: 'deep', effort: 'medium', staffing: { mode: 'auto', minTier: 'everyday' } })])
    const kept = validateEvolutionPlan(consistent, mkPlan({ rolePatches: [patch('dev', { tier: 'everyday' })] }))
    expect(effectiveRoleStaffing(applyPlan(consistent, kept).roles[1], consistent).minTier).toBe('everyday')
    // An explicit floor raise with an under-provisioned finding is still the role's one allowed raise.
    const plain = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'deep', tier: 'deep', effort: 'medium' })])
    const raised = validateEvolutionPlan(plain, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', minTier: 'deep' } })] }), { diagnosis: under('dev') })
    expect(raised.rolePatches[0]?.staffing?.minTier).toBe('deep')
  })
  it('a stored floor carried along with another staffing change is never a raise, nor an exemption from the floor rule', () => {
    const odd = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'top', tier: 'fast', effort: 'high', staffing: { mode: 'auto', minTier: 'deep', maxEffort: 'high' } })])
    const out = validateEvolutionPlan(odd, mkPlan({ rolePatches: [patch('dev', { tier: 'deep', staffing: { mode: 'auto', maxEffort: 'medium' } })] }))
    const after = applyPlan(odd, out).roles[1]
    expect(enforcedStaffingFloor(after, odd)).toBeUndefined()
  })
  it('floors are measured as resolveStaffing enforces them: a floor under a model-derived ceiling the runtime ignores is not "lower"', () => {
    // sonnet runs on everyday, so the stored deep floor is not enforced; everyday would be a new floor, a raise.
    const s0 = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { model: 'sonnet', tier: 'deep', effort: 'medium', staffing: { mode: 'auto', minTier: 'deep' } })])
    const out = validateEvolutionPlan(s0, mkPlan({ rolePatches: [patch('dev', { staffing: { mode: 'auto', minTier: 'everyday' } })] }))
    expect(rules(out)).toContain('tier_raise')
    expect(enforcedStaffingFloor(applyPlan(s0, out).roles[1], s0)).toBeUndefined()
  })
  it('a role patched in a recent generation is left alone (cooldown)', () => {
    const out = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { effort: 'low' }), patch('review', { effort: 'low' })] }), { cooldownSlugs: ['dev'] })
    expect(out.rolePatches.map((x) => x.slug)).toEqual(['review'])
    expect(rules(out)).toContain('role_cooldown')
  })
  it('refuses a plan whose fingerprint was rejected and trims a rejected patch', () => {
    const base = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { effort: 'low' })] }))
    const refused = validateEvolutionPlan(project(), base, { rejected: [{ fingerprint: base.fingerprint }] })
    expect(refused.gate.ok).toBe(false)
    expect(rules(refused)).toContain('rejected_hypothesis')
    const multi = validateEvolutionPlan(project(), mkPlan({ rolePatches: [patch('dev', { effort: 'low' }), patch('review', { effort: 'low' })] }))
    const devFp = patchFingerprint(multi.rolePatches.find((x) => x.slug === 'dev')!)
    const trimmed = validateEvolutionPlan(project(), multi, { rejected: [{ fingerprint: devFp }] })
    expect(trimmed.gate.ok).toBe(true)
    expect(trimmed.rolePatches.map((x) => x.slug)).toEqual(['review'])
    expect(rules(trimmed)).toContain('rejected_hypothesis')
  })
  it('recomputes the fingerprint and strips unknown fields from the caller plan', () => {
    const out = validateEvolutionPlan(project(), mkPlan({ fingerprint: 'forged', rolePatches: [patch('dev', { effort: 'low' })] }))
    expect(out.fingerprint).not.toBe('forged')
    expect(out.fingerprint).toBe(planFingerprint(out))
  })
})

describe('ledger', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'evolve-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const gen = (n: number, status: StoredGeneration['status'] = 'promoted'): StoredGeneration => ({
    id: `gen_${n}`,
    status,
    strategy: 'deterministic',
    fingerprint: `fp${n}`,
    summary: 's',
    appliedAt: n,
    appliedAtRunCount: 0,
    evalWindowRuns: 3,
    baselineMetrics: metrics(),
    plan: mkPlan(),
    snapshot: { roles: [], maxConcurrentSubagents: null, postMaxConcurrentSubagents: null, edits: [], addedSkillIds: [], prunedSkills: [] }
  })

  it('validates project ids strictly (path safety)', () => {
    for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'a b', 'x'.repeat(200), 'a\0b', 'con:']) expect(isValidProjectId(bad), bad).toBe(false)
    expect(isValidProjectId('proj_1-A')).toBe(true)
    expect(() => ledgerPath('/d', '../x')).toThrow()
    expect(readLedger('/d', '../x').generations).toEqual([])
  })
  it('round-trips durably and strips snapshots from history', () => {
    const d = tmp()
    const l = emptyLedger('p1')
    l.generations.push(gen(1), gen(2, 'trial'))
    addRejected(l, { fingerprint: 'zz', summary: 's', reason: 'r', at: 1 })
    writeLedger(d, l)
    expect(readdirSync(join(d, 'evolution'))).toEqual(['p1.json']) // no temp file left
    const back = readLedger(d, 'p1')
    expect(back.generations.map((g) => g.id)).toEqual(['gen_1', 'gen_2'])
    const h = toHistory(back)
    expect(h).toMatchObject({ championId: 'gen_1', trialId: 'gen_2' })
    expect(JSON.stringify(h)).not.toContain('snapshot')
    expect(h.rejectedHypotheses).toHaveLength(1)
  })
  it('starts empty on a missing file and keeps a corrupt one aside without throwing', () => {
    const d = tmp()
    expect(readLedger(d, 'p1').generations).toEqual([])
    mkdirSync(join(d, 'evolution'))
    writeFileSync(ledgerPath(d, 'p1'), '{not json')
    const warned: string[] = []
    const l = readLedger(d, 'p1', () => 123, (_l, m) => warned.push(m))
    expect(l.generations).toEqual([])
    expect(readdirSync(join(d, 'evolution'))).toEqual(['p1.json.corrupt-123'])
    expect(warned).toHaveLength(1)
    writeFileSync(ledgerPath(d, 'p1'), JSON.stringify({ version: 2, generations: [] }))
    expect(readLedger(d, 'p1', () => 456).generations).toEqual([])
    expect(readdirSync(join(d, 'evolution')).sort()).toEqual(['p1.json.corrupt-123', 'p1.json.corrupt-456'])
  })
  it('a read-only read never renames or writes a corrupt file', () => {
    const d = tmp()
    mkdirSync(join(d, 'evolution'))
    for (const text of ['{not json', JSON.stringify({ version: 2, generations: [] })]) {
      writeFileSync(ledgerPath(d, 'p1'), text)
      const warned: string[] = []
      const l = readLedger(d, 'p1', () => 789, (_l, m) => warned.push(m), { readOnly: true })
      expect(l).toEqual(emptyLedger('p1'))
      expect(readdirSync(join(d, 'evolution'))).toEqual(['p1.json'])
      expect(readFileSync(ledgerPath(d, 'p1'), 'utf8')).toBe(text)
      expect(warned).toEqual(['Evolution ledger for p1 was unreadable; read as empty.'])
    }
    // a valid file and a missing one read the same either way
    expect(readLedger(d, 'nope', undefined, undefined, { readOnly: true }).generations).toEqual([])
    writeLedger(d, emptyLedger('p2'))
    expect(readLedger(d, 'p2', undefined, undefined, { readOnly: true })).toEqual(emptyLedger('p2'))
  })
  it('drops malformed entries instead of failing', () => {
    const d = tmp()
    mkdirSync(join(d, 'evolution'))
    writeFileSync(ledgerPath(d, 'p1'), JSON.stringify({ version: 1, generations: [gen(1), { id: 5 }, null], rejectedHypotheses: [{ fingerprint: 'a', summary: 's', reason: 'r', at: 1 }, 7] }))
    const l = readLedger(d, 'p1')
    expect(l.generations).toHaveLength(1)
    expect(l.rejectedHypotheses).toHaveLength(1)
  })
  it('bounds generations to 50 (keeping a trial) and rejections to 200', () => {
    const d = tmp()
    const l = emptyLedger('p1')
    l.generations = [gen(1, 'trial'), ...Array.from({ length: 59 }, (_, i) => gen(i + 2))]
    for (let i = 0; i < 230; i++) addRejected(l, { fingerprint: `f${i}`, summary: 's', reason: 'r', at: i })
    writeLedger(d, l)
    const back = readLedger(d, 'p1')
    expect(back.generations.length).toBeLessThanOrEqual(MAX_GENERATIONS + 1)
    expect(back.generations.some((g) => g.status === 'trial')).toBe(true)
    expect(back.generations.at(-1)?.id).toBe('gen_60')
    expect(back.rejectedHypotheses).toHaveLength(MAX_REJECTED)
    expect(back.rejectedHypotheses.at(-1)?.fingerprint).toBe('f229')
    expect(JSON.parse(readFileSync(ledgerPath(d, 'p1'), 'utf8')).version).toBe(1)
  })
})

function metrics(over: Partial<EvolutionMetrics> = {}): EvolutionMetrics {
  return { runs: 5, firstPassRate: 0.9, conflictRate: 0, errorRunRate: 0.1, medianCostUsd: 1, medianWallMs: 60_000, medianInputTokens: 1000, dagConcurrencyRatio: 1, ...over }
}

describe('promote vs rollback thresholds (boundary values)', () => {
  const b = metrics()
  it('first-pass drop: exactly 0.15 promotes, just over rolls back', () => {
    expect(compareMetrics(b, metrics({ firstPassRate: 0.75 })).regressed).toBe(false)
    expect(compareMetrics(b, metrics({ firstPassRate: 0.74 })).regressed).toBe(true)
    expect(compareMetrics(b, metrics({ firstPassRate: 1 })).regressed).toBe(false)
  })
  it('error-run rate rise: exactly 0.20 promotes, over rolls back', () => {
    expect(compareMetrics(b, metrics({ errorRunRate: 0.3 })).regressed).toBe(false)
    expect(compareMetrics(b, metrics({ errorRunRate: 0.31 })).regressed).toBe(true)
  })
  it('cost x time: +25% promotes, over rolls back unless first-pass improved', () => {
    expect(compareMetrics(b, metrics({ medianCostUsd: 1.25 })).regressed).toBe(false)
    expect(compareMetrics(b, metrics({ medianCostUsd: 1.26 })).regressed).toBe(true)
    expect(compareMetrics(b, metrics({ medianCostUsd: 1.26, firstPassRate: 0.9 })).regressed).toBe(true) // equal first pass is not higher
    expect(compareMetrics(b, metrics({ medianCostUsd: 2, firstPassRate: 0.95 })).regressed).toBe(false)
    expect(compareMetrics(b, metrics({ medianWallMs: 80_000 })).regressed).toBe(true) // +33% by time
    expect(compareMetrics(metrics({ medianCostUsd: 0 }), metrics({ medianCostUsd: 9 })).regressed).toBe(false) // no baseline figure
  })

  const g = (over: Partial<EvolutionGeneration> = {}): Pick<EvolutionGeneration, 'appliedAt' | 'evalWindowRuns' | 'baselineMetrics'> => ({ appliedAt: 5_000_000, evalWindowRuns: 3, baselineMetrics: b, ...over })
  const after = (n: number, over: Parameters<typeof run>[0] = {}) => Array.from({ length: n }, (_, i) => run({ startedAt: 5_000_000 + i * 1000, agents: [{ slug: 'dev' }], ...over }))
  it('waits for the window, ignores runs started before the apply, setup and quick runs', () => {
    expect(evaluateActiveTrial(g(), after(2))).toEqual({ state: 'pending', have: 2, need: 3 })
    const noise = [run({ startedAt: 4_999_999 }), run({ startedAt: 5_000_100, kind: 'setup' }), run({ startedAt: 5_000_100, quick: true })]
    expect(evaluateActiveTrial(g(), [...after(2), ...noise]).state).toBe('pending')
    expect(evaluateActiveTrial(g(), after(3)).state).toBe('decided')
  })
  it('clamps the window to 1..10 and measures only the first N runs after the apply', () => {
    expect(evaluateActiveTrial(g({ evalWindowRuns: 0 }), after(1)).state).toBe('decided')
    expect(evaluateActiveTrial(g({ evalWindowRuns: 99 }), after(9))).toMatchObject({ state: 'pending', need: 10 })
    const mixed = [...after(3), run({ startedAt: 6_000_000, status: 'error', agents: [{ slug: 'dev', state: 'error' }] })]
    const d = evaluateActiveTrial(g(), mixed)
    expect(d).toMatchObject({ state: 'decided', regressed: false })
    if (d.state === 'decided') expect(d.trialMetrics.runs).toBe(3)
  })
  it('rolls back a trial that regressed and promotes one that did not', () => {
    const bad = after(3, { status: 'error', agents: [{ slug: 'dev', state: 'error' }] })
    const d = evaluateActiveTrial(g(), bad)
    expect(d).toMatchObject({ state: 'decided', regressed: true })
    // no baseline run: decided on the error rate only, never promoted on cost
    expect(evaluateActiveTrial(g({ baselineMetrics: metrics({ runs: 0, errorRunRate: 0, firstPassRate: 0 }) }), after(3))).toMatchObject({ regressed: false })
    expect(evaluateActiveTrial(g({ baselineMetrics: metrics({ runs: 0, errorRunRate: 0, firstPassRate: 0 }) }), bad)).toMatchObject({ regressed: true })
  })
})

describe('restoreSnapshot', () => {
  // Another role also holds Bash, so a rollback may give it back to dev (a write tool nobody holds is not restored).
  const p = project({ maxConcurrentSubagents: 4 }, [
    role('lead', { id: 'r_lead', reportsTo: null, canSpawn: true, spawnable: ['r_dev', 'r_review'], tier: 'deep', model: 'deep' }),
    role('dev', { id: 'r_dev', tools: ['Read', 'Edit', 'Write', 'Bash'], tier: 'deep', model: 'deep', effort: 'high' }),
    role('review', { id: 'r_review', name: 'Reviewer', tools: ['Read', 'Grep', 'Bash'] })
  ])
  const diagnosis = { findings: [
    { kind: 'tool_friction' as const, roleSlug: 'dev', severity: 10, summary: '', evidence: [] },
    { kind: 'serial_bottleneck' as const, severity: 10, summary: '', evidence: [], data: { limitThrottled: 1, peakReady: 6, limit: 4 } }
  ] }
  const gated = validateEvolutionPlan(p, mkPlan({ rolePatches: [patch('dev', { effort: 'low', tier: 'everyday', removeTools: ['Bash'] })], maxConcurrentSubagents: 6 }), { diagnosis })
  const applied = applyPlan(p, gated)
  const snap = snapshotOf(p, applied, gated)

  it('the gated plan is what the tests expect', () => {
    expect(gated.rolePatches[0]).toMatchObject({ effort: 'low', tier: 'everyday', removeTools: ['Bash'] })
    expect(gated.maxConcurrentSubagents).toBe(6)
  })
  it('restores exactly what the plan touched', () => {
    const r = restoreSnapshot(applied, snap, gated)
    expect(r.ok).toBe(true)
    const dev = r.project.roles.find((x) => x.slug === 'dev')!
    expect(dev).toMatchObject({ effort: 'high', tier: 'deep', model: 'deep' })
    expect([...dev.tools].sort()).toEqual([...p.roles[1].tools].sort())
    expect(r.project.maxConcurrentSubagents).toBe(4)
    expect(r.notes).toEqual([])
    expect(r.restored).toBeGreaterThan(0)
  })
  it('keeps fields the user edited since, and restores the rest, with a note', () => {
    const edited: Project = { ...applied, roles: applied.roles.map((r) => (r.slug === 'dev' ? { ...r, effort: 'medium' as const, description: 'edited' } : r)), maxConcurrentSubagents: 3 }
    const r = restoreSnapshot(edited, snap, gated)
    const dev = r.project.roles.find((x) => x.slug === 'dev')!
    expect(dev.effort).toBe('medium')
    expect(dev.description).toBe('edited')
    expect(dev.tier).toBe('deep')
    expect(r.notes).toEqual(expect.arrayContaining(['kept your later edit to dev.effort', 'kept your later edit to the concurrency limit']))
    expect(r.project.maxConcurrentSubagents).toBe(3)
  })
  it('tolerates a deleted role', () => {
    const r = restoreSnapshot({ ...applied, roles: applied.roles.filter((x) => x.slug !== 'dev') }, snap, gated)
    expect(r.ok).toBe(true)
    expect(r.notes).toContain('role dev no longer exists')
  })
  it('touches only the fields a plan can change: a tampered snapshot naming canSpawn or reportsTo is unusable', () => {
    for (const field of ['canSpawn', 'spawnable', 'requiredReports', 'reportsTo', 'mcpServers', 'connection', 'permissionMode']) {
      const bad = structuredClone(snap)
      bad.edits[0].pre = { ...bad.edits[0].pre, [field]: field === 'canSpawn' ? true : 'x' }
      bad.edits[0].post = { ...bad.edits[0].post, [field]: false }
      const r = restoreSnapshot(applied, bad, gated)
      expect(r.ok, field).toBe(false)
      expect(r.project).toBe(applied)
      expect(r.reason).toContain('unusable')
    }
  })
  it('refuses values of the wrong type or enum, and fields the plan did not touch', () => {
    const t = (mut: (s: typeof snap) => void) => { const b = structuredClone(snap); mut(b); return restoreSnapshot(applied, b, gated) }
    expect(t((b) => { b.edits[0].pre.tier = 'galaxy' }).ok).toBe(false)
    expect(t((b) => { b.edits[0].pre.effort = 7 }).ok).toBe(false)
    expect(t((b) => { b.edits[0].pre.staffing = { mode: 'auto', minTier: 'top?' } }).ok).toBe(false)
    expect(t((b) => { b.edits[0].pre.prompt = 5 }).ok).toBe(false)
    expect(t((b) => { b.edits[0].pre.tools = 'Bash' }).ok).toBe(false)
    expect(t((b) => { b.postMaxConcurrentSubagents = 6; b.maxConcurrentSubagents = 500 }).ok).toBe(false)
    expect(t((b) => { (b as { edits: unknown }).edits = 'nope' }).ok).toBe(false)
    expect(t((b) => { b.edits = [null as never] }).ok).toBe(true) // null entries are skipped, nothing to restore
    const noPrompt = structuredClone(snap)
    noPrompt.edits[0].pre.prompt = 'x'
    noPrompt.edits[0].post.prompt = applied.roles[1].prompt
    expect(restoreSnapshot(applied, noPrompt, gated).ok).toBe(false) // the plan never touched the prompt
  })
  it('a write or exec tool comes back only when this plan removed exactly that tool', () => {
    const r = restoreSnapshot(applied, snap, gated)
    expect(r.ok).toBe(true)
    expect(r.project.roles.find((x) => x.slug === 'dev')!.tools).toContain('Bash')
  })
  describe('never restores what an evolution could never set', () => {
    const base = (devOver: Partial<Role>, others?: Partial<Role>): Project =>
      project({}, [
        role('lead', { id: 'r_lead', reportsTo: null, canSpawn: true, spawnable: ['r_dev', 'r_review'], tier: 'deep', model: 'deep' }),
        role('dev', { id: 'r_dev', tier: 'deep', model: 'deep', effort: 'high', ...devOver }),
        role('review', { id: 'r_review', ...others })
      ])
    const roll = (before: Project, rolePatch: EvolutionRolePatch) => {
      const plan = mkPlan({ rolePatches: [rolePatch] })
      const after = applyPlan(before, plan)
      return restoreSnapshot(after, snapshotOf(before, after, plan), plan)
    }
    const dev = (r: ReturnType<typeof roll>) => r.project.roles.find((x) => x.slug === 'dev')!

    it('top tier is kept, with a note, and the rest of the rollback goes on', () => {
      const r = roll(base({ tier: 'top', model: 'top', effort: 'medium' }), patch('dev', { tier: 'deep', effort: 'low' }))
      expect(r.ok).toBe(true)
      expect(dev(r)).toMatchObject({ tier: 'deep', effort: 'medium' })
      expect(r.notes).toContain('kept dev.tier: restoring would set "top", which only you can set')
      expect(r.notes.join(' ')).toContain('dev.model')
      expect(dev(r).model).not.toBe('top')
    })
    it.each(['xhigh', 'max'] as const)('effort %s is kept, with a note', (effort) => {
      const r = roll(base({ effort }), patch('dev', { effort: 'low' }))
      expect(r.ok).toBe(true)
      expect(dev(r).effort).toBe('low')
      expect(r.notes).toContain(`kept dev.effort: restoring would set "${effort}", which only you can set`)
    })
    it('staffing maxEffort xhigh / max and minTier top are kept', () => {
      for (const [pre, word] of [
        [{ mode: 'auto', maxEffort: 'xhigh' }, 'xhigh'],
        [{ mode: 'auto', maxEffort: 'max' }, 'max'],
        [{ mode: 'auto', minTier: 'top' }, 'top']
      ] as const) {
        const r = roll(base({ staffing: { ...pre } }), patch('dev', { staffing: { mode: 'auto', minTier: 'deep', maxEffort: 'high' } }))
        expect(r.ok).toBe(true)
        expect(dev(r).staffing).toEqual({ mode: 'auto', minTier: 'deep', maxEffort: 'high' })
        expect(r.notes).toContain(`kept dev.staffing: restoring would set "${word}", which only you can set`)
      }
    })
    it('lower values still come back', () => {
      const r = roll(base({ staffing: { mode: 'auto', minTier: 'everyday', maxEffort: 'high' } }), patch('dev', { staffing: { mode: 'auto', minTier: 'deep' } }))
      expect(dev(r).staffing).toEqual({ mode: 'auto', minTier: 'everyday', maxEffort: 'high' })
      expect(r.notes).toEqual([])
    })
    it('a write tool nobody else holds is left out with a note; a read tool still comes back', () => {
      const r = roll(base({ tools: ['Read', 'Grep', 'Edit', 'Bash'] }), patch('dev', { removeTools: ['Bash', 'Grep'] }))
      expect(r.ok).toBe(true)
      expect(dev(r).tools).toContain('Grep')
      expect(dev(r).tools).not.toContain('Bash')
      expect(r.notes).toContain('Bash was not given back to dev; add it yourself if you want it')
    })
    it('a write tool another role holds comes back', () => {
      const r = roll(base({ tools: ['Read', 'Edit', 'Bash'] }, { tools: ['Read', 'Bash'] }), patch('dev', { removeTools: ['Bash'] }))
      expect(r.ok).toBe(true)
      expect(dev(r).tools).toContain('Bash')
      expect(r.notes).toEqual([])
    })
  })
  it('a snapshot edited after the fact (a pre value the recorded chart does not hold) is refused whole', () => {
    const extra = structuredClone(snap)
    extra.edits[0].pre.tools = ['Read', 'Edit', 'Write', 'Bash', 'NotebookEdit']
    expect(restoreSnapshot(applied, extra, gated).ok).toBe(false)
    const louder = structuredClone(snap)
    louder.edits[0].pre.effort = 'max'
    const r = restoreSnapshot(applied, louder, gated)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('does not match the chart and plan')
    expect(r.project).toBe(applied)
  })
  it('a rollback never raises the concurrency limit (a value before above the value after is kept as it is)', () => {
    const raised = structuredClone(snap)
    raised.maxConcurrentSubagents = 8 // the plan raised 4 -> 6; a "before" of 8 would raise it on rollback
    const r = restoreSnapshot(applied, raised, gated)
    expect(r.ok).toBe(true)
    expect(r.project.maxConcurrentSubagents).toBe(6)
    expect(r.notes.join(' ')).toContain('kept the concurrency limit')
    expect(restoreSnapshot(applied, snap, gated).project.maxConcurrentSubagents).toBe(4)
  })
  it('a role renamed since the generation still gets its rollback (matched by id)', () => {
    const renamed: Project = { ...applied, roles: applied.roles.map((x) => (x.slug === 'dev' ? { ...x, slug: 'implementer' } : x)) }
    const r = restoreSnapshot(renamed, snap, gated)
    expect(r.ok).toBe(true)
    expect(r.project.roles.find((x) => x.slug === 'implementer')?.effort).toBe('high')
  })
  it('a restored chart that would break the safety rules is refused whole', () => {
    const broken: Project = { ...applied, permissionMode: 'default' }
    expect(chartProblems(applied, broken).length).toBeGreaterThan(0)
    const r = restoreSnapshot(applied, snap, gated)
    expect(chartProblems(applied, r.project)).toEqual([])
  })
})

describe('trial comparison edge cases', () => {
  const b = metrics()
  it('compares cost and time separately when the product is unusable', () => {
    expect(compareMetrics(metrics({ medianWallMs: 0 }), metrics({ medianWallMs: 0, medianCostUsd: 2 })).regressed).toBe(true) // cost alone +100%
    expect(compareMetrics(metrics({ medianCostUsd: 0 }), metrics({ medianCostUsd: 0, medianWallMs: 120_000 })).regressed).toBe(true) // time alone +100%
    expect(compareMetrics(metrics({ medianWallMs: 0 }), metrics({ medianWallMs: 0, medianCostUsd: 1.25 })).regressed).toBe(false)
  })
  it('trial figures against a baseline with none are not comparable (quality only, and it says so)', () => {
    const r = compareMetrics(metrics({ medianCostUsd: 0, medianWallMs: 0 }), b)
    expect(r.regressed).toBe(false)
    expect(r.reason).toContain('not comparable')
  })
  it('a zero-run baseline decides on the error rate only', () => {
    const none = metrics({ runs: 0, firstPassRate: 0, errorRunRate: 0 })
    expect(compareMetrics(none, metrics({ firstPassRate: 0.1, errorRunRate: 0.2, medianCostUsd: 99 })).regressed).toBe(false)
    expect(compareMetrics(none, metrics({ errorRunRate: 0.21 })).regressed).toBe(true)
    expect(compareMetrics(none, metrics()).reason).toContain('no baseline run')
  })
})

describe('ledger size cap', () => {
  it('an oversized file is set aside as corrupt, and a write drops the oldest decided generations to stay under it', () => {
    const d = mkdtempSync(join(tmpdir(), 'evolve-cap-'))
    try {
      mkdirSync(join(d, 'evolution'))
      writeFileSync(ledgerPath(d, 'p1'), `{"version":1,"generations":[],"rejectedHypotheses":[],"pad":"${'x'.repeat(MAX_LEDGER_BYTES)}"}`)
      expect(readLedger(d, 'p1', () => 9).generations).toEqual([])
      expect(readdirSync(join(d, 'evolution'))).toEqual(['p1.json.corrupt-9'])
      const l = emptyLedger('p1')
      const big = (n: number, status: StoredGeneration['status']): StoredGeneration => ({ id: `gen_${n}`, status, strategy: 'deterministic', fingerprint: `f${n}`, summary: 's', appliedAt: n, appliedAtRunCount: 0, evalWindowRuns: 3, baselineMetrics: metrics(), plan: mkPlan(), snapshot: { roles: [{ pad: 'y'.repeat(900_000) }] as never, maxConcurrentSubagents: null, postMaxConcurrentSubagents: null, edits: [], addedSkillIds: [], prunedSkills: [] } })
      l.generations = [big(1, 'promoted'), big(2, 'promoted'), big(3, 'promoted'), big(4, 'trial')]
      writeLedger(d, l)
      const back = readLedger(d, 'p1')
      expect(back.generations.map((g) => g.id)).toEqual(['gen_3', 'gen_4'])
      expect(back.generations.at(-1)?.status).toBe('trial')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
