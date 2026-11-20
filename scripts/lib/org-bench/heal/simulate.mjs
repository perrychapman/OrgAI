// Run-record simulator for the self-healing bench. Pure and deterministic: the same (chart, truth, task mix, seed, run
// index) always gives the same RunRecord. No I/O, no clock.
//
// The rules (each one causal, from the chart and the hidden truth; none reads an engine threshold):
//  1. Task: one template per run, drawn by weight from the chart's task mix with a PRNG keyed by (seed, complexity,
//     run index), so a defect case and its frozen reference baseline see the same tasks and the same noise.
//  2. Routing: a step for role X is spawned along X's reportsTo chain in the CURRENT chart (one agent per intermediate
//     role per run, the "hops"). A hop that is not X's reference parent (truth.refParent) is an extra hop. When X is
//     not in the chart at all, the nearest existing reference ancestor does the step itself, inside its own agent.
//  3. Capability: tier index (fast 0, everyday 1, deep 2, top 3) + 0.5 x effort index (low 0, medium 1, high 2, ...).
//     gap = need - run + noise(+-0.2). An attempt fails with p = 0.03 + (gap > 0.25 ? min(0.85, 0.3 + 0.5 gap) : 0)
//     + 0.12 per extra hop + 0.15 x the capability gap of an under-capable hop + 0.1 when a WRITE tool the work needs
//     is missing; capped at 0.9. A role runs on its own tier and effort (staffing 'auto', goal 'balanced' resolves to
//     the ceiling with no orchestrator request: runtime/staffing.ts resolveStaffing rule 3).
//  4. Retry: a failed attempt is followed by one retry agent of the same role, recorded as staffing source
//     'escalated' when the failure was a capability gap, else 'role' (a plain re-spawn). A failed retry ends the step
//     failed and the run 'error'. The first agent of a failed step finishes 'done' with a result.
//  5. Size: turns = base(kind) x (1 +- 25%) + 1 per failed call to a missing tool + routine turns; output tokens =
//     turns x per-turn(kind) x effort factor (low .7, medium 1, high 1.5, xhigh 2, max 2.5); input tokens = turns x
//     (3000 + prompt tokens + 300 x turns) + the output of every agent it spawned (results flow back once).
//     Prompt tokens = prompt chars / 4 + 50 per spawnable role + 30 per tool.
//  6. Price per million tokens in/out: fast 1/5, everyday 3/15, deep 5/25, top 15/75. Wall = turns x seconds per turn
//     (fast 4, everyday 7, deep 12, top 15) x effort factor (low .8, medium 1, high 1.3, xhigh 1.6, max 2).
//  7. Tools: an agent tries every tool its kind of work needs (truth.tools); each missing one is called twice and fails
//     with "No such tool available". Its other calls are drawn from the tools it has.
//  8. Routine: a role whose truth has a routine and holds no grant of the routine skill runs the six-call routine and
//     4 extra turns per step; with the grant it makes one Skill call and 1 extra turn.
//  9. Files: a build or write step changes files under its plan paths; a role whose prompt has a "Shared files:" line
//     also touches each listed folder with p 0.6, cut to 0.12 when its spawner's prompt carries the engine's fixed
//     file-scope rule. Two agents that overlap in time and touch the same top-two-level folder conflict: the one
//     that ends later is marked 'conflict' with p 0.8 and a redo agent (half the turns) follows it.
// 10. Concurrency: at most maxConcurrentSubagents step agents run at once (hops and the root do not count); steps start
//     in plan order when their `after` steps are done. A step done by the root or a lead itself runs in that agent's
//     own lane, one at a time.
// 11. Root: 4 turns + 1 per step + the turns of steps it does itself. The root is never measured by the engine.

import { KIND_TOOLS, ROUTINE, ROUTINE_SKILL_ID } from './charts.mjs'

