// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Schedules (docs/design/schedules.md): the Schedules page (sidebar
// nav-schedules, empty state, New schedule form with validation, three next runs, Run now with its history row and the
// "Scheduled: <name>" run meta, Pause / Resume, Edit, Delete with confirm, an ask (Chat) target), the conversation path
// (a `[mock:schedule]` Chat run raises the proposal-schedules card; Approve saves it, Not now saves nothing), a due-time
// fire (`[mock:schedule-once]` fires 10 s ahead; ORGAI_SCHEDULE_TEST_TICK_MS shortens the scheduler's wake interval),
// Pause all (banner, a due slot is recorded as skipped and does not start, Run now still works) and persistence (restart
// on the same data dir: schedules and history are back, no slot fires twice). Waits on conditions, not fixed sleeps.
// A check on a known integration defect logs KNOWN: and is skipped so the rest still runs.
import { TMP, check, createProject, endSession, finish, launch, log, makeFixtureRepo, relaunch, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
process.env.ORGAI_SCHEDULE_TEST_TICK_MS = '200'

const PROJECT = 'E2E schedules (orgai test)'
const repo = makeFixtureRepo('schedules')
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const known = (what, why) => log(`KNOWN: ${what} -- ${why}`)

let { app, page, shot } = await launch({ shotPrefix: 'schedules' })
page.setDefaultTimeout(10_000)

const T = (id) => page.locator(`[data-testid=${id}]`)
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const row = (name) => T('schedule-row').filter({ has: page.locator('.schedule-row-name', { hasText: name }) })
/** Poll `fn` until it returns a truthy value (returned) or the deadline passes (null). */
async function until(fn, ms = 20_000, every = 250) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
const list = () => page.evaluate(() => window.orgai.schedules.list())
const history = (id) => page.evaluate((i) => window.orgai.schedules.history(i), id)
const goSchedules = async () => {
  await T('nav-schedules').click()
  await T('schedules-view').waitFor({ timeout: 10_000 })
  await until(async () => (await T('schedules-loading').count()) === 0, 10_000)
}
const menu = (id) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)
const startField = () => page.locator('[data-testid=assistant-start-quick] .composer textarea')
const mainText = () => page.evaluate(() => document.querySelector('#main-content')?.textContent ?? '')
const waitMain = (needle, ms = 30_000) => until(async () => (await mainText()).includes(needle), ms)

/** Stop every run a schedule started that is still live (a mock run parks on a permission card), so the overlap rule never blocks a later step. */
async function stopScheduledRuns() {
  await page.evaluate(async () => {
    for (const s of await window.orgai.schedules.list()) {
      for (const h of await window.orgai.schedules.history(s.id)) {
        if (h.result === 'started' && h.runId) await window.orgai.runs.stop(h.runId).catch(() => {})
      }
    }
  })
  await sleep(1500)
}

/** A fresh Chat, the prompt sent. */
async function startChat(prompt) {
  await menu('ask-about-orgai')
  await T('assistant-start-quick').waitFor({ timeout: 10_000 })
  await startField().fill(prompt)
  await startField().press('Enter')
  await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 })
}

/**
 * Wait for the schedules proposal card body to be in the DOM, then open it. In a compact frame (the CI runners' small
 * windows) the decision card keeps its body collapsed behind a Details toggle, so the body is attached but not visible
 * until Details is pressed; on a big window there is no toggle. On a miss, log the Chat run's state for the next CI read.
 */
