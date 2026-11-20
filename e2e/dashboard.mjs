// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The Dashboard overhaul (docs/design/dashboard-overhaul.md sections 12 and 13),
// numbered like the acceptance criteria in the check names ("A1" ... "A30").
//  A1  one h1, one h2 per rendered section with the 11.2 title, DOM order equals visual order at 1024x640 and 1600x1000.
//  A2  first launch: "Welcome to OrgAI." and its line, the start choice, no Customise button, no sections.
//  A3  the salutation with and without a name, in each hour band (Date.now is faked in the page and the Dashboard remounted).
//  A4/A5 the brief never reads "$0.00" and is not live; `dashboard-live` is the only aria-live / role=status element.
//  A7  the name: Add your name popover (focus, Enter saves, Esc cancels and returns focus, 41 characters stopped by maxLength,
//      a zero-width character refused with the stated sentence, clearing, the Settings > General > About you field, relaunch).
//  A8  Waiting on you rows equal the sidebar bell; inline Allow once removes the row and is announced; no wider scope text;
//      a [mock:fatigue] compound command is answered inline.
//  A10 Waiting order by kind (permission before proposal) and a row does not move while other events arrive.
//  A11 a decision is a row once: band and tile text carry no raw command and the band run says "Waiting on you".
//  A13 Pick up: a run cut by quit while waiting shows "Was waiting on you when OrgAI closed." and Continue; a pinned project
//      with no runs shows New run; each chain once; a paused run ([mock:model-switch-limit]) offers Resume now and leaves
//      the list; a stopped run with an output ([mock:outputs]) offers Open output and lands on the Outputs tab.
//  A14 Today: a schedule due later today, open to-dos (IPC seeded and `[mock:todo]`), Start session fills the composer and
//      starts no run, done to-dos never show, the paused line.
//  A15/A16 empty sections do not render outside customise mode; no dash-now-empty.
//  A17/A18 Your week: runs, 7 ledger days, one today, one Tab stop, ArrowLeft, Enter pins, Esc unpins, counts sum to the
//      figure, track height 40 (1024x640) and 56 (1600x1000), never "$0.00".
//  A19 no plan limits on the mock adapter.   A20 pins from the tile More menu and the customise toggle, no tile-run.
//  A21 customise by keyboard only (Tab path, Move up and down, the ends, Hide / Show focus, Esc, Reset keeps pins, reload keeps
//      the layout, corrupt storage loads a valid layout).   A22 one full-width track in customise mode, pairs outside it.
//  A23 1024x640: no horizontal overflow, the window never scrolls, `.dashboard` scrolls.
//  A25 reduced motion: the working mark's ::after has no animation, no `.motion-enter` has a duration above 0.01 ms.
//  A30 `display-name-input` in Settings.
// Not covered here (unit tests or later): the IPC argument of Allow once (A8), the 25th pin (A20), a second real window (A21, a
// synthetic storage event stands in), a decision entering 2 s after load (A25), the other brief variants (A4, `dashboardBrief`
// unit tests), plan limits off the mock adapter (A19), a failed name save (A7).
// Known product failure kept visible: A5 on first launch (the inline new-project form has its own role=status region).
// Kept from the earlier script: first launch Tab order, New project dialog and Escape, the tile More menu and delete confirm,
// New run from the menu, Enter on a band agent row opens the agent, both sizes and themes, relaunch with a run cut while waiting.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, deleteProject, endSession, finish, gotoProjects, launch, log, makeFixtureRepo, openAppSettings, openProject, projectTab, relaunch, removeFixture, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-dash-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const WAIT = 'E2E dash waiting (orgai test)'
const BUSY = 'E2E dash busy (orgai test)'
const PINNED = 'E2E dash pinned (orgai test)'
const SCHED = 'E2E dash schedule (orgai test)'
const INLINE = 'E2E dash inline (orgai test)'
const COMPOUND = 'E2E dash compound (orgai test)'
const repoA = makeFixtureRepo('dash-a')
const repoB = makeFixtureRepo('dash-b')
const repoP = makeFixtureRepo('dash-p')
const repoS = makeFixtureRepo('dash-s')
const repoC = makeFixtureRepo('dash-c')
const repoD = makeFixtureRepo('dash-d')

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const DEFAULT_ORDER = ['resume', 'today', 'working', 'week', 'projects']
const TITLES = { resume: 'Pick up where you left off', today: 'Today', working: 'Working now', week: 'Your week', projects: 'Projects' }
const SECTION_IDS = { 'dash-needs-you': 'Waiting on you', 'dash-setup': 'To finish setting up', 'dash-resume': TITLES.resume, 'dash-today': TITLES.today, 'dash-now': TITLES.working, 'dash-week': TITLES.week, 'dash-projects': TITLES.projects }
const KIND_WEIGHT = { plan: 0, question: 1, permission: 2, merge: 3, proposal: 4, install: 5, rules: 6, team: 7 }
const SALUTE = /^(Good morning|Good afternoon|Good evening|Hello)(, .+)?\.$/
const REMOVED_IDS = ['dash-status-line', 'dash-paused', 'dash-since', 'dash-since-clear', 'dash-now-empty', 'dash-strip-waiting', 'tile-run', 'dash-strip-usage-link', 'dash-cost', 'dash-strip-runs']
const LAYOUT_KEY = 'orgai.dashboardLayout'

let { app, page, shot } = await launch({ shotPrefix: 'dashboard' })
const pageErrors = []
const watchErrors = (p) => p.on('pageerror', (e) => pageErrors.push(e.message))
watchErrors(page)

const T = (id) => page.locator(`[data-testid=${id}]`)
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const text = async (id) => clean(await T(id).first().innerText().catch(() => ''))
const tileOf = (name) => page.locator(`[data-testid=project-tile][data-name="${name}"]`)
const live = () => text('dashboard-live')
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((w2) => Math.abs(window.innerWidth - w2) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(600)
}
/** Merge a patch into the saved settings through settings:set (the broadcast re-applies it). */
const setSettings = async (patch) => {
  await page.evaluate(async (p) => {
    const info = await window.orgai.settings.get()
    const { dataDir: _d, appVersion: _v, ...s } = info
    await window.orgai.settings.set({ ...s, ...p })
  }, patch)
  await sleep(400)
}
const setAppearance = async (patch) => {
  await page.evaluate(async (p) => {
    const info = await window.orgai.settings.get()
    const { dataDir: _d, appVersion: _v, ...s } = info
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, ...p } })
  }, patch)
  await sleep(500)
}
/** Poll `fn` until truthy (returned) or the deadline passes (null). */
async function until(fn, ms = 20_000, every = 250) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
/** The name popover's input is visible a frame or more before the popover hands it focus; typing earlier loses characters. */
const nameInputFocused = async () => {
  await T('dash-name-input').waitFor({ timeout: 5000 })
  await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'dash-name-input', 5000, 50)
}
const activeInfo = () =>
  page.evaluate(() => {
    const a = document.activeElement
    return {
      tag: a?.tagName ?? '',
      testid: a?.getAttribute('data-testid') ?? '',
      section: a?.closest?.('[data-testid=dash-section-controls]')?.getAttribute('data-section') ?? '',
      inMainTopbarH1: !!a?.matches?.('main .topbar h1'),
      type: a?.getAttribute('type') ?? '',
      inChoice: !!a?.closest?.('[data-testid=dash-start-choice]'),
      inComposer: !!a?.closest?.('.composer')
    }
  })
const startRun = async (prompt) => {
  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(prompt)
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
}
const bellCount = async () => Number(/Needs you · (\d+)/.exec(await text('needs-you-row'))?.[1] ?? 0)
const layoutOf = () =>
  page.evaluate((k) => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null')
    } catch {
      return 'unparsable'
    }
  }, LAYOUT_KEY)
const slotOrder = () => page.evaluate(() => [...document.querySelectorAll('[data-testid=dash-section]')].map((e) => e.getAttribute('data-section')))
const ctl = (id, testid) => page.locator(`[data-testid=dash-section-controls][data-section="${id}"] [data-testid="${testid}"]`)
const store = (scope) => page.evaluate((s) => window.orgai.todos.list(s), scope)
const runsOf = (projectId) => page.evaluate((id) => window.orgai.runs.list(id), projectId)
const needsKinds = () => page.locator('[data-testid=dash-needs-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
const needsKeys = () => page.locator('[data-testid=dash-needs-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
const weightsAscend = (kinds) => kinds.every((k, i) => i === 0 || (KIND_WEIGHT[k] ?? 99) >= (KIND_WEIGHT[kinds[i - 1]] ?? 99))
const salutationText = () => text('dash-greeting-salutation')
const briefText = () => text('dash-greeting-brief')

/** The h1 / h2 facts of the page: counts, titles of the rendered sections and whether DOM order is visual order. */
const headingFacts = () =>
  page.evaluate((map) => {
    const present = Object.keys(map).filter((id) => {
      const el = document.querySelector(`[data-testid=${id}]`)
      return !!el && el.offsetParent !== null
    })
    const wrong = present.filter((id) => (document.querySelector(`[data-testid=${id}] h2`)?.textContent ?? '').trim() !== map[id])
    const hs = [...document.querySelectorAll('[data-testid=dashboard] h2')].filter((h) => h.offsetParent !== null).map((h) => {
      const r = h.getBoundingClientRect()
      return { text: (h.textContent ?? '').trim(), top: r.top, left: r.left }
    })
    let ordered = true
    for (let i = 1; i < hs.length; i++) {
      const a = hs[i - 1]
      const b = hs[i]
      if (!(b.top > a.top + 2 || (Math.abs(b.top - a.top) <= 2 && b.left > a.left))) ordered = false
    }
    return { h1s: document.querySelectorAll('h1').length, h1: document.querySelector('h1')?.textContent?.trim() ?? '', present, wrong, h2s: hs.length, texts: hs.map((h) => h.text), ordered }
  }, SECTION_IDS)
async function checkHeadings(tag) {
  const f = await headingFacts()
  check(f.h1s === 1 && f.h1 === 'Dashboard', `A1 the page has exactly one h1 "Dashboard" ${tag}`, JSON.stringify(f))
  check(f.wrong.length === 0 && f.h2s === f.present.length && f.present.length >= 1, `A1 every rendered section has one h2 with its 11.2 title ${tag}`, JSON.stringify(f))
  check(f.ordered, `A1 DOM order of the section headings equals their visual order ${tag}`, JSON.stringify(f))
}
/** The same salutation / brief rules everywhere: no "$0.00", the brief is not live, one live region. */
async function checkBrief(tag) {
  const brief = await briefText()
  check(!/\$0\.00/.test(brief), `A4 the brief never reads $0.00 ${tag}`, brief)
  const inLive = await T('dash-greeting-brief').first().evaluate((el) => !!el.closest('[aria-live], [role=status], [role=alert]'))
  check(!inLive, `A4 the brief is not inside a live region ${tag}`)
  // Inside the Dashboard view: exactly dashboard-live. Elsewhere in the app shell (menu announcer, ...) other regions
  // legitimately exist and are only logged.
  const regions = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-live], [role=status]')].map((e) => ({
      id: e.getAttribute('data-testid') ?? e.id ?? '',
      cls: String(e.className).slice(0, 30),
      inDashboard: !!e.closest('[data-testid=dashboard]'),
      parent: e.parentElement?.className?.toString().slice(0, 40) ?? ''
    }))
  )
  // The inline New project form on first launch keeps its own progress status (new-project-status, clone and setup
  // steps; FirstLaunch is unchanged by the overhaul, spec 2.6 and the amended section 10): it is the one allowed extra.
  const inside = regions.filter((r) => r.inDashboard && r.id !== 'new-project-status')
  check(inside.length === 1 && inside[0].id === 'dashboard-live', `A5 dashboard-live is the only Dashboard aria-live / role=status element (besides the New project form's own status) ${tag}`, JSON.stringify(regions))
  const outside = regions.filter((r) => !r.inDashboard)
  if (outside.length) log(`note: live regions outside the Dashboard view ${tag}: ${JSON.stringify(outside)}`)
}
/** The page's own overflow and window-scroll facts. */
const overflowFacts = () =>
  page.evaluate(() => {
    const d = document.querySelector('[data-testid=dashboard]')
    const se = document.scrollingElement
    return {
      over: d.scrollWidth - d.clientWidth,
      docOver: document.documentElement.scrollWidth - window.innerWidth,
      winTop: se?.scrollTop ?? 0,
      scrolls: d.scrollHeight > d.clientHeight + 1,
      dTop: d.getBoundingClientRect().top
    }
  })

