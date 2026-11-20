// Tests of the org chart benchmark scorer with hand-written good and bad charts and revisions (node:test, token-free, no
// network, no source import). Run: node --test scripts/lib/org-bench/score.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { badC1, goodC1, goodC4, recommendSession, retroSession, viewsFromDrafts, withTools } from './canned.mjs'
import { renderCompare, renderReport } from './report.mjs'
import { RECOMMEND_SCENARIOS, RETRO_SCENARIOS, SCENARIOS, scenarioById } from './scenarios.mjs'
import { REVISION_WEIGHTS, RECOMMEND_WEIGHTS, SCORER_VERSION, compareSummaries, diffCharts, rescore, scoreChart, scoreRevision, scoreSession, summarize } from './score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sample = JSON.parse(readFileSync(join(here, 'fixtures', 'sample-results.json'), 'utf8'))

const dim = (r, id) => r.dimensions.find((d) => d.id === id)
const chk = (r, id) => r.dimensions.flatMap((d) => d.checks).find((c) => c.id === id)
const failed = (r) => r.dimensions.flatMap((d) => d.checks).filter((c) => !c.pass && !c.na).map((c) => c.id)
const score = (id, drafts, extra) => scoreChart(recommendSession(id, drafts, extra), scenarioById(id))
const reviseScore = (id, edit, extra) => scoreRevision(retroSession(id, edit, extra), scenarioById(id))

const WRITE = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']
const EXAMPLE_PROMPT = 'You are the database specialist. Follow the architecture document. Write and review SQL migrations and schema changes under migrations/ as your brief says, stay within the files named in your brief and report every file you touched. Say how to roll each migration back.'
const newRole = (name, over = {}) => ({ slug: name.toLowerCase().replace(/\s+/g, '-'), name, tier: 'everyday', model: 'sonnet', tools: WRITE, description: `${name} owns it.`, responsibilities: [`${name} work`], prompt: EXAMPLE_PROMPT, canSpawn: false, spawnable: [], reportsTo: 'orchestrator', ...over })
const addRole = (role) => (v) => [...v.map((r) => (r.slug === 'orchestrator' ? { ...r, spawnable: [...r.spawnable, role.slug] } : r)), role]

// ---------------------------------------------------------------- shape and determinism

test('weights sum to 100 in both families', () => {
  assert.equal(Object.values(RECOMMEND_WEIGHTS).reduce((a, b) => a + b, 0), 100)
  assert.equal(Object.values(REVISION_WEIGHTS).reduce((a, b) => a + b, 0), 100)
})

test('a result has total, weighted dimensions with stable check ids, and metrics; it is JSON safe and deterministic', () => {
  const s = recommendSession('c4', goodC4())
  const a = scoreChart(s, scenarioById('c4'))
  const b = scoreChart(JSON.parse(JSON.stringify(s)), scenarioById('c4'))
  assert.deepEqual(a, b)
  assert.deepEqual(a, JSON.parse(JSON.stringify(a)))
  assert.deepEqual(a.dimensions.map((d) => d.id), Object.keys(RECOMMEND_WEIGHTS))
  for (const d of a.dimensions) {
    assert.equal(d.weight, RECOMMEND_WEIGHTS[d.id])
    for (const c of d.checks) assert.ok(typeof c.id === 'string' && typeof c.pass === 'boolean' && typeof c.detail === 'string')
  }
  const total = a.dimensions.reduce((n, d) => n + d.weight * d.score, 0)
  assert.ok(Math.abs(total - a.total) < 0.06)
  assert.equal(scoreSession(s, scenarioById('c4')).total, a.total)
})

// ---------------------------------------------------------------- recommend: good and bad charts

test('a small sensible chart for the trivial scenario scores full marks', () => {
  const r = score('c1', goodC1())
  assert.equal(r.total, 100, failed(r).join(', '))
  assert.equal(r.metrics.roles, 2)
  assert.equal(r.metrics.depth, 1)
  assert.equal(r.metrics.tierMix.deep, 1)
  assert.equal(r.metrics.costProxy, 4)
})

test('a good middle-layer chart scores high on the largest scenario', () => {
  const r = score('c4', goodC4())
  assert.ok(r.total >= 95, `${r.total}: ${failed(r).join(', ')}`)
  assert.equal(chk(r, 'middle-layer').pass, true)
  assert.equal(r.metrics.depth, 2)
})

