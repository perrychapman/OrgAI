// Defect injectors for the self-healing bench. Each defect takes a fresh reference chart (charts.mjs) and returns the
// defective chart plus what it touched and what the engine would have to find. Pure; mutates only the copy it is given.
//
// A defect entry:
//   id, label, group ('engine' = in the engine's finding vocabulary, 'structural' = outside it)
//   target(complexity) -> the role slug(s) it lands on, or null when it does not apply to that chart
//   inject(chart, target) -> { touched: [{ slug, field } | { project: 'maxConcurrentSubagents' } | { structure: true }],
//                              expect: { kind, roleSlug? , match? } | null, related?: { kind, roleSlug } }
//   heal: the mechanism that could heal it today and what stops the unattended path (file and function), from reading
//         the code; the bench's observed gate rules and held raises are reported beside it.

import { ROUTINE, ROUTINE_SKILL_ID } from './charts.mjs'

const role = (chart, slug) => chart.project.roles.find((r) => r.slug === slug)
const setTier = (r, tier) => {
  r.tier = tier
  r.model = tier
}
const sixCopies = (prompt) => Array.from({ length: 6 }, () => prompt).join('\n')
const per = (small, medium, large) => (c) => ({ small, medium, large })[c]

/** Insert a new role `slug` between `child` and its current parent; the parent spawns the new role instead. */
function insertBetween(chart, childSlug, slug, o) {
  const child = role(chart, childSlug)
  const parent = chart.project.roles.find((r) => r.id === child.reportsTo)
  const id = `r_${slug}`
  chart.project.roles.push({
    id,
    slug,
    name: slug,
    description: `${slug} role`,
    responsibilities: [],
    prompt: o.prompt,
    tools: ['Read', 'Glob', 'Grep'],
    model: o.tier,
    tier: o.tier,
    effort: o.effort,
    canSpawn: true,
    spawnable: [child.id],
    reportsTo: parent.id,
    position: { x: 9000, y: 320 },
    color: '#888888'
  })
  parent.spawnable = parent.spawnable.map((x) => (x === child.id ? id : x))
  child.reportsTo = id
  chart.truth[slug] = { needTier: o.tier, needEffort: o.effort, kind: 'analyze', tools: ['Read', 'Glob', 'Grep'], refParent: parent.slug }
}

const COORD_PROMPT = ['You coordinate the work of your report.', 'Pass on the brief with the context it needs and collect the result.', 'Report back what was done.'].join('\n')
const ARCHIVIST_PROMPT = ['You keep an index of past decisions and their reasons.', 'Update the index when a decision is made.', 'Answer questions about why something was decided.'].join('\n')