const NOW_OFFSET_DAY = (h, m) => `new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1, ${h}, ${m}).getTime()`

try {
  // ---------------------------------------------------------------- First launch (A2)
  await setSize(1600, 1000)
  await gotoProjects(page)
  check(await visible('[data-testid=dash-start-choice]'), 'A2 first launch shows the start choice')
  check((await salutationText()) === 'Welcome to OrgAI.', 'A2 first launch greets with "Welcome to OrgAI."', await salutationText())
  check((await briefText()) === 'Start a project or just chat. Nothing runs until you say so.', 'A2 first launch shows its line', await briefText())
  check((await T('dash-customise').count()) === 0 && (await T('dash-section').count()) === 0 && (await T('dash-needs-you').count()) === 0, 'A2 first launch has no Customise button, no section and no attention column')
  check(await visible('[data-testid=dash-name-add]'), 'A2 first launch offers "Add your name"')
  check((await T('dashboard-app-facts').count()) === 1, 'dashboard-app-facts footer is drawn on first launch')
  const first = await headingFacts()
  check(first.h1s === 1 && first.h1 === 'Dashboard', 'A1 first launch has exactly one h1', JSON.stringify(first))
  await checkBrief('on first launch')
  await page.evaluate(() => {
    const h = document.querySelector('main .topbar h1')
    h.tabIndex = -1
    h.focus()
  })
  const stops = []
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab')
    stops.push(await activeInfo())
  }
  check(stops[0].testid === 'dash-name-add' && stops[1].inChoice && stops[1].type === 'radio', 'the first Tab stops in main are "Add your name", then the start-choice radio', JSON.stringify(stops))
  const primaries = await page.locator('main .btn.primary:visible').count()
  check(primaries === 1, 'first launch has exactly one primary button', String(primaries))
  await shot('first-launch')
  await T('dash-start-choice').getByRole('radio', { name: 'Chat now' }).check({ force: true })
  check(await visible('[data-testid=empty-chat-now]'), 'choosing Chat now shows the Chat now button')
  check((await page.locator('main .btn.primary:visible').count()) === 1, 'still exactly one primary with Chat now chosen')
  await T('dash-start-choice').getByRole('radio', { name: 'Start a project' }).check({ force: true })

  // Walk 4 M2: on first launch a saved name shows in the greeting at once, and "Add your name" looks like a control.
  const addBox = await T('dash-name-add').evaluate((el) => {
    const s = getComputedStyle(el)
    return { border: parseFloat(s.borderTopWidth), bg: s.backgroundColor }
  })
  check(addBox.border >= 1 && addBox.bg !== 'rgba(0, 0, 0, 0)', 'M2 "Add your name" has a border and a fill (it reads as a control)', JSON.stringify(addBox))
  await T('dash-name-add').click()
  await nameInputFocused()
  await page.keyboard.type('Sam')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()) === 'Welcome to OrgAI, Sam.', 8000)), 'M2 first launch: saving a name puts it in the greeting at once', await salutationText())
  await T('dash-name-edit').click()
  await nameInputFocused()
  // Select the field with the locator: a synthetic Cmd+A does not reach a field on macOS (CI run 44674564818).
  await T('dash-name-input').selectText()
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()) === 'Welcome to OrgAI.', 5000)), 'M2 first launch: removing the name restores the plain welcome', await salutationText())

  // ---------------------------------------------------------------- Projects with no runs yet
  const waiting = await createProject(page, { path: repoA, name: WAIT })
  check(!!waiting, 'first project created from the inline form')
  const busy = await createProject(page, { path: repoB, name: BUSY })
  check(!!busy, 'second project created from the dialog')
  check((await page.locator('main .topbar h1').first().innerText()).trim() === BUSY, 'creating a project opens it')
  const pinProject = await createProject(page, { path: repoP, name: PINNED })
  check(!!pinProject, 'third project created (it will be pinned and stay without runs)')
  const pinId = pinProject?.id
  const waitId = waiting?.id
  await gotoProjects(page)
  await sleep(600)

  check((await briefText()) === 'No runs yet. Open a project to start one.', 'A4 with projects and no run the brief says "No runs yet. Open a project to start one."', await briefText())
  // "Not rendered" = absent or hidden: an empty Waiting on you stays in the DOM as a `hidden` section (reported below).
  const shownIds = await page.evaluate((ids) => ids.filter((id) => { const e = document.querySelector(`[data-testid="${id}"]`); return !!e && e.offsetParent !== null }), ['dash-resume', 'dash-today', 'dash-now', 'dash-week', 'dash-needs-you'])
  check(shownIds.length === 0, 'A15 with nothing to show Pick up, Today, Working now, Your week and Waiting on you are not displayed', JSON.stringify(shownIds))
  const needsInDom = await T('dash-needs-you').count()
  if (needsInDom) log('note: an empty Waiting on you is a `hidden` section in the DOM (spec 7.2 says "not rendered"); it is not displayed')
  check((await T('dash-now-empty').count()) === 0, 'A16 there is no dash-now-empty')
  check(await visible('[data-testid=dash-projects]'), 'Projects renders with projects')
  check(await visible('[data-testid=dash-customise]'), 'the Customise button shows once a project exists')
  await checkHeadings('with no runs')
  await checkBrief('with no runs')

  // ---------------------------------------------------------------- A3 / A7 The name
  const noName = await salutationText()
  const hourWord = await page.evaluate(() => {
    const h = new Date().getHours()
    return h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : h >= 17 && h < 22 ? 'Good evening' : 'Hello'
  })
  check(noName === `${hourWord}.`, 'A3 without a name the salutation is the time-of-day word and a full stop', `${noName} / ${hourWord}`)
  check((await T('dash-name-edit').count()) === 0, 'A7 no edit button while no name is set')
  await T('dash-name-add').click()
  await nameInputFocused()
  await until(async () => (await activeInfo()).testid === 'dash-name-input', 5000, 50)
  check((await activeInfo()).testid === 'dash-name-input', 'A7 Add your name opens the popover with focus in dash-name-input')
  check((await T('dash-name-input').getAttribute('maxlength')) === '40', 'A7 the name field stops at 40 characters (maxLength)')
  await page.keyboard.type('Sam')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()).endsWith(', Sam.'), 8000)), 'A7 Enter saves and the salutation shows the name at once', await salutationText())
  // The live region is set in an effect after the salutation changes: poll it rather than read it once (a one-shot read failed intermittently on Windows).
  check(!!(await until(async () => (await live()).includes('Name saved.'), 3000)), 'A7 saving the name is announced "Name saved."', await live())
  await until(async () => (await activeInfo()).testid === 'dash-name-edit', 5000, 50)
  check((await activeInfo()).testid === 'dash-name-edit', 'A7 focus lands on the Change your name button after saving', JSON.stringify(await activeInfo()))
  check(!!(await page.evaluate(async () => (await window.orgai.settings.get()).displayName === 'Sam')), 'A7 the name is in the saved settings')
  // Esc cancels, focus returns.
  await T('dash-name-edit').click()
  await nameInputFocused()
  await T('dash-name-input').selectText()
  await page.keyboard.type('Zed')
  await page.keyboard.press('Escape')
  await until(async () => !(await visible('[data-testid=dash-name-input]')) && (await activeInfo()).testid === 'dash-name-edit', 5000, 50)
  check(!(await visible('[data-testid=dash-name-input]')), 'A7 Esc closes the name popover')
  check((await activeInfo()).testid === 'dash-name-edit' && (await salutationText()).endsWith(', Sam.'), 'A7 Esc keeps the name and returns focus to the control', `${await salutationText()} ${JSON.stringify(await activeInfo())}`)
  // 41 characters pasted stop at 40; a zero-width character is refused with the stated sentence.
  await T('dash-name-edit').click()
  await nameInputFocused()
  await T('dash-name-input').selectText()
  await page.keyboard.insertText('x'.repeat(41))
  await until(async () => (await T('dash-name-input').inputValue()).length >= 40, 5000, 50)
  check((await T('dash-name-input').inputValue()).length === 40, 'A7 a 41-character paste is stopped at 40 by maxLength', String((await T('dash-name-input').inputValue()).length))
  await T('dash-name-input').selectText()
  await page.keyboard.insertText('Sam​')
  await page.keyboard.press('Enter')
  await T('dash-name-error').waitFor({ timeout: 5000 }).catch(() => {})
  check((await text('dash-name-error')) === 'Use up to 40 letters, numbers or spaces.', 'A7 a hidden character gives "Use up to 40 letters, numbers or spaces."', await text('dash-name-error'))
  check((await T('dash-name-input').inputValue()) === 'Sam​' && (await salutationText()).endsWith(', Sam.'), 'A7 the refused field keeps what was typed and the saved name is unchanged')
  await page.keyboard.press('Escape')
  await sleep(300)
  // Settings > General > About you shows the name (A30).
  await openAppSettings(page)
  await T('display-name-input').waitFor({ timeout: 10_000 })
  check(await visible('[data-testid=appsettings-section-about-you]'), 'A30 Settings > General has the About you section')
  check((await T('display-name-input').inputValue()) === 'Sam' && (await T('display-name-input').getAttribute('maxlength')) === '40', 'A30 / A7 display-name-input shows the saved name and stops at 40', await T('display-name-input').inputValue())
  await T('display-name-input').fill('')
  await T('display-name-input').press('Enter')
  await sleep(500)
  await gotoProjects(page)
  check(!!(await until(async () => (await salutationText()) === `${hourWord}.`, 5000)), 'A7 clearing the Settings field removes the name from the salutation', await salutationText())
  check((await T('dash-name-add').count()) === 1 && (await T('dash-name-edit').count()) === 0, 'A7 with no name the Dashboard offers "Add your name" again')
  await openAppSettings(page)
  await T('display-name-input').fill('Sam')
  await T('display-name-input').press('Enter')
  await sleep(500)
  await gotoProjects(page)
  check(!!(await until(async () => (await salutationText()).endsWith(', Sam.'), 5000)), 'A7 typing the name in Settings shows it in the greeting', await salutationText())
  // Clear from the popover ("Remove name").
  await T('dash-name-edit').click()
  await nameInputFocused()
  await T('dash-name-input').selectText()
  await page.keyboard.press('Backspace')
  check(clean(await T('dash-name-save').innerText()) === 'Remove name', 'A7 emptying a saved name offers "Remove name"')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()) === `${hourWord}.`, 5000)), 'A7 Remove name clears the name', await salutationText())
  check(!!(await until(async () => (await live()).includes('Name removed.'), 3000)), 'A7 removing the name is announced', await live())
  await T('dash-name-add').click()
  await nameInputFocused()
  await page.keyboard.type('Sam')
  await page.keyboard.press('Enter')
  await until(async () => (await salutationText()).endsWith(', Sam.'), 5000)

  // A3: each hour band. Date.now is faked in the page (yesterday, so last-seen never moves forward) and the Dashboard is
  // remounted (it reads the clock at mount and every 30 s).
  const bands = [
    ['04:59', 4, 59, 'Hello'], ['05:00', 5, 0, 'Good morning'], ['11:59', 11, 59, 'Good morning'], ['12:00', 12, 0, 'Good afternoon'],
    ['16:59', 16, 59, 'Good afternoon'], ['17:00', 17, 0, 'Good evening'], ['21:59', 21, 59, 'Good evening'], ['22:00', 22, 0, 'Hello']
  ]
  const bandGot = []
  for (const [label, h, m, word] of bands) {
    await page.evaluate((expr) => {
      window.__realNow ??= Date.now.bind(Date)
      const ms = new Function(`return ${expr}`)()
      Date.now = () => ms
    }, NOW_OFFSET_DAY(h, m))
    await openProject(page, BUSY)
    await gotoProjects(page)
    const s = await salutationText()
    bandGot.push(`${label}=${s}`)
    await page.evaluate(() => {
      if (window.__realNow) Date.now = window.__realNow
    })
    if (s !== `${word}, Sam.`) check(false, `A3 at ${label} the salutation reads "${word}, Sam."`, s)
  }
  check(bandGot.length === 8, `A3 all eight hour edges were walked with a name (${bandGot.join('; ')})`)
  check(!/jsmith|admin|chapp/i.test(await salutationText()), 'A3 the OS account name never appears')
  await openProject(page, BUSY)
  await gotoProjects(page)

  // ---------------------------------------------------------------- A20 pins and A21 customise (no runs yet: empty sections are rows)
  // Pin from the tile's More menu.
  await tileOf(PINNED).locator('[data-testid=project-tile-more]').click()
  await T('project-tile-pin-item').waitFor({ state: 'visible', timeout: 5000 })
  check(/Pin to top/.test(await text('project-tile-pin-item')), 'A20 the More menu offers "Pin to top"')
  await T('project-tile-pin-item').click()
  await sleep(500)
  check((await page.locator('[data-testid=project-tile]').first().getAttribute('data-name')) === PINNED, 'A20 pinning from More moves the tile first')
  check((await live()).includes(`Pinned ${PINNED}.`), 'A20 pinning from More announces "Pinned ..."', await live())
  check((await layoutOf())?.pinned?.includes(pinId), 'A20 the pin is stored in orgai.dashboardLayout')
  await until(async () => (await activeInfo()).testid === 'project-tile-more', 5000, 50)
  check(((await activeInfo()).testid === 'project-tile-more'), 'A20 focus returns to the same tile control after pinning', JSON.stringify(await activeInfo()))
  check((await page.locator('[data-testid=tile-pinned-glyph]').count()) === 1 && /pinned/.test((await tileOf(PINNED).locator('[data-testid=project-tile-main]').getAttribute('aria-label')) ?? ''), 'A20 a pinned tile shows the Pin glyph and "pinned" in its name')
  check(!!(await T('dash-resume').count()) && (await T('dash-resume-row').filter({ has: page.locator('[data-action=new-run]') }).count()) === 1, 'A13 a pinned project with no runs shows one Pick up row with New run')
  const pinRow = page.locator(`[data-testid=dash-resume-row][data-kind=pinned][data-project="${pinId}"]`)
  check((await pinRow.count()) === 1 && /No runs yet\./.test(clean(await pinRow.innerText())) && (await pinRow.locator('[data-testid=dash-resume-action]').getAttribute('data-action')) === 'new-run', 'A13 its row is kind pinned, says "No runs yet." and offers New run', clean(await pinRow.innerText()))
  check((await T('tile-run').count()) === 0, 'A20 no tile shows tile-run')

  // Customise: entry, bar, controls, empty rows, full width.
  const customise = T('dash-customise')
  check((await customise.getAttribute('aria-expanded')) === 'false', 'A21 dash-customise starts collapsed (aria-expanded=false)')
  await customise.click()
  await T('dash-customise-bar').waitFor({ timeout: 5000 })
  check((await customise.getAttribute('aria-expanded')) === 'true' && clean(await customise.innerText()) === 'Done', 'A21 Customise becomes Done with aria-expanded=true')
  check((await slotOrder()).join() === DEFAULT_ORDER.join(), 'A21 customise lists all five sections in the default order', (await slotOrder()).join())
  const states = await page.locator('[data-testid=dash-section]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-section')}:${e.getAttribute('data-state')}`))
  check(states.join() === 'resume:shown,today:empty,working:empty,week:empty,projects:shown', 'A15 empty sections show as empty rows only while customising', states.join())
  check(/Today: nothing to show right now\./.test(clean(await page.locator('[data-testid=dash-section][data-section=today]').innerText())), 'A15 an empty section reads "Today: nothing to show right now." in customise mode')
  const widths = await page.locator('[data-testid=dash-section]').evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().width), e.getAttribute('data-span')]))
  check(widths.every((w) => w[0] === widths[0][0] && w[1] === widths[0][1] && w[2] === 'full'), 'A22 in customise mode every section is one full-width track at 1600x1000', JSON.stringify(widths))
  // Pin toggle on a tile, in customise mode.
  const pinBtn = tileOf(WAIT).locator('[data-testid=project-tile-pin]')
  check((await pinBtn.getAttribute('aria-pressed')) === 'false', 'A20 the customise pin toggle is aria-pressed=false while unpinned')
  await pinBtn.click()
  await sleep(300)
  check((await live()).includes(`Pinned ${WAIT}.`) && (await pinBtn.getAttribute('aria-pressed')) === 'true', 'A20 the pin toggle pins and announces', await live())
  check((await layoutOf())?.pinned?.join() === `${pinId},${waitId}`, 'A20 pins are stored in the order they were pinned', JSON.stringify((await layoutOf())?.pinned))
  await until(async () => (await activeInfo()).testid === 'project-tile-pin', 5000, 50)
  check(((await activeInfo()).testid === 'project-tile-pin'), 'A20 focus stays on the pin toggle after pinning', JSON.stringify(await activeInfo()))

  // Keyboard-only path: Tab from the Customise button to Reset, then the first section's controls.
  await customise.focus()
  const tabPath = []
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    const a = await activeInfo()
    tabPath.push(`${a.testid}${a.section ? `@${a.section}` : ''}`)
    if (a.testid === 'dash-section-hide') break
  }
  check(tabPath.includes('dash-customise-reset') && tabPath.slice(-3).join() === 'dash-section-up@resume,dash-section-down@resume,dash-section-hide@resume', 'A21 Tab reaches Reset, then each section\'s up, down, Hide in order', tabPath.join(' > '))
  // The first section's up button is aria-disabled at the top: Enter announces and keeps focus.
  await ctl('resume', 'dash-section-up').focus()
  check((await ctl('resume', 'dash-section-up').getAttribute('aria-disabled')) === 'true' && (await ctl('resume', 'dash-section-up').getAttribute('disabled')) === null, 'A21 the first section\'s Move up is aria-disabled (not disabled)')
  await page.keyboard.press('Enter')
  await sleep(300)
  check((await live()).includes('Pick up where you left off is already first.') && (await activeInfo()).testid === 'dash-section-up', 'A21 at the top, Move up says "is already first." and keeps focus', `${await live()} ${JSON.stringify(await activeInfo())}`)
  await ctl('projects', 'dash-section-down').focus()
  await page.keyboard.press('Enter')
  await sleep(300)
  check((await ctl('projects', 'dash-section-down').getAttribute('aria-disabled')) === 'true' && (await live()).includes('Projects is already last.'), 'A21 at the bottom, Move down says "is already last."', await live())
  // Move down: focus stays on the pressed button.
  await ctl('resume', 'dash-section-down').focus()
  await page.keyboard.press('Enter')
  await sleep(400)
  let ai = await activeInfo()
  check((await slotOrder()).join() === 'today,resume,working,week,projects', 'A21 Move down moves the section one place', (await slotOrder()).join())
  check(ai.testid === 'dash-section-down' && ai.section === 'resume', 'A21 after Move down focus stays on the pressed button', JSON.stringify(ai))
  check((await live()).includes('Pick up where you left off moved down. Position 2 of 5.'), 'A21 Move down announces "moved down. Position 2 of 5."', await live())
  await ctl('resume', 'dash-section-up').focus()
  await page.keyboard.press('Enter')
  await sleep(400)
  ai = await activeInfo()
  check((await slotOrder()).join() === DEFAULT_ORDER.join() && ai.testid === 'dash-section-up' && ai.section === 'resume', 'A21 Move up restores the order and keeps focus on the pressed button', `${(await slotOrder()).join()} ${JSON.stringify(ai)}`)
  check((await live()).includes('moved up. Position 1 of 5.'), 'A21 Move up announces "moved up. Position 1 of 5."', await live())
  check((await page.locator('[data-testid=dash-section][data-section=resume].motion-ring').count()) <= 1, 'a moved section carries at most one ring')
  // Hide and Show move focus to each other.
  await ctl('today', 'dash-section-hide').focus()
  await page.keyboard.press('Enter')
  await sleep(400)
  ai = await activeInfo()
  check(ai.testid === 'dash-section-show' && ai.section === 'today', 'A21 Hide moves focus to that section\'s Show', JSON.stringify(ai))
  check((await live()).includes('Today hidden.') && (await page.locator('[data-testid=dash-section][data-section=today]').getAttribute('data-state')) === 'hidden', 'A21 Hide announces "Today hidden." and collapses the section', await live())
  check(/Today, hidden/.test(clean(await page.locator('[data-testid=dash-section][data-section=today]').innerText())), 'A21 a hidden section reads "Today, hidden"')
  check((await layoutOf())?.hidden?.join() === 'today', 'A21 the hidden list is stored')
  await page.keyboard.press('Enter')
  await sleep(400)
  ai = await activeInfo()
  check(ai.testid === 'dash-section-hide' && ai.section === 'today' && (await live()).includes('Today shown.'), 'A21 Show moves focus back to Hide and announces "Today shown."', `${JSON.stringify(ai)} ${await live()}`)
  // Esc leaves customise mode and returns focus to the Customise button.
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await customise.getAttribute('aria-expanded')) === 'false' && (await T('dash-customise-bar').count()) === 0, 'A21 Esc leaves customise mode', String(await customise.getAttribute('aria-expanded')))
  await until(async () => (await activeInfo()).testid === 'dash-customise', 5000, 50)
  check((await activeInfo()).testid === 'dash-customise', 'A21 Esc returns focus to dash-customise', JSON.stringify(await activeInfo()))
  check((await T('dash-section-controls').count()) === 0, 'A21 the control rows go with customise mode')
  // Reset restores order and hidden and keeps pins; focus stays on Reset.
  await customise.click()
  await ctl('projects', 'dash-section-up').click()
  await ctl('week', 'dash-section-hide').click()
  await sleep(300)
  const messy = await layoutOf()
  check(messy?.order?.join() === 'resume,today,working,projects,week' && messy?.hidden?.join() === 'week', 'A21 a move and a hide are stored', JSON.stringify(messy))
  await T('dash-customise-reset').click()
  await sleep(300)
  const reset = await layoutOf()
  check(reset?.order?.join() === DEFAULT_ORDER.join() && reset?.hidden?.length === 0 && reset?.pinned?.join() === `${pinId},${waitId}`, 'A21 Reset restores order and hidden and keeps pins', JSON.stringify(reset))
  await until(async () => (await activeInfo()).testid === 'dash-customise-reset', 5000, 50)
  check((await activeInfo()).testid === 'dash-customise-reset' &&(await live()).includes('Layout reset to the default.'), 'A21 Reset keeps focus on itself and announces', `${JSON.stringify(await activeInfo())} ${await live()}`)
  // Reload keeps the layout.
  await ctl('projects', 'dash-section-up').click()
  await ctl('today', 'dash-section-hide').click()
  await sleep(300)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 60_000 })
  await gotoProjects(page)
  await T('dash-customise').click()
  await T('dash-customise-bar').waitFor({ timeout: 5000 })
  check((await slotOrder()).join() === 'resume,today,working,projects,week' && (await page.locator('[data-testid=dash-section][data-section=today]').getAttribute('data-state')) === 'hidden', 'A21 a reload keeps the order and the hidden section', (await slotOrder()).join())
  await T('dash-customise-reset').click()
  await T('dash-customise').click()
  check(!!(await until(async () => (await T('dash-customise-bar').count()) === 0, 5000, 50)), 'A21 Done leaves customise mode')
  // All five hidden, customise closed: one quiet line and a button that opens customise.
  await T('dash-customise').click()
  await T('dash-customise-bar').waitFor({ timeout: 5000 })
  for (const id of DEFAULT_ORDER) {
    const hide = ctl(id, 'dash-section-hide')
    if ((await hide.count()) > 0) await hide.click()
  }
  check(!!(await until(async () => ((await layoutOf())?.hidden ?? []).length === 5, 5000, 50)), 'A21 all five sections can be hidden', JSON.stringify((await layoutOf())?.hidden))
  await T('dash-customise').click()
  check(!!(await until(async () => (await T('dash-customise-bar').count()) === 0 && (await visible('[data-testid=dash-all-hidden]')), 5000, 50)), 'A21 with all five hidden and customise closed "All sections are hidden." shows')
  check(/^All sections are hidden\./.test(await text('dash-all-hidden')) && (await visible('[data-testid=dash-all-hidden-show]')), 'A21 the line has a Show sections button', await text('dash-all-hidden'))
  await T('dash-all-hidden-show').click()
  check(!!(await until(async () => (await T('dash-customise-bar').count()) === 1 && (await T('dash-all-hidden').count()) === 0, 5000, 50)), 'A21 Show sections opens customise mode and the line goes')
  check(!!(await until(async () => (await activeInfo()).testid === 'dash-customise', 5000, 50)), 'A21 Show sections moves focus to the Customise (Done) button', JSON.stringify(await activeInfo()))
  await T('dash-customise-reset').click()
  await T('dash-customise').click()
  await until(async () => (await T('dash-customise-bar').count()) === 0, 5000, 50)
  // Corrupt storage loads a valid layout and raises no error.
  const errorsBefore = pageErrors.length
  const corrupt = [
    ['a string', '"x"', DEFAULT_ORDER.join()],
    ['a wrong version', '{"v":2,"order":["projects"]}', DEFAULT_ORDER.join()],
    ['not JSON', 'not json{', DEFAULT_ORDER.join()],
    ['unknown and duplicate ids', '{"v":1,"order":["today","bogus","today","projects"],"hidden":["nope","today","today"],"pinned":[7,"x","x"]}', null]
  ]
  for (const [label, raw, want] of corrupt) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [LAYOUT_KEY, raw])
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 60_000 })
    await gotoProjects(page)
    await T('dash-customise').click()
    await T('dash-customise-bar').waitFor({ timeout: 5000 })
    const order = await slotOrder()
    const valid = order.length === 5 && new Set(order).size === 5 && order.every((o) => DEFAULT_ORDER.includes(o))
    check(valid && (want === null || order.join() === want), `A21 corrupt storage (${label}) loads a valid layout`, order.join())
    await T('dash-customise').click()
  }
  check(pageErrors.length === errorsBefore, 'A21 corrupt storage raises no page error', pageErrors.slice(errorsBefore).join(' | '))
  await page.evaluate((k) => localStorage.removeItem(k), LAYOUT_KEY)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 60_000 })
  await gotoProjects(page)
  // Re-pin: the default layout held no pins; the rest of the run needs the pinned project first.
  await tileOf(PINNED).locator('[data-testid=project-tile-more]').click()
  await T('project-tile-pin-item').click()
  await sleep(400)
  check((await page.locator('[data-testid=project-tile]').first().getAttribute('data-name')) === PINNED, 'A20 the project is pinned again after the storage tests')

  // ---------------------------------------------------------------- Runs: a permission card, a deep tree, a schedule proposal
  await openProject(page, WAIT)
  await startRun('First task')
  await page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first().waitFor({ timeout: 20_000 })
  await openProject(page, BUSY)
  await startRun('Deep tree [mock:deep-tree]')
  // While the tree runs: working agent rows and breathing marks (A25: none of it animates under reduced motion).
  await gotoProjects(page)
  const workingEarly = await until(async () => (await page.locator('[data-testid=dash-now] [data-testid=dash-agent-row][data-state=working]').count()) >= 1, 15_000, 150)
  check(!!workingEarly, 'Working now lists at least one working agent row while the deep tree runs')
  const markAnimOf = () =>
    page.evaluate(() => {
      const m = document.querySelector('.dash-mark[data-state=working]')
      return m ? getComputedStyle(m, '::after').animationName : 'no-mark'
    })
  const markNormal = await markAnimOf()
  await setAppearance({ reduceMotion: 'on' })
  const markAnim = await markAnimOf()
  if (markAnim === 'no-mark') log('SKIP reduced-motion mark check: the working mark was gone before the setting applied')
  else {
    check(markAnim === 'none', 'A25 with data-reduce-motion=on the working mark has no ::after animation', markAnim)
    check(markNormal !== 'none', 'A25 (control) without reduced motion the working mark does animate', markNormal)
  }
  await setAppearance({ reduceMotion: 'system' })
  const schedProject = await createProject(page, { path: repoS, name: SCHED })
  check(!!schedProject, 'fourth project created for the schedule proposal')
  await openProject(page, SCHED)
  await startRun('Please schedule a check [mock:schedule]')
  await page.locator('section.frame-tray article.decision-card').first().waitFor({ timeout: 20_000 })

  // Today's data: a schedule due later, open and done to-dos, one assistant to-do from a Chat run.
  const later = await page.evaluate(() => {
    const d = new Date(Date.now() + 20 * 60_000)
    const sameDay = d.getDate() === new Date().getDate()
    return { sameDay, time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  })
  let scheduleId = null
  if (later.sameDay) {
    scheduleId = await page.evaluate(([pid, time]) => window.orgai.schedules.save({ name: 'E2E dash check', prompt: 'Nothing.', target: { kind: 'team', projectId: pid }, timing: { kind: 'daily', time }, enabled: true }).then((s) => s.id), [pinId, later.time])
  } else log('SKIP the schedule row: less than 20 minutes to local midnight')
  const LONG_TITLE = 'Prepare the quarterly planning document with the budget notes and the hiring plan and the risks and send it to the whole leadership group before the end of the month'
  await page.evaluate(
    async ([pid, long]) => {
      await window.orgai.todos.save({ scope: { kind: 'project', projectId: pid }, title: 'Draft the project brief' })
      await window.orgai.todos.save({ scope: { kind: 'chat' }, title: long })
      const done = await window.orgai.todos.save({ scope: { kind: 'chat' }, title: 'Already finished thing' })
      await window.orgai.todos.save({ id: done.id, scope: { kind: 'chat' }, status: 'done' })
    },
    [pinId, LONG_TITLE]
  )
  let chatTodo = false
  try {
    await app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), 'ask-about-orgai')
    const field = page.locator('[data-testid=assistant-start-quick] .composer textarea')
    await field.waitFor({ timeout: 10_000 })
    await field.fill('Please remember this [mock:todo]')
    await field.press('Enter')
    chatTodo = !!(await until(async () => (await store({ kind: 'chat' })).some((i) => i.createdBy === 'agent'), 30_000))
    await endSession(page)
  } catch (e) {
    log('chat to-do run failed:', e.message.slice(0, 160))
  }
  check(chatTodo, 'A14 [mock:todo] in a Chat run adds an assistant to-do')

  await gotoProjects(page)
  await T('dash-needs-row').first().waitFor({ timeout: 15_000 })

  // ---------------------------------------------------------------- A8 / A10 / A11 Waiting on you, band and tiles
  const rows = await T('dash-needs-row').count()
  const bell = await bellCount()
  check(rows >= 2 && rows === bell, 'A8 dash-needs-row count equals the sidebar bell count', `${rows} vs ${bell}`)
  const kinds = await needsKinds()
  check(kinds.includes('permission') && kinds.length >= 2 && new Set(kinds).size >= 2, 'A10 two kinds of decision wait (permission and the schedule proposal)', kinds.join())
  check(weightsAscend(kinds), 'A10 Waiting on you is ordered by kind weight (permission before proposal)', kinds.join())
  const keysBefore = await needsKeys()
  await sleep(2500)
  check((await needsKeys()).join('|') === keysBefore.join('|'), 'A10 a row does not move while other events arrive', `${keysBefore.join('|')} -> ${(await needsKeys()).join('|')}`)
  check((await text('dash-needs-you')).startsWith('Waiting on you'), 'the section is called "Waiting on you"', (await text('dash-needs-you')).slice(0, 40))
  const regions = await headingFacts()
  check(regions.present.includes('dash-needs-you') && regions.present.includes('dash-now') && regions.present.includes('dash-resume') && regions.present.includes('dash-today') && regions.present.includes('dash-week'), 'A15 with data every arrangeable section renders', JSON.stringify(regions.present))
  await checkHeadings('with data at 1600x1000')
  // The band.
  check((await page.locator('[data-testid=dash-now] [data-testid=dash-running-row][data-status]').count()) >= 1, 'A16 a live run appears in Working now (dash-now > dash-running-row)')
  check((await T('dash-now-empty').count()) === 0, 'A16 there is no dash-now-empty while runs are live')
  check((await text('dash-now')).startsWith('Working now'), 'the band is called "Working now"', (await text('dash-now')).slice(0, 30))
  const runIds = await T('dash-running-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-run')))
  check(new Set(runIds).size === runIds.length, 'each run appears once in the band', JSON.stringify(runIds))
  const waitGroup = page.locator('[data-testid=dash-now] [data-testid=dash-now-project]', { has: page.locator('h3', { hasText: WAIT }) })
  const needsMarked = await waitGroup.locator('[data-testid=dash-running-row][data-needs]').first().waitFor({ timeout: 5000 }).then(() => true, () => false)
  check(needsMarked && (await waitGroup.locator('[data-testid=dash-running-row]').count()) === 1, 'A11 the waiting run is one band row marked data-needs')
  const waitBand = clean(await waitGroup.innerText().catch(() => ''))
  check(/Waiting on you/.test(waitBand) && !/\bcd /.test(waitBand), 'A11 the band run says "Waiting on you" and carries no raw command', waitBand)
  const bandText = await text('dash-now')
  check(!/\bcd /.test(bandText), 'A11 no band text contains the mock command', bandText.slice(0, 200))
  const tilesText = clean(await page.locator('[data-testid=dash-projects]').innerText())
  check(!/\bcd /.test(tilesText) && (await T('tile-run').count()) === 0, 'A11 no project tile text contains the mock command and no tile has tile-run')
  // Tiles.
  const tiles = await page.locator('[data-testid=project-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
  check(tiles[0] === PINNED && [WAIT, SCHED].includes(tiles[1]) && [WAIT, SCHED].includes(tiles[2]) && tiles[3] === BUSY, 'A20 the pinned tile is first, then the projects with a decision, then the rest', JSON.stringify(tiles))
  const tileText = clean(await tileOf(WAIT).innerText())
  check(/\b1 decision waiting\b/.test(tileText), 'A11 the waiting tile says only its count word ("1 decision waiting")', tileText)
  const team = await tileOf(BUSY).evaluate((li) => {
    const row = li.querySelector('[data-testid=tile-team]')
    return { count: Number(row?.getAttribute('data-count') ?? -1), marks: row ? row.querySelectorAll('.tile-team-root, .tile-team-mark').length : -1, more: li.querySelectorAll('[data-testid=tile-team-more]').length, hidden: row?.getAttribute('aria-hidden') ?? '', name: li.querySelector('[data-testid=project-tile-main]')?.getAttribute('aria-label') ?? '' }
  })
  check(team.count === 4 && team.marks === 4 && team.more === 0, 'the deep-tree project tile draws one team mark per role (4) and no "+N"', JSON.stringify(team))
  check(team.hidden === 'true' && /team of 4: [^,]+, [^,]+, [^,]+ and 1 more/.test(team.name), 'the team row is decorative and the Open name says "team of 4: ..."', team.name)
  const folder = tileOf(WAIT).locator('[data-testid=tile-folder]')
  check((await folder.count()) === 1 && ((await folder.getAttribute('title')) ?? '').length > clean(await folder.innerText()).length, 'the tile folder is a name with the full path as its title')
  await page.mouse.move(1, 1)
  await sleep(200)
  const bgs = await page.evaluate(([w, b]) => {
    const bg = (name) => {
      const li = document.querySelector(`[data-testid=project-tile][data-name="${name}"]`)
      return li ? { state: li.getAttribute('data-state'), bg: getComputedStyle(li).backgroundColor, img: getComputedStyle(li).backgroundImage } : null
    }
    return { wait: bg(w), busy: bg(b) }
  }, [WAIT, BUSY])
  check(bgs.wait?.state === 'decisions' && bgs.wait.bg === bgs.busy?.bg && bgs.wait.img === 'none', 'a [data-state=decisions] tile has no amber background (one tinted block)', JSON.stringify(bgs))
  check((await tileOf(WAIT).locator(':scope > .project-tile-more [data-testid=project-tile-more]').count()) === 1, 'More sits in a direct child of the tile li')
  // Waiting rows: permission rows offer Allow once and Deny, never a wider scope.
  const permRow = page.locator('[data-testid=dash-needs-row][data-kind=permission]').first()
  check((await permRow.getAttribute('data-inline')) === 'allow', 'a short permission row offers inline Allow', String(await permRow.getAttribute('data-inline')))
  check((await permRow.locator('[data-testid=dash-needs-allow]').count()) === 1 && (await permRow.locator('[data-testid=dash-needs-deny]').count()) === 1, 'the permission row has Allow once and Deny')
  const dashText = await T('dashboard').innerText()
  check(!/Allow for session|Always allow/i.test(dashText), 'A8 the Dashboard never offers Allow for session or Always allow')
  check((await T('tile-chip').count()) === 0, 'no tile chip shows when nothing is pending')
  const setupKinds = await T('dash-setup-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  check(setupKinds.every((k) => k === 'connection'), 'To finish setting up holds no project, service or connector rows (only machine-dependent connection rows)', JSON.stringify(setupKinds))
  check((await T('dash-limits').count()) === 0, 'A19 plan limits are absent under the mock adapter')
  const removed = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`[data-testid="${id}"]`)), REMOVED_IDS)
  check(removed.length === 0, 'the removed test ids are not on the page', removed.join())
  await checkBrief('with decisions waiting')
  const brief1 = await briefText()
  check(/^2 decisions are waiting on you\./.test(brief1) && (brief1.match(/\./g) ?? []).length <= 3, 'A4 the brief leads with the waiting sentence and stays short', brief1)

  // ---------------------------------------------------------------- A14 Today
  const today = T('dash-today')
  await today.waitFor({ timeout: 10_000 })
  const todoRows = await T('dash-today-todo').evaluateAll((els) => els.map((e) => e.textContent ?? ''))
  check(todoRows.length >= 2 && !todoRows.some((t) => /Already finished thing/.test(t)), 'A14 open to-dos from two lists show and a done to-do never does', JSON.stringify(todoRows).slice(0, 300))
  const todayTodos = clean(await text('dash-today-todos'))
  check(/To-dos/.test(todayTodos) && /Draft the project brief/.test(todayTodos) && todayTodos.includes(PINNED), 'A14 a to-do row names its list', todayTodos.slice(0, 200))
  if (chatTodo) check(/Added by an assistant/.test(todayTodos), 'A14 an assistant-added to-do says "Added by an assistant"', todayTodos.slice(0, 300))
  const longRow = page.locator('[data-testid=dash-today-todo]', { has: page.locator('.dash-row-name', { hasText: 'Prepare the quarterly planning' }) })
  const longFacts = await longRow.evaluate((li) => {
    const name = li.querySelector('.dash-row-name')
    const btn = li.querySelector('[data-testid=dash-today-start]')
    return { clipped: name.scrollWidth > name.clientWidth, title: name.getAttribute('title') === name.textContent, btnInside: btn.getBoundingClientRect().right <= li.getBoundingClientRect().right + 1 }
  })
  check(longFacts.clipped && longFacts.title && longFacts.btnInside, 'A6 a long to-do title clips with an ellipsis and a title and the button stays in its row', JSON.stringify(longFacts))
  if (scheduleId) {
    const sRow = page.locator('[data-testid=dash-today-schedule][data-state=upcoming]', { hasText: 'E2E dash check' })
    const sText = clean(await sRow.innerText().catch(() => ''))
    const timeWords = clean(await page.evaluate((t) => { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }, later.time))
    check((await sRow.count()) === 1 && sText.includes(timeWords) && sText.includes(PINNED) && /Starts at/.test(sText), 'A14 a schedule due later today shows its time and target', `${sText} (wanted ${timeWords})`)
    await setSettings({ schedulesPaused: true })
    check(!!(await until(async () => (await T('dash-today-paused').count()) === 1, 5000)) && (await T('dash-today-schedule').count()) === 0, 'A14 paused schedules show the pause line and no rows', await text('dash-today'))
    check(/Schedules are paused\. Nothing will start today\./.test(await text('dash-today-paused')), 'A14 the pause line reads "Schedules are paused. Nothing will start today."')
    await setSettings({ schedulesPaused: false })
    await until(async () => (await T('dash-today-schedule').count()) === 1, 5000)
  }
  // Start session fills the composer and starts no run.
  const runsBefore = (await runsOf(pinId)).length
  const startBtn = page.getByRole('button', { name: 'Start session for Draft the project brief' })
  await startBtn.click()
  await page.locator('.composer textarea').first().waitFor({ timeout: 10_000 })
  await sleep(500)
  const draft = await page.locator('.composer textarea').first().inputValue()
  check(/Draft the project brief/.test(draft), 'A14 Start session fills the message box with the to-do', draft.slice(0, 120))
  check((await runsOf(pinId)).length === runsBefore, 'A14 Start session starts no run', `${runsBefore} -> ${(await runsOf(pinId)).length}`)
  check((await page.locator('main .topbar h1').first().innerText()).trim() === PINNED, 'A14 Start session opens the project it belongs to')
  check((await activeInfo()).inComposer, 'A14 focus is in the composer after Start session', JSON.stringify(await activeInfo()))
  await gotoProjects(page)

  // ---------------------------------------------------------------- A17 / A18 Your week
  const week = T('dash-week')
  await week.waitFor({ timeout: 10_000 })
  const days = T('dash-strip-day')
  check((await days.count()) === 7, 'A17 the ledger has 7 day buttons', String(await days.count()))
  const todays = await days.evaluateAll((els) => els.filter((e) => e.getAttribute('data-today') !== null && e.getAttribute('data-today') !== 'false').length)
  check(todays === 1, 'A17 exactly one ledger day is today', String(todays))
  const stops2 = await days.evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length)
  check(stops2 === 1, 'A17 the ledger is one Tab stop', String(stops2))
  const dayRuns = (await days.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-runs')) || 0))).reduce((a, b) => a + b, 0)
  const weekRuns = Number(/\d+/.exec(await text('dash-week-runs'))?.[0] ?? -1)
  check(dayRuns === weekRuns && dayRuns >= 3, 'A17 the day counts add up to dash-week-runs', `${dayRuns} vs ${weekRuns}`)
  check(/\d/.test(await text('dash-week-time')) && (await T('dash-week-top-project').count()) === 1, 'A17 Time working and the most active project show with several active projects', `${await text('dash-week-time')} / ${await text('dash-week-top-project')}`)
  check(!/\$0\.00/.test(await text('dash-week')), 'A17 Your week never reads $0.00', (await text('dash-week')).slice(0, 200))
  check((await T('dash-week-usage').count()) === 1, 'Your week offers "See usage"')
  const todayBtn = days.evaluateAll((els) => els.findIndex((e) => e.getAttribute('data-today') === 'true'))
  await days.nth(await todayBtn).focus()
  const readoutBefore = await text('dash-strip-readout')
  await page.keyboard.press('ArrowLeft')
  await sleep(200)
  const readoutAfter = await text('dash-strip-readout')
  check(readoutAfter !== readoutBefore, 'A17 ArrowLeft on the ledger changes its readout', `${readoutBefore} -> ${readoutAfter}`)
  await page.keyboard.press('Enter')
  const pressed = await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'))
  check(pressed === 'true', 'A17 Enter pins a ledger day (aria-pressed=true)', String(pressed))
  await page.keyboard.press('Escape')
  const unpressed = await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'))
  check(unpressed === 'false', 'A17 Esc unpins it', String(unpressed))
  check(!(await visible('[data-testid=dash-customise-bar]')), 'Esc on the ledger does not turn customise on or off')
  const track = await page.locator('.dash-strip-track').first().evaluate((el) => ({ h: Math.round(el.getBoundingClientRect().height), data: el.getAttribute('data-track') }))
  check(track.h === 56 && track.data === '56', 'A18 the ledger track is 56 px at 1600x1000', JSON.stringify(track))
  const bars = await page.locator('[data-testid=dash-strip-bar]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))
  check(bars.length >= 1 && bars.every((h) => h >= 2), 'A18 a day with runs has a bar of at least 2 px', JSON.stringify(bars))
  await shot('week-1600x1000')

  // ---------------------------------------------------------------- A22 pairs outside customise mode
  const slots = await page.locator('[data-testid=dash-section]').evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute('data-section'), span: e.getAttribute('data-span'), x: Math.round(e.getBoundingClientRect().left), y: Math.round(e.getBoundingClientRect().top), w: Math.round(e.getBoundingClientRect().width), state: e.getAttribute('data-state') }))
  )
  const byRow = new Map()
  for (const s of slots) byRow.set(s.y, [...(byRow.get(s.y) ?? []), s])
  const rowsOf = [...byRow.values()]
  const pairedOk = rowsOf.every((r) => (r.length === 1 && r[0].span === 'full') || (r.length === 2 && r.every((s) => s.span === 'half') && r[0].x < r[1].x && Math.abs(r[0].w - r[1].w) <= 2))
  check(pairedOk && rowsOf.some((r) => r.length === 2) && slots.map((s) => s.id).join() === DEFAULT_ORDER.join(), 'A22 outside customise mode the half-width sections sit side by side and Projects takes the row', JSON.stringify(slots))
  check(slots.find((s) => s.id === 'projects')?.span === 'full', 'A22 Projects is always full width')

  // ---------------------------------------------------------------- A25 reduced motion
  await setAppearance({ reduceMotion: 'on' })
  const motion = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'motion-enter'
    document.querySelector('[data-testid=dashboard]').appendChild(probe)
    const all = [...document.querySelectorAll('.motion-enter')].map((e) => getComputedStyle(e).animationDuration)
    probe.remove()
    const ms = (v) => v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000))
    return { count: all.length, max: Math.max(...all.flatMap(ms)) }
  })
  check(motion.count >= 1 && motion.max <= 0.011, 'A25 under reduced motion no .motion-enter has a duration above 0.01 ms', JSON.stringify(motion))
  await setAppearance({ reduceMotion: 'system' })
  check((await page.locator('.motion-ring').count()) === 0, 'A25 no ring is left on the page at rest')

  // ---------------------------------------------------------------- More menu, delete confirm, New run
  await tileOf(WAIT).locator('[data-testid=project-tile-more]').click()
  await T('project-tile-open-folder').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const menu = clean(await page.getByRole('menu').last().innerText().catch(() => ''))
  check((await visible('[data-testid=project-tile-open-folder]')) && (await visible('[data-testid=project-tile-delete]')) && /Open folder/.test(menu) && /Delete project/.test(menu), 'the More menu offers Open folder and Delete', menu)
  check((await visible('[data-testid=project-tile-new-run]')) && /New run/.test(menu) && (await visible('[data-testid=project-tile-pin-item]')) && /Pin to top/.test(menu), 'the More menu offers New run and Pin to top', menu)
  check(await page.evaluate(() => !!document.activeElement?.closest?.('[role=menu]')), 'opening the More menu moves focus into it')
  await T('project-tile-delete').click()
  const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog')).last()
  await dlg.waitFor({ timeout: 5000 })
  const body = clean(await dlg.innerText())
  check(/Ends 1 open run/.test(body), 'the delete confirm names the open run', body.slice(0, 240))
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await sleep(300)
  // A Waiting row opens the card.
  await page.locator('[data-testid=dash-needs-row]').first().locator('[data-row-main]').click()
  await page.locator('section.frame-tray article.decision-card').first().waitFor({ timeout: 10_000 })
  check(true, 'the Waiting on you row opens the decision card')
  await gotoProjects(page)
  // New run from the tile menu: a draft with focus on the page, not on the body.
  await tileOf(BUSY).locator('[data-testid=project-tile-more]').click()
  await T('project-tile-new-run').click()
  await sleep(900)
  const newRunLanded = await page.evaluate(() => ({
    h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '',
    focusOk: document.activeElement !== document.body && !document.activeElement?.closest?.('[data-testid=dashboard]'),
    composer: !!document.querySelector('.composer textarea')
  }))
  check(newRunLanded.h1 === BUSY && newRunLanded.focusOk && newRunLanded.composer, 'New run in the tile menu opens a draft with focus on a real element', JSON.stringify(newRunLanded))
  await gotoProjects(page)

  // ---------------------------------------------------------------- The band: Enter on an agent row opens the agent
  const doneButton = page.locator('[data-testid=dash-now] [data-testid=dash-agent-done][data-count]')
  await doneButton.first().waitFor({ timeout: 60_000 }).then(
    () => check(true, 'a settled deep tree folds into a dash-agent-done group'),
    () => check(false, 'a settled deep tree folds into a dash-agent-done group')
  )
  const agentRow = page.locator('[data-testid=dash-now] [data-testid=dash-agent-row][data-agent]').first()
  if (await agentRow.count()) {
    const agentId = await agentRow.getAttribute('data-agent')
    await agentRow.focus()
    await page.keyboard.press('Enter')
    const landedNode = await page
      .waitForFunction((id) => {
        const n = document.querySelector(`.react-flow__node[data-id="${id}"]`)
        return !!n && n.classList.contains('selected') && document.activeElement?.closest?.('.react-flow__node')?.getAttribute('data-id') === id
      }, agentId, { timeout: 10_000 })
      .then(() => true, () => false)
    check(landedNode, 'Enter on a band agent row opens the Live view with that node selected and focused', agentId)
    await gotoProjects(page)
  } else check(false, 'the band lists an agent row to open')

  // Keyboard: Enter on Open lands on the heading.
  await tileOf(BUSY).locator('[data-testid=project-tile-main]').focus()
  await page.keyboard.press('Enter')
  await sleep(600)
  check((await activeInfo()).inMainTopbarH1, 'Enter on a tile Open leaves focus on the topbar heading', JSON.stringify(await activeInfo()))
  await gotoProjects(page)

  // Escape on the New project dialog.
  await T('new-project').click()
  await T('new-project-dialog').waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await T('new-project-dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  await sleep(200)
  check((await activeInfo()).testid === 'new-project', 'Escape on the New project dialog returns focus to New project', JSON.stringify(await activeInfo()))

  // ---------------------------------------------------------------- Sizes and themes (A1, A6, A18, A22, A23)
  await setName('Bartholomew-Maximilian Featherstonehaugh')
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await setSize(w, h)
    for (const theme of ['dark', 'light']) {
      const tag = `at ${w}x${h} ${theme}`
      await setTheme(theme)
      await gotoProjects(page)
      await T('dash-needs-you').waitFor({ timeout: 10_000 })
      const m = await page.evaluate(() => {
        const n = document.querySelector('[data-testid=dash-needs-you]').getBoundingClientRect()
        const hero = document.querySelector('[data-testid=dashboard-hero]').getBoundingClientRect()
        const sal = document.querySelector('[data-testid=dash-greeting-salutation]')
        const tr = document.querySelector('.dash-strip-track')
        return {
          theme: document.documentElement.dataset.theme,
          needsTop: n.top,
          vh: window.innerHeight,
          heroBottom: hero.bottom,
          needsRows: document.querySelectorAll('[data-testid=dash-needs-row]').length,
          salClipped: sal.scrollWidth > sal.clientWidth,
          salInside: sal.getBoundingClientRect().right <= hero.right + 1,
          track: tr ? Math.round(tr.getBoundingClientRect().height) : -1,
          tracks: document.querySelector('.dash-page')?.getAttribute('data-tracks')
        }
      })
      const o = await overflowFacts()
      check(m.theme === theme, `theme is ${theme} ${tag}`)
      check(o.over <= 1 && o.docOver <= 1, `A23 the dashboard has no horizontal overflow ${tag}`, JSON.stringify({ ...m, ...o }))
      check(o.winTop === 0, `A23 the window does not scroll ${tag}`, JSON.stringify(o))
      check(m.salInside, `A6 a 40-character name stays inside the greeting ${tag}`, JSON.stringify(m))
      check(m.track === (h === 640 ? 40 : 56), `A18 the ledger track is ${h === 640 ? 40 : 56} px ${tag}`, JSON.stringify(m))
      check(m.tracks === (w >= 1500 ? '2' : '1'), `the page uses ${w >= 1500 ? 'two tracks' : 'one track'} ${tag}`, JSON.stringify(m))
      await checkHeadings(tag)
      if (h === 640) {
        check(m.heroBottom <= m.vh && m.needsTop >= 0 && m.needsTop < m.vh - 40 && m.needsRows <= 3, `A23 the greeting and Waiting on you start inside the viewport ${tag}`, JSON.stringify(m))
        const scrolled = await page.evaluate(() => {
          const d = document.querySelector('[data-testid=dashboard]')
          d.scrollTop = 300
          return { dashTop: d.scrollTop, winTop: document.scrollingElement?.scrollTop ?? 0, canScroll: d.scrollHeight > d.clientHeight }
        })
        check(scrolled.canScroll && scrolled.dashTop > 0 && scrolled.winTop === 0, `A23 .dashboard scrolls and the window does not ${tag}`, JSON.stringify(scrolled))
        await page.evaluate(() => (document.querySelector('[data-testid=dashboard]').scrollTop = 0))
      }
      if (w === 1024) {
        const col = await page.locator('[data-testid=dash-section]').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size)
        check(col === 1, `A22 one track at 1024x640 ${tag}`, String(col))
      }
      await screenshot(page, `dashboard-${w}x${h}-${theme}`)
    }
  }
  await setTheme('dark')
  await setSize(1600, 1000)
  await setName('Sam')

  // ---------------------------------------------------------------- Inline Allow once (its own project; WAIT keeps waiting for the relaunch)
  const inline = await createProject(page, { path: repoC, name: INLINE })
  check(!!inline, 'fifth project created for the inline answer')
  await openProject(page, INLINE)
  await startRun('Inline task')
  await page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first().waitFor({ timeout: 20_000 })
  await gotoProjects(page)
  const inlineRow = page.locator('[data-testid=dash-needs-row][data-kind=permission]', { hasText: INLINE })
  await inlineRow.first().waitFor({ timeout: 15_000 })
  check((await inlineRow.first().getAttribute('data-inline')) === 'allow', 'the new permission row offers inline Allow')
  const orderKinds = await needsKinds()
  check(weightsAscend(orderKinds), 'A10 a permission that arrives after the proposal still sorts before it', orderKinds.join())
  const before = await bellCount()
  const rowsBefore = await T('dash-needs-row').count()
  await inlineRow.first().locator('[data-testid=dash-needs-allow]').click()
  await page.locator('[data-testid=dash-needs-row]', { hasText: INLINE }).first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  check((await page.locator('[data-testid=dash-needs-row]', { hasText: INLINE }).count()) === 0, 'A8 Allow once removes the row')
  await sleep(500)
  const after = await bellCount()
  check(after === before - 1 && (await T('dash-needs-row').count()) === rowsBefore - 1, 'A8 the bell and the rows drop by one', `${before} -> ${after}`)
  const focusAfter = await page.evaluate(() => {
    const a = document.activeElement
    return { ok: !!a?.matches?.('[data-testid=dash-needs-you] [data-row-main], [data-testid=dash-needs-you] h2'), tag: a?.tagName ?? '', testid: a?.getAttribute?.('data-testid') ?? '' }
  })
  check(focusAfter.ok, 'A8 focus lands on another Waiting row or the heading, not the body', JSON.stringify(focusAfter))
  check(/Allowed once: /.test(await live()), 'A8 dashboard-live reads "Allowed once: ..."', await live())
  await openProject(page, INLINE)
  await sleep(800)
  check((await page.locator('section.frame-tray article.decision-card[data-kind="permission"]').count()) === 0, 'the run no longer shows the permission card')
  await endSession(page)

  // A compound command answered inline ([mock:fatigue]: `cd <worktree> && npm test`).
  const compound = await createProject(page, { path: repoD, name: COMPOUND })
  check(!!compound, 'sixth project created for the compound command')
  await openProject(page, COMPOUND)
  await startRun('Compound [mock:fatigue]')
  await page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first().waitFor({ timeout: 20_000 })
  await gotoProjects(page)
  const cRow = page.locator('[data-testid=dash-needs-row][data-kind=permission]', { hasText: 'agent-x' })
  await cRow.first().waitFor({ timeout: 15_000 })
  const cInfo = await cRow.first().evaluate((row) => ({
    inline: row.getAttribute('data-inline'),
    lines: (row.querySelector('.dash-needs-code')?.textContent ?? '').split('\n'),
    allow: row.querySelector('[data-testid=dash-needs-allow]')?.getAttribute('aria-label') ?? '',
    deny: row.querySelector('[data-testid=dash-needs-deny]')?.getAttribute('aria-label') ?? ''
  }))
  check(cInfo.inline === 'allow', 'a compound `cd x && npm test` row offers inline Allow', JSON.stringify(cInfo))
  check(cInfo.lines.length === 2 && /^cd .*agent-x$/.test(cInfo.lines[0]) && cInfo.lines[1] === '&& npm test', 'each step is shown whole on its own line with its operator', JSON.stringify(cInfo.lines))
  check(/^Allow once: .* wants to run cd .*agent-x && npm test/.test(cInfo.allow) && /^Deny: .*agent-x && npm test/.test(cInfo.deny), 'Allow once and Deny name the whole command', JSON.stringify(cInfo))
  // A11 while that command waits, the band and the tile still show no raw command.
  const bandCompound = clean(await page.locator('[data-testid=dash-now] [data-testid=dash-now-project]', { has: page.locator('h3', { hasText: COMPOUND }) }).innerText().catch(() => ''))
  check(bandCompound !== '' && /Waiting on you/.test(bandCompound) && !/\bcd /.test(bandCompound), 'A11 the band run of the compound command says "Waiting on you" and not the command', bandCompound)
  check(!/\bcd /.test(clean(await tileOf(COMPOUND).innerText())), 'A11 the compound project tile carries no command')
  await cRow.first().locator('[data-testid=dash-needs-allow]').click()
  await cRow.first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  check((await cRow.count()) === 0, 'Allow once answers the compound command and removes its row')
  check(/Allowed once: /.test(await live()), 'dashboard-live reads "Allowed once: ..." for the compound command', await live())
  const editRow = page.locator('[data-testid=dash-needs-row][data-kind=permission]', { hasText: 'README.md' })
  if (await editRow.first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
    check((await editRow.first().getAttribute('data-inline')) === 'none', 'an edit outside the project is not offered inline', String(await editRow.first().getAttribute('data-inline')))
  } else log('SKIP outside-edit row check: the second fatigue card did not arrive')
  await openProject(page, COMPOUND)
  await endSession(page)
  await gotoProjects(page)

  // ---------------------------------------------------------------- Relaunch: runs cut by quit (A7, A13)
  // ---------------------------------------------------------------- A13 a paused run resumes; a run with an output offers Open output
  // Both runs start through the IPC in the INLINE project ([mock:model-switch-limit] pauses 24 h ahead; [mock:outputs] writes one output).
  const pausedRun = await page.evaluate((id) => window.orgai.runs.start({ projectId: id, prompt: 'Limit test [mock:model-switch-limit]' }), inline.id)
  const wasPaused = await until(async () => (await page.evaluate((id) => window.orgai.runs.get(id), pausedRun.id))?.summary?.status === 'paused', 20_000)
  const outRun = await page.evaluate((id) => window.orgai.runs.start({ projectId: id, prompt: 'Produce the deliverables [mock:outputs]' }), inline.id)
  const madeOutput = await until(async () => (await page.evaluate((id) => window.orgai.outputs.list(id), inline.id)).length >= 1, 30_000)
  await until(async () => ['idle', 'finished'].includes((await page.evaluate((id) => window.orgai.runs.get(id), outRun.id))?.summary?.status), 20_000)
  await page.evaluate((id) => window.orgai.runs.stop(id), outRun.id).catch(() => {})
  await until(async () => (await page.evaluate((id) => window.orgai.runs.get(id), outRun.id))?.summary?.status === 'finished', 20_000)
  if (!wasPaused || !madeOutput) log('SKIP part of the paused / output rows:', JSON.stringify({ wasPaused, madeOutput }))
  await gotoProjects(page)
  const pausedRow = page.locator(`[data-testid=dash-resume-row][data-kind=paused][data-run="${pausedRun.id}"]`)
  if (wasPaused && (await pausedRow.waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
    check(/Paused/.test(clean(await pausedRow.innerText())) && (await pausedRow.locator('[data-testid=dash-resume-action]').getAttribute('data-action')) === 'resume', 'A13 a paused run is the first Pick up row and offers Resume now', clean(await pausedRow.innerText()))
    check((await page.locator('[data-testid=dash-resume-row]').first().getAttribute('data-kind')) === 'paused', 'A13 paused rows come before every other kind')
    await pausedRow.locator('[data-testid=dash-resume-action]').click()
    check(!!(await until(async () => (await pausedRow.count()) === 0, 15_000)), 'A13 Resume now resumes the run and its paused row leaves')
  } else check(false, 'A13 a paused run shows a Pick up row', String(wasPaused))
  await gotoProjects(page)
  const outRow = page.locator(`[data-testid=dash-resume-row][data-run="${outRun.id}"]`)
  const outAction = outRow.locator('[data-testid=dash-resume-action][data-action=output]')
  if (madeOutput && (await outAction.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
    check(/Open output/.test(clean(await outAction.innerText())), 'A13 a finished run with an output shows "Open output"', clean(await outAction.innerText()))
    await outAction.click()
    const tab = page.locator('[data-testid=side-tab-outputs]')
    const opened = await tab.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
    check(opened && (await page.locator('main .topbar h1').first().innerText()).trim() === INLINE, 'A13 Open output opens that run in its project with the Outputs tab', String(opened))
    check(opened && (await tab.getAttribute('aria-selected')) === 'true', 'A13 the Outputs tab is the selected side tab', String(await tab.getAttribute('aria-selected')))
    await gotoProjects(page)
  } else check(false, 'A13 a finished run with an output offers "Open output"', String(madeOutput))
  // Several outputs, files that are gone and the cap with "Show N more" are covered by the unit tests (resumeRows).

  // A second window follows a change in the layout (the storage event).
  await T('dash-customise').click()
  const storedLayout = await layoutOf()
  await page.evaluate(([k, cur]) => window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: JSON.stringify({ ...cur, v: 1, order: ['week', 'resume', 'today', 'working', 'projects'], hidden: [] }) })), [LAYOUT_KEY, storedLayout])
  await sleep(300)
  check((await slotOrder()).join() === 'week,resume,today,working,projects', 'A21 a storage event from another window changes the order here', (await slotOrder()).join())
  await T('dash-customise-reset').click()
  await T('dash-customise').click()

  log('relaunching')
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'dashboard' }))
  log('relaunched')
  watchErrors(page)
  await gotoProjects(page)
  await T('dash-resume-row').first().waitFor({ timeout: 15_000 }).catch(() => {})
  await sleep(600)
  check((await salutationText()).endsWith(', Sam.'), 'A7 the name survives a relaunch', await salutationText())
  check((await text('dash-resume')).startsWith('Pick up where you left off'), 'the section is called "Pick up where you left off"', (await text('dash-resume')).slice(0, 40))
  const resumeFacts = await T('dash-resume-row').evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute('data-kind'), run: e.getAttribute('data-run'), project: e.getAttribute('data-project'), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })))
  const closedWait = resumeFacts.find((r) => r.kind === 'closed' && r.text.includes(WAIT))
  check(!!closedWait && closedWait.text.includes('Was waiting on you when OrgAI closed.'), 'A13 a run ended by quit while waiting shows "Was waiting on you when OrgAI closed."', JSON.stringify(resumeFacts).slice(0, 400))
  const waitResumeRow = page.locator('[data-testid=dash-resume-row][data-kind=closed]', { hasText: WAIT })
  check((await waitResumeRow.locator('[data-testid=dash-resume-action][data-action=continue]').count()) === 1, 'A13 that row offers Continue')
  const runKeys = resumeFacts.filter((r) => r.run).map((r) => r.run)
  check(new Set(runKeys).size === runKeys.length, 'A13 each chain appears once in Pick up', JSON.stringify(runKeys))
  const kindOrder = resumeFacts.map((r) => r.kind)
  const rank = { paused: 0, closed: 1, failed: 2, finished: 3, pinned: 4, recent: 5 }
  check(kindOrder.every((k, i) => i === 0 || rank[k] >= rank[kindOrder[i - 1]]), 'A13 Pick up rows follow the kind order (closed, then pinned, then recent)', kindOrder.join())
  const pinnedAfter = page.locator(`[data-testid=dash-resume-row][data-project="${pinId}"]`)
  check((await pinnedAfter.count()) === 1 && (await pinnedAfter.locator('[data-testid=dash-resume-action]').getAttribute('data-action')) === 'new-run', 'A13 the pinned project without runs still offers New run after a relaunch')
  check((await T('dash-now').count()) === 0 && (await T('dash-now-empty').count()) === 0, 'A15 with nothing running Working now is not rendered and there is no dash-now-empty')
  check((await page.locator('[data-testid=project-tile]').first().getAttribute('data-name')) === PINNED, 'A20 the pin survives a relaunch (the pinned tile is first)')
  const goneIds = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`[data-testid="${id}"]`)), REMOVED_IDS)
  check(goneIds.length === 0, 'the removed test ids are absent after the relaunch too', goneIds.join())
  check(/waiting on you when OrgAI closed/.test(await briefText()), 'A4 the brief names the runs that were waiting when OrgAI closed', await briefText())
  await checkBrief('after the relaunch')
  await checkHeadings('after the relaunch')
  await shot('relaunch')
  // Tiles of ended projects: "Last run <time> ago".
  const endedStatus = clean(await tileOf(BUSY).locator('.project-tile-status-text').innerText())
  check(/^Last run \S/.test(endedStatus), 'an ended project tile reads "Last run <time> ago"', endedStatus)
  // Continue from Pick up opens the run with the cursor in the composer.
  await tileOf(BUSY).locator('[data-testid=project-tile-main]').click()
  await sleep(600)
  await gotoProjects(page)
  const waitRow = page.locator('[data-testid=dash-resume-row]', { hasText: WAIT })
  await waitRow.first().waitFor({ timeout: 10_000 }).catch(() => {})
  check((await waitRow.locator('[data-testid=dash-resume-action][data-action=continue]').count()) === 1, 'A13 the Continue row survives a trip to a project and back')
  await waitRow.locator('[data-testid=dash-resume-action][data-action=continue]').click()
  await page.locator('.composer textarea').waitFor({ timeout: 15_000 })
  await sleep(500)
  const landed = await page.evaluate(() => ({
    h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '',
    tabs: document.querySelectorAll('.run-tab[aria-selected=true]').length,
    inComposer: !!document.activeElement?.closest?.('.composer') && document.activeElement?.tagName === 'TEXTAREA'
  }))
  check(landed.h1 === WAIT && landed.tabs === 1, 'A13 Continue on a Pick up row opens the run in its project', JSON.stringify(landed))
  check(landed.inComposer, 'A13 Continue puts the cursor in the composer', JSON.stringify(landed))
  // A plain row click opens the run and focus does not fall to the body.
  await gotoProjects(page)
  await page.locator('[data-testid=dash-resume-row]', { hasText: WAIT }).first().locator('[data-testid=dash-resume-main]').click().catch(() => {})
  await sleep(800)
  const rowLanded = await page.evaluate(() => ({ h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '', body: document.activeElement === document.body }))
  check(rowLanded.h1 === WAIT && !rowLanded.body, 'a row click opens the run and focus stays on a real element', JSON.stringify(rowLanded))
  // New run on the pinned row opens a draft.
  await gotoProjects(page)
  await page.locator(`[data-testid=dash-resume-row][data-project="${pinId}"] [data-testid=dash-resume-action]`).click()
  await sleep(800)
  const newRunRow = await page.evaluate(() => ({ h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '', composer: !!document.querySelector('.composer textarea'), body: document.activeElement === document.body }))
  check(newRunRow.h1 === PINNED && newRunRow.composer && !newRunRow.body, 'A13 New run on a pinned row opens that project\'s draft', JSON.stringify(newRunRow))

  // Deleting a project removes its rows and its pin.
  const left = await deleteProject(page, WAIT)
  check(left === 0, 'the project is deleted')
  await gotoProjects(page)
  await sleep(500)
  check((await page.locator('[data-testid=dash-resume-row]', { hasText: WAIT }).count()) === 0, 'a deleted project leaves no Pick up row')
  const leftPinned = await deleteProject(page, PINNED)
  check(leftPinned === 0, 'the pinned project is deleted')
  await sleep(500)
  check(!((await layoutOf())?.pinned ?? []).includes(pinId), 'A20 deleting a pinned project prunes its pin', JSON.stringify((await layoutOf())?.pinned))
  if (scheduleId) await page.evaluate((id) => window.orgai.schedules.remove(id), scheduleId).catch(() => {})
} catch (e) {
  check(false, 'dashboard script ran to the end', e.stack ?? e.message)
  await screenshot(page, 'dashboard-failure').catch(() => {})
} finally {
  try {
    if (page && !page.isClosed()) {
      await setSettings({ schedulesPaused: false, displayName: undefined }).catch(() => {})
      for (const n of [WAIT, BUSY, PINNED, SCHED, INLINE, COMPOUND]) {
        const left = await deleteProject(page, n)
        check(left === 0, `project "${n}" deleted`, `${left} tile(s) left`)
      }
    }
  } catch (e) {
    check(false, 'projects deleted', e.message)
  }
  await app?.close().catch(() => {})
  for (const r of [repoA, repoB, repoP, repoS, repoC, repoD]) removeFixture(r)
  finish('dashboard')
}
log('done')

/** Set (or clear) the saved display name straight through settings (the long-name size checks). */
async function setName(name) {
  await setSettings({ displayName: name })
  await sleep(300)
}