test('a chart that names a role by slug: the tool drops the reference and wires the role itself, so structure is judged on what it accepted', () => {
  const slugDrafts = goodC1().map((d) => (d.name === 'Developer' ? { ...d, name: 'Backend Implementer' } : d))
  slugDrafts[0] = { ...slugDrafts[0], spawnable: ['backend-implementer'] }
  slugDrafts[1] = { ...slugDrafts[1], reportsTo: 'orchestrator' }
  // What toRoles produced: the unresolved spawnable was dropped, the manager got its direct report added, the orphan was re-rooted.
  const views = [
    { ...viewsFromDrafts(slugDrafts)[0], spawnable: ['backend-implementer'], reportsTo: null, canSpawn: true },
    { ...viewsFromDrafts(slugDrafts)[1], reportsTo: 'orchestrator' }
  ]
  const s = recommendSession('c1', slugDrafts)
  s.chart.roles = views
  const r = scoreChart(s, scenarioById('c1'))
  for (const id of ['reportsTo-exists', 'spawnable-exist', 'spawnable-covers-reports', 'no-cycles', 'one-root']) assert.equal(chk(r, id).pass, true, id)
  assert.equal(dim(r, 'structure').checks.filter((c) => !c.pass).map((c) => c.id).join(), 'references-resolve')
  assert.equal(chk(r, 'references-resolve').credit, 0.5)
  assert.match(chk(r, 'references-resolve').detail, /Orchestrator spawnable backend-implementer/)
  // Weighted lightly: far less than the four failures it used to cause.
  assert.ok(dim(r, 'structure').score > 0.9, String(dim(r, 'structure').score))
})

test('a wiring the tool resolved fully gets references-resolve credit; a view with a truly dangling id still fails the structure checks', () => {
  const ok = score('c1', goodC1())
  assert.equal(chk(ok, 'references-resolve').pass, true)
  const s = recommendSession('c1', goodC1())
  s.chart.roles[1] = { ...s.chart.roles[1], reportsTo: 'ghost-lead' }
  const r = scoreChart(s, scenarioById('c1'))
  assert.ok(failed(r).includes('reportsTo-exists'))
  assert.ok(failed(r).includes('no-cycles'))
})

test('a bloated, over-privileged, badly wired chart fails many named checks', () => {
  const r = score('c1', badC1(), { reviseRounds: 2 })
  assert.ok(r.total < 55, String(r.total))
  for (const id of ['role-count', 'depth', 'reportsTo-exists', 'spawnable-exist', 'readonly-no-write', 'messaging-matches', 'no-role-has-every-tool', 'root-deep', 'no-top', 'no-vendor-model-ids', 'prompt-length', 'root-no-delegate-all', 'revise-rounds']) {
    assert.ok(failed(r).includes(id), `${id} should fail; failed: ${failed(r).join(', ')}`)
  }
  assert.equal(chk(r, 'revise-rounds').credit, 0.5)
})

test('a session that proposed nothing scores 0 on every dimension and names the failed check', () => {
  const r = scoreChart({ family: 'recommend', status: 'noChart', chart: null, questionTurns: 3, askUserCalls: 2 }, scenarioById('c2'))
  assert.equal(r.total, 0)
  assert.equal(r.noResult, true)
  assert.ok(r.dimensions.every((d) => d.score === 0))
  assert.deepEqual(failed(r), ['chart-produced'])
  assert.equal(r.metrics.askUserCalls, 2)
  assert.equal(r.metrics.questionTurns, 3)
})

test('each REVISE round costs a quarter of validity, down to zero', () => {
  assert.equal(dim(score('c1', goodC1(), { reviseRounds: 1 }), 'validity').score, 0.875)
  assert.equal(chk(score('c1', goodC1(), { reviseRounds: 1 }), 'revise-rounds').credit, 0.75)
  assert.equal(chk(score('c1', goodC1(), { reviseRounds: 6 }), 'revise-rounds').credit, 0)
})

// ---------------------------------------------------------------- recommend: structure, sizing, coverage

test('structure: two roots, an unknown manager, a loop and a manager that cannot spawn its report are all caught', () => {
  const base = goodC4()
  const twoRoots = base.map((d) => (d.name === 'QA Engineer' ? { ...d, reportsTo: null } : d))
  assert.equal(chk(score('c4', twoRoots), 'one-root').pass, false)
  const ghost = base.map((d) => (d.name === 'QA Engineer' ? { ...d, reportsTo: 'Nobody' } : d))
  assert.equal(chk(score('c4', ghost), 'reportsTo-exists').pass, false)
  assert.equal(chk(score('c4', ghost), 'no-cycles').pass, false)
  const loop = base.map((d) => (d.name === 'Product Lead' ? { ...d, reportsTo: 'Web Implementer' } : d))
  assert.equal(chk(score('c4', loop), 'no-cycles').pass, false)
  const noSpawn = base.map((d) => (d.name === 'Platform Lead' ? { ...d, spawnable: ['Infra Engineer'] } : d))
  const r = score('c4', noSpawn)
  assert.equal(chk(r, 'spawnable-covers-reports').pass, false)
  assert.ok(chk(r, 'spawnable-covers-reports').detail.includes('Platform Lead'))
  const leafSpawns = base.map((d) => (d.name === 'QA Engineer' ? { ...d, canSpawn: true, spawnable: ['Infra Engineer'] } : d))
  assert.equal(chk(score('c4', leafSpawns), 'leaf-no-spawn').pass, false)
  const dup = [...base, { ...base[8], name: 'compliance reviewer' }]
  assert.equal(chk(score('c4', dup), 'unique-names').pass, false)
})

