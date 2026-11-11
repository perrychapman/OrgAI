// Token-free (mock adapter, temp ORGAI_DATA_DIR, two mock-proxy connections). The run settings row: Model, Effort,
// Permission and Goal chips on the New run page (data-surface=start) and above the live composer (data-surface=live).
// docs/design/ux-review-run-start-pre.md. Check names carry a tag where a check needs more than this tree always has:
//   (live row)    needs the live composer's settings row (RunSettingsRow surface=live, run-permission-note, run-meta-permission)
//   (merged mock) needs the mock adapter that applies runs:setPermissionMode and the [mock:mode-refuse] /
//                 [mock:mode-reports-unchanged] markers
// Sections:
//   1 defaults   2 pick model / effort / permission / goal then Start   3 a start refusal keeps the draft
//   4 widening on the start page   5 mid-run narrowing   6 mid-run widening, confirm and cancel
//   7 ended run: saved for the next message   8 mock markers   9 keyboard pass   V sizes x themes
import { check, cleanup, finish, launch, log, makeFixtureRepo, openProject, projectTab, removeFixture, setReduceMotion, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E run start (orgai test)'
const repo = makeFixtureRepo('run-start')
const { app, page, shot } = await launch({ shotPrefix: 'run-start' })

const T = (id) => `[data-testid=${id}]`
const START_ROW = `${T('run-settings')}[data-surface=start]`
const LIVE_ROW = `${T('run-settings')}[data-surface=live]`
const MODE_NAME = { auto: 'Unattended', acceptEdits: 'Auto-accept edits', default: 'Ask for everything risky', dontAsk: 'Never ask', plan: 'Plan only', bypassPermissions: 'Bypass all prompts' }
const IDLE_MARK = '[mock:model-switch]'

let gatewayA = ''
let gatewayB = ''
let project

// ---------- helpers ----------

async function section(name, fn) {
  try {
    await fn()
  } catch (e) {
    check(false, `${name} runs to the end`, String(e.message ?? e).split('\n')[0])
    await shot(`failure-${name.replace(/\W+/g, '-')}`).catch(() => {})
  }
}

const mainSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => {
    const win = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('#/run/'))
    win.setContentSize(cw, ch)
  }, [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await sleep(250)
}
const setTheme = (theme) =>
  page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    const { dataDir: _d, appVersion: _v, ...rest } = s
    await window.orgai.settings.set({ ...rest, appearance: { ...rest.appearance, theme: t } })
  }, theme)

/** Reload the renderer (the store re-reads projects), open the project's New run page. */
async function reopen() {
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 60_000 })
  await openProject(page, NAME)
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  await page.locator(START_ROW).waitFor({ timeout: 10_000 })
  // The default model needs the project's connection catalog.
  await page.waitForFunction(() => !/Project default/.test(document.querySelector('[data-testid=run-model-current]')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => {})
}

const saveProject = (patch) =>
  page.evaluate(async ({ id, patch }) => {
    const p = (await window.orgai.projects.list()).find((x) => x.id === id)
    const root = p.roles.find((r) => r.reportsTo === null)
    const { rootEffort, ...rest } = patch
    return window.orgai.projects.save({
      ...p,
      ...rest,
      roles: p.roles.map((r) => (r.id === root.id && 'rootEffort' in patch ? { ...r, effort: rootEffort } : r))
    })
  }, { id: project.id, patch })

const runsOf = () => page.evaluate((id) => window.orgai.runs.list(id), project.id)
const getRun = (id) => page.evaluate((rid) => window.orgai.runs.get(rid), id)
async function newestRunAfter(count) {
  for (let i = 0; i < 100; i++) {
    const list = await runsOf()
    if (list.length > count) return [...list].sort((a, b) => b.startedAt - a.startedAt)[0]
    await sleep(100)
  }
  return undefined
}
const waitStatus = (id, statuses, timeout = 25_000) =>
  page.waitForFunction(async ({ id, statuses }) => statuses.includes((await window.orgai.runs.get(id))?.summary.status), { id, statuses }, { timeout, polling: 200 })
const startViaApi = async (prompt, extra = {}) => {
  const run = await page.evaluate((a) => window.orgai.runs.start(a), { projectId: project.id, prompt, ...extra })
  await waitStatus(run.id, ['idle'])
  return run
}

let view
async function openRunWindow(run, size) {
  for (const w of app.windows()) if (w !== page) await w.close().catch(() => {})
  view = undefined
  await page.evaluate((r) => window.orgai.window.openRun({ projectId: r.projectId, runId: r.id }), run)
  for (let i = 0; i < 60 && !view; i++) {
    view = app.windows().find((w) => w !== page)
    if (!view) await sleep(100)
  }
  if (!view) throw new Error('Run window did not open')
  view.setDefaultTimeout(10_000)
  await view.waitForSelector('.composer textarea', { timeout: 20_000 })
  if (size) {
    await app.evaluate(({ BrowserWindow }, { id, w, h }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(id))?.setContentSize(w, h), { id: run.id, w: size[0], h: size[1] })
    await sleep(300)
  }
  return view
}