export const DEFECTS = [
  // ---------- in the engine's vocabulary ----------
  {
    id: 'tier-over',
    label: 'Tier over-provisioned (lookup role on deep)',
    group: 'engine',
    target: per('researcher', 'researcher', 'researcher'),
    inject(chart, slug) {
      setTier(role(chart, slug), 'deep')
      return { touched: [{ slug, field: 'tier' }, { slug, field: 'model' }], expect: { kind: 'tier_overprovisioned', roleSlug: slug } }
    },
    heal: {
      mechanism: 'deterministic evolve (one step per generation)',
      blocker: 'telemetry.ts diagnose: the over-provisioned rule stops at everyday when effort is low (`!(runtimeTier === \'everyday\' && role.effort === \'low\')`) and never fires on fast; synthesizer.ts fromFindings steps one tier per generation and service.ts cooldownOf holds the role for COOLDOWN_RUNS (5) runs after each decision.'
    }
  },
  {
    id: 'tier-under',
    label: 'Tier under-provisioned (builder on everyday)',
    group: 'engine',
    target: per('builder', 'builder-a', 'builder-a'),
    inject(chart, slug) {
      setTier(role(chart, slug), 'everyday')
      return { touched: [{ slug, field: 'tier' }, { slug, field: 'model' }], expect: { kind: 'tier_underprovisioned', roleSlug: slug } }
    },
    heal: {
      mechanism: 'interactive `orgai org evolve --apply` with a person approving the raise (two generations), the hybrid strategy with approval, propose_org_change in a work run, or the Architect retrospective',
      blocker: 'service.ts applyCore: the post-run pass never sets allowSpendRaise, so spend.ts holdSpendRaises strips every raise (rule spend_held). Even approved, synthesizer.ts fromFindings first proposes `staffing.minTier = current tier` (a floor equal to the ceiling, which changes nothing under goal balanced: runtime/staffing.ts resolveStaffing already runs at the ceiling); only the next generation raises the tier.'
    }
  },
  {
    id: 'effort-high',
    label: 'Effort too high (simple-work role on high)',
    group: 'engine',
    target: per('researcher', 'checker', 'checker'),
    inject(chart, slug) {
      role(chart, slug).effort = 'high'
      return { touched: [{ slug, field: 'effort' }], expect: { kind: 'tier_overprovisioned', roleSlug: slug } }
    },
    heal: {
      mechanism: 'deterministic evolve on everyday/deep roles; nothing on a fast role',
      blocker: 'telemetry.ts diagnose: the over-provisioned rule requires `tierDown(runtimeTier)` (deep or everyday), so effort waste on a fast role is never a finding; on an everyday role it fires only for short work (avg turns <= 6 and output <= 4,000 tokens).'
    }
  },
  {
    id: 'serial',
    label: 'Serial bottleneck (concurrency 1)',
    group: 'engine',
    target: per('*', '*', '*'),
    inject(chart) {
      chart.project.maxConcurrentSubagents = 1
      return { touched: [{ project: 'maxConcurrentSubagents' }], expect: { kind: 'serial_bottleneck' } }
    },
    heal: {
      mechanism: 'interactive `orgai org evolve --apply` with a person approving the concurrency raise',
      blocker: 'spend.ts spendRaisesOf counts a higher concurrency limit as a raise; service.ts applyCore holds it on the post-run pass (spend_held). telemetry.ts spawnShape also reads only the ROOT\'s direct reports, so a chart whose leads fan out is measured on the leads, not the workers.'
    }
  },
  {
    id: 'conflict',
    label: 'Merge conflict hotspot (overlapping file scopes)',
    group: 'engine',
    target: per(['builder'], ['builder-a', 'builder-b'], ['builder-a', 'builder-b', 'builder-c']),
    inject(chart, slugs) {
      for (const s of slugs) role(chart, s).prompt += '\nShared files: src/common/.'
      return { touched: slugs.map((s) => ({ slug: s, field: 'prompt' })), expect: { kind: 'merge_conflict_hotspot' } }
    },
    heal: {
      mechanism: 'deterministic evolve treats the symptom (the fixed file-scope block in the spawner\'s prompt); the overlapping scope lines themselves only by hand or propose_org_change',
      blocker: 'ratchet.ts validateEvolutionPlan accepts a prompt patch only as compressPrompt output or the fixed SCOPE block on the conflict\'s lead (prompt_not_subset), so the builders\' own scope lines are never edited.'
    }
  },
  {
    id: 'tool-friction',
    label: 'Tool friction (lookup role lacks Grep)',
    group: 'engine',
    target: per('researcher', 'researcher', 'researcher'),
    inject(chart, slug) {
      const r = role(chart, slug)
      r.tools = r.tools.filter((t) => t !== 'Grep')
      return { touched: [{ slug, field: 'tools' }], expect: { kind: 'tool_friction', roleSlug: slug } }
    },
    heal: { mechanism: 'deterministic evolve (adds Read, Glob or Grep)', blocker: '' }
  },
  {
    id: 'prompt-bloat',
    label: 'Prompt bloat (six pasted copies)',
    group: 'engine',
    target: per('builder', 'writer', 'writer'),
    inject(chart, slug) {
      const r = role(chart, slug)
      r.prompt = sixCopies(r.prompt)
      return { touched: [{ slug, field: 'prompt' }], expect: { kind: 'prompt_deflation', roleSlug: slug } }
    },
    heal: { mechanism: 'deterministic evolve (compressPrompt removes exact duplicate lines)', blocker: 'telemetry.ts diagnose fires only above PROMPT_BUDGET_PER_ROLE (900) characters, so bloat under 900 is invisible.' }
  },
  {
    id: 'ceremonial',
    label: 'Ceremonial layer (coordinator with one report)',
    group: 'engine',
    target: per('builder', 'builder-a', 'writer'),
    inject(chart, slug) {
      insertBetween(chart, slug, 'coordinator', { tier: 'everyday', effort: 'medium', prompt: COORD_PROMPT })
      return { touched: [{ structure: true }], expect: { kind: 'ceremonial_layer', roleSlug: 'coordinator' } }
    },
    heal: {
      mechanism: 'propose_org_change in a work run or the Architect retrospective (a person approves the new chart)',
      blocker: 'synthesizer.ts fromFindings turns ceremonial_layer into a note only; ratchet.ts chartProblems rejects any change to reportsTo, spawnable or the role set (chart_broken), so no evolve strategy can remove a layer.'
    }
  },
  {
    id: 'skill-routine',
    label: 'Repeated procedure that should be a skill',
    group: 'engine',
    target: per(['builder'], ['builder-a', 'builder-b'], ['builder-a', 'builder-b', 'builder-c']),
    inject(chart, slugs) {
      for (const s of slugs) delete role(chart, s).skills
      chart.project.skills = []
      return { touched: slugs.map((s) => ({ slug: s, field: 'skills' })), expect: { kind: 'skill_crystallization', match: ROUTINE } }
    },
    heal: {
      mechanism: 'the hybrid strategy drafts a skill (created disabled; a person turns it on), or the skills suggestion flow',
      blocker: 'synthesizer.ts fromFindings: skill_crystallization is a note on the deterministic strategy; service.ts planFor drops new skills without the skills.setEnabled port (the host wires none: bootstrap.ts), and grants to the new skill are never added by a plan.'
    }
  },
  // ---------- structural ----------
  {
    id: 'missing-specialty',
    label: 'Missing specialty (root or lead does lookups itself)',
    group: 'structural',
    target: per('researcher', 'researcher', 'researcher'),
    inject(chart, slug) {
      const r = role(chart, slug)
      chart.project.roles = chart.project.roles.filter((x) => x !== r)
      for (const x of chart.project.roles) x.spawnable = x.spawnable.filter((id) => id !== r.id)
      for (const x of chart.project.roles) x.canSpawn = x.spawnable.length > 0
      return { touched: [{ structure: true }], expect: null }
    },
    heal: {
      mechanism: 'propose_org_change in a work run or the Architect retrospective',
      blocker: 'telemetry.ts diagnose skips the root agent (isRoot) and has no finding for work a spawner does itself; ratchet.ts chartProblems rejects adding a role (chart_broken).'
    }
  },
  {
    id: 'redundant-role',
    label: 'Redundant role never used',
    group: 'structural',
    target: per('lead', 'lead', 'director'),
    inject(chart, parentSlug) {
      const parent = role(chart, parentSlug)
      chart.project.roles.push({ id: 'r_archivist', slug: 'archivist', name: 'archivist', description: 'archivist role', responsibilities: [], prompt: ARCHIVIST_PROMPT, tools: ['Read', 'Glob', 'Grep', 'Write'], model: 'everyday', tier: 'everyday', effort: 'medium', canSpawn: false, spawnable: [], reportsTo: parent.id, position: { x: 9200, y: 160 }, color: '#888888' })
      parent.spawnable = [...parent.spawnable, 'r_archivist']
      chart.truth.archivist = { needTier: 'everyday', needEffort: 'medium', kind: 'write', tools: ['Read', 'Write'], refParent: parentSlug }
      return { touched: [{ structure: true }], expect: null }
    },
    heal: {
      mechanism: 'the Architect retrospective or a person; nothing measures an unused role',
      blocker: 'telemetry.ts diagnose aggregates only agents that ran, so a role never spawned has no finding (unless its prompt passes 900 characters); ratchet.ts chartProblems rejects removing a role (chart_broken).'
    }
  },
  {
    id: 'wrong-line',
    label: 'Wrong reporting line (analyst under the build lead)',
    group: 'structural',
    target: per(null, null, 'analyst'),
    inject(chart, slug) {
      const r = role(chart, slug)
      const from = role(chart, 'content-lead')
      const to = role(chart, 'build-lead')
      from.spawnable = from.spawnable.filter((x) => x !== r.id)
      to.spawnable = [...to.spawnable, r.id]
      r.reportsTo = to.id
      return { touched: [{ structure: true }], expect: null, related: { kind: 'ceremonial_layer', roleSlug: 'build-lead' } }
    },
    heal: {
      mechanism: 'propose_org_change in a work run or the Architect retrospective',
      blocker: 'telemetry.ts diagnose has no finding for "spawned through the wrong lead"; plain re-spawns (staffing source role) are counted as first passes; ratchet.ts chartProblems rejects reportsTo and spawnable changes (chart_broken).'
    }
  },
  {
    id: 'missing-write',
    label: 'Role lacks a write tool it needs',
    group: 'structural',
    target: per('builder', 'writer', 'writer'),
    inject(chart, slug) {
      const r = role(chart, slug)
      const drop = slug === 'builder' ? 'Edit' : 'Write'
      r.tools = r.tools.filter((t) => t !== drop)
      return { touched: [{ slug, field: 'tools' }], expect: { kind: 'tool_friction', roleSlug: slug } }
    },
    heal: {
      mechanism: 'a person, propose_org_change in a work run, or the Architect retrospective',
      blocker: 'synthesizer.ts fromFindings adds only Read, Glob and Grep; ratchet.ts validateEvolutionPlan rejects the whole plan for any write or exec tool (write_tool_added / write_tool_to_readonly), also from the hybrid model.'
    }
  },
  {
    id: 'guard-bloat',
    label: 'Guard role (reviewer) prompt bloat',
    group: 'structural',
    target: per('reviewer', 'reviewer', 'reviewer'),
    inject(chart, slug) {
      const r = role(chart, slug)
      r.prompt = sixCopies(r.prompt)
      return { touched: [{ slug, field: 'prompt' }], expect: { kind: 'prompt_deflation', roleSlug: slug } }
    },
    heal: {
      mechanism: 'a person or the Architect retrospective (by design)',
      blocker: 'plan.ts isGuardRole protects review/verify/QA/audit/security/test roles; synthesizer.ts fromFindings notes it and ratchet.ts validateEvolutionPlan trims any prompt change (prompt_protected).'
    }
  },
  {
    id: 'guard-tier-over',
    label: 'Guard role (reviewer) on deep',
    group: 'structural',
    target: per('reviewer', 'reviewer', 'reviewer'),
    inject(chart, slug) {
      setTier(role(chart, slug), 'deep')
      return { touched: [{ slug, field: 'tier' }, { slug, field: 'model' }], expect: { kind: 'tier_overprovisioned', roleSlug: slug } }
    },
    heal: {
      mechanism: 'deterministic evolve if the review work were short; otherwise a person',
      blocker: 'telemetry.ts diagnose: the over-provisioned rule needs short work (avg turns <= 6, output <= 4,000); a review of 9 turns never qualifies, so cost waste on long-work roles is invisible. Note the gate does NOT protect a guard role\'s tier (only its prompt, tool removals and skills).'
    }
  }
]

export const CONTROL = { id: 'control', label: 'Control (healthy reference chart)', group: 'control', target: per('*', '*', '*'), inject: () => ({ touched: [], expect: null }), heal: { mechanism: '', blocker: '' } }

/** The defect by id (controls included). */
export const defectById = (id) => (id === 'control' ? CONTROL : DEFECTS.find((d) => d.id === id))

export { ROUTINE_SKILL_ID }