test('right-sizing: partial credit by distance, depth cap, and the middle layer c4 needs', () => {
  const flat = goodC4().map((d, i) => (i === 0 ? { ...d, spawnable: goodC4().slice(1).map((x) => x.name) } : { ...d, reportsTo: i === 0 ? null : 'Orchestrator', spawnable: [], canSpawn: false }))
  const r = score('c4', flat)
  assert.equal(chk(r, 'middle-layer').pass, false)
  assert.equal(chk(r, 'role-count').pass, true)
  const small = score('c4', goodC4().slice(0, 6).map((d) => ({ ...d, spawnable: [], canSpawn: false, reportsTo: d.name === 'Orchestrator' ? null : 'Orchestrator' })))
  const c = chk(small, 'role-count')
  assert.equal(c.pass, false)
  assert.ok(c.credit > 0 && c.credit < 1, String(c.credit))
  assert.ok(chk(score('c1', badC1()), 'role-count').credit < chk(score('c1', [...goodC1(), { ...goodC1()[1], name: 'Extra' }].map((d) => ({ ...d, reportsTo: d.name === 'Orchestrator' ? null : 'Orchestrator' }))), 'role-count').credit + 1)
  const deep = [...goodC1(), { ...goodC1()[1], name: 'Helper', reportsTo: 'Developer' }]
  assert.equal(chk(score('c1', deep), 'depth').pass, false)
})

test('coverage counts expected groups matched by some role and flags forbidden roles', () => {
  const noMobile = goodC4().filter((d) => d.name !== 'Mobile Implementer').map((d) => (d.name === 'Product Lead' ? { ...d, spawnable: ['Web Implementer'], description: 'Leads the web app.', prompt: d.prompt.replace(/mobile/gi, 'tablet') } : d))
  const r = score('c4', noMobile)
  assert.equal(chk(r, 'cover:mobile').pass, false)
  assert.equal(chk(r, 'cover:web').pass, true)
  assert.ok(dim(r, 'coverage').score < 1)
  const e2 = scenarioById('e2')
  assert.ok(e2.expect.forbid.length > 0)
  const dev = [{ name: 'Engagement Lead', description: 'Leads the assessment and workflow review.', responsibilities: ['plan'], prompt: 'You are the lead of the healthcare workflow assessment. Follow the engagement document and its charter. '.repeat(3), tools: ['Read'], model: 'deep', canSpawn: true, spawnable: ['Software Developer'], reportsTo: null }, { name: 'Software Developer', description: 'Writes code.', responsibilities: ['code'], prompt: 'You are a developer. Follow the engagement document. '.repeat(8), tools: ['Read', 'Write'], model: 'everyday', canSpawn: false, spawnable: [], reportsTo: 'Engagement Lead' }]
  assert.equal(chk(scoreChart(recommendSession('e2', dev), e2), 'forbid:developer').pass, false)
})

// ---------------------------------------------------------------- recommend: least privilege, tiering, prompts