/** Pick a mode in the permission popover of `p` (page or window) and press "Use this mode". */
async function chooseMode(p, mode) {
  await p.locator(T('run-permission-change')).click()
  await p.locator(T('run-permission-picker')).waitFor({ state: 'visible' })
  await p.locator(`${T('run-permission-choice')}[value="${mode}"]`).check()
  await p.locator(T('run-permission-apply')).click()
}
const activeTestId = (p) =>
  p.evaluate(() => {
    const el = document.activeElement
    return el?.getAttribute('data-testid') ?? (el?.tagName === 'TEXTAREA' ? 'TEXTAREA' : (el?.getAttribute('aria-label') ?? el?.tagName))
  })
const text = async (p, sel) => ((await p.locator(sel).first().innerText({ timeout: 5000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()

/**
 * Move keyboard focus to `selector` inside an open popover (a radio other than the one the Popover focused first),
 * retrying briefly while the panel finishes opening.
 */
async function focusInside(selector, p = page) {
  for (let i = 0; i < 40; i++) {
    const ok = await p.evaluate((sel) => {
      const el = document.querySelector(sel)
      el?.focus()
      return !!el && document.activeElement === el
    }, selector)
    if (ok) return
    await sleep(50)
  }
  throw new Error(`could not focus ${selector}`)
}

async function pickStartModel(modelId, connection) {
  await page.locator(T('run-model-change')).click()
  await page.locator(T('run-model-picker')).waitFor({ state: 'visible' })
  const choice = page.locator(`${T('run-model-choice')}[value="${modelId}"][data-connection="${connection}"]`)
  await choice.waitFor({ timeout: 15_000 })
  // The Popover is placed once; a catalog that loads after that can grow the panel past the window edge (see the V check).
  // Place it again so the rest of the flow can reach "Use this model".
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(100)
  await choice.check()
  await page.locator(T('run-model-apply')).click()
  await page.locator(T('run-model-picker')).waitFor({ state: 'hidden' })
}

try {
  await setReduceMotion(page, 'on')

  // ---------- setup: two mock gateways, a mock project on the first ----------
  const setup = await page.evaluate(async (repo) => {
    const a = await window.orgai.connections.createProxy({ name: 'Start gateway', kind: 'litellm', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'mock-key' })
    await window.orgai.connections.connect(a.connection.id)
    await window.orgai.connections.setDefault(a.connection.id)
    const b = await window.orgai.connections.createProxy({ name: 'Spare gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'mock-key' })
    await window.orgai.connections.connect(b.connection.id)
    const created = await window.orgai.projects.create({ path: repo, name: 'E2E run start (orgai test)', mock: true })
    const saved = await window.orgai.projects.save({ ...created, autoContinue: false, provider: { ...created.provider, connection: a.connection.id } })
    return { a: a.connection.id, b: b.connection.id, project: saved }
  }, repo)
  gatewayA = setup.a
  gatewayB = setup.b
  project = setup.project
  check(project.provider.id === 'mock' && project.provider.connection === gatewayA, 'fixture project is a mock project on the first gateway')
  await reopen()

  // ---------- 1. defaults ----------
  await section('defaults', async () => {
    check((await page.locator(START_ROW).count()) === 1, '1 the start page has one run settings row')
    check((await page.locator(T('run-settings-note')).count()) === 1, '1 run-settings-note appears once')
    const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid=run-settings] .popover-wrap > button')].map((b) => b.getAttribute('data-testid')))
    check(JSON.stringify(order) === JSON.stringify(['run-model-change', 'run-effort-change', 'run-permission-change', 'run-goal-change']), '1 chips are Model, Effort, Permission, Goal in that order', order.join(','))
    const model = await text(page, T('run-model-current'))
    check(/opus/i.test(model) && /Start gateway/.test(model), '1 Model chip shows the root model on the project connection', model)
    check((await text(page, T('run-effort-current'))) === 'Model default', '1 Effort chip says Model default while the root role sets none', await text(page, T('run-effort-current')))
    // Fresh mock projects start in Unattended (auto): a permissive default shows the warning tone, still the default.
    check((await text(page, T('run-permission-current'))) === MODE_NAME.auto, '1 Permission chip shows the project mode (Unattended)', await text(page, T('run-permission-current')))
    check((await page.locator(T('run-permission-change')).getAttribute('data-tone')) === 'warning', '1 a permissive project mode carries data-tone=warning')
    check((await text(page, T('run-goal-current'))) === 'Balanced', '1 Goal chip shows Balanced', await text(page, T('run-goal-current')))
    for (const id of ['run-model-change', 'run-effort-change', 'run-permission-change', 'run-goal-change']) {
      check((await page.locator(T(id)).getAttribute('data-default')) === 'true', `1 ${id} is data-default=true`)
    }

    // Now set a root effort and a plain project mode through the app and look again.
    await saveProject({ rootEffort: 'high', permissionMode: 'default' })
    await reopen()
    check((await text(page, T('run-effort-current'))) === 'High', '1 Effort chip shows the root role effort', await text(page, T('run-effort-current')))
    check((await page.locator(T('run-effort-change')).getAttribute('data-default')) === 'true', '1 the root role effort is still the default')
    check((await text(page, T('run-permission-current'))) === MODE_NAME.default, '1 Permission chip follows the saved project mode', await text(page, T('run-permission-current')))
    check((await page.locator(T('run-permission-change')).getAttribute('data-tone')) === null, '1 a plain project mode has no warning tone')

    // Copy that moved with this change.
    check((await page.locator('.composer textarea').getAttribute('placeholder')) === 'Describe the task', '1 the placeholder is "Describe the task" (the hint line carries the keys)')
    check((await text(page, '.composer-mode-label')) === 'New run', '1 the composer label is "New run"')
    check((await page.locator(T('new-run-mode-desc')).count()) === 0, '1 the Ask page duplicate line (new-run-mode-desc) is gone')
    await page.locator(T('run-goal-change')).click()
    await page.locator(T('run-goal-picker')).waitFor({ state: 'visible' })
    const goals = await page.locator(`${T('run-goal-picker')} .seg-item`).allTextContents()
    check(JSON.stringify(goals.map((g) => g.trim())) === JSON.stringify(['Balanced', 'Faster', 'Cheaper']), '1 goal options are Balanced / Faster / Cheaper', goals.join('|'))
    await page.keyboard.press('Escape')
    await page.locator(T('run-goal-picker')).waitFor({ state: 'hidden' })

    // Ask mode: lead line and the same settings row, goal hidden (it only shapes a team).
    await page.locator('[data-testid=new-run-mode] label', { hasText: 'Ask' }).click()
    check((await page.locator(T('new-run-ask-lead')).count()) === 1, '1 Ask page shows new-run-ask-lead')
    check((await page.locator(START_ROW).count()) === 1 && (await page.locator(T('run-goal-change')).count()) === 0, '1 Ask page keeps the settings row without the Goal chip')
    await page.locator('[data-testid=new-run-mode] label', { hasText: 'Team' }).click()
    await page.locator(T('run-goal-change')).waitFor()
  })

  // ---------- 4. widening on the start page ----------
  await section('start-widening', async () => {
    await chooseMode(page, 'bypassPermissions')
    await page.locator(T('run-permission-confirm')).waitFor({ state: 'visible' })
    check(true, '4 choosing Bypass opens the confirmation')
    await shot('widen-confirm')
    await page.getByRole('button', { name: 'Keep current mode', exact: true }).click()
    await page.locator(T('run-permission-confirm')).waitFor({ state: 'hidden' })
    check((await text(page, T('run-permission-current'))) === MODE_NAME.default, '4 "Keep current mode" keeps the old mode', await text(page, T('run-permission-current')))
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'run-permission-change', null, { timeout: 3000 }).catch(() => {})
    check((await activeTestId(page)) === 'run-permission-change', '4 focus returns to the permission chip after Keep current mode', await activeTestId(page))
    await chooseMode(page, 'bypassPermissions')
    await page.locator(T('run-permission-confirm')).click()
    await page.waitForFunction(() => document.querySelector('[data-testid=run-permission-current]')?.textContent === 'Bypass all prompts', null, { timeout: 5000 }).catch(() => {})
    check((await text(page, T('run-permission-current'))) === MODE_NAME.bypassPermissions, '4 confirming sets Bypass', await text(page, T('run-permission-current')))
    const chip = page.locator(T('run-permission-change'))
    check((await chip.getAttribute('data-tone')) === 'danger' && (await chip.getAttribute('data-default')) === 'false', '4 Bypass shows data-tone=danger (not the warning amber) and data-default=false')
    await shot('widen-bypass')
    // Back to the project's mode: that is the default again and is not a widening.
    await chooseMode(page, 'default')
    await page.waitForFunction(() => document.querySelector('[data-testid=run-permission-change]')?.getAttribute('data-default') === 'true', null, { timeout: 5000 }).catch(() => {})
    check((await chip.getAttribute('data-default')) === 'true' && (await chip.getAttribute('data-tone')) === null, '4 choosing the project mode again is the default without a confirmation')
  })

  // ---------- V. sizes x themes ----------
  await section('visual', async () => {
    for (const [w, h] of [[1600, 1000], [1024, 640]]) {
      for (const theme of ['dark', 'light']) {
        await mainSize(w, h)
        await setTheme(theme)
        await sleep(250)
        const m = await page.evaluate(() => {
          const row = document.querySelector('[data-testid=run-settings]')
          const start = document.querySelector('.composer .btn.primary')?.getBoundingClientRect()
          return {
            pageOverflow: document.documentElement.scrollWidth > innerWidth,
            chipsOut: [...row.querySelectorAll('.run-chip')].some((c) => { const b = c.getBoundingClientRect(); return b.right > innerWidth + 1 || b.left < -1 }),
            startVisible: !!start && start.bottom <= innerHeight + 1 && start.top >= 0,
            h: innerHeight
          }
        })
        const tag = `${w}x${h} ${theme}`
        check(!m.pageOverflow, `V no horizontal overflow on the New run page ${tag}`)
        check(!m.chipsOut, `V every chip is inside the window ${tag}`)
        check(m.startVisible, `V the Start button is inside the window ${tag}`)
        await shot(`start-${w}-${theme}`)
        for (const [trigger, picker] of [['run-model-change', 'run-model-picker'], ['run-permission-change', 'run-permission-picker']]) {
          await page.locator(T(trigger)).click()
          await page.locator(T(picker)).waitFor({ state: 'visible' })
          // Measure the panel with its content: the model list loads after the panel opens.
          await page.locator(`${T(picker)} input[type=radio]`).first().waitFor({ timeout: 15_000 })
          await sleep(300)
          const box = await page.locator(T(picker)).boundingBox()
          check(!!box && box.y >= 0 && box.y + box.height <= h && box.x >= 0 && box.x + box.width <= w, `V ${picker} is bounded by the window ${tag}`, JSON.stringify(box))
          if (theme === 'dark' || w === 1024) await shot(`${picker}-${w}-${theme}`)
          await page.keyboard.press('Escape')
          await page.locator(T(picker)).waitFor({ state: 'hidden' })
        }
      }
    }
    await mainSize(1600, 1000)
    await setTheme('dark')
  })

  // ---------- 2. pick and start ----------
  await section('pick-and-start', async () => {
    await reopen()
    const before = (await runsOf()).length
    // Model by mouse.
    await pickStartModel('claude-sonnet-5-5', gatewayA)
    check((await text(page, T('run-model-current'))).includes('claude-sonnet-5-5'), '2 Model chip shows the picked model', await text(page, T('run-model-current')))
    check((await page.locator(T('run-model-change')).getAttribute('data-default')) === 'false', '2 a picked model is data-default=false')
    // Effort by keyboard: Enter opens, the radio takes Space, Escape closes and returns focus to the chip.
    await page.locator(T('run-effort-change')).focus()
    await page.keyboard.press('Enter')
    await page.locator(T('run-effort-picker')).waitFor({ state: 'visible' })
    await focusInside(`${T('run-effort-picker')} input[value=medium]`)
    await page.keyboard.press('Space')
    await page.keyboard.press('Escape')
    await page.locator(T('run-effort-picker')).waitFor({ state: 'hidden' })
    check((await text(page, T('run-effort-current'))) === 'Medium', '2 Effort chip shows the keyboard pick', await text(page, T('run-effort-current')))
    // Permission (narrowing) by keyboard.
    await page.locator(T('run-permission-change')).focus()
    await page.keyboard.press('Enter')
    await page.locator(T('run-permission-picker')).waitFor({ state: 'visible' })
    await focusInside(`${T('run-permission-choice')}[value=plan]`)
    await page.keyboard.press('Space')
    await focusInside(T('run-permission-apply'))
    await page.keyboard.press('Enter')
    await page.locator(T('run-permission-picker')).waitFor({ state: 'hidden' })
    check((await text(page, T('run-permission-current'))) === MODE_NAME.plan, '2 narrowing to Plan only applies without a confirmation', await text(page, T('run-permission-current')))
    check((await page.locator(T('run-permission-confirm')).count()) === 0, '2 no confirmation for a narrowing mode')
    // Goal by mouse.
    await page.locator(T('run-goal-change')).click()
    await page.locator(`${T('run-goal-picker')} .seg-item`, { hasText: 'Faster' }).click()
    await page.keyboard.press('Escape')
    check((await text(page, T('run-goal-current'))) === 'Faster', '2 Goal chip shows Faster', await text(page, T('run-goal-current')))
    await shot('picked')

    await page.locator('.composer textarea').fill(`${IDLE_MARK} start with chosen settings`)
    await page.locator('.composer .btn.primary').click()
    const run = await newestRunAfter(before)
    check(!!run, '2 Start creates a run')
    await waitStatus(run.id, ['idle'])
    let rec = await getRun(run.id)
    for (let i = 0; i < 75 && !JSON.stringify(rec.transcript).includes('Mock root model'); i++) {
      await sleep(200)
      rec = await getRun(run.id)
    }
    const s = rec.summary
    check(s.modelSelection?.model === 'claude-sonnet-5-5' && s.modelSelection?.connection === gatewayA, '2 runs.get summary.modelSelection is the picked model', JSON.stringify(s.modelSelection))
    check(s.rootEffort === 'medium', '2 summary.rootEffort is medium', String(s.rootEffort))
    check(s.permissionMode === 'plan' && s.permissionModeChosen === true, '2 summary.permissionMode is plan and permissionModeChosen is true', `${s.permissionMode} ${s.permissionModeChosen}`)
    check(JSON.stringify(rec.transcript).includes('Mock root model: claude-sonnet-5-5'), '2 the mock root ran on the picked model', JSON.stringify(rec.transcript.map((t) => t.block?.text).filter(Boolean)).slice(0, 200))

    // The live row (the same page, now showing the run).
    await page.locator(T('run-meta')).waitFor({ timeout: 15_000 })
    await sleep(500)
    check((await page.locator(LIVE_ROW).count()) === 1, '2 (live row) the live composer has the settings row')
    check(((await page.locator(T('live-model-change')).getAttribute('title').catch(() => '')) ?? '').includes('claude-sonnet-5-5'), '2 (live row) the live model chip shows the picked model')
    check((await text(page, T('run-effort-readonly'))).includes('Medium'), '2 (live row) run-effort-readonly says Medium', await text(page, T('run-effort-readonly')))
    check((await text(page, T('run-permission-current'))) === MODE_NAME.plan, '2 (live row) the live permission chip says Plan only', await text(page, T('run-permission-current')))
    check((await text(page, T('run-goal-readonly'))).includes('Faster'), '2 (live row) run-goal-readonly says Faster', await text(page, T('run-goal-readonly')))
    check((await page.locator(`${T('run-meta-permission')}[data-mode=plan]`).count()) === 1, '2 (live row) RunMeta shows run-meta-permission[data-mode=plan]')
    await shot('live-after-start')
    // The next draft starts from the defaults again.
    await page.keyboard.press('Control+t')
    await page.locator(START_ROW).waitFor()
    check((await page.locator(T('run-model-change')).getAttribute('data-default')) === 'true' && (await page.locator(T('run-permission-change')).getAttribute('data-default')) === 'true', '2 a new draft starts from the project defaults again')
    await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
  })

  // ---------- 3. a refused start keeps the draft ----------
  await section('refusal', async () => {
    await reopen()
    const before = (await runsOf()).length
    // Pick a model on the spare gateway, then remove that gateway: main's catalog check refuses the start.
    await pickStartModel('claude-haiku-4-5-20251001', gatewayB)
    await page.locator(T('run-effort-change')).click()
    await page.locator(`${T('run-effort-picker')} .seg-item`, { hasText: 'Low' }).click()
    await page.keyboard.press('Escape')
    await chooseMode(page, 'plan')
    await page.locator(T('run-permission-picker')).waitFor({ state: 'hidden' })
    const draft = `${IDLE_MARK} this draft must survive a refused start`
    await page.locator('.composer textarea').fill(draft)
    const removed = await page.evaluate((id) => window.orgai.connections.removeProxy(id).then(() => 'ok', (e) => String(e.message ?? e)), gatewayB)
    check(removed === 'ok', '3 the spare gateway was removed so main will refuse its model', removed)
    await page.locator('.composer .btn.primary').click()
    await page.locator(T('composer-error')).waitFor({ state: 'visible', timeout: 10_000 })
    const err = await text(page, T('composer-error'))
    check(err.length > 0 && /model|connection/i.test(err), '3 composer-error shows main\'s refusal', err)
    check((await page.locator('.composer textarea').inputValue()) === draft, '3 the textarea keeps the draft')
    check((await text(page, T('run-model-current'))).includes('claude-haiku-4-5-20251001'), '3 the Model chip keeps the pick', await text(page, T('run-model-current')))
    check((await text(page, T('run-effort-current'))) === 'Low' && (await text(page, T('run-permission-current'))) === MODE_NAME.plan, '3 the Effort and Permission chips keep their picks')
    check((await runsOf()).length === before && (await page.locator('.new-run').count()) === 1, '3 no run was created and the page stayed on the draft')
    await shot('refused')
    // Recovery: choose a model that exists and start the same draft.
    await pickStartModel('claude-sonnet-5-5', gatewayA)
    await page.locator('.composer .btn.primary').click()
    const run = await newestRunAfter(before)
    check(!!run && run.modelSelection?.model === 'claude-sonnet-5-5' && run.permissionMode === 'plan', '3 after choosing another model the same draft starts with the kept mode', JSON.stringify(run?.modelSelection))
    if (run) {
      await waitStatus(run.id, ['idle'])
      await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
    }
  })

  // ---------- 9. keyboard pass at 1024x640 ----------
  await section('keyboard', async () => {
    await mainSize(1024, 640)
    await setTheme('light')
    await reopen()
    const before = (await runsOf()).length
    await page.locator('[data-testid=new-run-mode] input:checked').focus()
    const stops = []
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      stops.push(await activeTestId(page))
    }
    check(JSON.stringify(stops) === JSON.stringify(['run-model-change', 'run-effort-change', 'run-permission-change', 'run-goal-change', 'Attach images', 'TEXTAREA']), '9 Tab order after Team|Ask is Model, Effort, Permission, Goal, Attach, textarea', stops.join(' > '))
    for (const [trigger, picker] of [['run-model-change', 'run-model-picker'], ['run-effort-change', 'run-effort-picker'], ['run-permission-change', 'run-permission-picker'], ['run-goal-change', 'run-goal-picker']]) {
      await page.locator(T(trigger)).focus()
      await page.keyboard.press('Enter')
      await page.locator(T(picker)).waitFor({ state: 'visible' })
      // The shared Popover moves focus into the panel on the very first open too: to the checked radio when there is one
      // (permission: the project's mode), else the first control (effort / goal with nothing checked: the first radio;
      // the model picker keeps focusing its search box).
      await page.waitForFunction((p) => !!document.querySelector(`[data-testid=${p}]`)?.contains(document.activeElement), picker, { timeout: 3000 }).catch(() => {})
      const where = await page.evaluate((p) => {
        const panel = document.querySelector(`[data-testid=${p}]`)
        const el = document.activeElement
        return { inside: !!panel?.contains(el), id: el?.getAttribute('data-testid') ?? el?.tagName, checked: el?.matches?.('input[type=radio]') ? el.checked : null, type: el?.getAttribute?.('type') ?? '' }
      }, picker)
      check(where.inside, `9 opening ${picker} with Enter moves focus inside it`, JSON.stringify(where))
      if (picker === 'run-model-picker') check(where.id === 'run-model-search', '9 the model picker focuses its search box', where.id)
      else if (picker === 'run-permission-picker') check(where.checked === true, '9 the permission picker focuses the checked radio (the current mode)', JSON.stringify(where))
      else check(where.type === 'radio', `9 ${picker} focuses a radio`, JSON.stringify(where))
      await page.keyboard.press('Escape')
      await page.locator(T(picker)).waitFor({ state: 'hidden' })
      check((await activeTestId(page)) === trigger, `9 Escape in ${picker} returns focus to ${trigger}`, await activeTestId(page))
    }
    await page.locator('.composer textarea').fill(`${IDLE_MARK} keyboard start`)
    await page.locator('.composer textarea').press('Enter')
    const run = await newestRunAfter(before)
    check(!!run, '9 Enter in the textarea starts the run')
    if (run) {
      await page.locator(T('run-meta')).waitFor({ timeout: 15_000 })
      await sleep(600)
      const focus = await page.evaluate(() => {
        const el = document.activeElement
        return { tag: el?.tagName, inComposer: !!el?.closest('.composer'), name: el?.getAttribute('aria-label') || el?.getAttribute('placeholder') || '' }
      })
      check(focus.tag === 'TEXTAREA' && focus.inComposer, '9 after Start the live composer textarea has focus', JSON.stringify(focus))
      check(focus.name.length > 0, '9 that textarea has an accessible name', focus.name)
      await waitStatus(run.id, ['idle'])
      await shot('keyboard-live-1024')
      await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
    }
    await mainSize(1600, 1000)
    await setTheme('dark')
  })

  // ---------- live run windows ----------
  // 5. mid-run narrowing (applied)
  await section('mid-run-narrowing', async () => {
    const run = await startViaApi(`${IDLE_MARK} narrowing`)
    const v = await openRunWindow(run, [1024, 640])
    await v.locator(LIVE_ROW).waitFor({ timeout: 10_000 })
    check(true, '5 (live row) the live composer has the settings row')
    check((await text(v, T('run-permission-current'))) === MODE_NAME.default, '5 (live row) the live chip starts at the project mode', await text(v, T('run-permission-current')))
    await chooseMode(v, 'plan')
    await v.waitForFunction(() => /Permission mode is now Plan only\./.test(document.querySelector('[data-testid=run-permission-note]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
    check((await text(v, T('run-permission-note'))) === 'Permission mode is now Plan only.' || (await text(v, T('run-permission-note'))).startsWith('Permission mode is now Plan only.'), '5 (merged mock) run-permission-note says "Permission mode is now Plan only."', await text(v, T('run-permission-note')))
    const rec = await getRun(run.id)
    check(rec.summary.permissionMode === 'plan' && rec.summary.permissionModeChosen === true, '5 (merged mock) runs.get permissionMode is plan', `${rec.summary.permissionMode}`)
    const logs = rec.logs.map((l) => l.message)
    const i = logs.findIndex((m) => m === 'Mock session permission mode: plan.')
    check(i >= 0 && logs.slice(i + 1).some((m) => /^Permission mode set to .+ for this run\.$/.test(m)), '5 (merged mock) the mock logs its mode, then "Permission mode set to <label> for this run."', logs.filter((m) => /ermission/.test(m)).join(' | '))
    check((await text(v, T('run-permission-current'))) === MODE_NAME.plan, '5 (merged mock) the chip shows Plan only', await text(v, T('run-permission-current')))
    check((await v.locator(`${T('run-meta-permission')}[data-mode=plan]`).count()) === 1, '5 (merged mock) RunMeta shows run-meta-permission[data-mode=plan]')
    check(await v.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '5 (live row) the live window has no horizontal overflow at 1024x640')
    await v.screenshot({ path: 'e2e/shots/run-start-live-narrowed-1024.png' })
    await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
  })

  // 6. mid-run widening
  await section('mid-run-widening', async () => {
    const run = await startViaApi(`${IDLE_MARK} widening`)
    const v = await openRunWindow(run)
    await v.locator(LIVE_ROW).waitFor({ timeout: 10_000 })
    await chooseMode(v, 'acceptEdits')
    await v.locator(T('run-permission-confirm')).waitFor({ state: 'visible' })
    check(true, '6 (live row) widening a live run asks for confirmation')
    await v.getByRole('button', { name: 'Keep current mode', exact: true }).click()
    await v.locator(T('run-permission-confirm')).waitFor({ state: 'hidden' })
    await sleep(500)
    check((await text(v, T('run-permission-current'))) === MODE_NAME.default, '6 (live row) cancel keeps the chip mode', await text(v, T('run-permission-current')))
    check((await getRun(run.id)).summary.permissionMode === 'default', '6 (live row) cancel leaves runs.get permissionMode unchanged')
    check((await activeTestId(v)) === 'run-permission-change', '6 (live row) cancel returns focus to the permission chip', await activeTestId(v))
    await chooseMode(v, 'acceptEdits')
    await v.locator(T('run-permission-confirm')).click()
    await v.waitForFunction(() => /Permission mode is now Auto-accept edits\./.test(document.querySelector('[data-testid=run-permission-note]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
    check((await text(v, T('run-permission-note'))).startsWith('Permission mode is now Auto-accept edits.'), '6 (merged mock) confirming applies the wider mode', await text(v, T('run-permission-note')))
    check((await getRun(run.id)).summary.permissionMode === 'acceptEdits', '6 (merged mock) runs.get permissionMode is acceptEdits')
    check((await v.locator(T('run-permission-change')).getAttribute('data-tone')) === 'warning', '6 (merged mock) a permissive live mode shows data-tone=warning')
    await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
  })

  // 7. ended run: saved for the next message
  await section('ended-run', async () => {
    const run = await startViaApi(`${IDLE_MARK} ended`)
    await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
    await waitStatus(run.id, ['finished'])
    const v = await openRunWindow(run)
    await v.locator(LIVE_ROW).waitFor({ timeout: 10_000 })
    check(!/Next message:/.test(await text(v, T('run-permission-change'))), '7 (live row) an ended run with no pending choice shows its mode without a "Next message:" prefix', await text(v, T('run-permission-change')))
    await chooseMode(v, 'plan')
    await v.waitForFunction(() => /applies from your next message/.test(document.querySelector('[data-testid=run-permission-note]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
    check((await text(v, T('run-permission-note'))).includes('Plan only applies from your next message.'), '7 (live row) run-permission-note says "Plan only applies from your next message."', await text(v, T('run-permission-note')))
    check(/^Permission:\s*Next message:/.test(await text(v, T('run-permission-change'))) &&(await text(v, T('run-permission-current'))) === MODE_NAME.plan, '7 (live row) a saved choice reads "Permission: Next message: Plan only"', await text(v, T('run-permission-change')))
    const rec = await getRun(run.id)
    check(rec.summary.permissionMode === 'plan' && rec.summary.permissionModeChosen === true, '7 runs.get permissionMode is plan and permissionModeChosen is true', `${rec.summary.permissionMode} ${rec.summary.permissionModeChosen}`)
    // The next message carries it.
    await v.locator('.composer textarea').fill(`${IDLE_MARK} continue in plan mode`)
    await v.locator('.composer textarea').press('Enter')
    await page.waitForFunction(async (id) => (await window.orgai.runs.listLive()).some((r) => r.resumedFrom === id), run.id, { timeout: 20_000 }).catch(() => {})
    const successor = await page.evaluate(async (id) => (await window.orgai.runs.listLive()).find((r) => r.resumedFrom === id), run.id)
    check(successor?.permissionMode === 'plan' && successor?.permissionModeChosen === true, '7 the continuation starts in the saved mode', JSON.stringify({ m: successor?.permissionMode, c: successor?.permissionModeChosen }))
    if (successor) await page.evaluate((id) => window.orgai.runs.stop(id), successor.id)
  })

  // 8. mock markers
  await section('mock-markers', async () => {
    const refuse = await startViaApi(`[mock:mode-refuse] ${IDLE_MARK}`)
    let v = await openRunWindow(refuse)
    await v.locator(LIVE_ROW).waitFor({ timeout: 10_000 })
    await chooseMode(v, 'plan')
    // A provider refusal arrives either thrown (run-permission-error) or as a refused result (run-permission-note).
    const refusalSel = `${T('run-permission-error')}, ${T('run-permission-note')}`
    await v.locator(refusalSel).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    const refusal = await text(v, refusalSel)
    check(refusal.includes('This provider applies a new permission mode from the next session.') || refusal.includes('The session could not change its permission mode now.'), "8 (merged mock) [mock:mode-refuse] shows main's refusal (the mock's sentence or the fixed one) in run-permission-error", refusal)
    check((await text(v, T('run-permission-current'))) === MODE_NAME.default && (await getRun(refuse.id)).summary.permissionMode === 'default', '8 (merged mock) a refused change keeps the old mode on the chip and in runs.get')
    await v.screenshot({ path: 'e2e/shots/run-start-mode-refused.png' })
    await page.evaluate((id) => window.orgai.runs.stop(id), refuse.id)

    const unchanged = await startViaApi(`[mock:mode-reports-unchanged] ${IDLE_MARK}`)
    v = await openRunWindow(unchanged)
    await v.locator(LIVE_ROW).waitFor({ timeout: 10_000 })
    await chooseMode(v, 'plan')
    await v.waitForFunction(() => /keeps? the earlier mode until (they|it) finish/.test(document.querySelector('[data-testid=run-permission-note]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
    check(/keeps? the earlier mode until (they|it) finish/.test(await text(v, T('run-permission-note'))),'8 (merged mock) [mock:mode-reports-unchanged] says running reports keep the earlier mode', await text(v, T('run-permission-note')))
    await page.evaluate((id) => window.orgai.runs.stop(id), unchanged.id)
  })

  // 10. review fixes: option icons, one confirmation per double click, RunMeta on an ended run ("Interrupt and change" going stale is unit-tested: a staged refusal cannot be driven on the idle mock)
  await section('review-fixes', async () => {
    await reopen()
    await page.locator(T('run-permission-change')).click()
    await page.locator(T('run-permission-picker')).waitFor({ state: 'visible' })
    const permissive = await page.locator(`${T('run-permission-picker')} .run-permission-option[data-tone]`).count()
    const icons = await page.locator(`${T('run-permission-picker')} .run-permission-option[data-tone] ${T('run-permission-option-icon')} svg[aria-hidden=true]`).count()
    const danger = await page.locator(`${T('run-permission-picker')} .run-permission-option[data-tone=danger]`).count()
    check(permissive === 3 && icons === permissive && danger === 1, '10 every permissive mode in the list carries a hidden icon (not colour alone) and only Bypass is danger', `${icons}/${permissive}, danger ${danger}`)
    await page.locator(`${T('run-permission-choice')}[value="bypassPermissions"]`).check()
    // Two activations in one task (a double click, Enter twice): a real second click would land on the opened dialog.
    await page.locator(T('run-permission-apply')).evaluate((b) => {
      b.click()
      b.click()
    })
    await page.locator(T('run-permission-confirm')).waitFor({ state: 'visible', timeout: 5000 })
    await sleep(300)
    check((await page.locator(T('run-permission-confirm')).count()) === 1 && (await page.locator('dialog[open], [role=dialog][aria-modal=true]').count()) <= 1, '10 a double click on "Use this mode" opens one confirmation', String(await page.locator(T('run-permission-confirm')).count()))
    await page.getByRole('button', { name: 'Keep current mode', exact: true }).click()
    await page.locator(T('run-permission-confirm')).waitFor({ state: 'hidden' })

    // An ended run's RunMeta says what the chip says: "Next message: <mode>".
    const ended = await startViaApi(`${IDLE_MARK} meta`, { permissionMode: 'plan' })
    await page.evaluate((id) => window.orgai.runs.stop(id), ended.id)
    await waitStatus(ended.id, ['finished'])
    const ev = await openRunWindow(ended)
    await ev.locator(T('run-meta-permission')).waitFor({ timeout: 10_000 })
    check(/^Next message:\s*Plan only/.test(await text(ev, T('run-meta-permission'))) && (await ev.locator(T('run-meta-permission')).getAttribute('data-next')) === 'true', '10 an ended run\'s RunMeta reads "Next message: Plan only", like the chip', await text(ev, T('run-meta-permission')))

    await page.evaluate((id) => window.orgai.runs.stop(id), ended.id).catch(() => {})
  })
} catch (error) {
  check(false, 'run-start script completes', error.stack || String(error))
  await shot('failure').catch(() => {})
} finally {
  for (const w of app.windows()) if (w !== page) await w.close().catch(() => {})
  await cleanup(app, page, NAME)
  removeFixture(repo)
}
finish('run-start')