export const TIERS = ['fast', 'everyday', 'deep', 'top']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const PRICE = { fast: [1, 5], everyday: [3, 15], deep: [5, 25], top: [15, 75] }
const SEC_PER_TURN = { fast: 4, everyday: 7, deep: 12, top: 15 }
const EFFORT_OUT = { low: 0.7, medium: 1, high: 1.5, xhigh: 2, max: 2.5 }
const EFFORT_WALL = { low: 0.8, medium: 1, high: 1.3, xhigh: 1.6, max: 2 }
const BASE_TURNS = { lookup: 4, check: 5, review: 9, analyze: 8, write: 9, build: 14 }
const OUT_PER_TURN = { lookup: 550, check: 450, review: 500, analyze: 700, write: 1000, build: 900, lead: 400 }
export const SCOPE_RULE = 'File scope: give each parallel report its own disjoint files or folders'
export const RUN_SPACING_MS = 3_600_000
export const T0 = Date.UTC(2026, 0, 5, 9, 0, 0)

// ---------- PRNG ----------

/** FNV-1a 32-bit hash of a string. */
export function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A PRNG keyed by a string (the same key always gives the same stream). */
export const rngFor = (key) => mulberry32(hash32(key))

const pickWeighted = (items, r) => {
  const total = items.reduce((n, x) => n + x.weight, 0)
  let at = r * total
  for (const x of items) {
    at -= x.weight
    if (at < 0) return x
  }
  return items[items.length - 1]
}

// ---------- chart reading ----------

export const tierOf = (role) => (TIERS.includes(String(role.model ?? '').trim()) ? String(role.model).trim() : TIERS.includes(role.tier) ? role.tier : 'everyday')
export const effortOf = (role) => (EFFORTS.includes(role.effort) ? role.effort : 'medium')
export const capability = (tier, effort) => TIERS.indexOf(tier) + 0.5 * EFFORTS.indexOf(effort)

const bySlug = (project) => new Map(project.roles.map((r) => [r.slug, r]))
const byId = (project) => new Map(project.roles.map((r) => [r.id, r]))
const rootOf = (project) => project.roles.find((r) => r.reportsTo === null)

/** Intermediate roles between the root and `role` (top-down, root and role excluded), from the current chart. */
export function hopsOf(project, role) {
  const ids = byId(project)
  const chain = []
  const seen = new Set()
  let cur = role.reportsTo ? ids.get(role.reportsTo) : undefined
  while (cur && cur.reportsTo !== null && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = ids.get(cur.reportsTo)
  }
  return chain
}

const hasRoutineSkill = (project, role) => !!role.skills?.includes(ROUTINE_SKILL_ID) && !!project.skills?.some((s) => s.id === ROUTINE_SKILL_ID)
const sharedFolders = (prompt) => {
  const m = /^Shared files:\s*(.+?)\.?\s*$/m.exec(prompt ?? '')
  return m ? m[1].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean) : []
}
const promptTokens = (role) => Math.ceil((role.prompt?.length ?? 0) / 4) + 50 * (role.spawnable?.length ?? 0) + 30 * (role.tools?.length ?? 0)
const dirKey = (file) => file.split('/').filter(Boolean).slice(0, 2).join('/')

// ---------- one run ----------

/**
 * Simulate one finished team work run of `project` (the current chart) and return the stored RunRecord the engine
 * reads plus the simulator's own ground-truth figures (`sim`).
 *   chart: { id (complexity), truth, tasks }   project: the current Project   runIndex: 1-based   seed: number
 */