test('least privilege: read-only roles must not edit; messaging must match the scenario; no role holds every tool', () => {
  const editReviewer = goodC4().map((d) => (d.name === 'Compliance Reviewer' ? { ...d, tools: [...d.tools, 'Write'] } : d))
  assert.equal(chk(score('c4', editReviewer), 'readonly-no-write').pass, false)
  assert.equal(chk(score('c1', goodC1()), 'messaging-matches').pass, true)
  const chatty = goodC1().map((d) => ({ ...d, tools: [...d.tools, 'SendMessage'] }))
  assert.equal(chk(score('c1', chatty), 'messaging-matches').pass, false)
  const silent = goodC4().map((d) => ({ ...d, tools: d.tools.filter((t) => t !== 'SendMessage' && t !== 'ListAgents') }))
  assert.equal(chk(score('c4', silent), 'messaging-matches').pass, false)
  const everyone = goodC4().map((d) => ({ ...d, tools: [...d.tools, 'SendMessage'] }))
  assert.equal(chk(score('c4', everyone), 'messaging-matches').pass, false)
  assert.equal(chk(score('c2', goodC1()), 'messaging-matches').pass, true)
  const everything = goodC1().map((d, i) => (i === 1 ? { ...d, tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit', 'SendMessage', 'ListAgents'] } : d))
  assert.equal(chk(score('c4', everything), 'no-role-has-every-tool').pass, false)
})

test('tiering: root on deep, no top unless allowed, the deep share, no vendor ids, a reviewer when wanted', () => {
  const everydayRoot = goodC1().map((d) => (d.name === 'Orchestrator' ? { ...d, model: 'everyday' } : d))
  assert.equal(chk(score('c1', everydayRoot), 'root-deep').pass, false)
  const topRoot = goodC1().map((d) => (d.name === 'Orchestrator' ? { ...d, model: 'top' } : d))
  assert.equal(chk(score('c1', topRoot), 'root-deep').credit, 0)
  assert.equal(chk(score('c1', topRoot), 'no-top').pass, false)
  const topC4 = goodC4().map((d) => (d.name === 'Orchestrator' ? { ...d, model: 'top' } : d))
  assert.equal(chk(score('c4', topC4), 'root-deep').pass, true)
  assert.equal(chk(score('c4', topC4), 'no-top').na, true)
  const heavy = goodC4().map((d) => ({ ...d, model: 'deep' }))
  assert.equal(chk(score('c4', heavy), 'deep-share').pass, false)
  const vendor = goodC1().map((d) => (d.name === 'Developer' ? { ...d, model: 'claude-sonnet-4-5' } : d))
  assert.equal(chk(score('c1', vendor), 'no-vendor-model-ids').pass, false)
  const inherit = goodC1().map((d) => (d.name === 'Orchestrator' ? { ...d, model: 'inherit' } : d))
  assert.equal(chk(score('c1', inherit), 'root-deep').credit, 0.5)
  const omitted = goodC1().map((d) => { const { model: _m, ...rest } = d; return d.name === 'Developer' ? rest : d })
  assert.equal(chk(score('c1', omitted), 'no-vendor-model-ids').pass, true)
  const gone = ['Compliance Reviewer', 'QA Engineer']
  const noReviewer = goodC4().filter((d) => !gone.includes(d.name)).map((d) => (d.name === 'Orchestrator' ? { ...d, spawnable: d.spawnable.filter((s) => !gone.includes(s)) } : d))
  assert.equal(chk(score('c4', noReviewer), 'reviewer-present').pass, false)
})

test('prompt quality: length, second person, the architecture or engagement document, writers, and a root that delegates everything', () => {
  const short = goodC1().map((d) => ({ ...d, prompt: 'Do the work well.' }))
  const r = score('c1', short)
  for (const id of ['prompt-length', 'prompt-second-person', 'prompt-refs-document', 'writers-stay-in-brief']) assert.equal(chk(r, id)?.pass ?? false, id === 'writers-stay-in-brief' ? chk(r, id)?.na === true : false, id)
  const longPrompt = goodC1().map((d) => ({ ...d, prompt: `${d.prompt} ${'More words. '.repeat(80)}` }))
  assert.equal(chk(score('c1', longPrompt), 'prompt-length').pass, false)
  const noBrief = goodC4().map((d) => (d.name === 'Mobile Implementer' ? { ...d, prompt: 'You are the mobile implementer for the driver app. Follow the architecture document. Write the screens, run the app on a simulator, check that the build is green, fix what you find, and tell the lead how it went in a short note with the outcome first and anything still open. ' } : d))
  const rn = score('c4', noBrief)
  assert.equal(chk(rn, 'writers-stay-in-brief').pass, false)
  assert.equal(chk(rn, 'writers-report-files').pass, false)
  const delegateAll = goodC4().map((d) => (d.name === 'Orchestrator' ? { ...d, prompt: `${d.prompt} Delegate everything to your leads and never do any work yourself.` } : d))
  assert.equal(chk(score('c4', delegateAll), 'root-no-delegate-all').pass, false)
  const eng = score('e2', goodC4().map((d) => ({ ...d, prompt: d.prompt.replace(/architecture document/g, 'engagement document') })))
  assert.equal(chk(eng, 'prompt-refs-document').pass, true)
  assert.equal(chk(eng, 'root-no-delegate-all').na, true)
  assert.equal(chk(score('e2', goodC4()), 'prompt-refs-document').pass, false)
})

test('unscored figures: tool counts, prompt words and the cost proxy (top 5, deep 3, everyday 1, fast 0.3)', () => {
  const drafts = [{ ...goodC1()[0], model: 'top' }, { ...goodC1()[1], model: 'everyday' }, { ...goodC1()[1], name: 'Scout', model: 'fast', reportsTo: 'Orchestrator' }]
  const r = score('c1', drafts)
  assert.equal(r.metrics.costProxy, 6.3)
  assert.equal(r.metrics.toolCounts.Bash, 2)
  assert.ok(r.metrics.promptWords > 100)
})

// ---------------------------------------------------------------- retro: the diff

test('diffCharts reports added, removed and changed roles and ignores wiring to roles it added or removed', () => {
  const before = viewsFromDrafts(RETRO_SCENARIOS.find((s) => s.id === 'r1').chart)
  const added = diffCharts(before, addRole(newRole('Database Engineer'))(before))
  assert.deepEqual(added.added.map((r) => r.slug), ['database-engineer'])
  assert.deepEqual(added.changed, [])
  const removed = diffCharts(before, before.filter((r) => r.slug !== 'researcher').map((r) => ({ ...r, spawnable: r.spawnable.filter((s) => s !== 'researcher') })))
  assert.deepEqual(removed.removed.map((r) => r.slug), ['researcher'])
  assert.deepEqual(removed.changed, [])
  const tools = diffCharts(before, withTools(before, 'tester', ['Read']))
  assert.deepEqual(tools.changed.map((c) => `${c.slug}:${c.fields}`), ['tester:tools'])
  assert.deepEqual(diffCharts(before, structuredClone(before)), { added: [], removed: [], changed: [] })
})

// ---------------------------------------------------------------- retro: the six planted defects

test('r2 (a role lacked a tool): adding Bash to the tester is a full fix; no change or the wrong role is not', () => {
  const good = reviseScore('r2', (v) => withTools(v, 'tester', [...v.find((r) => r.slug === 'tester').tools, 'Bash']))
  assert.equal(good.total, 100, failed(good).join(', '))
  assert.equal(chk(good, 'fix:tester').credit, 1)
  const none = reviseScore('r2', null)
  assert.equal(dim(none, 'fix').score, 0)
  assert.ok(none.total < 70, String(none.total))
  const wrong = reviseScore('r2', (v) => withTools(v, 'implementer', [...v.find((r) => r.slug === 'implementer').tools, 'WebSearch']))
  assert.equal(chk(wrong, 'fix:tester').credit, 0)
  assert.equal(chk(wrong, 'must-not-change').pass, false)
  const readOnlyBash = reviseScore('r2', (v) => v.map((r) => (r.slug === 'tester' ? { ...r, prompt: `${r.prompt} Ask for Bash.` } : r)))
  assert.ok(chk(readOnlyBash, 'fix:tester').credit < 1)
})

test('r1 (missing specialty): a new role covering the work is best, extending a role is partial, an unrelated role is weak', () => {
  const full = reviseScore('r1', addRole(newRole('Database Engineer')))
  assert.equal(full.total, 100, failed(full).join(', '))
  const extended = reviseScore('r1', (v) => v.map((r) => (r.slug === 'backend-implementer' ? { ...r, prompt: `${r.prompt} You also own the SQL migrations and the schema.` } : r)))
  assert.equal(chk(extended, 'fix:new-role:a-database-migrations-specialist').credit, 0.7)
  const unrelated = reviseScore('r1', addRole(newRole('Release Manager', { prompt: 'You are the release manager. Follow the architecture document. Prepare the notes.', description: 'Release notes.', responsibilities: ['notes'] })))
  assert.equal(chk(unrelated, 'fix:new-role:a-database-migrations-specialist').credit, 0.3)
  const sprawl = reviseScore('r1', (v) => addRole(newRole('Database Engineer'))(addRole(newRole('Cache Engineer', { prompt: 'You are the cache engineer. Follow the architecture document.', description: 'Caches.' }))(v)))
  assert.ok(chk(sprawl, 'no-extra-roles').credit < 1)
  assert.ok(sprawl.total < full.total)
  const collateral = reviseScore('r1', (v) => withTools(addRole(newRole('Database Engineer'))(v), 'frontend-implementer', ['Read']))
  assert.equal(chk(collateral, 'must-not-change').pass, false)
  assert.ok(collateral.total < 95)
  const fatter = reviseScore('r1', (v) => addRole(newRole('Database Engineer', { tier: 'deep', model: 'opus' }))(v))
  assert.equal(chk(fatter, 'no-tier-raise').pass, false)
})

test('r3 (a prompt misled a role): the misleading wording must go and a confinement must come in', () => {
  const fixedPrompt = 'You are the web implementer. Follow the architecture document. Work on the React app under apps/web/ as your brief says. Stay within the files named in your brief: if you find a problem elsewhere, do not edit it, tell your lead. Report every file you touched.'
  const good = reviseScore('r3', (v) => v.map((r) => (r.slug === 'web-implementer' ? { ...r, prompt: fixedPrompt } : r)))
  assert.equal(good.total, 100, failed(good).join(', '))
  const half = reviseScore('r3', (v) => v.map((r) => (r.slug === 'web-implementer' ? { ...r, prompt: 'You are the web implementer. Follow the architecture document. Work on the React app and report back.' } : r)))
  assert.ok(chk(half, 'fix:web-implementer').credit > 0.4 && chk(half, 'fix:web-implementer').credit < 1)
  const stillMisleading = reviseScore('r3', (v) => v.map((r) => (r.slug === 'web-implementer' ? { ...r, prompt: `${r.prompt} Please be careful.` } : r)))
  assert.equal(chk(stillMisleading, 'fix:web-implementer').credit, 0.4)
  const untouched = reviseScore('r3', null)
  assert.equal(chk(untouched, 'fix:web-implementer').credit, 0)
  const rewriteAll = reviseScore('r3', (v) => v.map((r) => ({ ...r, prompt: r.slug === 'web-implementer' ? fixedPrompt : `${r.prompt} Be careful.` })))
  assert.equal(chk(rewriteAll, 'no-collateral').pass, false)
  assert.equal(dim(rewriteAll, 'minimality').score < 0.35, true)
  assert.ok(rewriteAll.total < 90 && rewriteAll.total > 70, String(rewriteAll.total)) // the fix is there; minimality alone (25 points) pays for the sprawl
})

test('r4 (an over-provisioned role): lowering the tier is the fix; raising spend is penalized', () => {
  const good = reviseScore('r4', (v) => v.map((r) => (r.slug === 'researcher' ? { ...r, tier: 'fast', model: 'haiku' } : r)))
  assert.equal(good.total, 100, failed(good).join(', '))
  assert.equal(good.metrics.costProxyAfter < good.metrics.costProxyBefore, true)
  const same = reviseScore('r4', (v) => v.map((r) => (r.slug === 'researcher' ? { ...r, prompt: `${r.prompt} Keep it brief.` } : r)))
  assert.equal(chk(same, 'fix:researcher').credit, 0.4)
  const worse = reviseScore('r4', (v) => v.map((r) => (r.slug === 'reviewer' ? { ...r, tier: 'deep', model: 'opus' } : r)))
  assert.equal(chk(worse, 'no-tier-raise').pass, false)
  assert.equal(chk(worse, 'fix:researcher').credit, 0)
})

test('r5 (a healthy run): complete_setup with no change, or an empty change, is full marks; any edit is penalized', () => {
  const ended = reviseScore('r5', null)
  assert.equal(ended.total, 100, failed(ended).join(', '))
  assert.equal(chk(ended, 'no-change').pass, true)
  assert.equal(ended.metrics.ending, 'noChange')
  const empty = reviseScore('r5', (v) => v)
  assert.equal(empty.total, 100)
  const nitpick = reviseScore('r5', (v) => v.map((r) => (r.slug === 'reviewer' ? { ...r, prompt: `${r.prompt} Be thorough.` } : r)))
  assert.equal(chk(nitpick, 'no-change').pass, false)
  assert.equal(chk(nitpick, 'healthy-untouched').pass, false)
  assert.ok(nitpick.total < 80, String(nitpick.total))
  const rewrite = reviseScore('r5', (v) => v.filter((r) => r.slug !== 'researcher').map((r) => ({ ...r, tier: 'deep', model: 'opus', spawnable: r.spawnable.filter((s) => s !== 'researcher') })))
  assert.ok(rewrite.total < 40, String(rewrite.total))
})

test('r6 (unused roles in this run): removing them is the failure; keeping the chart is full marks', () => {
  assert.equal(reviseScore('r6', null).total, 100)
  const slim = (v) => v.filter((r) => !['mobile-implementer', 'ui-tester', 'researcher'].includes(r.slug)).map((r) => ({ ...r, spawnable: r.spawnable.filter((s) => !['mobile-implementer', 'ui-tester', 'researcher'].includes(s)) }))
  const r = reviseScore('r6', slim)
  assert.equal(chk(r, 'unused-not-removed').pass, false)
  assert.ok(chk(r, 'unused-not-removed').detail.includes('mobile-implementer'))
  assert.equal(chk(r, 'no-unprovoked-removal').credit, 0)
  assert.ok(dim(r, 'stability').score < 0.6)
  assert.ok(r.total < 85)
  const tweakUsed = reviseScore('r6', (v) => v.map((x) => (x.slug === 'api-implementer' ? { ...x, prompt: `${x.prompt} Paginate with cursors.` } : x)))
  assert.equal(tweakUsed.total, 100)
})

test('a revision session with neither a proposal nor complete_setup scores 0; revise rounds cost validity', () => {
  const r = scoreRevision({ family: 'retro', status: 'noEnding', revision: null, turns: 8, costUsd: 0.4 }, scenarioById('r2'))
  assert.equal(r.total, 0)
  assert.deepEqual(failed(r), ['revision-ended'])
  assert.equal(r.metrics.costUsd, 0.4)
  const rounds = reviseScore('r2', (v) => withTools(v, 'tester', [...v.find((x) => x.slug === 'tester').tools, 'Bash']), { reviseRounds: 2 })
  assert.equal(dim(rounds, 'validity').score, 0.75)
  assert.equal(rounds.total, 97.5)
})

test('revision results carry the efficiency figures and the cost proxy change, unscored', () => {
  const r = reviseScore('r4', (v) => v.map((x) => (x.slug === 'researcher' ? { ...x, tier: 'fast', model: 'haiku' } : x)), { turns: 7, costUsd: 0.9, durationMs: 33000 })
  assert.equal(r.metrics.turns, 7)
  assert.equal(r.metrics.costUsd, 0.9)
  assert.equal(r.metrics.durationMs, 33000)
  assert.equal(r.metrics.costProxyBefore - r.metrics.costProxyAfter, 2.7)
  assert.deepEqual(r.dimensions.map((d) => d.id), Object.keys(REVISION_WEIGHTS))
})

// ---------------------------------------------------------------- scenarios

test('scenario table: ids, families and expectations are well formed', () => {
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length)
  assert.deepEqual(RECOMMEND_SCENARIOS.map((s) => s.id), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'e1', 'e2', 'e3'])
  assert.deepEqual(RETRO_SCENARIOS.map((s) => s.id), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])
  for (const s of RECOMMEND_SCENARIOS) {
    assert.equal(s.family, 'recommend')
    assert.ok(s.complexity >= 1 && s.complexity <= 4)
    assert.ok(s.answers.endsWith('Go ahead and propose; use your judgment for anything else.'), s.id)
    assert.ok(s.expect.roles.min <= s.expect.roles.max && s.expect.cover.length > 0)
    assert.ok(['none', 'some', 'any'].includes(s.expect.wantsMessaging))
    assert.ok((s.setupKind === 'existing') === !!s.files, `${s.id}: only existing projects carry files`)
    if (s.files) assert.ok(Object.keys(s.files).length <= 12 && Object.values(s.files).every((t) => t.length < 1600), `${s.id}: a dozen small files at most`)
  }
  assert.deepEqual(RECOMMEND_SCENARIOS.filter((s) => s.kind === 'engagement').map((s) => s.id), ['e1', 'e2', 'e3'])
  assert.deepEqual(RECOMMEND_SCENARIOS.filter((s) => s.setupKind === 'existing').map((s) => s.id), ['c5', 'c6'])
  const c1 = scenarioById('c1').expect
  assert.deepEqual([c1.roles, c1.maxDepth, c1.wantsMessaging, c1.allowTop], [{ min: 1, max: 3 }, 1, 'none', false])
  assert.equal(scenarioById('c4').expect.middleLayer, true)
})

