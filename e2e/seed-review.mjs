// A TOOL, not a test (it is not in e2e:free and not in scripts/e2e-select.mjs). Token-free: the mock adapter only.
// Fills a data folder with realistic review content so the UI can be reviewed by hand: five projects (code and
// engagements) with runs in many states, outputs with versions and notes, knowledge, to-dos, schedules, a Chat, pending
// decision cards and a proposal, a spending limit and spend history. See e2e/README.md "Review data".
//
//   E2E_DATA_DIR=<folder> node e2e/seed-review.mjs [--force] [--no-backdate]
//   E2E_DATA_DIR=<folder> node e2e/seed-review.mjs --live     (re-opens a seeded folder, starts the live / waiting runs
//                                                              again and keeps the window open until it is closed)
//
// Never deletes anything. Every step is wrapped: a failure is logged and the rest continue.
import * as fs from 'node:fs'
import * as path from 'node:path'

const raw = process.env.E2E_DATA_DIR?.trim()
if (!raw) {
  console.error('seed-review: E2E_DATA_DIR is required (the data folder to fill). Refusing to run without it.')
  process.exit(2)
}
const FORCE = process.argv.includes('--force')
const LIVE = process.argv.includes('--live')
const BACKDATE = !process.argv.includes('--no-backdate')
process.env.ORGAI_MOCK = '1'
// lib.mjs reads E2E_DATA_DIR when it is imported, so it is imported only after the check above.
const { DATA_DIR, launch, createProject, findProject, makeFixtureRepo, writeFile, git, sleep, log, openProjectForm, gotoProjects, pickSetup, errDetail } = await import('./lib.mjs')