export function simulateRun({ chart, project, runIndex, seed }) {
  const key = (...parts) => [seed, chart.id, runIndex, ...parts].join('|')
  const truth = chart.truth
  const roles = bySlug(project)
  const root = rootOf(project)
  const startedAt = T0 + runIndex * RUN_SPACING_MS
  const runId = `run-${String(runIndex).padStart(4, '0')}`
  const task = pickWeighted(chart.tasks, rngFor(key('task'))())
  const limit = Number.isInteger(project.maxConcurrentSubagents) && project.maxConcurrentSubagents >= 1 ? Math.min(project.maxConcurrentSubagents, 32) : 8

  const agents = {}
  const transcript = []
  const assignments = []
  let agentSeq = 0
  let entrySeq = 0
  const newAgentId = () => `${runId}-a${++agentSeq}`
  const tool = (agentId, at, name, error) => {
    const id = `${runId}-t${++entrySeq}`
    transcript.push({ id: `${id}u`, agentId, at, block: { kind: 'tool_use', id, name, input: {} } })
    transcript.push({ id: `${id}r`, agentId, at: at + 1, block: { kind: 'tool_result', toolUseId: id, content: error ? `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>` : 'ok', isError: !!error } })
  }

  // --- route every step
  const hopAgents = new Map() // slug -> { role, parentSlug, children: [], start, end, extraIn }
  const steps = task.steps.map((s) => {
    const t = truth[s.role]
    const own = roles.get(s.role)
    if (own) {
      const hops = hopsOf(project, own)
      const extra = hops.filter((h) => h.slug !== t.refParent).length
      return { ...s, kind: t.kind, worker: own, doer: null, hops, extraHops: extra }
    }
    // missing role: the nearest reference ancestor that exists does it itself
    let anc = t.refParent
    while (anc && !roles.get(anc)) anc = truth[anc]?.refParent ?? null
    const doer = anc ? roles.get(anc) : root
    return { ...s, kind: t.kind, worker: null, doer, hops: doer.reportsTo === null ? [] : [...hopsOf(project, doer), doer], extraHops: 0 }
  })
  for (const s of steps) {
    let parent = root.slug
    for (const h of s.hops) {
      if (!hopAgents.has(h.slug)) hopAgents.set(h.slug, { role: h, parentSlug: parent, children: [], selfSteps: [], start: Infinity, end: -Infinity })
      parent = h.slug
    }
    s.spawnerSlug = s.worker ? parent : null
  }
  const spawnerRole = (slug) => roles.get(slug)
  const hopGap = (s) => {
    let g = 0
    for (const h of s.hops) {
      const need = truth[h.slug]
      if (!need || h === s.doer) continue
      const gap = capability(need.needTier, need.needEffort) - capability(tierOf(h), effortOf(h))
      if (gap > 0) g += gap
    }
    return g
  }

  // --- pre-draw each step's attempts (independent of the schedule)
  let failedSteps = 0
  let retries = 0
  for (const s of steps) {
    const who = s.worker ?? s.doer
    const tr = truth[s.role]
    const tier = tierOf(who)
    const effort = effortOf(who)
    const r = rngFor(key(s.id, 'step', s.role))
    const noise = (r() - 0.5) * 0.4
    const gap = capability(tr.needTier, tr.needEffort) - capability(tier, effort) + noise
    const missing = tr.tools.filter((x) => !who.tools.includes(x))
    const missingWrite = missing.some((x) => ['Edit', 'Write', 'Bash'].includes(x))
    let p = 0.03 + (gap > 0.25 ? Math.min(0.85, 0.3 + 0.5 * gap) : 0) + 0.12 * s.extraHops + 0.15 * hopGap(s) + (missingWrite ? 0.1 : 0)
    p = Math.min(0.9, p)
    const routine = tr.routine ? (hasRoutineSkill(project, who) ? 'skill' : 'routine') : null
    const size = (attempt) => {
      const rr = rngFor(key(s.id, 'size', attempt))
      const base = BASE_TURNS[s.kind] * (1 + (rr() - 0.5) * 0.5)
      const turns = Math.max(2, Math.round(base + missing.length * 2 + (routine === 'routine' ? 4 : routine === 'skill' ? 1 : 0)))
      return { turns, out: Math.round(turns * OUT_PER_TURN[s.kind] * EFFORT_OUT[effort]), wallMs: Math.round(turns * SEC_PER_TURN[tier] * EFFORT_WALL[effort] * 1000), r: rr }
    }
    const a1 = size(1)
    const fail1 = r() < p
    s.attempts = [{ ...a1, failed: fail1, source: 'role' }]
    if (fail1) {
      retries++
      const a2 = size(2)
      const fail2 = r() < p
      s.attempts.push({ ...a2, failed: fail2, source: gap > 0.25 ? 'escalated' : 'role' })
      if (fail2) failedSteps++
    }
    s.tier = tier
    s.effort = effort
    s.missing = missing
    s.routine = routine
    s.duration = s.attempts.reduce((n, a) => n + a.wallMs, 0) + 3000 * s.attempts.length
  }

  // --- schedule
  const PLAN_MS = 20_000
  const done = new Map()
  const started = new Set()
  const running = []
  const laneBusy = new Map()
  let t = PLAN_MS
  const ready = (s) => !started.has(s.id) && (s.after ?? []).every((d) => done.has(d) && done.get(d) <= t)
  for (let guard = 0; guard < 1000 && done.size < steps.length; guard++) {
    for (const s of steps) {
      if (!ready(s)) continue
      if (s.worker) {
        if (running.filter((x) => x.slot).length >= limit) continue
        running.push({ s, end: t + s.duration, slot: true })
      } else {
        const lane = s.doer.slug
        if ((laneBusy.get(lane) ?? -1) > t) continue
        laneBusy.set(lane, t + s.duration)
        running.push({ s, end: t + s.duration, slot: false })
      }
      s.start = t
      started.add(s.id)
    }
    if (!running.length) break
    running.sort((a, b) => a.end - b.end || (a.s.id < b.s.id ? -1 : 1))
    t = running[0].end
    for (let i = running.length - 1; i >= 0; i--) {
      if (running[i].end <= t) {
        done.set(running[i].s.id, running[i].end)
        running.splice(i, 1)
      }
    }
  }

  // --- agents
  const rootId = 'root'
  const costOf = (tier, inTok, outTok) => (inTok * PRICE[tier][0] + outTok * PRICE[tier][1]) / 1e6
  const mkAgent = (o) => {
    const cost = costOf(o.tier, o.inTok, o.out)
    agents[o.id] = {
      id: o.id,
      roleId: o.role.id,
      roleSlug: o.role.slug,
      name: o.role.name,
      parentId: o.parentId,
      spawnToolUseId: null,
      state: o.state ?? 'done',
      activity: '',
      inputTokens: o.inTok,
      outputTokens: o.out,
      costUsd: cost,
      usage: { tokens: { input: o.inTok, output: o.out, cacheRead: 0, cacheWrite: 0 }, models: [], costUsd: cost, costSource: 'provider', turns: o.turns, toolCalls: o.calls ?? 0, retries: 0 },
      startedAt: startedAt + o.start,
      endedAt: startedAt + o.end,
      result: o.state === 'error' ? '' : 'Done.',
      ...(o.files ? { worktree: { path: `/wt/${o.id}`, branch: `b-${o.id}`, status: o.conflict ? 'conflict' : 'merged', changedFiles: o.files } } : {})
    }
    return agents[o.id]
  }
  const workerAgents = []
  for (const s of steps) {
    if (!s.worker) continue
    let at = s.start
    s.attempts.forEach((a, i) => {
      const id = newAgentId()
      const role = s.worker
      const spawner = spawnerRole(s.spawnerSlug)
      const r = a.r
      let files
      if (s.kind === 'build' || s.kind === 'write') {
        files = (s.paths ?? []).map((p) => `${p.replace(/\/$/, '')}/file${1 + Math.floor(r() * 3)}.txt`)
        const scoped = !!spawner?.prompt?.includes(SCOPE_RULE)
        for (const f of sharedFolders(role.prompt)) if (r() < (scoped ? 0.12 : 0.6)) files.push(`${f.replace(/\/$/, '')}/shared${1 + Math.floor(r() * 2)}.txt`)
      }
      const inTok = a.turns * (3000 + promptTokens(role) + 300 * a.turns)
      const ag = { id, role, parentId: null, tier: s.tier, inTok, out: a.out, turns: a.turns, start: at + 3000, end: at + 3000 + a.wallMs, state: i === s.attempts.length - 1 && a.failed ? 'error' : 'done', files, step: s, calls: 0 }
      workerAgents.push(ag)
      assignments.push({ agentId: id, stepId: s.id, roleId: role.id, tier: s.tier, model: s.tier, effort: s.effort, source: a.source, at: startedAt + at })
      // transcript: missing tools first, then the routine or skill, then ordinary calls
      let tt = startedAt + ag.start
      const calls = []
      for (const m of s.missing) calls.push([m, true], [m, true])
      if (s.routine === 'routine') for (const x of ROUTINE) calls.push([x, false])
      else if (s.routine === 'skill') calls.push(['Skill', false])
      const have = KIND_TOOLS[s.kind].filter((x) => role.tools.includes(x))
      const pool = have.length ? have : ['Read']
      for (let k = 0; k < Math.min(a.turns, 8); k++) calls.push([pool[Math.floor(r() * pool.length)], false])
      ag.calls = calls.length
      ag.calls_ = calls
      ag.tt = tt
      at = ag.end
    })
  }
  // conflicts: agents overlapping in time on the same folder; the later one conflicts (p 0.8) and gets a redo
  const redo = []
  for (let i = 0; i < workerAgents.length; i++) {
    const b = workerAgents[i]
    if (!b.files?.length) continue
    for (let j = 0; j < workerAgents.length; j++) {
      const a = workerAgents[j]
      if (a === b || !a.files?.length || b.conflict) continue
      const overlap = a.start < b.end && b.start < a.end
      const later = b.end > a.end || (b.end === a.end && j < i)
      if (!overlap || !later) continue
      const dirs = new Set(a.files.map(dirKey))
      if (!b.files.some((f) => dirs.has(dirKey(f)))) continue
      if (rngFor(key(b.id, 'conflict'))() < 0.8) {
        b.conflict = true
        const turns = Math.max(2, Math.round(b.turns / 2))
        const wall = Math.round(turns * SEC_PER_TURN[b.tier] * EFFORT_WALL[b.step.effort] * 1000)
        redo.push({ id: newAgentId(), role: b.role, parentId: null, tier: b.tier, inTok: turns * (3000 + promptTokens(b.role) + 300 * turns), out: Math.round(turns * OUT_PER_TURN[b.step.kind] * EFFORT_OUT[b.step.effort]), turns, start: b.end + 2000, end: b.end + 2000 + wall, state: 'done', files: b.files, step: b.step, calls: 2, calls_: [['Read', false], ['Edit', false]] })
      }
    }
  }
  const allWork = [...workerAgents, ...redo]
  // hops: one agent per intermediate role, spanning its children; parent = the hop above or the root
  const hopIds = new Map()
  for (const [slug] of hopAgents) hopIds.set(slug, newAgentId())
  for (const w of allWork) {
    const hopSlug = w.step.spawnerSlug
    w.parentId = hopSlug === root.slug ? rootId : hopIds.get(hopSlug)
    if (hopSlug !== root.slug) hopAgents.get(hopSlug).children.push(w)
  }
  // steps a lead does itself
  for (const s of steps) if (!s.worker && s.doer.reportsTo !== null) hopAgents.get(s.doer.slug).selfSteps.push(s)
  // child hops
  const hopChildren = new Map()
  for (const [slug, h] of hopAgents) {
    if (h.parentSlug !== root.slug) hopChildren.set(h.parentSlug, [...(hopChildren.get(h.parentSlug) ?? []), slug])
  }
  const hopSpan = (slug) => {
    const h = hopAgents.get(slug)
    let s = Infinity
    let e = -Infinity
    for (const c of h.children) {
      s = Math.min(s, c.start)
      e = Math.max(e, c.end)
    }
    for (const st of h.selfSteps) {
      s = Math.min(s, st.start)
      e = Math.max(e, st.start + st.duration)
    }
    for (const c of hopChildren.get(slug) ?? []) {
      const [cs, ce] = hopSpan(c)
      s = Math.min(s, cs)
      e = Math.max(e, ce)
    }
    return [s - 5000, e + 5000]
  }
  const finalAgents = []
  for (const w of allWork) finalAgents.push(w)
  const hopOutputs = new Map()
  // deepest hops first so a parent hop can read its children's output
  const depth = (slug) => (hopAgents.get(slug).parentSlug === root.slug ? 0 : 1 + depth(hopAgents.get(slug).parentSlug))
  const hopOrder = [...hopAgents.keys()].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1))
  for (const slug of hopOrder) {
    const h = hopAgents.get(slug)
    const kids = h.children.length + (hopChildren.get(slug)?.length ?? 0)
    const [s, e] = hopSpan(slug)
    const tier = tierOf(h.role)
    const effort = effortOf(h.role)
    let turns = 2 + 2 * kids
    let out = Math.round(turns * OUT_PER_TURN.lead * EFFORT_OUT[effort])
    for (const st of h.selfSteps) {
      for (const a of st.attempts) {
        turns += a.turns
        out += a.out
      }
    }
    const kidOut = h.children.reduce((n, c) => n + c.out, 0) + (hopChildren.get(slug) ?? []).reduce((n, c) => n + (hopOutputs.get(c) ?? 0), 0)
    const inTok = turns * (3000 + promptTokens(h.role) + 300 * turns) + kidOut
    hopOutputs.set(slug, out)
    const id = hopIds.get(slug)
    const calls = [...h.children.map(() => ['Agent', false]), ...(hopChildren.get(slug) ?? []).map(() => ['Agent', false])]
    finalAgents.push({ id, role: h.role, parentId: h.parentSlug === root.slug ? rootId : hopIds.get(h.parentSlug), tier, inTok, out, turns, start: s, end: e, state: 'done', calls: calls.length, calls_: calls })
    assignments.push({ agentId: id, roleId: h.role.id, tier, model: tier, effort, source: 'role', at: startedAt + s })
  }
  // root
  const rootSelf = steps.filter((s) => !s.worker && s.doer.reportsTo === null)
  let rootTurns = 4 + steps.length
  let rootOut = Math.round(rootTurns * OUT_PER_TURN.lead * EFFORT_OUT[effortOf(root)])
  for (const s of rootSelf) for (const a of s.attempts) {
    rootTurns += a.turns
    rootOut += a.out
  }
  const directKids = finalAgents.filter((a) => a.parentId === rootId)
  const rootIn = rootTurns * (3000 + promptTokens(root) + 300 * rootTurns) + directKids.reduce((n, a) => n + a.out, 0)
  let runEnd = PLAN_MS
  for (const a of finalAgents) runEnd = Math.max(runEnd, a.end)
  for (const s of rootSelf) runEnd = Math.max(runEnd, s.start + s.duration)
  runEnd += 15_000
  finalAgents.push({ id: rootId, role: root, parentId: null, tier: tierOf(root), inTok: rootIn, out: rootOut, turns: rootTurns, start: 0, end: runEnd, state: 'done', calls_: [['TodoWrite', false], ...directKids.map(() => ['Agent', false])] })

  // materialize agents and transcript in start order
  finalAgents.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))
  let costUsd = 0
  let inSum = 0
  let outSum = 0
  let turnSum = 0
  for (const a of finalAgents) {
    const rec = mkAgent(a)
    costUsd += rec.costUsd
    inSum += a.inTok
    outSum += a.out
    turnSum += a.turns
    let tt = startedAt + a.start
    for (const [name, err] of a.calls_ ?? []) tool(a.id, (tt += 10), name, err)
  }
  const status = failedSteps > 0 ? 'error' : 'finished'
  const r6 = (n) => Math.round(n * 1e6) / 1e6
  const record = {
    summary: {
      id: runId,
      projectId: project.id,
      kind: 'work',
      prompt: `bench task ${task.id}`,
      status,
      startedAt,
      endedAt: startedAt + runEnd,
      totalCostUsd: r6(costUsd),
      usage: { tokens: { input: inSum, output: outSum, cacheRead: 0, cacheWrite: 0 }, costUsd: r6(costUsd), costSource: 'provider', models: [], roles: [], wallMs: runEnd, turns: turnSum, toolCalls: transcript.length / 2, retries, agents: finalAgents.length, agentsWithoutResult: 0, noResultTokens: 0, nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, updatedAt: startedAt + runEnd }
    },
    agents,
    transcript,
    logs: [],
    plan: { goal: task.id, steps: steps.map((s) => ({ id: s.id, title: `${s.role} ${s.kind}`, status: 'done', owner: s.role, ...(s.after?.length ? { after: s.after } : {}), ...(s.paths?.length ? { paths: s.paths } : {}) })), status: 'done', autoContinues: 0, updatedAt: startedAt + runEnd },
    staffing: { goal: 'balanced', assignments }
  }
  return {
    record,
    sim: { task: task.id, costUsd: r6(costUsd), wallMs: runEnd, stepFailures: failedSteps, retries, conflicts: redo.length, agents: finalAgents.length }
  }
}