test('retro scenarios: charts of 3, 6 and 11 roles, planted defects that name real roles', () => {
  const sizes = Object.fromEntries(RETRO_SCENARIOS.map((s) => [s.id, s.chart.length]))
  assert.deepEqual(sizes, { r1: 6, r2: 3, r3: 11, r4: 6, r5: 6, r6: 11 })
  for (const s of RETRO_SCENARIOS) {
    const views = viewsFromDrafts(s.chart)
    const slugs = new Set(views.map((v) => v.slug))
    assert.equal(views.filter((v) => v.reportsTo === null).length, 1, `${s.id}: one root`)
    for (const v of views) {
      assert.ok(v.reportsTo === null || slugs.has(v.reportsTo), `${s.id}: ${v.slug} reports to a real role`)
      for (const t of v.spawnable) assert.ok(slugs.has(t), `${s.id}: ${v.slug} spawns a real role`)
    }
    for (const a of s.run.agents) assert.ok(slugs.has(a.slug), `${s.id}: run agent ${a.slug} is in the chart`)
    const named = [...(s.expect.mustChange ?? []).map((m) => m.slug).filter(Boolean), ...s.expect.mustNotChange, ...s.expect.mustNotRemove, ...(s.expect.mayChange ?? [])]
    for (const n of named) assert.ok(slugs.has(n), `${s.id}: expectation names ${n}`)
    assert.equal(s.expect.mustChange.length === 0 && !s.expect.expectNoChange && s.id !== 'r6', false, `${s.id}: has a defect to fix, or expects no change`)
  }
  assert.equal(scenarioById('r5').expect.expectNoChange, true)
  assert.equal(scenarioById('r4').chart.find((d) => d.name === 'Researcher').model, 'deep')
  const r6 = scenarioById('r6')
  const used = new Set(r6.run.agents.map((a) => a.slug))
  for (const slug of r6.expect.mustNotRemove) assert.ok(!used.has(slug), `${slug} is unused in the r6 run`)
  assert.ok(viewsFromDrafts(scenarioById('r3').chart).some((v) => v.reportsTo !== 'orchestrator' && v.reportsTo !== null), 'the 11-role chart has a middle layer')
})