fs.mkdirSync(DATA_DIR, { recursive: true })
const WORK = `${DATA_DIR}-work`
const SCRIPT_FILE = `${DATA_DIR}-mock-script.json`
fs.mkdirSync(WORK, { recursive: true })
const mk = (name) => {
  const dir = path.join(WORK, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ---------- Summary bookkeeping ----------
const made = {}
const failed = []
const skipped = []
const count = (kind, n = 1) => (made[kind] = (made[kind] ?? 0) + n)
let page, app

/** One seeding step: a failure is logged and the rest go on. */
async function step(name, fn) {
  try {
    log(`seed: ${name}`)
    return await fn()
  } catch (e) {
    failed.push(`${name}: ${errDetail(e)}`)
    log(`seed FAILED: ${name} -- ${errDetail(e)}`)
    return undefined
  }
}

// ---------- IPC helpers (the renderer's own bridge) ----------
const ev = (fn, arg) => page.evaluate(fn, arg)
const startRun = (projectId, prompt, extra = {}) => ev(([projectId, prompt, extra]) => window.orgai.runs.start({ projectId, prompt, ...extra }), [projectId, prompt, extra])
const startChat = (prompt, extra = {}) => ev(([prompt, extra]) => window.orgai.runs.startQuick({ prompt, ...extra }), [prompt, extra])
const getRun = async (runId) => {
  const rec = await ev((id) => window.orgai.runs.get(id), runId)
  return rec ? { ...rec, status: rec.summary?.status } : rec
}
const cardsOf = (runId) => ev((id) => window.orgai.runs.pendingCards(id), runId)
const sendTo = (runId, text) => ev(([runId, text]) => window.orgai.runs.send({ runId, text }), [runId, text])
const stopRun = (runId) => ev((id) => window.orgai.runs.stop(id), runId)
const cardCount = (c) => (c ? c.permissions.length + c.questions.length + c.proposals.length + c.ruleRequests.length + c.mergeReviews.length + c.mcpInstalls.length : 0)

/**
 * Wait for a run to settle. allow: answer permission cards with Allow as they come. until 'idle': the turn is done
 * (status idle / error / paused / finished); 'card': a decision is pending; 'settled': either.
 */
async function drive(runId, { allow = false, until = 'idle', ms = 90_000, answerQuestions = false } = {}) {
  const end = Date.now() + ms
  let last = ''
  while (Date.now() < end) {
    const run = await getRun(runId)
    const cards = await cardsOf(runId).catch(() => null)
    last = `${run?.status} cards=${cardCount(cards)}`
    if (allow && cards?.permissions?.length) {
      for (const p of cards.permissions) await ev(([runId, requestId]) => window.orgai.runs.decide({ runId, requestId, decision: { behavior: 'allow' } }), [runId, p.id ?? p.requestId])
      await sleep(400)
      continue
    }
    if (answerQuestions && cards?.questions?.length) {
      for (const q of cards.questions) await ev(([runId, q]) => window.orgai.runs.decide({ runId, requestId: q.id, decision: { behavior: 'allow' } }), [runId, q]).catch(() => {})
      await sleep(400)
      continue
    }
    const pending = cardCount(cards) > 0
    const done = ['idle', 'error', 'paused', 'finished'].includes(run?.status ?? '')
    if (until === 'card' && pending) return run
    if (until === 'idle' && done && !pending) return run
    if (until === 'settled' && (done || pending)) return run
    if (until === 'ended' && ['finished', 'error'].includes(run?.status ?? '')) return run
    await sleep(500)
  }
  throw new Error(`run ${runId} did not settle (${last})`)
}

const results = new Map()
/** Start a run, drive it, remember it for the summary. end: 'live' (leave it open), 'stop' (End session). */
async function run(label, projectId, prompt, { allow = false, until = 'idle', end = 'live', follow = [], chat = false, extra = {} } = {}) {
  return step(`run: ${label}`, async () => {
    const r = chat ? await startChat(prompt, extra) : await startRun(projectId, prompt, extra)
    await drive(r.id, { allow, until })
    for (const text of follow) {
      // A run that already ended (a spending-limit hold ends the session) cannot take a reply: say why, not "Run is not active".
      const before = await getRun(r.id)
      if (['finished', 'error'].includes(before?.status ?? '')) throw new Error(`run ${r.id} ended (${before.status}) before the follow-up${before.summary?.hold ? `: ${before.summary.hold.reason}` : ''}`)
      await sendTo(r.id, text)
      await sleep(600)
      await drive(r.id, { allow, until: 'idle' })
    }
    if (end === 'stop') await stopRun(r.id)
    const now = await getRun(r.id)
    const cards = await cardsOf(r.id).catch(() => null)
    results.set(label, `${now?.status}${cardCount(cards) ? `, ${cardCount(cards)} pending` : ''}`)
    count('runs')
    return r
  })
}

// ---------- Content ----------
const LONG_MD = `## Findings

I read the module and the tests first. Three things matter:

1. **Pagination is missing.** \`GET /notes\` returns the whole list; with a few thousand notes the response is slow.
2. *Validation is thin.* A body without \`text\` is stored as an empty note.
3. The store keeps everything in memory, so a restart loses it.

### Proposed change

\`\`\`js
export function list({ limit = 50, cursor = 0 } = {}) {
  const page = notes.slice(cursor, cursor + limit)
  return { items: page, next: cursor + page.length < notes.length ? cursor + page.length : null }
}
\`\`\`

| Endpoint | Before | After | Notes |
| --- | --- | --- | --- |
| GET /notes | all notes | 50 per page | cursor in the response |
| POST /notes | accepts empty text | 400 on empty text | message names the field |
| DELETE /notes/:id | missing | planned | needs an id scheme |

- Reference: https://example.com/docs/api/pagination/cursor-based-pagination-with-stable-ordering-and-opaque-tokens?utm_source=review&utm_medium=seed&utm_campaign=very-long-link-for-wrapping-checks
- Naive café notes with unicode: Zürich, São Paulo, 東京, Ελλάδα
> Keep the page size configurable; a fixed 50 will not suit every client.

Open questions:

- Should the cursor be opaque?
- Do we version the endpoint?
`
const SHORT_MD = (n) => `### Update ${n}\n\nThe change for step ${n} is in place and the tests pass.\n\n- touched: \`src/store.js\`, \`src/server.js\`\n- next: review the table below\n\n| step | status |\n| --- | --- |\n| ${n} | done |\n`
const FOLLOW = [
  'Thanks. Can you also add a **limit** query parameter? Cap it at 200.\n\nUse this shape:\n\n```json\n{ "limit": 50, "cursor": 0 }\n```',
  'One more thing: list what you changed as a table with the file, the reason and the risk.',
  'And please keep the README in sync (see https://example.com/readme/conventions/how-we-write-readmes-for-small-services-with-many-words-in-the-path).'
]
const REPLY = `### Reply

You wrote:

> {text}

Here is how I read it:

1. Start with the **smallest** change that answers it.
2. Keep the tests beside the modules.
3. Report the files touched.

\`\`\`bash
npm test -- --reporter=spec
\`\`\`

| item | state |
| --- | --- |
| request understood | yes |
| files to touch | 2 |
`

function writeLongScript() {
  const script = {
    delayMs: 120,
    reply: REPLY,
    work: [
      { type: 'thinking', text: 'The request touches the store and the route. I will read both, delegate the edit and review the result.' },
      { type: 'text', text: 'I will start by reading the project files, then split the work.' },
      { type: 'tool', name: 'Read', input: { file_path: 'src/store.js' }, result: 'export function createStore() {\n  const notes = []\n  return { list: () => notes.slice() }\n}\n' },
      { type: 'tool', name: 'Grep', input: { pattern: 'createStore' }, result: 'src/server.js:5:const store = createStore()\ntest/store.test.js:5:  const s = createStore()\n' },
      { type: 'text', text: LONG_MD },
      { type: 'spawn', id: 'seed-report-1', description: 'Implement cursor pagination in the store' },
      { type: 'tool', agent: 'seed-report-1', name: 'Read', input: { file_path: 'src/store.js' }, result: 'export function createStore() {}\n' },
      { type: 'text', agent: 'seed-report-1', text: SHORT_MD(1) },
      { type: 'finish', id: 'seed-report-1', result: 'Added cursor pagination to the store. Files touched: src/store.js' },
      { type: 'spawn', id: 'seed-report-2', description: 'Cover the new behaviour with tests' },
      { type: 'text', agent: 'seed-report-2', text: SHORT_MD(2) },
      { type: 'finish', id: 'seed-report-2', result: 'Added three tests for pagination. Files touched: test/store.test.js' },
      { type: 'text', text: SHORT_MD(3) },
      { type: 'text', text: 'Everything is in place. Tell me if you want the page size to be configurable per client.' }
    ]
  }
  fs.writeFileSync(SCRIPT_FILE, JSON.stringify(script, null, 2))
}

// ---------- Launch ----------
async function open(withScript) {
  if (withScript) process.env.ORGAI_MOCK_SCRIPT = SCRIPT_FILE
  else delete process.env.ORGAI_MOCK_SCRIPT
  const l = await launch({ shotPrefix: 'seed-review', clearPrefs: false })
  app = l.app
  page = l.page
  page.setDefaultTimeout(20_000)
}
const closeApp = async () => {
  await app?.close().catch(() => {})
  app = undefined
}

const P = {}
const NAMES = {
  harbor: 'Harbor Notes API',
  lantern: 'Lantern Mobile App',
  quarry: 'Quarry Data Pipeline',
  acme: 'Acme Corp FY25 audit',
  birch: 'Birch Street Clinic tax review'
}

async function createEngagement({ name, client, dir, refs = [], brief = '' }) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  if (client) await form.locator('[data-testid=new-project-client]').fill(client)
  await form.getByLabel('Working folder', { exact: true }).fill(dir)
  if (brief) await form.locator('textarea').first().fill(brief)
  for (const r of refs) {
    await form.locator('[data-testid=new-project-ref-input]').fill(r)
    await form.locator('[data-testid=new-project-ref-add]').click()
  }
  await pickSetup(form, true)
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  return findProject(page, name)
}

async function createProjects() {
  const harborRepo = path.join(WORK, 'harbor-notes-api')
  makeFixtureRepo('seed-harbor', { at: harborRepo })
  const lanternRepo = path.join(WORK, 'lantern-mobile-app')
  makeFixtureRepo('seed-lantern', { at: lanternRepo })
  writeFile(lanternRepo, 'README.md', '# Lantern\n\nA small mobile companion app for the notes service: offline notes, sync on reconnect.\n\n- screens: Home, Note, Settings\n- state: a single store, persisted\n')
  writeFile(lanternRepo, 'src/screens/Home.tsx', 'export function Home() {\n  return null\n}\n')
  git(lanternRepo, ['add', '-A'])
  git(lanternRepo, ['commit', '-q', '-m', 'add the Lantern readme and the home screen'])
  const quarryRepo = path.join(WORK, 'quarry-data-pipeline')
  makeFixtureRepo('seed-quarry', { at: quarryRepo })
  writeFile(quarryRepo, 'README.md', '# Quarry\n\nNightly import of partner CSV files into the warehouse. Validates, de-duplicates and loads.\n')
  git(quarryRepo, ['add', '-A'])
  git(quarryRepo, ['commit', '-q', '-m', 'describe the nightly import'])

  const specs = [
    ['harbor', () => createProject(page, { mode: 'existing', path: harborRepo, name: NAMES.harbor, brief: 'A small Express API that stores notes in memory. Goal: pagination, validation and a durable store before the 0.2 release.' })],
    ['lantern', () => createProject(page, { mode: 'existing', path: lanternRepo, name: NAMES.lantern, brief: 'The mobile companion for the notes service. Offline first; sync when the connection returns.' })],
    ['quarry', () => createProject(page, { mode: 'existing', path: quarryRepo, name: NAMES.quarry, brief: 'Nightly partner CSV import into the warehouse: validate, de-duplicate, load.' })],
    [
      'acme',
      async () => {
        const dir = mk('acme-fy25-audit')
        const refA = mk('acme-shared-docs')
        const refB = mk('acme-prior-year-workpapers')
        fs.writeFileSync(path.join(refA, 'engagement-letter.md'), '# Engagement letter\n\nScope: FY25 statutory audit of Acme Corp and two subsidiaries.\n')
        fs.writeFileSync(path.join(refB, 'fy24-summary.md'), '# FY24 summary\n\nUnqualified opinion. Two control observations on revenue cut-off.\n')
        return createEngagement({ name: NAMES.acme, client: 'Acme Corp (finance team)', dir, refs: [refA, refB], brief: 'Statutory audit of Acme Corp for FY25: planning, controls testing, fieldwork and the management letter.' })
      }
    ],
    [
      'birch',
      async () => {
        const dir = mk('birch-street-clinic')
        const ref = mk('birch-source-documents')
        fs.writeFileSync(path.join(ref, 'ledger-notes.md'), '# Ledger notes\n\nCash basis. Two partners. Equipment purchases in March and October.\n')
        return createEngagement({ name: NAMES.birch, client: 'Birch Street Clinic', dir, refs: [ref], brief: 'Annual tax review for a two-partner clinic: deductions, equipment, and the partner draw schedule.' })
      }
    ]
  ]
  for (const [key, make] of specs) {
    await step(`project: ${NAMES[key]}`, async () => {
      const p = await make()
      if (!p) throw new Error('not found after creation')
      P[key] = p
      count('projects')
    })
  }
}

async function loadProjects() {
  const list = await ev(() => window.orgai.projects.list())
  for (const [k, name] of Object.entries(NAMES)) P[k] = list.find((p) => p.name === name)
}

// ---------- Phase 1: long Markdown runs (custom mock script) ----------
async function longRuns() {
  const targets = [
    ['long: Harbor pagination', P.harbor, 'Add cursor pagination to GET /notes and cover it with tests'],
    ['long: Lantern sync', P.lantern, 'Explain how the offline queue should replay notes after a reconnect'],
    ['long: Acme planning', P.acme, 'Summarise the audit plan and list the open questions for the client']
  ]
  for (const [label, proj, prompt] of targets) {
    if (!proj) continue
    await run(label, proj.id, prompt, { until: 'idle', end: 'stop', follow: FOLLOW })
  }
}

// ---------- Phase 2: the marker runs (default mock script) ----------
async function projectRuns() {
  const h = P.harbor?.id
  const l = P.lantern?.id
  const q = P.quarry?.id
  const a = P.acme?.id
  const b = P.birch?.id

  if (h) {
    // The project's spending limit is set at the very end (otherData): with it in place the mock's unpriced report makes
    // ordinary runs stop on the limit, which would hide the other states. The budget-stop run carries its own per-run cap.
    await run('Harbor: finished team run', h, 'Add input validation to POST /notes and report what changed', { allow: true, end: 'stop', follow: ['Looks good. Please also reject notes over 2000 characters.', 'Thanks, that is all.'] })
    await run('Harbor: deep tree', h, 'Audit every route for missing error handling [mock:deep-tree]', { allow: true, end: 'stop' })
    await run('Harbor: plan', h, 'Plan and ship the 0.2.0 release notes [mock:exec-plan]', { allow: true, end: 'live' })
    await run('Harbor: blocked plan', h, 'Move the store to SQLite [mock:exec-blocked]', { allow: true, end: 'stop' })
    await run('Harbor: media', h, 'Show me the request flow screenshot for the notes route [mock:media]', { allow: true, end: 'stop' })
    await run('Harbor: outputs', h, 'Produce the project pack: plan, budget, deck and diagrams [mock:outputs-all]', { allow: true, end: 'stop' })
    await run('Harbor: outputs v2', h, 'Refresh the project pack after review [mock:outputs-v2]', { allow: true, end: 'stop' })
    await run('Harbor: provider error', h, 'Investigate why startup fails on Node 18 [mock:provider-error]', { until: 'settled', end: 'live' })
    await run('Harbor: budget stop', h, 'Cap the notes list at 500 entries [mock:budget-stop]', { until: 'settled', end: 'live', extra: { maxBudgetUsd: 2.5 } })
  }
  if (l) {
    await run('Lantern: finished', l, 'Draft the onboarding screen copy and wire it to the Home screen', { allow: true, end: 'stop', follow: ['Make the tone friendlier.'] })
    await run('Lantern: failed turn', l, 'Port the settings screen to the new theme [mock:turn-fail]', { until: 'settled', end: 'live' })
    await run('Lantern: staffing', l, 'Split the sync work across the team [mock:staffing]', { allow: true, end: 'stop' })
    await run('Lantern: provider retry', l, 'Check the retry behaviour on a flaky connection [mock:provider-retry]', { allow: true, end: 'stop' })
  }
  if (q) {
    await run('Quarry: finished', q, 'Profile the nightly import and suggest the three slowest steps', { allow: true, end: 'stop' })
    await run('Quarry: compaction', q, 'Walk the whole import code path end to end [mock:compact]', { allow: true, end: 'live' })
  }
  if (a) {
    await run('Acme: knowledge', a, 'Record the kickoff call: people, risks and decisions [mock:knowledge]', { allow: true, end: 'stop' })
    await run('Acme: outputs', a, 'Write the planning memo and the testing budget [mock:outputs]', { allow: true, end: 'stop' })
    await run('Acme: todo', a, 'Remind me to follow up on the export format [mock:todo]', { allow: true, end: 'stop' })
    await run('Acme: recall', a, 'What did we agree about billing with Acme? [mock:knowledge-recall]', { allow: true, end: 'live' })
  }
  if (b) {
    await run('Birch: finished', b, 'Compare the prior-year return with this year draft', { allow: true, end: 'stop' })
    await run('Birch: reference gate', b, 'Fix the typo in the source ledger notes [mock:reference-edit]', { allow: true, end: 'stop' })
    await run('Birch: knowledge', b, 'Record who signs for the clinic and the open risks [mock:knowledge]', { allow: true, end: 'live' })
  }
}

// ---------- Live and waiting runs (left open; they end when the app closes) ----------
async function liveRuns() {
  const h = P.harbor?.id
  const l = P.lantern?.id
  const a = P.acme?.id
  const b = P.birch?.id
  if (h) {
    // Reopened with --live, Harbor already has its spending limit, and the mock's default script ends on a report with no
    // known price: under a limit that run stops at once ("part of it used a model with no known price") and cannot take the
    // follow-up. [mock:computed-cost] gives that report a price. (Phase 2 runs before the limit is set and needs no marker.)
    const priced = LIVE ? ' [mock:computed-cost]' : ''
    await run('LIVE idle: Harbor', h, `Review the open pull request and summarise the risks${priced}`, { allow: true, end: 'live', follow: ['Please flag anything that touches the store.'] })
    await run('WAITING permission: Harbor', h, `Rename the notes route to memos and update the tests${priced}`, { until: 'card', end: 'live' })
    await run('WAITING question: Harbor', h, 'Choose the page size default for the list endpoint [mock:exec-question]', { until: 'card', end: 'live' })
    await run('WAITING proposal: Harbor (schedule)', h, 'Set up a nightly check for new pull requests [mock:schedule]', { until: 'card', end: 'live' })
  }
  if (l) {
    await run('LIVE idle: Lantern', l, 'Sketch the offline queue and the retry policy', { allow: true, end: 'live' })
    await run('WAITING permission: Lantern', l, 'Replace the hard-coded API URL with an environment variable', { until: 'card', end: 'live' })
    await run('WAITING proposal: Lantern (org change)', l, 'Add a tester to the team for the sync work [mock:org-change]', { until: 'card', end: 'live' })
  }
  if (a) await run('WAITING question: Acme', a, 'Ask the client which subsidiaries are in scope [mock:exec-question]', { until: 'card', end: 'live' })
  if (b) await run('WAITING permission: Birch', b, 'Draft the partner draw schedule memo', { until: 'card', end: 'live' })
  await run('Chat: live', null, 'Help me plan the quarter: three goals and what could slip', { chat: true, allow: true, end: 'live', follow: ['Turn that into a short checklist.'] })
  await run('Chat: waiting edit', null, 'Write my weekly notes into notes.md [mock:chat-edit]', { chat: true, until: 'card', end: 'live' })
}

// ---------- Data that is not a run ----------
async function otherData() {
  const h = P.harbor?.id
  const l = P.lantern?.id
  const q = P.quarry?.id
  const a = P.acme?.id
  const b = P.birch?.id

  const todos = [
    [{ kind: 'project', projectId: h }, [['Decide the default page size', 'Fifty is the working guess; the mobile client may want fewer.', 'open'], ['Add a rate limit to POST /notes', null, 'open'], ['Write the 0.2.0 changelog', 'Group by added, changed, fixed.', 'done'], ['Pin the Node version in CI', null, 'done']]],
    [{ kind: 'project', projectId: l }, [['Confirm the offline queue limit with the backend team', null, 'open'], ['Design the empty state for Home', 'Needs copy and an illustration.', 'open'], ['Fix the keyboard overlap on small phones', null, 'done']]],
    [{ kind: 'project', projectId: q }, [['Ask the partner for a sample with the new date format', null, 'open']]],
    [{ kind: 'project', projectId: a }, [['Request the FY25 trial balance', 'From the finance team, by Friday.', 'open'], ['Confirm the two subsidiaries in scope', null, 'open'], ['Send the engagement letter for signature', null, 'done']]],
    [{ kind: 'project', projectId: b }, [['Collect the equipment invoices for March and October', null, 'open'], ['Ask about the partner draw changes', null, 'done']]],
    [{ kind: 'chat' }, [['Book the quarterly planning slot', null, 'open'], ['Reply to the vendor about the renewal', 'They need an answer before the end of the month.', 'open'], ['Archive last quarter notes', null, 'done']]]
  ]
  for (const [scope, items] of todos) {
    if (scope.kind === 'project' && !scope.projectId) continue
    await step(`todos: ${scope.kind} ${scope.projectId ?? ''}`.trim(), async () => {
      for (const [title, detail, status] of items) {
        const saved = await ev(async ([scope, title, detail]) => window.orgai.todos.save({ scope, title, ...(detail ? { detail } : {}) }), [scope, title, detail])
        if (status === 'done') await ev(([scope, id]) => window.orgai.todos.save({ id, scope, status: 'done' }), [scope, saved.id ?? saved.item?.id])
        count('to-dos')
      }
    })
  }

  const schedules = [
    h && { name: 'Morning repository digest', prompt: 'Summarise yesterday commits and open pull requests for the team.', target: { kind: 'team', projectId: h }, timing: { kind: 'daily', time: '07:30', days: [1, 2, 3, 4, 5] }, enabled: true },
    a && { name: 'Weekly audit status for Acme', prompt: 'Write the weekly status: what was tested, what is open, what the client owes us.', target: { kind: 'team', projectId: a }, timing: { kind: 'cron', expression: '0 9 * * 1' }, enabled: true },
    l && { name: 'Dependency check (paused while the freeze is on)', prompt: 'Check the dependencies for known issues and list the upgrades worth doing.', target: { kind: 'team', projectId: l }, timing: { kind: 'daily', time: '03:00' }, enabled: false }
  ].filter(Boolean)
  for (const s of schedules) {
    await step(`schedule: ${s.name}`, async () => {
      const saved = await ev((s) => window.orgai.schedules.save(s), s)
      if (!s.enabled) await ev((id) => window.orgai.schedules.setEnabled({ id, enabled: false }), saved.id)
      count('schedules')
    })
  }

  const notes = [
    [a, 'Kickoff call, 3 March', '# Kickoff call\n\nAttendees: Jane Doe (CFO), two finance leads.\n\n- Year end is 31 December\n- Revenue cut-off was the FY24 observation\n- Client prefers one weekly status mail\n'],
    [a, 'Controls walkthrough', '# Controls walkthrough\n\nThe month-end close has a manual journal step with no second review.\n\n| control | owner | tested |\n| --- | --- | --- |\n| journal review | Controller | no |\n| bank rec | Accountant | yes |\n'],
    [a, 'Open questions for the client', '1. Which subsidiaries are in scope?\n2. Is the new billing system live for the whole year?\n3. Who signs the representation letter?\n'],
    [b, 'Partner draw history', 'Draws were monthly until June, then quarterly. Two partners, equal shares. See https://example.com/clinic/records/partner-draws-2024-2025-quarterly-schedule-with-a-very-long-address.'],
    [b, 'Equipment purchases', 'March: ultrasound unit. October: two exam tables. Check the depreciation method used last year.']
  ]
  for (const [pid, title, text] of notes) {
    if (!pid) continue
    await step(`note: ${title}`, async () => {
      await ev(([projectId, title, text]) => window.orgai.engagement.saveNote({ projectId, title, text }), [pid, title, text])
      count('notes')
    })
  }
  for (const [pid, text] of [[a, '# Acme Corp FY25 audit\n\n## Objective\nAn unqualified opinion on the FY25 statements, with the revenue cut-off finding closed.\n\n## Approach\n- Planning in March\n- Interim controls testing in June\n- Final fieldwork in February\n\n## Who it is for\nThe finance team at Acme Corp, and the audit committee.\n'], [b, '# Birch Street Clinic tax review\n\n## Objective\nFile on time, claim the equipment correctly, and agree a draw schedule the partners can plan around.\n']]) {
    if (!pid) continue
    await step('engagement document', async () => {
      await ev(([projectId, text]) => window.orgai.engagement.updateDocument({ projectId, text }), [pid, text])
      count('engagement documents')
    })
  }

  const kn = [
    [b, 'organisation', 'Birch Street Clinic', 'Two-partner clinic, cash basis.', ['Fiscal year ends 31 December', 'Files on extension most years']],
    [b, 'person', 'Dr Mara Quinn', 'Managing partner.', ['Signs the return', 'Prefers email']],
    [b, 'decision', 'Move to quarterly draws', 'Agreed in June.', ['Effective from the third quarter']],
    [b, 'risk', 'Equipment depreciation method differs from last year', 'Could change the deduction.', ['Check with the prior preparer']],
    [a, 'person', 'Samir Patel', 'Group controller at Acme Corp.', ['Owns the month-end close']],
    [a, 'system', 'Billing platform', 'Replaced the legacy invoicing tool in July.', ['Legacy export is XLSX only']]
  ]
  const ids = new Map()
  for (const [pid, kind, name, summary, facts] of kn) {
    if (!pid) continue
    await step(`knowledge: ${name}`, async () => {
      const n = await ev(([projectId, kind, name, summary, facts]) => window.orgai.knowledge.saveNode({ projectId, kind, name, summary, facts: facts.map((text) => ({ text })) }), [pid, kind, name, summary, facts])
      ids.set(`${pid}:${name}`, n.id ?? n.node?.id)
      count('knowledge entries')
    })
  }
  const links = [[b, 'Dr Mara Quinn', 'Birch Street Clinic', 'works at'], [b, 'Move to quarterly draws', 'Dr Mara Quinn', 'decided by'], [b, 'Equipment depreciation method differs from last year', 'Birch Street Clinic', 'affects'], [a, 'Samir Patel', 'Billing platform', 'owns']]
  for (const [pid, from, to, relation] of links) {
    if (!pid) continue
    await step(`knowledge link: ${from} -> ${to}`, async () => {
      const f = ids.get(`${pid}:${from}`)
      const t2 = ids.get(`${pid}:${to}`)
      if (!f || !t2) throw new Error('node missing')
      await ev(([projectId, from, to, relation]) => window.orgai.knowledge.saveEdge({ projectId, from, to, relation }), [pid, f, t2, relation])
      count('knowledge links')
    })
  }

  if (h) {
    await step('settings: spending limit on Harbor', async () => {
      await ev(async (id) => {
        const p = await window.orgai.projects.get(id)
        await window.orgai.projects.save({ ...p, maxBudgetUsd: 25 })
      }, h)
      count('spending limits')
    })
  }

  // Notes on outputs (an output with more than one version gets a note on each of two).
  if (h) {
    await step('output notes', async () => {
      const outs = await ev((id) => window.orgai.outputs.list(id), h)
      let n = 0
      for (const o of outs.slice(0, 3)) {
        const versions = o.version ?? o.latestVersion ?? 1
        await ev(([projectId, outputId, version, text]) => window.orgai.outputs.noteAdd({ projectId, outputId, version, anchor: { type: 'whole' }, text }), [h, o.id, versions, n === 0 ? 'Please add the rollout dates before this goes to the client.' : 'Check the totals against the budget sheet.'])
        n++
      }
      count('output notes', n)
    })
  }
}

// ---------- Backdate: spread the stored runs over the last two weeks so Home and Usage show history ----------
function backdateRuns() {
  // Edits the run records and the runs index while the app is closed: every epoch-ms value inside a record (and inside its
  // index entry) moves by the same amount, so durations and order inside a run are kept. The newest runs stay on today.
  const base = path.join(DATA_DIR, 'data')
  const dir = path.join(base, 'runs')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []
  if (!files.length) throw new Error(`no run records in ${dir}`)
  const DAY = 86_400_000
  const now = Date.now()
  const shiftOf = new Map()
  const move = (v, shift, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 12) return
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'number' && x > now - 4 * DAY && x < now + DAY) v[k] = x - shift
      else move(x, shift, depth + 1)
    }
  }
  const keep = 8
  files.forEach((f, i) => {
    if (i >= files.length - keep) return
    const daysAgo = 1 + Math.floor((i / Math.max(1, files.length - keep)) * 13)
    const shift = daysAgo * DAY + (i % 5) * 3_600_000
    const file = path.join(dir, f)
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    shiftOf.set(rec.summary?.id, shift)
    move(rec, shift)
    fs.writeFileSync(file, JSON.stringify(rec))
  })
  const indexFile = path.join(base, ['runs', 'json'].join('.'))
  if (fs.existsSync(indexFile)) {
    const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    for (const r of idx.runs ?? []) if (shiftOf.has(r.id)) move(r, shiftOf.get(r.id))
    fs.writeFileSync(indexFile, JSON.stringify(idx, null, 2))
  }
  return shiftOf.size
}

