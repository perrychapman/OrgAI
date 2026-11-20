// Pure, deterministic scorer for the org chart benchmark (docs/design/org-chart-benchmark.md). No I/O, no model, no clock.
// Input is plain JSON (a session from results.json plus its scenario), so a saved results file can be re-scored with a
// newer scorer without spending a token.
//
// Two families:
//   recommend  scoreChart(session, scenario)     the Architect's first org chart for a project
//   retro      scoreRevision(session, scenario)  the Architect's revision of a set-up chart after a run record
// Both return { total (0-100), dimensions: [{ id, weight, score (0-1), checks: [{ id, pass, credit, detail, na? }] }], metrics }.
// A check has a stable id so failures can be counted across scenarios; `credit` (0-1) allows partial credit, `na` marks a
// check that does not apply to the scenario (it is left out of the dimension's mean and of the failure counts).
//
// Bump SCORER_VERSION whenever a check, a weight or a threshold changes: compared runs must share it.
// v2: structure and sizing read the normalized roles (what propose_org_chart accepted); new check recommend/references-resolve.
export const SCORER_VERSION = 2

export const TIERS = ['top', 'deep', 'everyday', 'fast']
/** Cost proxy weight per tier (unscored; a rough ratio, not a price). `inherit` and an unknown tier count as everyday. */
export const TIER_WEIGHT = { top: 5, deep: 3, everyday: 1, fast: 0.3 }
const TIER_RANK = { fast: 0, everyday: 1, deep: 2, top: 3 }
// MIRRORS TOOL_CATALOG in src/shared/types.ts; the runner's --self-check compares the two.
export const ALL_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit', 'SendMessage', 'ListAgents']
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const MESSAGE_TOOLS = ['SendMessage', 'ListAgents']

export const RECOMMEND_WEIGHTS = { validity: 15, structure: 15, 'right-sizing': 20, coverage: 15, 'least-privilege': 10, tiering: 10, 'prompt-quality': 15 }
export const REVISION_WEIGHTS = { fix: 35, minimality: 25, stability: 20, spend: 10, validity: 10 }

// ---------------------------------------------------------------- small helpers

const norm = (s) => String(s ?? '').trim().toLowerCase()
const clamp01 = (n) => Math.min(1, Math.max(0, n))
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d
const arr = (v) => (Array.isArray(v) ? v : [])
const strs = (v) => arr(v).filter((x) => typeof x === 'string')
const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length
const asRe = (r) => (r instanceof RegExp ? new RegExp(r.source, r.flags.replace(/[gy]/g, '')) : new RegExp(String(r), 'i'))
const anyMatch = (patterns, text) => arr(patterns).some((p) => asRe(p).test(text))
const share = (bad, total) => (total === 0 ? 1 : clamp01(1 - bad / total))
const list = (xs, max = 6) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '))
const slugOf = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function check(id, credit, detail, w = 1) {
  const c = clamp01(credit)
  return w === 1 ? { id, pass: c >= 1, credit: round(c, 3), detail } : { id, pass: c >= 1, credit: round(c, 3), detail, w }
}
const na = (id, detail) => ({ id, pass: true, credit: 1, detail, na: true })

/** Mean of the checks' credit, each weighted by its optional `w` (default 1). */
function dimension(id, weight, checks) {
  const live = checks.filter((c) => !c.na)
  const wsum = live.reduce((n, c) => n + (c.w ?? 1), 0)
  const score = wsum === 0 ? 1 : live.reduce((n, c) => n + c.credit * (c.w ?? 1), 0) / wsum
  return { id, weight, score: round(score, 3), checks }
}

function finish(dimensions, metrics, extra = {}) {
  const total = round(dimensions.reduce((n, d) => n + d.weight * d.score, 0), 1)
  return { total, dimensions, metrics, ...extra }
}

/** A session that produced nothing scorable: every dimension 0, one failed check naming why. */
function nothing(weights, validityId, detail, metrics) {
  const dimensions = Object.entries(weights).map(([id, weight]) => ({ id, weight, score: 0, checks: id === 'validity' ? [{ id: validityId, pass: false, credit: 0, detail }] : [] }))
  return { total: 0, dimensions, metrics, noResult: true }
}

// ---------------------------------------------------------------- recommend family