// ---------------------------------------------------------------- re-scoring, summary, comparison, reports

test('the sample results file re-scores deterministically and summarizes both families', () => {
  const a = rescore(sample, SCENARIOS)
  const b = rescore(JSON.parse(JSON.stringify(a)), SCENARIOS)
  assert.deepEqual(a, b)
  assert.equal(a.scorerVersion, SCORER_VERSION)
  assert.equal(a.sessions.length, 9)
  assert.equal(a.sessions.find((s) => s.status === 'skipped').score, null)
  const sum = summarize(a)
  assert.equal(sum.scored, 8)
  assert.equal(sum.skipped, 1)
  assert.deepEqual(Object.keys(sum.families), ['recommend', 'retro'])
  const rec = sum.families.recommend
  assert.deepEqual(rec.scenarios.map((s) => s.id).sort(), ['c1', 'c2', 'c4'])
  const c1 = rec.scenarios.find((s) => s.id === 'c1')
  assert.equal(c1.n, 2)
  assert.equal(c1.minTotal < c1.meanTotal && c1.meanTotal < c1.maxTotal, true)
  assert.equal(rec.scenarios.find((s) => s.id === 'c2').noResult, 1)
  const retro = sum.families.retro
  assert.equal(retro.scenarios.find((s) => s.id === 'r5').meanTotal < 50, true)
  assert.equal(retro.scenarios.find((s) => s.id === 'r2').meanTotal, 100)
  const ids = sum.weakestChecks.map((c) => `${c.family}/${c.id}`)
  assert.ok(ids.includes('retro/healthy-untouched') && ids.includes('recommend/role-count') && ids.includes('recommend/chart-produced'))
  const credits = sum.weakestChecks.map((c) => c.meanCredit)
  assert.deepEqual(credits, [...credits].sort((x, y) => x - y), 'lowest first')
  for (const c of sum.weakestChecks) assert.ok(c.fails >= 1 && c.fails <= c.total)
})