async function awaitSchedulesCard(ms = 40_000) {
  await T('proposal-schedules').waitFor({ state: 'attached', timeout: ms }).catch(() => {})
  const toggle = page.locator('.decision-card[data-kind=proposal] .decision-details').first()
  if ((await toggle.count()) > 0 && (await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await T('proposal-schedules').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await visible('[data-testid=proposal-schedules]')) return
  const diag = await page
    .evaluate(async () => {
      const tab = document.querySelector('.run-tab[aria-selected=true]')
      const scheduled = !!document.querySelector('[data-testid=run-meta-scheduled]')
      const cards = Array.from(document.querySelectorAll('.decision-card')).map((c) => ({ kind: c.getAttribute('data-kind'), expanded: c.getAttribute('data-expanded') }))
      return { tab: tab?.textContent?.slice(0, 80), scheduledRun: scheduled, cards, main: (document.querySelector('#main-content')?.textContent ?? '').slice(-300) }
    })
    .catch((e) => ({ error: String(e) }))
  log('DIAG schedules card missing:', JSON.stringify(diag))
}

/** Open the editor, fill the common fields. */
async function openEditor() {
  await T('schedules-new').click()
  await T('schedule-editor').waitFor({ timeout: 10_000 })
}
async function fillBasics(name, prompt) {
  await T('schedule-field-name').fill(name)
  await T('schedule-field-prompt').fill(prompt)
}

try {
  // A mock project for the team target.
  const proj = await createProject(page, { path: repo, name: PROJECT })
  check(!!proj, 'seed: the mock project exists')

  // ---------- 1. Navigation and empty state ----------
  await goSchedules()
  check(await visible('[data-testid=schedules-view]'), '1 nav-schedules opens the Schedules page')
  check((await T('nav-schedules').getAttribute('aria-current')) === 'page', '1 nav-schedules has aria-current=page')
  check(await visible('[data-testid=schedules-empty]'), '1 the empty state shows with no schedules')
  check(/No schedules yet/.test(await T('schedules-empty').innerText()), '1 the empty state title reads "No schedules yet"')
  check(/Ask in Chat, for example/.test(await T('schedules-empty').innerText()), '1 the empty state teaches the chat path')
  check(await visible('[data-testid=schedules-new]'), '1 the New schedule button is in the page header')
  check(await visible('[data-testid=schedules-empty-new]'), '1 the empty state has its own New schedule button')
  check(!(await visible('[data-testid=schedules-paused-banner]')), '1 no paused banner on a fresh data dir')
  await shot('empty')

  // ---------- 2. Form create and validation ----------
  await openEditor()
  await T('schedule-save').click()
  await T('schedule-error-name').waitFor({ timeout: 5000 }).catch(() => {})
  check(clean(await T('schedule-error-name').innerText().catch(() => '')) === 'Give the schedule a name.', '2 an empty name is refused with a visible message')
  check(/Say what the schedule should do/.test(await T('schedule-error-prompt').innerText().catch(() => '')), '2 an empty prompt is refused with a visible message')
  check(await visible('[data-testid=schedule-editor]'), '2 the editor stays open after a refused save')
  check((await list()).length === 0, '2 nothing was saved by the empty-name save')

  await fillBasics('E2E nightly team', 'Check the repository and report what needs attention.')
  await T('schedule-field-preset').selectOption('custom')
  await T('schedule-field-cron').fill('*/5 * * * *')
  await T('schedule-error-timing').waitFor({ timeout: 5000 }).catch(() => {})
  const cronMsg = clean(await T('schedule-error-timing').innerText().catch(() => ''))
  check(/apart.*shortest allowed gap is 15 minutes/.test(cronMsg), '2 a cron firing every 5 minutes shows the 15 minute rule at once', cronMsg)
  await T('schedule-save').click()
  await sleep(600)
  check(await visible('[data-testid=schedule-editor]'), '2 the editor stays open after saving a too-frequent cron')
  check((await list()).length === 0, '2 nothing was saved for the too-frequent cron')
  await T('schedule-field-cron').fill('* * * * *')
  check(/1 minute apart.*shortest allowed gap is 15 minutes/.test(clean(await T('schedule-error-timing').innerText().catch(() => ''))), '2 "* * * * *" is refused (1 minute apart, shortest allowed gap 15)', clean(await T('schedule-error-timing').innerText().catch(() => '')))
  await shot('cron-refused')

  await T('schedule-field-preset').selectOption('daily')
  await T('schedule-field-time').fill('09:30')
  await until(async () => (await T('schedule-next-run').count()) === 3, 5000)
  check((await T('schedule-next-run').count()) === 3, '2 Daily at 09:30 shows three next runs', String(await T('schedule-next-run').count()))
  check(/Every day at 09:30/.test(await T('schedule-next-runs').innerText()), '2 the timing is described in words')
  check(/Runs only while OrgAI is open/.test(await T('schedule-unattended-note').innerText()), '2 the editor carries the unattended note')
  check(await T('schedule-field-target-team').isChecked(), '2 the team target is the default')
  const projChosen = await T('schedule-field-project').evaluate((s) => s.options[s.selectedIndex]?.textContent)
  check(projChosen === PROJECT, '2 the mock project is selected', String(projChosen))
  await shot('editor-filled')
  await T('schedule-save').click()
  await T('schedule-editor').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  const rowA = row('E2E nightly team')
  await rowA.waitFor({ timeout: 10_000 }).catch(() => {})
  check((await rowA.count()) === 1, '2 the row appears after Save')
  check((await rowA.getAttribute('data-state')) === 'Active', '2 the row state is Active', String(await rowA.getAttribute('data-state')))
  check(clean(await rowA.locator('[data-testid=schedule-state]').innerText()) === 'Active', '2 the state chip reads Active')
  check(/Every day at 09:30/.test(await rowA.locator('[data-testid=schedule-timing]').innerText()), '2 the row shows the timing')
  const nextA = clean(await rowA.locator('[data-testid=schedule-next]').innerText())
  check(nextA.length > 0 && !/Held|Not scheduled/i.test(nextA), '2 the row shows a next run', nextA)
  check((await rowA.locator('[data-testid=schedule-target]').innerText()).includes(PROJECT), '2 the row names the project as target')
  check((await list()).length === 1, '2 exactly one schedule is stored')
  const idA = (await list())[0].id
  check((await list())[0].createdBy === 'user', '2 a form save is createdBy user')
  await shot('row-created')

  // ---------- 3. Run now ----------
  await rowA.locator('[data-testid=schedule-run-now]').click()
  const startedA = await until(async () => (await history(idA)).some((h) => h.result === 'started' && h.trigger === 'manual'), 20_000)
  check(!!startedA, '3 Run now records a started history entry with trigger manual', JSON.stringify(await history(idA)))
  await rowA.locator('[data-testid=schedule-history-toggle]').click()
  await rowA.locator('[data-testid=schedule-history-row]').first().waitFor({ timeout: 10_000 }).catch(() => {})
  const hrow = rowA.locator('[data-testid=schedule-history-row]').first()
  check((await hrow.getAttribute('data-result')) === 'started', '3 the history row is a started row', String(await hrow.getAttribute('data-result')))
  check(/Run now/.test(await hrow.innerText()), '3 the history row reads trigger "Run now"', clean(await hrow.innerText()))
  check(/Started/.test(await hrow.innerText()), '3 the history row reads Started')
  const ended = await until(async () => (await history(idA)).find((h) => h.runId && h.outcome), 90_000, 500)
  check(!!ended, '3 the started run gets an outcome in the history (finished / stopped / needs-you)', JSON.stringify(await history(idA)))
  if (ended) {
    const shown = await until(async () => /Finished|Stopped|Failed|Needs you/.test(await rowA.locator('[data-testid=schedule-history-row]').first().innerText()), 10_000)
    check(!!shown, '3 the history row shows the outcome in words without reopening', clean(await rowA.locator('[data-testid=schedule-history-row]').first().innerText()))
    log('info: run outcome', ended.outcome, 'cost', String(ended.costUsd))
  }
  check(/Finished|Stopped|Needs you|Failed/.test(clean(await rowA.locator('[data-testid=schedule-last]').innerText())) || true, '3 (info) last result: ' + clean(await rowA.locator('[data-testid=schedule-last]').innerText()))
  await rowA.locator('[data-testid=schedule-history-open]').first().click()
  await page.waitForSelector('[data-testid=run-meta]', { timeout: 20_000 }).catch(() => {})
  check(await visible('[data-testid=run-meta]'), '3 Open run opens the run view')
  const metaLabel = clean(await T('run-meta-scheduled').innerText().catch(() => ''))
  check(metaLabel.includes('Scheduled: E2E nightly team'), '3 the run meta shows "Scheduled: <schedule name>"', metaLabel)
  const runSummaryA = await page.evaluate((id) => window.orgai.schedules.history(id).then((h) => h.find((x) => x.runId)?.runId).then((rid) => window.orgai.runs.get(rid)), idA)
  check(runSummaryA?.summary?.scheduleId === idA && runSummaryA.summary.scheduleName === 'E2E nightly team', '3 the run summary carries scheduleId and scheduleName', JSON.stringify({ id: runSummaryA?.summary?.scheduleId, name: runSummaryA?.summary?.scheduleName }))
  await shot('scheduled-run')
  await T('run-meta-scheduled').click()
  await T('schedules-view').waitFor({ timeout: 10_000 }).catch(() => {})
  check(await visible('[data-testid=schedules-view]'), '3 the run meta label opens the Schedules page')
  const focusedRow = await until(async () => page.evaluate(() => document.activeElement?.closest('[data-testid=schedule-row]')?.getAttribute('data-schedule-id')), 5000)
  check(focusedRow === idA, '3 focus lands on that schedule row', String(focusedRow))
  await endSession(page).catch(() => {})

  // ---------- 4. Pause / Resume, Edit, Delete ----------
  await goSchedules()
  await rowA.locator('[data-testid=schedule-toggle]').click()
  await until(async () => (await rowA.getAttribute('data-state')) === 'Paused', 10_000)
  check((await rowA.getAttribute('data-state')) === 'Paused', '4 Pause moves the row to Paused', String(await rowA.getAttribute('data-state')))
  check(clean(await rowA.locator('[data-testid=schedule-toggle]').innerText()) === 'Resume', '4 the action reads Resume while paused')
  check((await list())[0].enabled === false, '4 the stored schedule is disabled')
  await rowA.locator('[data-testid=schedule-toggle]').click()
  await until(async () => (await rowA.getAttribute('data-state')) === 'Active', 10_000)
  check((await rowA.getAttribute('data-state')) === 'Active', '4 Resume moves the row back to Active')
  check(clean(await rowA.locator('[data-testid=schedule-toggle]').innerText()) === 'Pause', '4 the action reads Pause again')

  const beforeNext = clean(await rowA.locator('[data-testid=schedule-next]').innerText())
  await rowA.locator('[data-testid=schedule-edit]').click()
  await T('schedule-editor').waitFor({ timeout: 10_000 })
  check((await T('schedule-field-name').inputValue()) === 'E2E nightly team', '4 Edit loads the stored name')
  check((await T('schedule-field-time').inputValue()) === '09:30', '4 Edit loads the stored time')
  await T('schedule-field-time').fill('21:45')
  await T('schedule-save').click()
  await T('schedule-editor').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  await until(async () => /21:45/.test(await rowA.locator('[data-testid=schedule-timing]').innerText()), 10_000)
  const afterNext = clean(await rowA.locator('[data-testid=schedule-next]').innerText())
  check(/Every day at 21:45/.test(await rowA.locator('[data-testid=schedule-timing]').innerText()), '4 Edit changes the timing text to 21:45')
  check(afterNext !== beforeNext && /21:45/.test(afterNext), '4 the next run text changes with the time', `${beforeNext} -> ${afterNext}`)
  check((await list())[0].timing.time === '21:45', '4 the stored timing is 21:45')

  // Delete: a throwaway created through the IPC (the form was exercised above).
  const throwaway = await page.evaluate((pid) => window.orgai.schedules.save({ name: 'E2E throwaway', prompt: 'Nothing.', target: { kind: 'team', projectId: pid }, timing: { kind: 'daily', time: '03:00' }, enabled: true }), proj.id)
  await goSchedules()
  await until(async () => (await row('E2E throwaway').count()) === 1, 10_000)
  check((await row('E2E throwaway').count()) === 1, '4 a second schedule shows in the list (live push or reload)')
  await row('E2E throwaway').locator('[data-testid=schedule-delete]').click()
  await T('schedule-delete-confirm').waitFor({ timeout: 5000 })
  check(await visible('[data-testid=schedule-delete-confirm]'), '4 Delete asks for confirmation')
  check((await row('E2E throwaway').count()) === 1, '4 the row stays until the confirm')
  await T('schedule-delete-confirm').click()
  await until(async () => (await row('E2E throwaway').count()) === 0, 10_000)
  check((await row('E2E throwaway').count()) === 0, '4 confirming Delete removes the row')
  check(!(await list()).some((s) => s.id === throwaway.id), '4 the schedule is gone from the store')
  check((await history(throwaway.id).catch(() => [])).length === 0, '4 its history is gone too')
  check((await row('E2E nightly team').count()) === 1, '4 the other schedule is untouched')

  // ---------- 5. Ask (Chat) target ----------
  await openEditor()
  await T('schedule-field-target-ask').check({ force: true })
  await fillBasics('E2E chat ask', 'Say hello from a schedule.')
  await T('schedule-field-preset').selectOption('daily')
  await T('schedule-field-time').fill('08:15')
  check(!(await visible('[data-testid=schedule-field-project]')), '5 the project picker is hidden for a Chat target')
  await T('schedule-save').click()
  await T('schedule-editor').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  const rowB = row('E2E chat ask')
  await rowB.waitFor({ timeout: 10_000 }).catch(() => {})
  check((await rowB.count()) === 1 && (await rowB.getAttribute('data-state')) === 'Active', '5 the Chat schedule row appears Active')
  check(/Chat/.test(await rowB.locator('[data-testid=schedule-target]').innerText()), '5 the row target reads Chat', clean(await rowB.locator('[data-testid=schedule-target]').innerText()))
  const idB = (await list()).find((s) => s.name === 'E2E chat ask')?.id
  check((await list()).find((s) => s.id === idB)?.target.kind === 'ask', '5 the stored target kind is ask')
  await rowB.locator('[data-testid=schedule-run-now]').click()
  const startedB = await until(async () => (await history(idB)).find((h) => h.result === 'started'), 20_000)
  check(!!startedB && startedB.trigger === 'manual', '5 Run now on the Chat schedule starts a run', JSON.stringify(await history(idB)))
  if (startedB) {
    const rec = await page.evaluate((rid) => window.orgai.runs.get(rid), startedB.runId)
    check(!!rec?.summary?.quick && rec.summary.scheduleId === idB, '5 the started run is a Chat (quick) run carrying the scheduleId', JSON.stringify({ quick: !!rec?.summary?.quick, sid: rec?.summary?.scheduleId }))
    await rowB.locator('[data-testid=schedule-history-toggle]').click()
    await rowB.locator('[data-testid=schedule-history-open]').first().waitFor({ timeout: 10_000 }).catch(() => {})
    await rowB.locator('[data-testid=schedule-history-open]').first().click()
    await page.waitForSelector('[data-testid=run-meta]', { timeout: 20_000 }).catch(() => {})
    check(await visible('[data-testid=run-meta-scheduled]'), '5 the Chat run meta shows the Scheduled label')
    check(/Scheduled: E2E chat ask/.test(clean(await T('run-meta-scheduled').innerText().catch(() => ''))), '5 the label names the Chat schedule')
    await shot('chat-scheduled-run')
  }
  await endSession(page).catch(() => {})
  await until(async () => (await history(idB)).some((h) => h.outcome), 60_000, 500)

  // ---------- 6. Conversation path ----------
  await goSchedules()
  const beforeIds = (await list()).map((s) => s.id)
  await startChat('Please watch my pull requests [mock:schedule]')
  await awaitSchedulesCard()
  check(await visible('[data-testid=proposal-schedules]'), '6 the proposal-schedules card shows in the Chat run')
  const card = T('proposal-schedules')
  check((await T('proposal-schedule-item').count()) === 1, '6 the card lists one item')
  const itemText = clean(await T('proposal-schedule-item').innerText().catch(() => ''))
  check(itemText.includes('Nightly PR monitor') && /Create|New/i.test(itemText), '6 the item names "Nightly PR monitor" as a create', itemText)
  check((await T('proposal-schedule-item').getAttribute('data-action')) === 'create', '6 the item action is create')
  check(/Every day at 00:00/.test(itemText), '6 the item says Every day at 00:00', itemText)
  const nextText = clean(await T('proposal-schedule-next').innerText().catch(() => ''))
  check(nextText.split(',').length >= 3 && !/No upcoming/.test(nextText), '6 the card lists three next runs', nextText)
  const noteText = clean(await T('proposal-schedule-note').innerText().catch(() => ''))
  check(/Runs only while OrgAI is open\. Each run uses tokens\./.test(noteText) && /waits for you/.test(noteText), '6 the unattended sentence is on the card', noteText)
  void card
  await shot('proposal-card')
  await T('proposal-approve').click()
  check(!!(await waitMain('APPROVED: the schedule is saved.')), '6 the mock answers APPROVED after Approve')
  const afterApprove = await list()
  const nightly = afterApprove.find((s) => s.name === 'Nightly PR monitor')
  check(!!nightly && !beforeIds.includes(nightly.id), '6 the approved schedule is stored', JSON.stringify(afterApprove.map((s) => s.name)))
  check(nightly?.createdBy === 'agent', '6 an approved proposal is createdBy agent', String(nightly?.createdBy))
  check(nightly?.target.kind === 'ask', '6 from Chat the target is ask', JSON.stringify(nightly?.target))
  await goSchedules()
  await row('Nightly PR monitor').waitFor({ timeout: 10_000 }).catch(() => {})
  check((await row('Nightly PR monitor').count()) === 1, '6 the Schedules page lists "Nightly PR monitor"')
  check(/Added from a chat/.test(await row('Nightly PR monitor').innerText().catch(() => '')), '6 the row says it was added from a chat')

  // Decline once: nothing saved.
  const countBeforeDecline = (await list()).length
  await startChat('Please watch my pull requests again [mock:schedule]')
  await awaitSchedulesCard()
  check(await visible('[data-testid=proposal-schedules]'), '6 a second card shows for the decline run')
  await T('proposal-decline').click()
  await T('proposal-decline-send').click()
  check(!!(await waitMain('DECLINED: I left your schedules alone.')), '6 the mock answers DECLINED after Not now')
  check((await list()).length === countBeforeDecline, '6 declining saves nothing', `${countBeforeDecline} -> ${(await list()).length}`)
  await goSchedules()
  check((await row('Nightly PR monitor').count()) === 1, '6 the page still lists exactly one "Nightly PR monitor"')

  // Delete the Chat-made one so later names stay unambiguous.
  await row('Nightly PR monitor').locator('[data-testid=schedule-delete]').click()
  await T('schedule-delete-confirm').click()
  await until(async () => (await row('Nightly PR monitor').count()) === 0, 10_000)
  check((await row('Nightly PR monitor').count()) === 0, '6 (cleanup) the Chat-made schedule is deleted')

  // ---------- 8. Pause all (before the due-time fire, so a due slot lands while paused) ----------
  await goSchedules()
  check(!(await visible('[data-testid=schedules-paused-banner]')), '8 no banner before Pause all')
  await T('schedules-pause-all').click()
  await T('schedules-paused-banner').waitFor({ timeout: 10_000 }).catch(() => {})
  check(await visible('[data-testid=schedules-paused-banner]'), '8 the Pause all switch shows the banner')
  check(/All schedules are paused/.test(await T('schedules-paused-banner').innerText().catch(() => '')), '8 the banner explains the pause')
  check((await page.evaluate(() => window.orgai.settings.get())).schedulesPaused === true, '8 the pause is saved in settings (schedulesPaused)')
  check(/Held: all schedules paused/.test(await rowA.locator('[data-testid=schedule-next]').innerText()), '8 rows read "Held: all schedules paused"', clean(await rowA.locator('[data-testid=schedule-next]').innerText()))
  await shot('paused-all')

  // A once schedule due 10 s ahead is approved while paused.
  const idsBeforeOnce1 = (await list()).map((s) => s.id)
  await startChat('Remind me once [mock:schedule-once]')
  await awaitSchedulesCard()
  check(/Once on/.test(clean(await T('proposal-schedule-item').innerText().catch(() => ''))), '7 the once proposal says "Once on ..."', clean(await T('proposal-schedule-item').innerText().catch(() => '')))
  await T('proposal-approve').click()
  check(!!(await waitMain('APPROVED: the schedule is saved.')), '7 the mock answers APPROVED for the once schedule')
  const once1 = (await list()).find((s) => !idsBeforeOnce1.includes(s.id))
  check(!!once1 && once1.timing.kind === 'once', '7 the once schedule is stored', JSON.stringify(once1?.timing))
  if (once1) {
    // Run now still works while paused (spec 3, schedules:runNow).
    await goSchedules()
    const runsBefore = (await history(idA)).filter((h) => h.result === 'started').length
    await until(async () => (await row('E2E nightly team').count()) === 1, 5000)
    // The earlier manual run parked on a permission card; it would block a new one (previous-running), so end it.
    await stopScheduledRuns()
    await rowA.locator('[data-testid=schedule-run-now]').click()
    const runNowPaused = await until(async () => (await history(idA)).filter((h) => h.result === 'started').length > runsBefore, 20_000)
    check(!!runNowPaused, '8 Run now still starts a run while all schedules are paused', JSON.stringify((await history(idA)).slice(0, 2)))
    // The due slot passes while paused: one skipped paused-globally entry, no run.
    const skipped = await until(async () => (await history(once1.id)).find((h) => h.result === 'skipped'), 40_000, 400)
    check(!!skipped && skipped.reason === 'paused-globally', '8 a due schedule is recorded as skipped paused-globally while paused', JSON.stringify(await history(once1.id)))
    check(!(await history(once1.id)).some((h) => h.result === 'started'), '8 no run started for the due schedule while paused')
    const afterSkip = (await list()).find((s) => s.id === once1.id)
    log('info: once schedule after a paused slot:', afterSkip?.state, afterSkip?.stateReason ?? '', afterSkip?.nextRunAt ?? 'no next run')
    await sleep(1500)
    check((await history(once1.id)).filter((h) => h.result === 'skipped').length === 1, '8 one skipped entry per schedule per pause (not one per tick)')
  }
  await endSession(page).catch(() => {})
  await goSchedules()
  await T('schedules-pause-all').click()
  await until(async () => (await T('schedules-paused-banner').count()) === 0, 10_000)
  check(!(await visible('[data-testid=schedules-paused-banner]')), '8 turning Pause all off removes the banner')
  check((await page.evaluate(() => window.orgai.settings.get())).schedulesPaused !== true, '8 the pause is cleared in settings')

  // ---------- 7. Due-time fire ----------
  const idsBeforeOnce2 = (await list()).map((s) => s.id)
  await startChat('Remind me once more [mock:schedule-once]')
  await awaitSchedulesCard()
  await T('proposal-approve').click()
  check(!!(await waitMain('APPROVED: the schedule is saved.')), '7 the second once proposal is approved')
  const once2 = (await list()).find((s) => !idsBeforeOnce2.includes(s.id))
  check(!!once2, '7 the second once schedule is stored')
  if (once2) {
    const fired = await until(async () => (await history(once2.id)).find((h) => h.result === 'started'), 45_000, 400)
    check(!!fired, '7 the due time fires a started history entry', JSON.stringify(await history(once2.id)))
    if (fired) {
      check(fired.trigger === 'timer', '7 the entry trigger is timer', String(fired.trigger))
      check(!!fired.runId, '7 the entry carries the started run id')
      const rec = await page.evaluate((rid) => window.orgai.runs.get(rid), fired.runId).catch(() => null)
      check(rec?.summary?.scheduleId === once2.id, '7 the started run carries the scheduleId', String(rec?.summary?.scheduleId))
    }
    const doneS = await until(async () => (await list()).find((s) => s.id === once2.id && s.state === 'done'), 15_000)
    check(!!doneS, '7 the once schedule ends in state done', JSON.stringify((await list()).find((s) => s.id === once2.id)))
    const n1 = (await history(once2.id)).length
    await sleep(3000)
    check((await history(once2.id)).length === n1 && (await history(once2.id)).filter((h) => h.result === 'started').length === 1, '7 it does not fire again (15+ ticks later)', `${n1} -> ${(await history(once2.id)).length}`)
    await goSchedules()
    const r2 = T('schedule-row').filter({ has: page.locator(`[data-schedule-id="${once2.id}"]`) })
    void r2
    const r2row = page.locator(`[data-testid=schedule-row][data-schedule-id="${once2.id}"]`)
    check((await r2row.getAttribute('data-state')) === 'Done', '7 the row chip reads Done', String(await r2row.getAttribute('data-state')))
    check((await r2row.locator('[data-testid=schedule-toggle]').count()) === 0, '7 a Done schedule offers no Resume')
    await shot('done-row')
  }
  await endSession(page).catch(() => {})

  // ---------- 9. Persistence ----------
  // Let ended runs settle so the snapshot is stable.
  await until(async () => {
    const all = await list()
    for (const s of all) for (const h of await history(s.id)) if (h.result === 'started' && !h.outcome) return false
    return true
  }, 60_000, 500)
  const snap = async () => {
    const all = await list()
    const out = {}
    for (const s of all) out[s.id] = { name: s.name, state: s.state, hist: (await history(s.id)).map((h) => `${h.slotAt}:${h.trigger}:${h.result}:${h.reason ?? ''}`).sort() }
    return out
  }
  const before = await snap()
  log('persistence snapshot', Object.values(before).map((v) => `${v.name}[${v.state}]=${v.hist.length}`).join(', '))
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'schedules-restart' }))
  page.setDefaultTimeout(10_000)
  await goSchedules()
  await row('E2E nightly team').waitFor({ timeout: 10_000 }).catch(() => {})
  check((await row('E2E nightly team').count()) === 1 && (await row('E2E chat ask').count()) === 1, '9 after a restart the schedules are listed')
  await sleep(3000) // ~15 scheduler ticks; the boot catch-up delay is 30 s, but no slot is due anyway
  const after = await snap()
  check(JSON.stringify(Object.keys(after).sort()) === JSON.stringify(Object.keys(before).sort()), '9 the same schedule ids survive the restart')
  let same = true
  for (const id of Object.keys(before)) if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) same = false
  check(same, '9 history entries and states are identical after the restart (no slot fired twice)', JSON.stringify({ before, after }).slice(0, 600))
  const onceDone = Object.values(after).filter((v) => v.state === 'done').length
  check(onceDone >= 1, '9 the Done once schedule is still Done', String(onceDone))
  await row('E2E nightly team').locator('[data-testid=schedule-history-toggle]').click()
  await row('E2E nightly team').locator('[data-testid=schedule-history-row]').first().waitFor({ timeout: 10_000 }).catch(() => {})
  check((await row('E2E nightly team').locator('[data-testid=schedule-history-row]').count()) >= 2, '9 the history table still shows its rows after the restart')
  // A run that was live at quit: its outcome must not be left "Running" forever.
  const stuck = Object.keys(after).length ? await (async () => { for (const s of await list()) for (const h of await history(s.id)) if (h.result === 'started' && !h.outcome) return `${s.name}:${h.id}`; return null })() : null
  check(!stuck, '9 no started entry is left without an outcome after the restart', String(stuck))
  await shot('after-restart')
} catch (e) {
  check(false, 'schedules e2e ran to the end', e.stack?.split('\n').slice(0, 4).join(' | ') ?? e.message)
  await shot('failure').catch(() => {})
} finally {
  await endSession(page).catch(() => {})
  await app.close().catch(() => {})
  removeFixture(repo)
  void TMP
  void known
  finish('schedules')
}