const roleText = (d) => [d.name, d.description, ...strs(d.responsibilities), d.prompt].filter(Boolean).join('\n')
const toolsOf = (d) => strs(d.tools)
const hasWrite = (d) => toolsOf(d).some((t) => WRITE_TOOLS.includes(t))
const READONLY_NAME = /(review|research|advis|audit|critic|inspect|assess)/i
const REVIEWER_NAME = /(review|audit|\bqa\b|quality|verif|critic|inspect)/i
const DELEGATE_ALL = /(delegate (everything|all (of )?(the |your )?(work|tasks?|implementation))|never (do|write|implement|code)[^.]{0,40}(yourself|your own)|do not (do|write|implement|code)[^.]{0,40}yourself|always delegate|only delegate|just delegate|(don't|do not) do (any|the) (work|implementation|coding) yourself)/i
const STAY_IN_BRIEF = /\b(stay|remain|keep|limit|restrict|confine)\w*\b[^.]{0,80}\b(brief|assigned|files|scope)|\bonly (edit|change|touch|modify|write)\b[^.]{0,60}\b(brief|assigned|files)/i
const REPORT_FILES = /report[^.]{0,80}\b(files?|touched|changed|modified|edited)\b|list (of )?(the )?files/i

/** The tier a draft asks for: a tier name, 'inherit', 'other' (a concrete model id) or, when omitted, the normalized tier. */
export function effectiveTier(draft, normalizedByName) {
  const m = norm(draft?.model)
  if (TIERS.includes(m)) return m
  if (m === 'inherit') return 'inherit'
  if (m) return 'other'
  const n = normalizedByName?.get(norm(draft?.name))
  return TIERS.includes(n?.tier) ? n.tier : 'everyday'
}

export const tierWeight = (t) => TIER_WEIGHT[t] ?? 1

/**
 * The wiring to judge. propose_org_chart resolves reportsTo / spawnable by role NAME only (toRoles in src/main/ai/draft.ts),
 * drops what does not resolve and re-roots orphans, so the chart the user is shown is the normalized one (session.chart.roles,
 * reportsTo / spawnable as slugs). When those views line up with the drafts (same order, same count) the topology comes from
 * them; otherwise (a hand-made session without views) it comes from the drafts. A node: { d: draft, key, mgr, spawn }.
 */
export function wiringNodes(session) {
  const drafts = arr(session?.chart?.drafts)
  const views = arr(session?.chart?.roles)
  if (views.length > 0 && views.length === drafts.length) {
    return { normalized: true, nodes: drafts.map((d, i) => ({ d, key: norm(views[i].slug), mgr: norm(views[i].reportsTo), spawn: strs(views[i].spawnable) })) }
  }
  return { normalized: false, nodes: drafts.map((d) => ({ d, key: norm(d.name), mgr: norm(d.reportsTo), spawn: strs(d.spawnable) })) }
}

function chartShape(nodes) {
  const names = new Set(nodes.map((n) => n.key))
  const roots = nodes.filter((n) => n.mgr === '')
  const children = new Map()
  for (const n of nodes) if (n.mgr !== '') children.set(n.mgr, [...(children.get(n.mgr) ?? []), n])
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const depthOf = (node) => {
    let n = 0
    const seen = new Set()
    let cur = node
    while (cur && cur.mgr !== '') {
      if (seen.has(cur.key)) return null
      seen.add(cur.key)
      cur = byKey.get(cur.mgr)
      if (!cur) return null
      n++
    }
    return n
  }
  const depths = nodes.map(depthOf)
  const depth = Math.max(0, ...depths.filter((x) => x !== null))
  return { names, roots, children, byKey, depthOf, depth }
}

export function recommendMetrics(session) {
  const drafts = arr(session?.chart?.drafts)
  const normalized = new Map(arr(session?.chart?.roles).map((r) => [norm(r.name), r]))
  const shape = chartShape(wiringNodes(session).nodes)
  const tierMix = { top: 0, deep: 0, everyday: 0, fast: 0, inherit: 0, other: 0 }
  let cost = 0
  const toolCounts = {}
  let promptWords = 0
  for (const d of drafts) {
    const t = effectiveTier(d, normalized)
    tierMix[t] += 1
    cost += tierWeight(t)
    for (const tool of new Set(toolsOf(d))) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1
    promptWords += words(d.prompt)
  }
  return {
    roles: drafts.length,
    depth: shape.depth,
    tierMix,
    costProxy: round(cost, 2),
    toolCounts,
    promptWords,
    reviseRounds: session?.reviseRounds ?? 0,
    askUserCalls: session?.askUserCalls ?? 0,
    questionTurns: session?.questionTurns ?? 0
  }
}

export function scoreChart(session, scenario) {
  const e = scenario.expect ?? {}
  const drafts = arr(session?.chart?.drafts)
  const metrics = recommendMetrics(session)
  if (!session?.chart || drafts.length === 0) return nothing(RECOMMEND_WEIGHTS, 'chart-produced', session?.status === 'error' ? 'the session failed before a chart' : 'no org chart was proposed (noChart)', metrics)
  const W = RECOMMEND_WEIGHTS
  const normalized = new Map(arr(session.chart.roles).map((r) => [norm(r.name), r]))
  const wiring = wiringNodes(session)
  const nodes = wiring.nodes
  const shape = chartShape(nodes)
  const { names, children } = shape
  const rootNode = shape.roots[0] ?? nodes[0]
  const n = drafts.length

  // 1. validity
  const rounds = (session.reviseRounds ?? 0) + (session.toolErrors ?? 0)
  const validity = dimension('validity', W.validity, [
    check('chart-produced', 1, 'an org chart was proposed and validated'),
    check('revise-rounds', 1 - 0.25 * rounds, rounds === 0 ? 'first proposal was accepted' : `${rounds} REVISE round(s) or tool error(s) before the chart was accepted`)
  ])

  // 2. structure. one-root, unique-names, manager-can-spawn and leaf-no-spawn read the drafts (what the model wrote);
  // the reference and topology checks read the normalized wiring (what the tool accepted; see wiringNodes), and
  // references-resolve keeps the references the tool silently dropped visible (it resolves by role name only).
  const dupNames = drafts.map((d) => norm(d.name)).filter((k, i, a) => a.indexOf(k) !== i)
  const draftRoots = drafts.filter((d) => norm(d.reportsTo) === '')
  const badMgr = nodes.filter((x) => x.mgr !== '' && !names.has(x.mgr))
  const badSpawn = nodes.flatMap((x) => x.spawn.filter((s) => !names.has(norm(s))).map((s) => `${x.d.name}->${s}`))
  const kids = (x) => children.get(x.key) ?? []
  const managers = nodes.filter((x) => kids(x).length > 0)
  const uncovered = managers.filter((m) => kids(m).some((c) => !m.spawn.some((s) => norm(s) === c.key)))
  const noSpawnFlag = managers.filter((m) => m.d.canSpawn !== true)
  const leaves = nodes.filter((x) => kids(x).length === 0)
  const leafBad = leaves.filter((l) => l.d.canSpawn === true || strs(l.d.spawnable).length > 0)
  const unreachable = nodes.filter((x) => shape.depthOf(x) === null)
  const draftNames = new Set(drafts.map((d) => norm(d.name)))
  const refsTotal = drafts.reduce((c, d) => c + (norm(d.reportsTo) ? 1 : 0) + strs(d.spawnable).length, 0)
  const dropped = drafts.flatMap((d) => [
    ...(norm(d.reportsTo) && !draftNames.has(norm(d.reportsTo)) ? [`${d.name} reportsTo ${d.reportsTo}`] : []),
    ...strs(d.spawnable).filter((s) => !draftNames.has(norm(s))).map((s) => `${d.name} spawnable ${s}`)
  ])
  const structure = dimension('structure', W.structure, [
    check('one-root', draftRoots.length === 1 ? 1 : 0, `${draftRoots.length} role(s) have no manager${draftRoots.length === 1 ? '' : ' (expected exactly one)'}`),
    check('unique-names', dupNames.length === 0 ? 1 : 0, dupNames.length ? `duplicate names: ${list(dupNames)}` : 'names are unique'),
    check('reportsTo-exists', share(badMgr.length, n), badMgr.length ? `unknown manager: ${list(badMgr.map((x) => `${x.d.name}->${x.mgr}`))}` : 'every manager exists'),
    check('spawnable-exist', share(badSpawn.length, Math.max(1, nodes.reduce((c, x) => c + x.spawn.length, 0))), badSpawn.length ? `unknown spawn targets: ${list(badSpawn)}` : 'every spawn target exists'),
    managers.length ? check('spawnable-covers-reports', share(uncovered.length, managers.length), uncovered.length ? `spawnable misses direct reports: ${list(uncovered.map((m) => m.d.name))}` : 'every manager can spawn its direct reports') : na('spawnable-covers-reports', 'no managers'),
    managers.length ? check('manager-can-spawn', share(noSpawnFlag.length, managers.length), noSpawnFlag.length ? `canSpawn false on managers: ${list(noSpawnFlag.map((m) => m.d.name))}` : 'every manager has canSpawn') : na('manager-can-spawn', 'no managers'),
    check('leaf-no-spawn', share(leafBad.length, leaves.length), leafBad.length ? `leaves that can spawn: ${list(leafBad.map((l) => l.d.name))}` : 'leaves cannot spawn'),
    check('no-cycles', share(unreachable.length, n), unreachable.length ? `roles that do not reach the root (loop or missing manager): ${list(unreachable.map((x) => x.d.name))}` : 'every role reaches the root'),
    wiring.normalized
      ? check('references-resolve', share(dropped.length, Math.max(1, refsTotal)), dropped.length ? `the tool resolves references by role name only and dropped: ${list(dropped)}` : 'every reportsTo and spawnable reference names a role', 0.5)
      : na('references-resolve', 'no normalized roles recorded; the checks above read the drafts')
  ])

  // 3. right-sizing
  const { min, max } = e.roles ?? { min: 1, max: 99 }
  const dist = n < min ? min - n : n > max ? n - max : 0
  const mid = Math.max(2, Math.ceil((min + max) / 2))
  const maxDepth = e.maxDepth ?? 99
  const hasMiddle = nodes.some((x) => x.mgr !== '' && kids(x).length > 0)
  const rightSizing = dimension('right-sizing', W['right-sizing'], [
    check('role-count', dist === 0 ? 1 : 1 - dist / mid, dist === 0 ? `${n} roles (expected ${min}-${max})` : `${n} roles, expected ${min}-${max}`),
    check('depth', shape.depth <= maxDepth ? 1 : 1 - 0.5 * (shape.depth - maxDepth), `${shape.depth} level(s) below the root (at most ${maxDepth})`),
    e.middleLayer ? check('middle-layer', hasMiddle ? 1 : 0, hasMiddle ? 'a lead with its own reports exists' : 'the scenario needs a middle layer (a lead under the root with its own reports)') : na('middle-layer', 'not expected')
  ])

  // 4. coverage
  const textOf = drafts.map(roleText)
  const coverChecks = arr(e.cover).map((g) => {
    const hit = drafts.findIndex((_, i) => anyMatch(g.patterns, textOf[i]))
    return check(`cover:${g.name}`, hit >= 0 ? 1 : 0, hit >= 0 ? `covered by ${drafts[hit].name}` : `no role matches ${g.name}`)
  })
  const forbidChecks = arr(e.forbid).map((g) => {
    const hit = drafts.filter((d) => anyMatch(g.patterns, d.name ?? ''))
    return check(`forbid:${g.name}`, hit.length ? 0 : 1, hit.length ? `unwanted role(s): ${list(hit.map((d) => d.name))}` : 'none present')
  })
  const coverage = dimension('coverage', W.coverage, [...coverChecks, ...forbidChecks])

  // 5. least privilege
  const readOnly = drafts.filter((d) => READONLY_NAME.test(d.name ?? ''))
  const readOnlyBad = readOnly.filter(hasWrite)
  const msgHolders = drafts.filter((d) => toolsOf(d).some((t) => MESSAGE_TOOLS.includes(t)))
  const want = e.wantsMessaging ?? 'any'
  const msgOk = want === 'none' ? msgHolders.length === 0 : want === 'some' ? msgHolders.length >= 1 && msgHolders.length < n : true
  const everything = drafts.filter((d) => ALL_TOOLS.every((t) => toolsOf(d).includes(t)))
  const leastPrivilege = dimension('least-privilege', W['least-privilege'], [
    readOnly.length ? check('readonly-no-write', share(readOnlyBad.length, readOnly.length), readOnlyBad.length ? `read-only roles with Edit/Write/NotebookEdit: ${list(readOnlyBad.map((d) => d.name))}` : `${readOnly.length} reviewer/researcher/advisor role(s) are read-only`) : na('readonly-no-write', 'no reviewer, researcher or advisor role'),
    want === 'any' ? na('messaging-matches', 'any messaging use is fine here') : check('messaging-matches', msgOk ? 1 : 0, `${msgHolders.length} of ${n} roles hold SendMessage/ListAgents; the scenario wants ${want === 'none' ? 'none' : 'some, but not all'}`),
    check('no-role-has-every-tool', everything.length ? 0 : 1, everything.length ? `holds every tool: ${list(everything.map((d) => d.name))}` : 'no role holds every tool')
  ])

  // 6. tiering
  const tier = (d) => effectiveTier(d, normalized)
  const root = rootNode?.d
  const rootTier = tier(root)
  const rootCredit = rootTier === 'deep' ? 1 : rootTier === 'top' ? (e.allowTop ? 1 : 0) : rootTier === 'inherit' ? 0.5 : 0
  const topRoles = drafts.filter((d) => tier(d) === 'top')
  const nonRoot = drafts.filter((d) => d !== root)
  const deepShare = nonRoot.length ? nonRoot.filter((d) => ['deep', 'top'].includes(tier(d))).length / nonRoot.length : 0
  const maxShare = e.maxDeepShare ?? 1
  const vendor = drafts.filter((d) => tier(d) === 'other')
  const tiering = dimension('tiering', W.tiering, [
    check('root-deep', rootCredit, `root ${root?.name ?? '?'} runs on ${rootTier}${rootTier === 'top' && !e.allowTop ? ' (top is not warranted here)' : ''}`),
    e.allowTop ? na('no-top', 'top is allowed') : check('no-top', topRoles.length ? 0 : 1, topRoles.length ? `top tier on ${list(topRoles.map((d) => d.name))}` : 'no top tier'),
    nonRoot.length ? check('deep-share', deepShare <= maxShare ? 1 : 1 - (deepShare - maxShare) / Math.max(0.1, 1 - maxShare), `${Math.round(deepShare * 100)}% of non-root roles are deep or top (at most ${Math.round(maxShare * 100)}%)`) : na('deep-share', 'a one-role chart'),
    check('no-vendor-model-ids', vendor.length ? 0 : 1, vendor.length ? `concrete model ids on ${list(vendor.map((d) => `${d.name} (${d.model})`))}` : 'tiers only'),
    e.wantsReviewer ? check('reviewer-present', drafts.some((d) => d !== root && REVIEWER_NAME.test(d.name ?? '')) ? 1 : 0, 'the scenario wants a reviewer role') : na('reviewer-present', 'not required')
  ])

  // 7. prompt quality
  const wordsOf = drafts.map((d) => words(d.prompt))
  const badLen = drafts.filter((_, i) => wordsOf[i] < 60 || wordsOf[i] > 160)
  const noYou = drafts.filter((d) => !/\byou(r|'re|'ll|'ve)?\b/i.test(d.prompt ?? ''))
  const docRe = scenario.kind === 'engagement' ? /(engagement (document|charter)|\bcharter\b|ENGAGEMENT\.md)/i : /(architecture|ARCHITECTURE\.md)/i
  const noDoc = drafts.filter((d) => !docRe.test(d.prompt ?? ''))
  const writers = drafts.filter((d) => d !== root && hasWrite(d))
  const noStay = writers.filter((d) => !STAY_IN_BRIEF.test(d.prompt ?? ''))
  const noReport = writers.filter((d) => !REPORT_FILES.test(d.prompt ?? ''))
  const rootHasReports = (children.get(rootNode?.key) ?? []).length > 0
  const delegateAll = rootHasReports && scenario.kind !== 'engagement' ? DELEGATE_ALL.test(root.prompt ?? '') : false
  const promptQuality = dimension('prompt-quality', W['prompt-quality'], [
    check('prompt-length', share(badLen.length, n), badLen.length ? `outside 60-160 words: ${list(badLen.map((d) => `${d.name} (${words(d.prompt)})`))}` : 'every prompt is 60-160 words'),
    check('prompt-second-person', share(noYou.length, n), noYou.length ? `not in the second person: ${list(noYou.map((d) => d.name))}` : 'second person throughout'),
    check('prompt-refs-document', share(noDoc.length, n), noDoc.length ? `no reference to the ${scenario.kind === 'engagement' ? 'engagement document' : 'architecture document'}: ${list(noDoc.map((d) => d.name))}` : 'every prompt points at the agreed document'),
    writers.length ? check('writers-stay-in-brief', share(noStay.length, writers.length), noStay.length ? `writers not told to stay within their brief's files: ${list(noStay.map((d) => d.name))}` : 'writers stay within their brief') : na('writers-stay-in-brief', 'no writing reports'),
    writers.length ? check('writers-report-files', share(noReport.length, writers.length), noReport.length ? `writers not told to report the files they touched: ${list(noReport.map((d) => d.name))}` : 'writers report files touched') : na('writers-report-files', 'no writing reports'),
    rootHasReports && scenario.kind !== 'engagement' ? check('root-no-delegate-all', delegateAll ? 0 : 1, delegateAll ? "the root's prompt tells it to delegate everything" : 'the root keeps contained work for itself') : na('root-no-delegate-all', rootHasReports ? 'engagement leads plan and gate by design' : 'the root has no reports')
  ])

  return finish([validity, structure, rightSizing, coverage, leastPrivilege, tiering, promptQuality], metrics)
}

// ---------------------------------------------------------------- retro family

/** A role as the benchmark stores it: plain, comparable, structured-clone safe. `byId` resolves reportsTo / spawnable ids to slugs. */
export function roleView(role, byId) {
  const slugOfId = (id) => byId.get(id)?.slug ?? String(id)
  return {
    slug: role.slug,
    name: role.name,
    tier: role.tier ?? 'inherit',
    model: role.model,
    tools: [...strs(role.tools)],
    description: role.description ?? '',
    responsibilities: [...strs(role.responsibilities)],
    prompt: role.prompt ?? '',
    canSpawn: !!role.canSpawn,
    spawnable: strs(role.spawnable).map(slugOfId),
    reportsTo: role.reportsTo ? slugOfId(role.reportsTo) : null
  }
}

export function viewsOf(roles) {
  const byId = new Map(arr(roles).map((r) => [r.id, r]))
  return arr(roles).map((r) => roleView(r, byId))
}

const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
const rank = (t) => TIER_RANK[t] ?? 1

/** Fields of a kept role that differ after the revision. Spawn-list entries for added or removed roles are the revision's own wiring, not a change. */
function changedFields(b, a, addedSlugs, removedSlugs) {
  const out = []
  if (norm(b.name) !== norm(a.name)) out.push('name')
  if (!setEq(b.tools, a.tools)) out.push('tools')
  if (b.tier !== a.tier || (b.tier === 'inherit' && b.model !== a.model)) out.push('tier')
  if (b.prompt.trim() !== a.prompt.trim()) out.push('prompt')
  if (b.description.trim() !== a.description.trim()) out.push('description')
  if (JSON.stringify(b.responsibilities) !== JSON.stringify(a.responsibilities)) out.push('responsibilities')
  if (b.canSpawn !== a.canSpawn && !(a.spawnable.some((s) => addedSlugs.has(s)))) out.push('canSpawn')
  const strip = (v, drop) => v.filter((s) => !drop.has(s))
  if (!setEq(strip(b.spawnable, removedSlugs), strip(a.spawnable, addedSlugs))) out.push('spawnable')
  const bm = b.reportsTo && removedSlugs.has(b.reportsTo) ? null : b.reportsTo
  if (bm !== null && bm !== a.reportsTo) out.push('reportsTo')
  return out
}

/** What a revision did: added roles, removed roles, and kept roles with the fields that changed. */
export function diffCharts(before, after) {
  const B = new Map(arr(before).map((r) => [r.slug, r]))
  const A = new Map(arr(after).map((r) => [r.slug, r]))
  const added = arr(after).filter((r) => !B.has(r.slug))
  const removed = arr(before).filter((r) => !A.has(r.slug))
  const addedSlugs = new Set(added.map((r) => r.slug))
  const removedSlugs = new Set(removed.map((r) => r.slug))
  const changed = []
  for (const [slug, b] of B) {
    const a = A.get(slug)
    if (!a) continue
    const fields = changedFields(b, a, addedSlugs, removedSlugs)
    if (fields.length) changed.push({ slug, fields, before: b, after: a })
  }
  return { added, removed, changed }
}

export function costProxyOfViews(views) {
  return round(arr(views).reduce((n, r) => n + tierWeight(r.tier), 0), 2)
}

export function revisionMetrics(session) {
  const rev = session?.revision
  const before = arr(rev?.before)
  const after = rev?.after ? arr(rev.after) : before
  const diff = diffCharts(before, after)
  return {
    ending: rev?.ending ?? null,
    listed: rev?.listed ?? 0,
    rolesBefore: before.length,
    rolesAfter: after.length,
    changed: diff.changed.map((c) => `${c.slug}[${c.fields.join('+')}]`),
    added: diff.added.map((r) => r.slug),
    removed: diff.removed.map((r) => r.slug),
    costProxyBefore: costProxyOfViews(before),
    costProxyAfter: costProxyOfViews(after),
    reviseRounds: session?.reviseRounds ?? 0,
    turns: session?.turns ?? null,
    costUsd: session?.costUsd ?? null,
    durationMs: session?.durationMs ?? null
  }
}

function fixCheck(item, diff) {
  if (item.newRole) {
    const id = `fix:new-role:${slugOf(item.newRole)}`
    const cover = (r) => anyMatch(item.cover, [r.name, r.description, ...r.responsibilities, r.prompt].join('\n'))
    const hit = diff.added.find(cover)
    if (hit) return check(id, 1, `new role ${hit.name} covers ${item.newRole}`)
    const extended = diff.changed.find((c) => cover(c.after) && !cover(c.before))
    if (extended) return check(id, 0.7, `no new role, but ${extended.slug} was extended to cover ${item.newRole}`)
    if (diff.added.length) return check(id, 0.3, `${list(diff.added.map((r) => r.name))} added, but none covers ${item.newRole}`)
    return check(id, 0, `nothing covers ${item.newRole}`)
  }
  const id = `fix:${item.slug}`
  const c = diff.changed.find((x) => x.slug === item.slug)
  if (!c) return check(id, 0, `${item.slug} was not changed`)
  const conds = []
  // `fields` alone says "something of this kind changed"; when the item names what the change must be, only that counts.
  const specific = !!(item.toolsAdded?.length || item.promptMatches?.length || item.promptNotMatches?.length || item.tierChange)
  if (item.fields?.length && !specific) conds.push([item.fields.some((f) => c.fields.includes(f)), `changed ${list(c.fields)} (wanted ${list(item.fields)})`])
  if (item.toolsAdded?.length) conds.push([item.toolsAdded.every((t) => c.after.tools.includes(t) && !c.before.tools.includes(t)), `tools now ${list(c.after.tools)} (wanted ${list(item.toolsAdded)} added)`])
  if (item.promptMatches?.length) conds.push([item.promptMatches.some((p) => asRe(p).test(c.after.prompt)), 'the prompt now carries the wanted instruction'])
  if (item.promptNotMatches?.length) conds.push([!item.promptNotMatches.some((p) => asRe(p).test(c.after.prompt)), 'the misleading wording is gone from the prompt'])
  if (item.tierChange === 'down') conds.push([rank(c.after.tier) < rank(c.before.tier), `tier ${c.before.tier} -> ${c.after.tier} (wanted lower)`])
  if (item.tierChange === 'up') conds.push([rank(c.after.tier) > rank(c.before.tier), `tier ${c.before.tier} -> ${c.after.tier} (wanted higher)`])
  if (!conds.length) return check(id, 1, `${item.slug} changed (${list(c.fields)})`)
  const ok = conds.filter((x) => x[0]).length
  const bad = conds.filter((x) => !x[0]).map((x) => x[1])
  return check(id, 0.4 + 0.6 * (ok / conds.length), ok === conds.length ? `${item.slug}: ${conds.map((x) => x[1]).join('; ')}` : `${item.slug} changed but not as needed: ${bad.join('; ')}`)
}

export function scoreRevision(session, scenario) {
  const e = scenario.expect ?? {}
  const W = REVISION_WEIGHTS
  const rev = session?.revision
  const metrics = revisionMetrics(session)
  if (!rev || !rev.ending) return nothing(W, 'revision-ended', session?.status === 'error' ? 'the session failed before a proposal or complete_setup' : 'the session ended with neither propose_org_chart nor complete_setup', metrics)
  const before = arr(rev.before)
  const after = rev.after ? arr(rev.after) : before
  const diff = diffCharts(before, after)
  const noChange = diff.added.length + diff.removed.length + diff.changed.length === 0
  const mustChange = arr(e.mustChange)
  const mustChangeSlugs = mustChange.map((m) => m.slug).filter(Boolean)
  const allowed = new Set([...mustChangeSlugs, ...strs(e.mayChange)])
  const listed = rev.listed ?? 0
  const maxListed = e.maxRolesListed ?? 99

  const rounds = (session.reviseRounds ?? 0) + (session.toolErrors ?? 0)
  const validity = dimension('validity', W.validity, [
    check('revision-ended', 1, rev.ending === 'propose' ? 'a revised chart was proposed and validated' : 'the session ended with complete_setup and no chart change'),
    check('revise-rounds', 1 - 0.25 * rounds, rounds === 0 ? 'accepted at once' : `${rounds} REVISE round(s) or tool error(s)`)
  ])

  const fixChecks = mustChange.map((m) => fixCheck(m, diff))
  if (e.expectNoChange) fixChecks.push(check('no-change', noChange ? 1 : 0, noChange ? 'the chart was left as it was' : `the chart changed: ${list([...diff.changed.map((c) => c.slug), ...diff.added.map((r) => `+${r.slug}`), ...diff.removed.map((r) => `-${r.slug}`)])}`))
  const fix = dimension('fix', W.fix, fixChecks.length ? fixChecks : [na('fix:none', 'no defect to fix in this scenario')])

  const collateral = diff.changed.filter((c) => !allowed.has(c.slug))
  const touched = (slug) => diff.changed.some((c) => c.slug === slug) || diff.removed.some((r) => r.slug === slug)
  const mustNot = strs(e.mustNotChange)
  const touchedMustNot = mustNot.filter(touched)
  const expectedNew = mustChange.filter((m) => m.newRole).length
  const extraAdded = Math.max(0, diff.added.length - expectedNew)
  const minimality = dimension('minimality', W.minimality, [
    check('listed-cap', listed <= maxListed ? 1 : 1 - (listed - maxListed) / Math.max(2, maxListed + 1), `${listed} role(s) listed in propose_org_chart (at most ${maxListed})`),
    diff.changed.length ? check('no-collateral', share(collateral.length, diff.changed.length), collateral.length ? `unrelated roles changed: ${list(collateral.map((c) => `${c.slug}[${c.fields.join('+')}]`))}` : 'only the expected roles changed') : na('no-collateral', 'no kept role changed'),
    mustNot.length ? check('must-not-change', share(touchedMustNot.length, mustNot.length), touchedMustNot.length ? `protected roles touched: ${list(touchedMustNot)}` : 'protected roles untouched') : na('must-not-change', 'none listed'),
    check('no-extra-roles', 1 - extraAdded / 2, extraAdded ? `${extraAdded} more new role(s) than the defect needs: ${list(diff.added.map((r) => r.slug))}` : 'no unneeded new roles')
  ])

  const mustNotRemove = strs(e.mustNotRemove)
  const removedSlugs = diff.removed.map((r) => r.slug)
  const keptBad = mustNotRemove.filter((s) => removedSlugs.includes(s))
  const allowRemove = strs(e.allowRemove)
  const provoked = removedSlugs.filter((s) => !allowRemove.includes(s))
  const rootBefore = before.find((r) => r.reportsTo === null)
  const rootsAfter = after.filter((r) => r.reportsTo === null)
  const stability = dimension('stability', W.stability, [
    mustNotRemove.length ? check('unused-not-removed', share(keptBad.length, mustNotRemove.length), keptBad.length ? `removed roles that were only unused in this run: ${list(keptBad)}` : 'unused roles were kept') : na('unused-not-removed', 'no unused roles in this run'),
    check('no-unprovoked-removal', 1 - provoked.length / 2, provoked.length ? `removed without evidence: ${list(provoked)}` : 'nothing removed without evidence'),
    check('root-intact', rootsAfter.length === 1 && rootsAfter[0].slug === rootBefore?.slug ? 1 : 0, rootsAfter.length === 1 && rootsAfter[0].slug === rootBefore?.slug ? 'the root is unchanged' : `root is now ${list(rootsAfter.map((r) => r.slug)) || 'missing'}`),
    e.expectNoChange ? check('healthy-untouched', noChange ? 1 : 0, noChange ? 'a healthy chart was left alone' : 'a healthy chart was modified') : na('healthy-untouched', 'the scenario has a defect')
  ])

  const raised = [
    ...diff.changed.filter((c) => rank(c.after.tier) > rank(c.before.tier)).map((c) => `${c.slug} ${c.before.tier}->${c.after.tier}`),
    ...diff.added.filter((r) => rank(r.tier) > 1).map((r) => `${r.slug} added on ${r.tier}`)
  ]
  const spend = dimension('spend', W.spend, [
    e.allowSpendRaise ? na('no-tier-raise', 'a higher tier is allowed here') : check('no-tier-raise', 1 - raised.length / 2, raised.length ? `spend went up: ${list(raised)}` : 'no tier was raised and no deep role was added')
  ])

  return finish([fix, minimality, stability, spend, validity], metrics)
}

// ---------------------------------------------------------------- dispatch, re-scoring, summary, comparison

export function scoreSession(session, scenario) {
  return scenario.family === 'retro' ? scoreRevision(session, scenario) : scoreChart(session, scenario)
}

/** results with every scorable session re-scored against the given scenarios (matched by id). Pure: returns a new object. */
export function rescore(results, scenarios) {
  const byId = new Map(arr(scenarios).map((s) => [s.id, s]))
  const sessions = arr(results?.sessions).map((s) => {
    const scenario = byId.get(s.scenarioId)
    if (!scenario || s.status === 'skipped') return { ...s, score: null }
    return { ...s, score: scoreSession(s, scenario) }
  })
  return { ...results, scorerVersion: SCORER_VERSION, sessions }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

function familyOf(session) {
  return session.family === 'retro' ? 'retro' : 'recommend'
}

/**
 * Aggregates scored sessions: per scenario (mean total and dimensions, shape and cost figures), per family, and the checks
 * that fail most often (what drives tuning). `results.sessions[i].score` must be present (see rescore).
 */
export function summarize(results) {
  const sessions = arr(results?.sessions).filter((s) => s.score)
  const out = { scorerVersion: SCORER_VERSION, families: {}, weakestChecks: [], sessions: arr(results?.sessions).length, scored: sessions.length, skipped: arr(results?.sessions).filter((s) => s.status === 'skipped').length, costUsd: round(arr(results?.sessions).reduce((n, s) => n + (s.costUsd ?? 0), 0), 4) }
  for (const family of ['recommend', 'retro']) {
    const inFamily = sessions.filter((s) => familyOf(s) === family)
    if (!inFamily.length) continue
    const ids = [...new Set(inFamily.map((s) => s.scenarioId))]
    const scenarios = ids.map((id) => {
      const ss = inFamily.filter((s) => s.scenarioId === id)
      const dims = {}
      for (const d of ss[0].score.dimensions) dims[d.id] = round(mean(ss.map((s) => s.score.dimensions.find((x) => x.id === d.id)?.score ?? 0)), 3)
      const m = (key) => mean(ss.map((s) => s.score.metrics?.[key]).filter((v) => typeof v === 'number'))
      const row = {
        id,
        kind: ss[0].kind ?? null,
        complexity: ss[0].complexity ?? null,
        n: ss.length,
        noResult: ss.filter((s) => s.score.noResult).length,
        meanTotal: round(mean(ss.map((s) => s.score.total)), 1),
        minTotal: Math.min(...ss.map((s) => s.score.total)),
        maxTotal: Math.max(...ss.map((s) => s.score.total)),
        dimensions: dims,
        costUsd: round(ss.reduce((n, s) => n + (s.costUsd ?? 0), 0), 4),
        turns: m('turns') ?? mean(ss.map((s) => s.turns).filter((v) => typeof v === 'number')),
        durationMs: mean(ss.map((s) => s.durationMs).filter((v) => typeof v === 'number'))
      }
      if (family === 'recommend') {
        const tierMix = { top: 0, deep: 0, everyday: 0, fast: 0, inherit: 0, other: 0 }
        for (const s of ss) for (const k of Object.keys(tierMix)) tierMix[k] += s.score.metrics?.tierMix?.[k] ?? 0
        Object.assign(row, { roles: m('roles'), depth: m('depth'), tierMix, costProxy: m('costProxy'), reviseRounds: m('reviseRounds'), askUserCalls: m('askUserCalls'), questionTurns: m('questionTurns'), promptWords: m('promptWords') })
      } else {
        Object.assign(row, { listed: m('listed'), rolesBefore: m('rolesBefore'), rolesAfter: m('rolesAfter'), costProxyDelta: round((m('costProxyAfter') ?? 0) - (m('costProxyBefore') ?? 0), 2), changed: ss.map((s) => s.score.metrics?.changed ?? []), added: ss.map((s) => s.score.metrics?.added ?? []), removed: ss.map((s) => s.score.metrics?.removed ?? []), reviseRounds: m('reviseRounds') })
      }
      return row
    })
    const dims = {}
    for (const id of Object.keys(inFamily[0].score.dimensions.reduce((o, d) => ({ ...o, [d.id]: 1 }), {}))) dims[id] = round(mean(scenarios.map((s) => s.dimensions[id] ?? 0)), 3)
    out.families[family] = { meanTotal: round(mean(scenarios.map((s) => s.meanTotal)), 1), dimensions: dims, scenarios }
  }
  // Checks: stable ids counted across every scored session; `na` checks do not count.
  const tally = new Map()
  for (const s of sessions) {
    for (const d of s.score.dimensions) {
      for (const c of d.checks) {
        if (c.na) continue
        const key = `${familyOf(s)}/${c.id}`
        const t = tally.get(key) ?? { family: familyOf(s), id: c.id, dimension: d.id, total: 0, fails: 0, credit: 0, scenarios: new Set(), sample: null }
        t.total += 1
        t.credit += c.credit
        if (!c.pass) {
          t.fails += 1
          t.scenarios.add(s.scenarioId)
          t.sample ??= c.detail
        }
        tally.set(key, t)
      }
    }
  }
  out.weakestChecks = [...tally.values()]
    .filter((t) => t.fails > 0)
    .map((t) => ({ family: t.family, id: t.id, dimension: t.dimension, fails: t.fails, total: t.total, meanCredit: round(t.credit / t.total, 3), scenarios: [...t.scenarios].sort(), sample: t.sample }))
    .sort((a, b) => a.meanCredit - b.meanCredit || b.fails - a.fails || a.id.localeCompare(b.id))
  return out
}

/** Per-scenario and per-dimension deltas (b minus a) between two summaries (summarize output). Pure. */
export function compareSummaries(a, b) {
  const out = { families: {}, checks: [] }
  for (const family of new Set([...Object.keys(a.families ?? {}), ...Object.keys(b.families ?? {})])) {
    const fa = a.families?.[family]
    const fb = b.families?.[family]
    const delta = (x, y) => (typeof x === 'number' && typeof y === 'number' ? round(y - x, 1) : null)
    const ids = [...new Set([...arr(fa?.scenarios).map((s) => s.id), ...arr(fb?.scenarios).map((s) => s.id)])]
    const dimIds = [...new Set([...Object.keys(fa?.dimensions ?? {}), ...Object.keys(fb?.dimensions ?? {})])]
    out.families[family] = {
      a: fa?.meanTotal ?? null,
      b: fb?.meanTotal ?? null,
      delta: delta(fa?.meanTotal, fb?.meanTotal),
      scenarios: ids.map((id) => {
        const sa = arr(fa?.scenarios).find((s) => s.id === id)
        const sb = arr(fb?.scenarios).find((s) => s.id === id)
        const dims = {}
        for (const d of new Set([...Object.keys(sa?.dimensions ?? {}), ...Object.keys(sb?.dimensions ?? {})])) dims[d] = delta((sa?.dimensions?.[d] ?? null) === null ? null : sa.dimensions[d] * 100, (sb?.dimensions?.[d] ?? null) === null ? null : sb.dimensions[d] * 100)
        return { id, a: sa?.meanTotal ?? null, b: sb?.meanTotal ?? null, delta: delta(sa?.meanTotal, sb?.meanTotal), dimensions: dims, costUsdA: sa?.costUsd ?? null, costUsdB: sb?.costUsd ?? null, turnsA: sa?.turns ?? null, turnsB: sb?.turns ?? null }
      }),
      dimensions: dimIds.map((id) => ({ id, a: fa?.dimensions?.[id] ?? null, b: fb?.dimensions?.[id] ?? null, delta: delta(fa?.dimensions?.[id] === undefined ? null : fa.dimensions[id] * 100, fb?.dimensions?.[id] === undefined ? null : fb.dimensions[id] * 100) })),
    }
  }
  const checkKey = (c) => `${c.family}/${c.id}`
  const ca = new Map(arr(a.weakestChecks).map((c) => [checkKey(c), c]))
  const cb = new Map(arr(b.weakestChecks).map((c) => [checkKey(c), c]))
  for (const key of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(key)
    const y = cb.get(key)
    const rateA = x ? x.fails / x.total : 0
    const rateB = y ? y.fails / y.total : 0
    if (rateA !== rateB) out.checks.push({ id: key, failRateA: round(rateA, 2), failRateB: round(rateB, 2), delta: round(rateB - rateA, 2) })
  }
  out.checks.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta) || p.id.localeCompare(q.id))
  return out
}