// ---------- Main ----------
try {
  if (LIVE) {
    await open(false)
    await loadProjects()
    if (!P.harbor) {
      console.error('seed-review --live: this folder has no seeded projects. Run the seed first.')
      await closeApp()
      process.exit(2)
    }
    await liveRuns()
    console.log('\nLive and waiting runs are open. Close the window (or press Ctrl+C) to end.')
    await new Promise((resolve) => app.on('close', resolve))
    app = undefined
  } else {
    // Phase 1: the custom script (long Markdown).
    writeLongScript()
    await open(true)
    const existing = await ev(() => window.orgai.projects.list())
    if (existing.length && !FORCE) {
      console.error(`seed-review: ${DATA_DIR} already holds ${existing.length} project(s). Nothing was changed. Use --force to add to it.`)
      await closeApp()
      process.exit(2)
    }
    await createProjects()
    await longRuns()
    await closeApp()

    // Phase 2: the default script and its markers.
    await open(false)
    await loadProjects()
    await projectRuns()
    await liveRuns()
    await otherData()
    await sleep(1500)
    await closeApp()

    if (BACKDATE) {
      await step('backdate run records', async () => {
        const n = backdateRuns()
        count('run records backdated', n)
      })
    }
  }
} finally {
  await closeApp()
}

console.log('\n=== seed-review summary ===')
console.log(`data folder: ${DATA_DIR}`)
console.log(`work folders: ${WORK}`)
for (const [k, v] of Object.entries(made)) console.log(`  ${k}: ${v}`)
console.log('runs:')
for (const [k, v] of results) console.log(`  ${k}: ${v}`)
if (skipped.length) console.log(`skipped:\n  ${skipped.join('\n  ')}`)
if (failed.length) console.log(`FAILED steps (${failed.length}):\n  ${failed.join('\n  ')}`)
else console.log('no failed steps')