test('compareSummaries gives per-scenario and per-dimension deltas for both families', () => {
  const a = summarize(rescore(sample, SCENARIOS))
  assert.ok(compareSummaries(a, a).checks.length === 0)
  assert.ok(Object.values(compareSummaries(a, a).families).every((f) => f.delta === 0 && f.scenarios.every((s) => s.delta === 0)))
  const better = rescore({ ...sample, sessions: sample.sessions.map((s) => (s.scenarioId === 'c1' && s.repeat === 2 ? { ...s, ...recommendSession('c1', goodC1()), repeat: 2 } : s.scenarioId === 'r5' ? retroSession('r5', null) : s)) }, SCENARIOS)
  const cmp = compareSummaries(a, summarize(better))
  assert.ok(cmp.families.recommend.delta > 0)
  assert.ok(cmp.families.retro.delta > 0)
  const c1 = cmp.families.recommend.scenarios.find((s) => s.id === 'c1')
  assert.ok(c1.delta > 0 && c1.dimensions['right-sizing'] > 0)
  const r5 = cmp.families.retro.scenarios.find((s) => s.id === 'r5')
  assert.ok(r5.delta > 50 && r5.dimensions.fix > 0)
  assert.ok(cmp.checks.some((c) => c.id === 'retro/healthy-untouched' && c.delta < 0))
  const text = renderCompare(cmp, ['before', 'after'])
  assert.match(text, /# Compare before -> after/)
  assert.match(text, /Self-healing \(retro\)/)
  assert.match(text, /\| r5 \|/)
})

test('report.md has a table per family, the lowest checks and the sessions; model text is escaped', () => {
  const rescored = rescore(sample, SCENARIOS)
  const evil = { ...rescored, sessions: rescored.sessions.map((s) => (s.scenarioId === 'c4' ? { ...s, chart: { ...s.chart, drafts: s.chart.drafts.map((d, i) => (i === 0 ? { ...d, name: 'Boss | `x`\n# injected' } : d)) } } : s)) }
  const md = renderReport(evil, summarize(evil))
  assert.match(md, /## Recommendation \(mean/)
  assert.match(md, /## Self-healing: revisions after a run record \(mean/)
  assert.match(md, /## Lowest-scoring checks/)
  assert.match(md, /- r5 #1: /)
  assert.ok(!/^# injected/m.test(md.split('## Sessions')[0]))
  assert.match(md, /label: sample/)
})
