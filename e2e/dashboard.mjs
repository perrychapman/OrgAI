// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The redesigned Dashboard (docs/design/dashboard-usage-redesign/project/dashboard.md
// and motion.md): Briefing hero card, Needs you and Right now (fixed regions), then the arrangeable sections Your week, Pick up,
// Up next, Projects, Engagements, Commits this week and To-dos (layout v2, localStorage `orgai.dashboardLayout`).
// Check names carry a tag:
//  BR  Briefing: the greeting (an h2, no full stop) with and without a name in every hour band, the visible status sentence,
//      the since line, quick actions in order Continue / New chat / New project / Customise, the setup line and its popover,
//      Team pulse (caption, nodes, signals), Pause motion (aria-pressed, data-motion-paused), no app-facts footer.
//  A7  the name: Add your name popover (focus, Enter saves, Esc cancels, maxLength, zero-width refused, clearing, Settings field).
//  NY  Needs you: rows equal the sidebar bell, count span, inline Allow once / Deny only when the whole request is visible,
//      order by kind, a row does not move, a compound command is answered inline.
//  RN  Right now: one row per run, waiting run says it, no raw command.
//  WK  Your week: four stat cards (one button each, Usage opens on 7 days with the right metric), activity map (text alternative,
//      today column), Pick up (state word, Continue / Open names carry the run title), Up next, To-dos.
//  PR  Projects: pin by keyboard (aria-pressed, constant name), pinned first, data-pinned edge; More menu, delete confirm.
//  CU  Customise: move / hide / show, focus figure persists, Reset layout, Needs you and Right now are never in the controls,
//      reload keeps the layout, corrupt storage loads a valid layout, a version 1 layout migrates.
//  EM  empty regions are not drawn.   MO  page arrival (hero class while arriving, none on return) and reduced motion.
//  SZ  both window sizes and both themes: no horizontal overflow, one page scroll.
// Multi-day history: the mock puts every run on one day, so a phase near the end closes the app, shifts some run records in
// the script's own throwaway data dir back by whole days (nothing in src is touched), relaunches and checks the activity map
// columns, the stat card movement lines and the since line.
// Not covered here (unit tests or later): the IPC argument of Allow once, the 25th pin, a second real window (a synthetic storage
// event stands in), the other brief variants (`dashboardBrief` unit tests), plan limits off the mock adapter, a failed name save.
// Kept from the earlier script: first launch Tab order, New project dialog and Escape, the tile More menu and delete confirm,
// New run from the menu, Enter on a band agent row opens the agent, both sizes and themes, relaunch with a run cut while waiting.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, deleteProject, endSession, finish, gotoProjects, launch, log, makeFixtureRepo, openAppSettings, openProject, projectTab, relaunch, removeFixture, runRecordsDir, screenshot, sleep } from './lib.mjs'

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
const DEFAULT_ORDER = ['week', 'pickup', 'upnext', 'projects', 'engagements', 'commits', 'todos']
const TITLES = { week: 'Your week', pickup: 'Pick up', upnext: 'Up next', projects: 'Projects', engagements: 'Engagements', commits: 'Commits this week', todos: 'To-dos' }
const SECTION_IDS = { 'dash-needs-you': 'Needs you', 'dash-now': 'Right now', 'dash-week': TITLES.week, 'dash-resume': TITLES.pickup, 'dash-upnext': TITLES.upnext, 'dash-projects': TITLES.projects, 'dash-engagements': TITLES.engagements, 'dash-commits': TITLES.commits, 'dash-todos': TITLES.todos }
const KIND_WEIGHT = { plan: 0, question: 1, permission: 2, merge: 3, proposal: 4, install: 5, rules: 6, team: 7 }
const REMOVED_IDS = [
  'dashboard-app-facts', 'dash-status-line', 'dash-paused', 'dash-since-clear', 'dash-now-empty', 'dash-attn-summary', 'dash-attn-tile', 'dash-attn-reply-count', 'dash-hero-stat', 'dash-hero-stats',
  'dash-needs-clear', 'dash-week-runs', 'dash-week-time', 'dash-week-cost', 'dash-week-top-project', 'dash-week-share', 'dash-strip-day', 'dash-strip-readout', 'dash-strip-bar', 'dash-today',
  'dash-today-schedule', 'dash-today-schedules', 'dash-today-paused', 'dash-today-more-schedules', 'dash-commits-empty', 'dash-commits-loading', 'tile-pinned-glyph', 'tile-run', 'dash-cost', 'dash-limits'
]
const LAYOUT_KEY = 'orgai.dashboardLayout'
const LAST_SEEN_KEY = 'orgai.dashboardSeenAt'
const T0 = Date.now()

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
/** The arrangeable slots in DOM order (the fixed Right now slot is not one of them). */
const slotOrder = () => page.evaluate(() => [...document.querySelectorAll('[data-testid=dash-section]')].map((e) => e.getAttribute('data-section')).filter((s) => s !== 'now'))
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
  // One h2 per rendered section with its title, plus the Briefing's greeting (the page's one large line is an h2).
  check(f.wrong.length === 0 && f.h2s === f.present.length + 1 && f.present.length >= 1 && f.texts[0] === (await salutationText()), `A1 every rendered section has one h2 with its title, after the greeting's h2 ${tag}`, JSON.stringify(f))
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

/**
 * Visual pass checks (dashboard-overhaul.md "Visual pass"), run at each size and theme: the text budget (no tile over two
 * text lines), one identity hue per project across sections, text alternatives on the instruments, the lead band and the
 * board tiles present.
 */
async function visualPassChecks(tag) {
  const v = await page.evaluate(() => {
    /** Distinct visible text lines in an element: line boxes of its text nodes grouped by top (6 px), skipping sr-only
     *  text, aria-hidden decoration and the action buttons. */
    const linesOf = (root) => {
      const tops = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue
        const el = n.parentElement
        if (!el || el.closest('.sr-only, [aria-hidden=true], .btn, svg')) continue
        const r = document.createRange()
        r.selectNodeContents(n)
        for (const rect of r.getClientRects()) {
          if (rect.width < 1 || rect.height < 1) continue
          if (!tops.some((t) => Math.abs(t - rect.top) <= 6)) tops.push(rect.top)
        }
      }
      return tops.length
    }
    const over = []
    // A Pick up row: the state word, the title and one caption line (three); the others two.
    const sel = [['[data-testid=dash-resume-row]', 3], ['[data-testid=dash-today-todo]', 2], ['[data-testid=dash-upnext-row]', 2], ['[data-testid=dash-engagement]', 2]]
    for (const [s, max] of sel) for (const el of document.querySelectorAll(s)) {
      const n = linesOf(el)
      if (n > max) over.push(`${s}:${n}:${(el.textContent ?? '').slice(0, 40)}`)
    }
    // A project tile: name, status line and its run count (three lines at most).
    for (const el of document.querySelectorAll('[data-testid=project-tile]')) {
      const n = linesOf(el)
      if (n > 3) over.push(`tile:${n}:${(el.textContent ?? '').slice(0, 40)}`)
    }
    const hues = {}
    for (const b of document.querySelectorAll('[data-testid=dash-project-badge]')) {
      const p = b.getAttribute('data-project')
      if (!p) continue
      ;(hues[p] ??= new Set()).add(`${b.getAttribute('data-hue')}|${getComputedStyle(b).backgroundColor}`)
    }
    const mixed = Object.entries(hues).filter(([, s]) => s.size > 1).map(([p, s]) => `${p}:${[...s].join('/')}`)
    const sparks = [...document.querySelectorAll('[data-testid=tile-spark]')].map((e) => e.getAttribute('aria-label') ?? '')
    const commits = document.querySelector('[data-testid=dash-commits]')
    const commitDays = document.querySelectorAll('[data-testid=dash-commits-day]').length
    const commitsText = document.querySelector('[data-testid=dash-commits-text]')?.textContent?.trim() ?? ''
    const needs = document.querySelector('[data-testid=dash-needs-you]')
    const now = document.querySelector('[data-testid=dash-now]')
    const stats = [...document.querySelectorAll('[data-testid=dash-stat]')].map((li) => {
      const b = li.querySelectorAll('button')
      return { stat: li.getAttribute('data-stat'), buttons: b.length, name: b[0]?.getAttribute('aria-label') ?? '' }
    })
    const heat = document.querySelector('[data-testid=dash-heat]')
    return {
      over,
      mixed,
      badges: Object.keys(hues).length,
      sparks,
      commits: !!commits,
      commitDays,
      commitsText,
      sideBeside: !!(needs && now && now.getBoundingClientRect().left > needs.getBoundingClientRect().right - 1),
      stats,
      heatName: heat?.getAttribute('aria-label') ?? '',
      heatToday: document.querySelectorAll('[data-testid=dash-heat-col][data-today]').length
    }
  })
  check(v.over.length === 0, `VP no row or tile has more than its text lines ${tag}`, v.over.join(' | '))
  check(v.badges >= 2 && v.mixed.length === 0, `VP a project has one identity hue in every section ${tag}`, `${v.badges} projects ${v.mixed.join(' ')}`)
  check(v.sparks.length >= 1 && v.sparks.every((s) => /^(Runs in the last 7 days|No runs this week)/.test(s)), `VP every project sparkline has a text alternative ${tag}`, JSON.stringify(v.sparks).slice(0, 200))
  check(!v.commits || (v.commitDays === 7 && v.commitsText.length > 0), `VP Commits this week, when drawn, shows its chart with a text alternative ${tag}`, JSON.stringify({ c: v.commits, d: v.commitDays, t: v.commitsText.slice(0, 80) }))
  // Decisions has no card until a run of the week carries the count, so three or four cards.
  check(v.stats.length >= 3 && v.stats.length <= 4 && ['spend', 'runs', 'time'].every((id) => v.stats.some((s) => s.stat === id)) && v.stats.every((s) => s.buttons === 1 && s.name.length > 0), `VP Your week shows its stat cards (Spend, Runs, Agent time, Decisions once counted), each one named button ${tag}`, JSON.stringify(v.stats))
  check(v.heatName.length > 0 && v.heatToday === 1, `VP the activity map has a text alternative and one marked today column ${tag}`, JSON.stringify({ n: v.heatName.slice(0, 60), t: v.heatToday }))
  if (tag.includes('1600')) check(v.sideBeside, `VP Right now sits to the right of Needs you ${tag}`, JSON.stringify(v))
}

const NOW_OFFSET_DAY = (h, m) => `new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1, ${h}, ${m}).getTime()`

try {
  // ---------------------------------------------------------------- First launch (A2)
  await setSize(1600, 1000)
  await gotoProjects(page)
  check(await visible('[data-testid=dash-start-choice]'), 'A2 first launch shows the start choice')
  check((await salutationText()) === 'Welcome to OrgAI', 'A2 first launch greets with "Welcome to OrgAI"', await salutationText())
  check((await briefText()) === 'Start a project or just chat. Nothing runs until you say so.', 'A2 first launch shows its line', await briefText())
  check((await T('dash-customise').count()) === 0 && (await T('dash-section').count()) === 0 && (await T('dash-needs-you').count()) === 0, 'A2 first launch has no Customise button, no section and no Needs you')
  check((await T('dash-quick-actions').count()) === 0 && (await T('dash-pulse').count()) === 0 && (await T('dash-pause-motion').count()) === 0 && (await T('dash-since').count()) === 0, 'BR first launch has no quick actions, Team pulse, Pause motion or since line')
  check(await visible('[data-testid=dash-name-add]'), 'A2 first launch offers "Add your name"')
  check((await T('dashboard-app-facts').count()) === 0, 'BR there is no app-facts footer on first launch')
  const first = await headingFacts()
  check(first.h1s === 1 && first.h1 === 'Dashboard' && first.texts[0] === 'Welcome to OrgAI', 'A1 first launch has exactly one h1 and the greeting h2', JSON.stringify(first))
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
  check(addBox.border >= 1 || addBox.bg !== 'rgba(0, 0, 0, 0)', 'M2 "Add your name" has a border or a fill (it reads as a control)', JSON.stringify(addBox))
  await T('dash-name-add').click()
  await nameInputFocused()
  await page.keyboard.type('Sam')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()) === 'Welcome to OrgAI, Sam', 8000)), 'M2 first launch: saving a name puts it in the greeting at once', await salutationText())
  await T('dash-name-edit').click()
  await nameInputFocused()
  // Select the field with the locator: a synthetic Cmd+A does not reach a field on macOS (CI run 44674564818).
  await T('dash-name-input').selectText()
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()) === 'Welcome to OrgAI', 5000)), 'M2 first launch: removing the name restores the plain welcome', await salutationText())

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
  // Empty regions are not drawn at all (outside Customise).
  const drawnIds = await page.evaluate((ids) => ids.filter((id) => !!document.querySelector(`[data-testid="${id}"]`)), ['dash-resume', 'dash-upnext', 'dash-todos', 'dash-now', 'dash-week', 'dash-needs-you', 'dash-stats', 'dash-activity'])
  check(drawnIds.length === 0, 'EM with nothing to show Pick up, Up next, To-dos, Right now, Your week and Needs you are not in the DOM', JSON.stringify(drawnIds))
  check((await T('dash-now-empty').count()) === 0, 'EM there is no dash-now-empty')
  check((await T('dash-section').count()) <= 3 && (await T('dash-setup').count()) === 0, 'EM no empty section slots are left in the DOM outside Customise', String(await T('dash-section').count()))
  const quick = await page.locator('[data-testid=dash-quick-actions] > *').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? e.textContent?.trim()))
  check(quick.join() === 'dash-continue,projects-new-chat,new-project,dash-customise', 'BR quick actions are Continue, New chat, New project, Customise in that order', quick.join())
  check(/^Continue /.test((await T('dash-continue').getAttribute('aria-label')) ?? ''), 'BR Continue is named for its project', String(await T('dash-continue').getAttribute('aria-label')))
  check((await page.locator('main .topbar [data-testid=new-project], main .topbar [data-testid=projects-new-chat]').count()) === 0, 'BR New chat and New project are no longer in the topbar')
  check((await T('dash-since').count()) === 0, 'BR no since line while nothing ended since the last visit')
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
  check(noName === hourWord, 'A3 without a name the salutation is the time-of-day word alone', `${noName} / ${hourWord}`)
  check((await T('dash-name-edit').count()) === 0, 'A7 no edit button while no name is set')
  await T('dash-name-add').click()
  await nameInputFocused()
  await until(async () => (await activeInfo()).testid === 'dash-name-input', 5000, 50)
  check((await activeInfo()).testid === 'dash-name-input', 'A7 Add your name opens the popover with focus in dash-name-input')
  check((await T('dash-name-input').getAttribute('maxlength')) === '40', 'A7 the name field stops at 40 characters (maxLength)')
  await page.keyboard.type('Sam')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()).endsWith(', Sam'), 8000)), 'A7 Enter saves and the salutation shows the name at once', await salutationText())
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
  check((await activeInfo()).testid === 'dash-name-edit' && (await salutationText()).endsWith(', Sam'), 'A7 Esc keeps the name and returns focus to the control', `${await salutationText()} ${JSON.stringify(await activeInfo())}`)
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
  check((await T('dash-name-input').inputValue()) === 'Sam​' && (await salutationText()).endsWith(', Sam'), 'A7 the refused field keeps what was typed and the saved name is unchanged')
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
  check(!!(await until(async () => (await salutationText()) === hourWord, 5000)), 'A7 clearing the Settings field removes the name from the salutation', await salutationText())
  check((await T('dash-name-add').count()) === 1 && (await T('dash-name-edit').count()) === 0, 'A7 with no name the Dashboard offers "Add your name" again')
  await openAppSettings(page)
  await T('display-name-input').fill('Sam')
  await T('display-name-input').press('Enter')
  await sleep(500)
  await gotoProjects(page)
  check(!!(await until(async () => (await salutationText()).endsWith(', Sam'), 5000)), 'A7 typing the name in Settings shows it in the greeting', await salutationText())
  // Clear from the popover ("Remove name").
  await T('dash-name-edit').click()
  await nameInputFocused()
  await T('dash-name-input').selectText()
  await page.keyboard.press('Backspace')
  check(clean(await T('dash-name-save').innerText()) === 'Remove name', 'A7 emptying a saved name offers "Remove name"')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await salutationText()) === hourWord, 5000)), 'A7 Remove name clears the name', await salutationText())
  check(!!(await until(async () => (await live()).includes('Name removed.'), 3000)), 'A7 removing the name is announced', await live())
  await T('dash-name-add').click()
  await nameInputFocused()
  await page.keyboard.type('Sam')
  await page.keyboard.press('Enter')
  await until(async () => (await salutationText()).endsWith(', Sam'), 5000)

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
    if (s !== `${word}, Sam`) check(false, `A3 at ${label} the salutation reads "${word}, Sam"`, s)
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
  check((await tileOf(PINNED).getAttribute('data-pinned')) !== null && (await tileOf(WAIT).getAttribute('data-pinned')) === null, 'PR a pinned tile carries data-pinned (its accent edge) and an unpinned one does not')
  const pinToggle = tileOf(PINNED).locator('[data-testid=project-tile-pin]')
  check((await pinToggle.getAttribute('aria-pressed')) === 'true' && (await pinToggle.getAttribute('aria-label')) === `Pin ${PINNED}`, 'PR the pin toggle keeps one name ("Pin <name>") and says its state with aria-pressed', `${await pinToggle.getAttribute('aria-pressed')} ${await pinToggle.getAttribute('aria-label')}`)
  check((await T('tile-pinned-glyph').count()) === 0 && (await T('tile-run').count()) === 0, 'PR no pin glyph and no tile-run')
  await page.mouse.move(1, 1)
  const edgeOf = (name) => tileOf(name).evaluate((el) => getComputedStyle(el).borderTopColor + '|' + getComputedStyle(el).backgroundImage)
  const pinEdge = await edgeOf(PINNED)
  const plainEdge = await edgeOf(WAIT)
  check(pinEdge !== plainEdge, 'PR a pinned tile draws an accent edge an unpinned tile does not', `${pinEdge} vs ${plainEdge}`)
  check((await T('dash-resume-row').count()) === 0, 'WK a pinned project with no runs is not a Pick up row (Pick up lists runs only)')
  check((await T('dash-continue').getAttribute('aria-label')) === `Continue ${PINNED}`, 'BR Continue names the pinned project', String(await T('dash-continue').getAttribute('aria-label')))

  // Customise: entry, bar, controls, empty rows, full width.
  const customise = T('dash-customise')
  check((await customise.getAttribute('aria-expanded')) === 'false', 'A21 dash-customise starts collapsed (aria-expanded=false)')
  await customise.click()
  await T('dash-customise-bar').waitFor({ timeout: 5000 })
  check((await customise.getAttribute('aria-expanded')) === 'true' && clean(await customise.innerText()) === 'Done', 'A21 Customise becomes Done with aria-expanded=true')
  check((await slotOrder()).join() === DEFAULT_ORDER.join(), 'CU customise lists all seven arrangeable sections in the default order', (await slotOrder()).join())
  const states = await page.locator('[data-testid=dash-section]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-section'), e.getAttribute('data-state')])))
  check(states.projects === 'shown' && ['week', 'pickup', 'upnext', 'engagements', 'todos'].every((id) => states[id] === 'empty') && !('now' in states), 'EM empty sections show as empty rows only while customising', JSON.stringify(states))
  check(/Up next: nothing to show right now\./.test(clean(await page.locator('[data-testid=dash-section][data-section=upnext]').innerText())), 'EM an empty section reads "Up next: nothing to show right now." in customise mode')
  check((await page.locator('[data-testid=dash-section-controls][data-section=now], [data-testid=dash-section-controls][data-section=needs]').count()) === 0 && (await page.locator('[data-testid=dash-section-controls]').count()) === DEFAULT_ORDER.length, 'CU Needs you and Right now have no controls (the seven arrangeable sections do)', String(await page.locator('[data-testid=dash-section-controls]').count()))
  const focusPick = await page.getByRole('radiogroup', { name: 'Lead figure in Your week' }).first().innerText().catch(() => '')
  check(/Spend/.test(focusPick) && /Runs/.test(focusPick) && /Agent time/.test(focusPick) && /Decisions/.test(focusPick), 'CU Customise offers the focus figure choice (Spend, Runs, Agent time, Decisions)', clean(focusPick))
  // The group has a visible caption, and a figure Your week does not draw is disabled with its reason in view (no runs carry decision counts yet).
  const leadCaption = clean(await T('dash-lead-caption').innerText().catch(() => ''))
  check(leadCaption === 'Lead figure in Your week' && (await T('dash-lead-caption').isVisible()), 'CU the focus figure group has the visible caption "Lead figure in Your week"', leadCaption)
  check((await page.getByRole('radio', { name: 'Decisions' }).isDisabled()) && (await T('dash-lead-reason').isVisible()) && /no run this week carries decision counts/.test(await T('dash-lead-reason').innerText()), 'CU Decisions is disabled with its reason while no run carries decision counts', clean(await T('dash-lead-reason').innerText().catch(() => '')))
  check(!(await page.getByRole('radio', { name: 'Spend' }).isDisabled()) && !(await page.getByRole('radio', { name: 'Runs' }).isDisabled()) && !(await page.getByRole('radio', { name: 'Agent time' }).isDisabled()), 'CU the figures Your week draws stay selectable')
  const widths = await page.locator('[data-testid=dash-section]').evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().width), e.getAttribute('data-span')]))
  check(widths.every((w) => w[0] === widths[0][0] && w[1] === widths[0][1] && w[2] === 'full'), 'A22 in customise mode every section is one full-width track at 1600x1000', JSON.stringify(widths))
  // Pin toggle on a tile, in customise mode.
  const pinBtn = tileOf(WAIT).locator('[data-testid=project-tile-pin]')
  check((await pinBtn.getAttribute('aria-pressed')) === 'false', 'PR the pin toggle is aria-pressed=false while unpinned')
  // Keyboard: the pin is the next Tab stop after the tile's Open button.
  await tileOf(WAIT).locator('[data-testid=project-tile-main]').focus()
  await page.keyboard.press('Tab')
  check((await activeInfo()).testid === 'project-tile-pin', 'PR the pin toggle is the next Tab stop after the tile Open button', JSON.stringify(await activeInfo()))
  await page.keyboard.press('Enter')
  await sleep(300)
  check((await live()).includes(`Pinned ${WAIT}.`) && (await pinBtn.getAttribute('aria-pressed')) === 'true' && (await pinBtn.getAttribute('aria-label')) === `Pin ${WAIT}`, 'PR Enter on the pin toggle pins, announces and keeps its name', await live())
  check(/It is pin 2 of 2\./.test(await live()), 'PR the announcement says where a second pin went', await live())
  check((await layoutOf())?.pinned?.join() === `${pinId},${waitId}`, 'A20 pins are stored in the order they were pinned', JSON.stringify((await layoutOf())?.pinned))
  await until(async () => (await activeInfo()).testid === 'project-tile-pin', 5000, 50)
  check(((await activeInfo()).testid === 'project-tile-pin'), 'A20 focus stays on the pin toggle after pinning', JSON.stringify(await activeInfo()))

  // Keyboard-only path: Tab from the Customise button to Reset, then the first section's controls.
  await customise.focus()
  const tabPath = []
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab')
    const a = await activeInfo()
    tabPath.push(`${a.testid}${a.section ? `@${a.section}` : ''}`)
    if (a.testid === 'dash-section-hide') break
  }
  check(tabPath.includes('dash-customise-reset') && tabPath.slice(-3).join() === 'dash-section-up@week,dash-section-down@week,dash-section-hide@week', 'CU Tab reaches Reset layout, then each section\'s up, down, Hide in order', tabPath.join(' > '))
  // The first section's up button is aria-disabled at the top: Enter announces and keeps focus.
  await ctl('week', 'dash-section-up').focus()
  check((await ctl('week', 'dash-section-up').getAttribute('aria-disabled')) === 'true' && (await ctl('week', 'dash-section-up').getAttribute('disabled')) === null, 'CU the first section\'s Move up is aria-disabled (not disabled)')
  await page.keyboard.press('Enter')
  await sleep(300)
  check((await live()).includes('Your week is already first.') && (await activeInfo()).testid === 'dash-section-up', 'CU at the top, Move up says "is already first." and keeps focus', `${await live()} ${JSON.stringify(await activeInfo())}`)
  await ctl('todos', 'dash-section-down').focus()
  await page.keyboard.press('Enter')
  await sleep(300)
  check((await ctl('todos', 'dash-section-down').getAttribute('aria-disabled')) === 'true' && (await live()).includes('To-dos is already last.'), 'CU at the bottom, Move down says "is already last."', await live())
  // Move down: focus stays on the pressed button.
  await ctl('week', 'dash-section-down').focus()
  await page.keyboard.press('Enter')
  await sleep(400)
  let ai = await activeInfo()
  check((await slotOrder()).join() === 'pickup,week,upnext,projects,engagements,commits,todos', 'CU Move down moves the section one place', (await slotOrder()).join())
  check(ai.testid === 'dash-section-down' && ai.section === 'week', 'CU after Move down focus stays on the pressed button', JSON.stringify(ai))
  check((await live()).includes('Your week moved down. Position 2 of 7.'), 'CU Move down announces "moved down. Position 2 of 7."', await live())
  await ctl('week', 'dash-section-up').focus()
  await page.keyboard.press('Enter')
  await sleep(400)
  ai = await activeInfo()
  check((await slotOrder()).join() === DEFAULT_ORDER.join() && ai.testid === 'dash-section-up' && ai.section === 'week', 'CU Move up restores the order and keeps focus on the pressed button', `${(await slotOrder()).join()} ${JSON.stringify(ai)}`)
  check((await live()).includes('moved up. Position 1 of 7.'), 'CU Move up announces "moved up. Position 1 of 7."', await live())
  check((await page.locator('[data-testid=dash-section][data-section=week].motion-ring').count()) <= 1, 'a moved section carries at most one ring')
  // Hide and Show move focus to each other.
  await ctl('upnext', 'dash-section-hide').focus()
  await page.keyboard.press('Enter')
  await sleep(400)
  ai = await activeInfo()
  check(ai.testid === 'dash-section-show' && ai.section === 'upnext', 'CU Hide moves focus to that section\'s Show', JSON.stringify(ai))
  check((await live()).includes('Up next hidden.') && (await page.locator('[data-testid=dash-section][data-section=upnext]').getAttribute('data-state')) === 'hidden', 'CU Hide announces "Up next hidden." and collapses the section', await live())
  check(/Up next, hidden/.test(clean(await page.locator('[data-testid=dash-section][data-section=upnext]').innerText())), 'CU a hidden section reads "Up next, hidden"')
  check((await layoutOf())?.hidden?.join() === 'upnext', 'CU the hidden list is stored')
  await page.keyboard.press('Enter')
  await sleep(400)
  ai = await activeInfo()
  check(ai.testid === 'dash-section-hide' && ai.section === 'upnext' && (await live()).includes('Up next shown.'), 'CU Show moves focus back to Hide and announces "Up next shown."', `${JSON.stringify(ai)} ${await live()}`)
  // The focus figure: a radio group; the choice is stored and announced.
  await page.getByRole('radio', { name: 'Runs' }).check({ force: true })
  await sleep(300)
  check((await layoutOf())?.focus === 'runs' && (await live()).includes('Your week now leads with runs.'), 'CU choosing the Runs focus figure stores it and announces', `${JSON.stringify(await layoutOf())} ${await live()}`)
  await page.getByRole('radio', { name: 'Spend' }).check({ force: true })
  await sleep(200)
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
  await page.getByRole('radio', { name: 'Agent time' }).check({ force: true })
  await sleep(300)
  const messy = await layoutOf()
  check(messy?.order?.join() === 'week,pickup,projects,upnext,engagements,commits,todos' && messy?.hidden?.join() === 'week' && messy?.focus === 'time', 'CU a move, a hide and a focus figure are stored', JSON.stringify(messy))
  await T('dash-customise-reset').click()
  await sleep(300)
  const reset = await layoutOf()
  check(reset?.order?.join() === DEFAULT_ORDER.join() && reset?.hidden?.length === 0 && reset?.focus === 'spend' && reset?.pinned?.join() === `${pinId},${waitId}`, 'CU Reset layout restores order, hidden and the focus figure and keeps pins', JSON.stringify(reset))
  await until(async () => (await activeInfo()).testid === 'dash-customise-reset', 5000, 50)
  check((await activeInfo()).testid === 'dash-customise-reset' && (await live()).includes('Layout reset to the default.'), 'CU Reset layout keeps focus on itself and announces', `${JSON.stringify(await activeInfo())} ${await live()}`)
  // Reload keeps the layout, the focus figure and Pause motion.
  await ctl('projects', 'dash-section-up').click()
  await ctl('upnext', 'dash-section-hide').click()
  // Decisions cannot be picked while no run carries decision counts (it is disabled), so the stored choice is written directly.
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), focus: 'decisions' })), LAYOUT_KEY)
  await sleep(300)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 60_000 })
  await gotoProjects(page)
  await T('dash-customise').click()
  await T('dash-customise-bar').waitFor({ timeout: 5000 })
  check((await slotOrder()).join() === 'week,pickup,projects,upnext,engagements,commits,todos' && (await page.locator('[data-testid=dash-section][data-section=upnext]').getAttribute('data-state')) === 'hidden', 'CU a reload keeps the order and the hidden section', (await slotOrder()).join())
  check(await page.getByRole('radio', { name: 'Decisions' }).isChecked(), 'CU a reload keeps the focus figure (Decisions)')
  await T('dash-customise-reset').click()
  await T('dash-customise').click()
  check(!!(await until(async () => (await T('dash-customise-bar').count()) === 0, 5000, 50)), 'CU Done leaves customise mode')
  // All seven hidden, customise closed: one quiet line and a button that opens customise.
  await T('dash-customise').click()
  await T('dash-customise-bar').waitFor({ timeout: 5000 })
  for (const id of DEFAULT_ORDER) {
    const hide = ctl(id, 'dash-section-hide')
    if ((await hide.count()) > 0) await hide.click()
  }
  check(!!(await until(async () => ((await layoutOf())?.hidden ?? []).length === DEFAULT_ORDER.length, 5000, 50)), 'CU all seven sections can be hidden', JSON.stringify((await layoutOf())?.hidden))
  await T('dash-customise').click()
  check(!!(await until(async () => (await T('dash-customise-bar').count()) === 0 && (await visible('[data-testid=dash-all-hidden]')), 5000, 50)), 'A21 with all six hidden and customise closed "All sections are hidden." shows')
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
    ['a wrong version', '{"v":3,"order":["projects"]}', DEFAULT_ORDER.join()],
    ['not JSON', 'not json{', DEFAULT_ORDER.join()],
    ['unknown and duplicate ids', '{"v":2,"order":["upnext","bogus","upnext","projects"],"hidden":["nope","upnext","upnext"],"pinned":[7,"x","x"]}', null],
    ['a version 1 layout in the old default order', '{"v":1,"order":["resume","today","working","week","engagements","projects"],"hidden":[],"pinned":[]}', DEFAULT_ORDER.join()],
    ['a version 1 layout with its own order', '{"v":1,"order":["projects","resume","today","working","week","engagements"],"hidden":["working","week"],"pinned":[]}', null]
  ]
  for (const [label, raw, want] of corrupt) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [LAYOUT_KEY, raw])
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 60_000 })
    await gotoProjects(page)
    await T('dash-customise').click()
    await T('dash-customise-bar').waitFor({ timeout: 5000 })
    const order = await slotOrder()
    const valid = order.length === DEFAULT_ORDER.length && new Set(order).size === DEFAULT_ORDER.length && order.every((o) => DEFAULT_ORDER.includes(o))
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
  check(!!workingEarly, 'RN Right now lists at least one working agent row while the deep tree runs')
  // Team pulse: the live org chart in miniature (a picture with a caption; nothing in it takes focus).
  const pulseUp = await until(async () => (await T('dash-pulse-node').count()) >= 2, 15_000, 150)
  const pulse = await page.evaluate(() => {
    const p = document.querySelector('[data-testid=dash-pulse]')
    const nodes = [...document.querySelectorAll('[data-testid=dash-pulse-node]')]
    return {
      drawn: !!p,
      aria: p?.querySelector('svg')?.getAttribute('aria-hidden') ?? '',
      focusable: p ? p.querySelectorAll('a, button, [tabindex]:not([tabindex="-1"])').length : -1,
      caption: p?.querySelector('[data-testid=dash-pulse-caption]')?.textContent?.trim() ?? '',
      nodes: nodes.map((n) => ({ state: n.getAttribute('data-state'), agent: n.getAttribute('data-agent'), depth: n.getAttribute('data-depth') })),
      motion: p?.hasAttribute('data-motion') ?? false
    }
  })
  check(!!pulseUp && pulse.drawn && pulse.nodes.length >= 2 && pulse.nodes.every((n) => n.state && n.agent && n.depth !== null), 'BR Team pulse draws a node per agent with state, agent and depth for a live mock run', JSON.stringify(pulse).slice(0, 300))
  check(pulse.aria === 'true' && pulse.focusable === 0 && /\d/.test(pulse.caption), 'BR Team pulse is decorative (aria-hidden picture, nothing focusable) with a caption that counts agents', JSON.stringify({ a: pulse.aria, f: pulse.focusable, c: pulse.caption }))
  check(pulse.nodes.some((n) => n.state === 'working'), 'BR the pulse shows a working node while agents work', JSON.stringify(pulse.nodes.map((n) => n.state)))
  check((await T('dash-pause-motion').getAttribute('aria-pressed')) === 'false' && (await page.locator('.dash-page[data-motion-paused]').count()) === 0, 'BR Pause motion starts unpressed and the page is not marked paused')
  const loops = () =>
    page.evaluate(() => ({
      breathing: document.querySelectorAll('.dash-pulse-halo[data-breathe]').length,
      signals: document.querySelectorAll('[data-testid=dash-pulse-signal]').length,
      infinite: document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations === Infinity && !!a.effect?.target?.closest?.('[data-testid=dashboard]')).length
    }))
  const loopsNormal = await loops()
  check(loopsNormal.breathing + loopsNormal.infinite > 0, 'MO (control) with motion on, breathing loops run while agents work', JSON.stringify(loopsNormal))
  // One page-wide breathing budget of 12 (Right now's marks first, the pulse with the rest) and a signal made of transform keyframes only.
  const pageBreathing = await page.evaluate(() => document.querySelectorAll('[data-testid=dashboard] [data-breathe]').length)
  check(pageBreathing <= 12, 'MO at most 12 elements breathe on the whole Dashboard (Right now first, Team pulse with the rest)', String(pageBreathing))
  const tripCss = await page.evaluate(() => {
    for (const sheet of [...document.styleSheets]) {
      try {
        for (const rule of [...sheet.cssRules]) if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'dash-pulse-trip') return rule.cssText
      } catch {
        // cross-origin sheet: not ours
      }
    }
    return ''
  })
  check(tripCss !== '' && /transform/.test(tripCss) && /opacity/.test(tripCss) && !/offset/.test(tripCss), 'MO the Team pulse signal animates transform and opacity only (no offset-distance)', tripCss.slice(0, 120))
  await T('dash-pause-motion').click()
  await sleep(300)
  const loopsPaused = await loops()
  check((await T('dash-pause-motion').getAttribute('aria-pressed')) === 'true' && (await page.locator('.dash-page[data-motion-paused]').count()) === 1 && clean(await text('dash-pause-motion')) === 'Pause motion', 'BR Pause motion pressed: aria-pressed true, the name stays "Pause motion" and the page carries data-motion-paused')
  check(loopsPaused.breathing === 0 && loopsPaused.signals === 0 && loopsPaused.infinite === 0, 'MO Pause motion stops the breathing marks, the pulse halos and signals (no looping animation runs)', JSON.stringify(loopsPaused))
  check((await T('dash-pulse-node').count()) >= 2 && /\d/.test(await text('dash-pulse-caption')), 'MO paused: the pulse keeps its static nodes and caption')
  check((await layoutOf())?.motionPaused === true, 'BR Pause motion is saved in the layout', JSON.stringify(await layoutOf()))
  check((await live()).includes('Motion paused.'), 'BR Pause motion announces "Motion paused."', await live())
  await T('dash-pause-motion').click()
  await sleep(300)
  check((await T('dash-pause-motion').getAttribute('aria-pressed')) === 'false' && (await page.locator('.dash-page[data-motion-paused]').count()) === 0, 'BR Pause motion pressed again resumes the page')
  // Reduced motion (Appearance): the working mark's ::after has no animation, no loop runs, the pulse is static.
  const markAnimOf = () =>
    page.evaluate(() => {
      const m = document.querySelector('.dash-mark[data-state=working][data-breathe]')
      return m ? getComputedStyle(m, '::after').animationName : 'no-mark'
    })
  const markNormal = await markAnimOf()
  await setAppearance({ reduceMotion: 'on' })
  const markAnim = await markAnimOf()
  const loopsReduced = await loops()
  if (markAnim === 'no-mark') log('SKIP reduced-motion mark check: the working mark was gone before the setting applied')
  else {
    check(markAnim === 'none', 'MO with data-reduce-motion=on the working mark has no ::after animation', markAnim)
    check(markNormal !== 'none', 'MO (control) without reduced motion the working mark does animate', markNormal)
  }
  check(loopsReduced.breathing === 0 && loopsReduced.signals === 0 && loopsReduced.infinite === 0, 'MO reduced motion: no pulse halo breathes, no signal travels, no infinite animation runs', JSON.stringify(loopsReduced))
  await setAppearance({ reduceMotion: 'system' })
  // The OS switch (prefers-reduced-motion) does the same without touching Appearance.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await sleep(500)
  const loopsOs = await loops()
  check(loopsOs.breathing === 0 && loopsOs.signals === 0 && loopsOs.infinite === 0, 'MO prefers-reduced-motion: no pulse halo breathes, no signal travels, no infinite animation runs', JSON.stringify(loopsOs))
  await page.emulateMedia({ reducedMotion: null })
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
  // Up next lists the next firing whatever the day, so a daily schedule 20 minutes ahead always shows (it may wrap past midnight).
  const scheduleId = await page.evaluate(([pid, time]) => window.orgai.schedules.save({ name: 'E2E dash check', prompt: 'Nothing.', target: { kind: 'team', projectId: pid }, timing: { kind: 'daily', time }, enabled: true }).then((s) => s.id), [pinId, later.time])
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
  // Rows drawn plus "Show N more" are every open decision; the heading's count span and the Briefing's sentence say the same number.
  const rows = await T('dash-needs-row').count()
  const bell = await bellCount()
  const moreN = Number(/(\d+)/.exec(await text('dash-needs-more').catch(() => ''))?.[1] ?? 0)
  const countN = Number(/^(\d+) decision/.exec(await text('dash-needs-count'))?.[1] ?? -1)
  check(rows >= 2 && rows + moreN === bell, 'NY dash-needs-row count (plus Show N more) equals the sidebar bell count', `${rows} + ${moreN} vs ${bell}`)
  check(countN === bell, 'NY the Needs you count span says the bell count in decisions', `${await text('dash-needs-count')} vs ${bell}`)
  check(new RegExp(`(^| )${bell} decisions? needs? you\\.`).test(await briefText()), 'NY the Briefing status sentence says the same decision count', await briefText())
  const kinds = await needsKinds()
  check(kinds.includes('permission') && kinds.length >= 2 && new Set(kinds).size >= 2, 'A10 two kinds of decision wait (permission and the schedule proposal)', kinds.join())
  check(weightsAscend(kinds), 'A10 Waiting on you is ordered by kind weight (permission before proposal)', kinds.join())
  const keysBefore = await needsKeys()
  await sleep(2500)
  check((await needsKeys()).join('|') === keysBefore.join('|'), 'A10 a row does not move while other events arrive', `${keysBefore.join('|')} -> ${(await needsKeys()).join('|')}`)
  check((await text('dash-needs-you')).startsWith('Needs you'), 'NY the region is called "Needs you"', (await text('dash-needs-you')).slice(0, 40))
  check((await page.locator('[data-testid=dash-needs-you]').evaluate((el) => !el.closest('[data-testid=dash-section]'))) && (await page.locator('[data-testid=dash-section][data-section=now]').count()) === 1, 'NY Needs you is a fixed region outside the arrangeable slots; Right now is the one fixed slot')
  const regions = await headingFacts()
  check(['dash-needs-you', 'dash-now', 'dash-week', 'dash-todos'].every((id) => regions.present.includes(id)), 'EM with data Needs you, Right now, Your week and To-dos render', JSON.stringify(regions.present))
  // Pick up lists ended and paused runs only (the stopped Chat run may be there); a run that is still live is Right now's.
  const liveProjects = [waitId, busy?.id, schedProject?.id]
  const pickProjects = await T('dash-resume-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-project')))
  check(!pickProjects.some((p) => liveProjects.includes(p)), 'WK Pick up never lists a run that is still live (those are in Right now)', JSON.stringify(pickProjects))
  await checkHeadings('with data at 1600x1000')
  // Right now.
  check((await page.locator('[data-testid=dash-now] [data-testid=dash-running-row][data-status]').count()) >= 1, 'RN a live run appears in Right now (dash-now > dash-running-row)')
  check((await T('dash-now-empty').count()) === 0, 'RN there is no dash-now-empty while runs are live')
  check((await text('dash-now')).startsWith('Right now'), 'RN the band is called "Right now"', (await text('dash-now')).slice(0, 30))
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
  // Pinned first, then by last activity (newest run start first); a decision never reshuffles the tiles.
  check(tiles.join('|') === [PINNED, SCHED, BUSY, WAIT].join('|'), 'PR the pinned tile is first, then the projects by newest run (a decision never reorders them)', JSON.stringify(tiles))
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
  // The setup line is one quiet button in the Briefing; its rows live in a popover (only drawn when something needs setting up).
  if (await T('dash-setup-line').count()) {
    check((await T('dash-setup').count()) === 0, 'BR the setup rows stay in the popover until the line is opened')
    await T('dash-setup-line').click()
    await T('dash-setup').waitFor({ timeout: 5000 })
    const setupKinds = await T('dash-setup-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
    const lineText = clean(await text('dash-setup-line'))
    check(setupKinds.length >= 1 && new RegExp(`^${setupKinds.length} things? to set up`).test(lineText), 'BR the setup line counts the rows its popover holds', `${lineText} / ${setupKinds.length}`)
    check((await T('dash-setup-action').first().getAttribute('aria-label')) !== null && (await T('dash-setup-action').count()) === setupKinds.length, 'BR every setup row has an action named with its line')
    await page.keyboard.press('Escape')
    await T('dash-setup').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    check((await T('dash-setup').count()) === 0 && (await activeInfo()).testid === 'dash-setup-line', 'BR Esc closes the setup popover and returns focus to the line', JSON.stringify(await activeInfo()))
  } else log('note: no setup rows on this machine, so the setup line is not drawn (it only exists when something needs setting up)')
  check((await T('plan-gauges').count()) === 0 && (await T('plan-gauge').count()) === 0, 'BR plan gauges are absent under the mock adapter')
  const removed = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`[data-testid="${id}"]`)), REMOVED_IDS)
  check(removed.length === 0, 'the removed test ids are not on the page', removed.join())
  await checkBrief('with decisions waiting')
  const brief1 = await briefText()
  check(/(^| )2 decisions need you\./.test(brief1) && (brief1.match(/\./g) ?? []).length <= 3, 'BR the visible status sentence says the decisions and stays short', brief1)
  const workingNow = await page.locator('[data-testid=dash-agent-row][data-state=working]').count()
  check(workingNow > 0 ? /agents? (is|are) working in \d+ runs?\./.test(brief1) : !/working in/.test(brief1), 'BR the status sentence says what is working, and only when something is', `${workingNow} working: ${brief1}`)
  const statusAttn = await page.locator('[data-testid=dash-greeting-brief] .dash-brief-attn').innerText().catch(() => '')
  check(/decisions? need you/.test(statusAttn), 'BR the decision sentence is the one emphasised part of the status', statusAttn)

  // ---------------------------------------------------------------- A14 Today
  const todosSection = T('dash-todos')
  await todosSection.waitFor({ timeout: 10_000 })
  check((await todosSection.locator('h2').innerText()).trim() === 'To-dos', 'WK the to-do section is called "To-dos" (own section, not part of Up next)')
  const todoRows = await T('dash-today-todo').evaluateAll((els) => els.map((e) => e.textContent ?? ''))
  check(todoRows.length >= 2 && !todoRows.some((t) => /Already finished thing/.test(t)), 'WK open to-dos from two lists show and a done to-do never does', JSON.stringify(todoRows).slice(0, 300))
  check((await todosSection.locator('[data-testid=dash-today-todo]').count()) === todoRows.length && (await T('dash-upnext').locator('[data-testid=dash-today-todo]').count()) === 0, 'WK the to-do rows live inside dash-todos, not inside Up next')
  const todayTodos = clean(await T('dash-today-todos').evaluate((el) => el.textContent ?? ''))
  check(/Draft the project brief/.test(todayTodos) && todayTodos.includes(PINNED), 'WK a to-do row names its list (for screen readers; the badge says it)', todayTodos.slice(0, 200))
  if (chatTodo) check(/Added by an assistant/.test(todayTodos), 'WK an assistant-added to-do says "Added by an assistant"', todayTodos.slice(0, 300))
  const longRow = page.locator('[data-testid=dash-today-todo]', { has: page.locator('.dash-row-name', { hasText: 'Prepare the quarterly planning' }) })
  const longFacts = await longRow.evaluate((li) => {
    const name = li.querySelector('.dash-row-name')
    const btn = li.querySelector('[data-testid=dash-today-start]')
    return { clipped: name.scrollWidth > name.clientWidth, title: name.getAttribute('title') === name.textContent, btnInside: btn.getBoundingClientRect().right <= li.getBoundingClientRect().right + 1 }
  })
  check(longFacts.clipped && longFacts.title && longFacts.btnInside, 'A6 a long to-do title clips with an ellipsis and a title and the button stays in its row', JSON.stringify(longFacts))
  {
    // Up next: a firing is a row whose one button is named with its name, day, time, target, kind and how far away it is.
    await T('dash-upnext').waitFor({ timeout: 10_000 })
    check((await T('dash-upnext').locator('h2').innerText()).trim() === 'Up next', 'WK the schedule section is called "Up next"')
    const sRow = page.locator(`[data-testid=dash-upnext-row][data-id="${scheduleId}"]`)
    const sBtn = sRow.locator('[data-testid=dash-upnext-open]')
    const sText = clean((await sBtn.getAttribute('aria-label').catch(() => '')) ?? '')
    const timeWords = clean(await page.evaluate((t) => { const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }, later.time))
    check((await sRow.count()) === 1 && sText.includes(timeWords) && sText.includes('E2E dash check') && sText.includes(PINNED) && /Team run\. In \d+ min\. Open schedule$/.test(sText), 'WK Up next shows the firing with its time, project, kind and how far away it is', `${sText} (wanted ${timeWords})`)
    check((await sRow.locator('.badge, [class*=badge]').count()) >= 1 && (await T('dash-upnext-pause').count()) === 1 && (await T('dash-upnext-schedules').count()) === 1, 'WK Up next offers the away badge, Pause all and Schedules')
    // Pause all (the Schedules page's own setting): rows give way to one line with the way back.
    await T('dash-upnext-pause').click()
    check(!!(await until(async () => (await T('dash-upnext-paused').count()) === 1, 5000)) && (await T('dash-upnext-row').count()) === 0 && (await T('dash-upnext-pause').count()) === 0, 'WK Pause all swaps the rows for the paused line', await text('dash-upnext'))
    // The pressed button unmounts: focus goes to its counterpart, never to the body.
    check(!!(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'dash-upnext-resume', 3000, 50)), 'WK after Pause all focus moves to Resume schedules', String(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)))
    check(/Schedules are paused\. Nothing will start until you resume them\./.test(await text('dash-upnext-paused')), 'WK the paused line reads "Schedules are paused. Nothing will start until you resume them."')
    check((await page.evaluate(async () => (await window.orgai.settings.get()).schedulesPaused)) === true && (await live()).includes('All schedules paused.'), 'WK Pause all saves the same schedulesPaused setting and announces', await live())
    await T('dash-upnext-resume').click()
    check(!!(await until(async () => (await T('dash-upnext-row').count()) === 1, 5000)) && (await T('dash-upnext-paused').count()) === 0, 'WK Resume schedules brings the row back')
    check(!!(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'dash-upnext-pause', 3000, 50)), 'WK after Resume schedules focus moves back to Pause all', String(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)))
    // The row opens its schedule on the Schedules page.
    await sBtn.click()
    const onSchedules = await page.getByRole('heading', { level: 1, name: /Schedules/ }).waitFor({ timeout: 8000 }).then(() => true, () => false)
    check(onSchedules, 'WK a row opens the Schedules page')
    await gotoProjects(page)
    await setSettings({ schedulesPaused: false })
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
  check((await week.locator('h2').innerText()).trim() === 'Your week', 'WK the section is called "Your week"')
  // The stat cards: Spend leads by default, each card is one native button, none of them reads $0.00 or a bare zero cost.
  const cardFacts = await T('dash-stat').evaluateAll((els) =>
    els.map((li) => ({ stat: li.getAttribute('data-stat'), focus: li.hasAttribute('data-focus'), buttons: li.querySelectorAll('button, a, [role=button]').length, tag: li.querySelector('button')?.tagName ?? '', name: li.querySelector('button')?.getAttribute('aria-label') ?? '', described: (document.getElementById(li.querySelector('button')?.getAttribute('aria-describedby') ?? '')?.textContent ?? '').trim(), value: li.querySelector('[data-testid=dash-stat-value]')?.textContent?.trim() ?? '', move: li.querySelector('[data-testid=dash-stat-move]')?.textContent?.trim() ?? '' }))
  )
  check(cardFacts.length >= 3 && cardFacts[0].stat === 'spend' && cardFacts[0].focus && cardFacts.filter((c) => c.focus).length === 1, 'WK the focus figure (Spend by default) leads Your week and is the one marked card', JSON.stringify(cardFacts.map((c) => [c.stat, c.focus])))
  check(cardFacts.every((c) => c.buttons === 1 && c.tag === 'BUTTON' && !/Opens Usage/.test(c.name) && c.name.startsWith(c.stat === 'time' ? 'Agent time' : c.stat[0].toUpperCase() + c.stat.slice(1))), 'WK each stat card is one native button named with its figure and movement only (no instruction in the name)', JSON.stringify(cardFacts.map((c) => c.name)))
  check(cardFacts.every((c) => /^Opens Usage for the same 7 days\./.test(c.described)), 'WK the instruction "Opens Usage for the same 7 days" is each card\'s description (aria-describedby), not its name', JSON.stringify(cardFacts.map((c) => c.described)))
  check(cardFacts.every((c) => c.value.length > 0 && c.move.length > 0) && !/\$0\.00/.test(cardFacts.map((c) => c.value).join(' ')), 'WK every card has a figure and a movement line and never reads $0.00', JSON.stringify(cardFacts.map((c) => [c.value, c.move])))
  const runsCard = cardFacts.find((c) => c.stat === 'runs')
  const timeCard = cardFacts.find((c) => c.stat === 'time')
  check(Number(runsCard?.value) >= 3, 'WK the Runs card counts the runs of the week', JSON.stringify(runsCard))
  check(/^(\d+h )?\d+m|^\d+s|^Not measured/.test(timeCard?.value ?? ''), 'WK the Agent time card shows a duration or "Not measured"', JSON.stringify(timeCard))
  // Each card opens Usage on the same 7 days: Spend with the cost metric pressed, Runs with the runs metric, Agent time on the period alone.
  const usageFacts = () =>
    page.evaluate(() => ({
      period: [...document.querySelectorAll('[data-testid=usage-period] input[type=radio]')].find((i) => i.checked)?.parentElement?.textContent?.trim() ?? '',
      pressed: [...document.querySelectorAll('[data-testid=usage-kpi-metric]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-metric')),
      h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? ''
    }))
  const openCard = async (stat, wantPressed) => {
    await gotoProjects(page)
    await T(`dash-stat-${stat}`).waitFor({ timeout: 10_000 })
    await T(`dash-stat-${stat}`).click()
    await T('usage-period').waitFor({ timeout: 15_000 })
    await until(async () => (await usageFacts()).period === '7 days' && (wantPressed === null || (await usageFacts()).pressed.join() === wantPressed), 8000, 100)
    return usageFacts()
  }
  const usTime = await openCard('time', null)
  check(usTime.h1 === 'Usage' && usTime.period === '7 days', 'WK the Agent time card opens Usage on 7 days', JSON.stringify(usTime))
  const usSpend = await openCard('spend', 'cost')
  check(usSpend.period === '7 days' && usSpend.pressed.join() === 'cost', 'WK the Spend card opens Usage on 7 days with the Cost metric pressed', JSON.stringify(usSpend))
  const usRuns = await openCard('runs', 'runs')
  check(usRuns.period === '7 days' && usRuns.pressed.join() === 'runs', 'WK the Runs card opens Usage on 7 days with the Runs metric pressed', JSON.stringify(usRuns))
  // Keyboard: a card is a native button, Enter opens it.
  await gotoProjects(page)
  await T('dash-stat-spend').focus()
  await page.keyboard.press('Enter')
  await T('usage-period').waitFor({ timeout: 15_000 })
  check((await usageFacts()).period === '7 days', 'WK Enter on a stat card opens Usage')
  // The activity map: 14 local days across, six blocks down, a text alternative, today's column marked.
  await gotoProjects(page)
  await T('dash-heat').waitFor({ timeout: 10_000 })
  const heat = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('[data-testid=dash-heat-col]')]
    const cells = [...document.querySelectorAll('[data-testid=dash-heat-cell]')]
    const total = cells.reduce((a, c) => a + Number(c.getAttribute('data-runs') || 0), 0)
    const d = new Date()
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const heatEl = document.querySelector('[data-testid=dash-heat]')
    return {
      cols: cols.length,
      cells: cells.length,
      total,
      todayCols: cols.filter((c) => c.hasAttribute('data-today')).length,
      lastIsToday: cols[cols.length - 1]?.hasAttribute('data-today') ?? false,
      lastKey: cols[cols.length - 1]?.getAttribute('data-date') ?? '',
      key,
      states: [...new Set(cells.map((c) => c.getAttribute('data-state')))].sort().join(),
      role: heatEl?.getAttribute('role') ?? '',
      alt: heatEl?.getAttribute('aria-label') ?? '',
      totalText: document.querySelector('[data-testid=dash-activity-total]')?.textContent?.trim() ?? '',
      todayText: document.querySelector('[data-testid=dash-activity-today]')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    }
  })
  check(heat.cols === 14 && heat.cells === 84 && heat.todayCols === 1 && heat.lastIsToday && heat.lastKey === heat.key, 'WK the activity map has 14 day columns of 6 blocks and today is the last, marked column', JSON.stringify(heat))
  check(heat.role === 'img' && /^Runs started per four-hour block over the last 14 days\. \d+ runs? in all\. Busiest: /.test(heat.alt), 'WK the activity map is one image with a text alternative naming the busiest blocks', heat.alt)
  check(heat.total >= 3 && heat.totalText === `${heat.total} runs · 14 days` && heat.states.includes('some') && /^Today · \d+ runs? started today\./.test(heat.todayText), 'WK the map total, cell counts and the "Today" footer agree', JSON.stringify(heat))
  check(Number(runsCard?.value) === heat.total, 'WK on a one-day history the Runs card equals the map total', `${runsCard?.value} vs ${heat.total}`)
  await T('dash-week-usage').click()
  await T('usage-period').waitFor({ timeout: 15_000 })
  await until(async () => (await usageFacts()).period === '30 days', 8000, 100)
  check((await usageFacts()).period === '30 days', 'WK the map link opens Usage on 30 days', JSON.stringify(await usageFacts()))
  await gotoProjects(page)
  await shot('week-1600x1000')

  // ---------------------------------------------------------------- A22 pairs outside customise mode
  const slots = await page.locator('[data-testid=dash-section]').evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute('data-section'), span: e.getAttribute('data-span'), lead: e.hasAttribute('data-lead'), x: Math.round(e.getBoundingClientRect().left), y: Math.round(e.getBoundingClientRect().top), w: Math.round(e.getBoundingClientRect().width), state: e.getAttribute('data-state') }))
  )
  const arrangeable = slots.filter((s) => s.id !== 'now')
  check(arrangeable.map((s) => s.id).join() === DEFAULT_ORDER.filter((id) => arrangeable.some((s) => s.id === id)).join() && arrangeable.every((s) => s.state === 'shown'), 'EM outside customise only the shown sections are slots, in the saved order', JSON.stringify(arrangeable))
  // The lead section (Your week, first visible) joins the left column under Needs you; the others pair two to a row or take the row.
  const byRow = new Map()
  for (const s of arrangeable.filter((s) => !s.lead)) byRow.set(s.y, [...(byRow.get(s.y) ?? []), s])
  const rowsOf = [...byRow.values()]
  const pairedOk = rowsOf.every((r) => (r.length === 1 && r[0].span === 'full') || (r.length === 2 && r.every((s) => s.span === 'half') && r[0].x < r[1].x && Math.abs(r[0].w - r[1].w) <= 2))
  check(pairedOk, 'SZ outside customise mode two half-width sections sit side by side and the others take the row (1600x1000)', JSON.stringify(arrangeable))
  log(`note: ${rowsOf.filter((r) => r.length === 2).length} paired row(s) of half-width sections at 1600x1000`)
  check(slots.find((s) => s.id === 'projects')?.span === 'full', 'SZ Projects is always full width')
  check(slots.find((s) => s.id === 'week')?.lead === true, 'SZ Your week, the first visible section, takes the work area\'s left column (data-lead)')

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
  // A trace of what could close the menu or take its focus: window blur, resize, wheel, focus leaving, the menu mounting or
  // going, and re-sorts of the tiles. It only feeds the check details below; no assertion depends on it. CI failed these
  // three checks once the MO block's emulateMedia({ reducedMotion: null }) handed the page from Playwright's default
  // no-preference to the runner's own setting, evidently reduce: the menu items then transitioned their inherited
  // visibility as the panel unhid, so focus() did nothing (fixed in ui.css .ctx-menu *; e2e/context-menus.mjs checks both
  // reduced-motion paths).
  await page.evaluate(() => {
    const t0 = performance.now()
    const tr = (window.__menuTrace = [])
    const add = (what) => tr.push(`${Math.round(performance.now() - t0)}ms ${what}`)
    const d = (el) => (el ? `${el.tagName}${el.dataset?.testid ? '[' + el.dataset.testid + ']' : ''}` : 'null')
    window.addEventListener('blur', () => add('window blur'), true)
    window.addEventListener('resize', () => add('window resize'))
    window.addEventListener('wheel', () => add('wheel'), true)
    document.addEventListener('focusout', (e) => add(`focusout ${d(e.target)} -> ${d(e.relatedTarget)}`), true)
    document.addEventListener('focusin', (e) => add(`focusin ${d(e.target)}`), true)
    new MutationObserver((ms) => {
      for (const m of ms) {
        for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('[role=menu]') || n.querySelector?.('[role=menu]'))) add('menu added')
        for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches?.('[role=menu]') || n.querySelector?.('[role=menu]'))) add('menu removed')
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await tileOf(WAIT).locator('[data-testid=project-tile-more]').click()
  await T('project-tile-open-folder').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const menu = clean(await page.getByRole('menu').last().innerText().catch(() => ''))
  const menuTrace = await page.evaluate(() => `${(window.__menuTrace ?? []).join(' | ')} | active=${document.activeElement?.tagName}${document.activeElement?.dataset?.testid ? '[' + document.activeElement.dataset.testid + ']' : ''} hasFocus=${document.hasFocus()}`)
  check((await visible('[data-testid=project-tile-open-folder]')) && (await visible('[data-testid=project-tile-delete]')) && /Open folder/.test(menu) && /Delete project/.test(menu), 'the More menu offers Open folder and Delete', `${menu} -- trace: ${menuTrace}`)
  check((await visible('[data-testid=project-tile-new-run]')) && /New run/.test(menu) && (await visible('[data-testid=project-tile-pin-item]')) && /Pin to top/.test(menu), 'the More menu offers New run and Pin to top', `${menu} -- trace: ${menuTrace}`)
  check(await page.evaluate(() => !!document.activeElement?.closest?.('[role=menu]')), 'opening the More menu moves focus into it', menuTrace)
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

  // ---------------------------------------------------------------- Sizes and themes (SZ)
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
        const now = document.querySelector('[data-testid=dash-now]')?.getBoundingClientRect()
        const hero = document.querySelector('[data-testid=dashboard-hero]').getBoundingClientRect()
        const sal = document.querySelector('[data-testid=dash-greeting-salutation]')
        const actions = document.querySelector('[data-testid=dash-quick-actions]')?.getBoundingClientRect()
        const pulse = document.querySelector('[data-testid=dash-pulse]')?.getBoundingClientRect()
        const pageW = document.querySelector('.dash-page')?.clientWidth ?? 0
        // An inner scroller: a descendant of the page that scrolls on its own (the Dashboard has one page scroll).
        const inner = [...document.querySelectorAll('[data-testid=dashboard] *')]
          .filter((e) => {
            const cs = getComputedStyle(e)
            return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1 && e.clientHeight > 0
          })
          .map((e) => `${e.tagName}.${String(e.className).slice(0, 30)}`)
        return {
          theme: document.documentElement.dataset.theme,
          vh: window.innerHeight,
          heroBottom: hero.bottom,
          heroRight: hero.right,
          salInside: sal.getBoundingClientRect().right <= hero.right + 1,
          actionsBottom: actions ? actions.bottom : -1,
          pulseInside: !pulse || (pulse.right <= hero.right + 1 && pulse.left >= hero.left - 1),
          pageW,
          needsRight: n.right,
          needsLeft: n.left,
          needsTop: n.top,
          nowLeft: now ? now.left : -1,
          nowTop: now ? now.top : -1,
          inner
        }
      })
      const o = await overflowFacts()
      check(m.theme === theme, `theme is ${theme} ${tag}`)
      check(o.over <= 1 && o.docOver <= 1, `SZ the dashboard has no horizontal overflow ${tag}`, JSON.stringify({ ...m, ...o }))
      check(o.winTop === 0, `SZ the window does not scroll ${tag}`, JSON.stringify(o))
      check(m.inner.length === 0, `SZ the Dashboard has no inner scrolling column (one page scroll) ${tag}`, m.inner.join(' | '))
      // An agent row's activity (and every child) stays inside its row, and the row inside Right now (the document-level check misses a clipped card).
      const rowsFit = await page.evaluate(() => {
        const now = document.querySelector('[data-testid=dash-now]')?.getBoundingClientRect()
        const bad = []
        let n = 0
        for (const row of document.querySelectorAll('[data-testid=dash-agent-row]')) {
          n += 1
          const r = row.getBoundingClientRect()
          if (now && r.right > now.right + 1) bad.push(`row ${Math.round(r.right)}>${Math.round(now.right)}`)
          for (const c of row.children) {
            const cr = c.getBoundingClientRect()
            if (cr.width > 0 && cr.right > r.right + 1) bad.push(`${c.className} ${Math.round(cr.right)}>${Math.round(r.right)}`)
          }
        }
        return { n, bad }
      })
      check(rowsFit.bad.length === 0, `SZ every agent row's text stays inside its run card ${tag}`, JSON.stringify(rowsFit))
      check(m.salInside, `SZ a 40-character name stays inside the greeting ${tag}`, JSON.stringify(m))
      check(m.pulseInside, `SZ the Team pulse stays inside the Briefing ${tag}`, JSON.stringify(m))
      await visualPassChecks(tag)
      // Two work columns from an 880 px page: Needs you left, Right now right; one column below that.
      const twoCols = m.pageW >= 880
      check(m.nowLeft > 0 && (twoCols ? m.nowLeft >= m.needsRight - 1 : m.nowLeft <= m.needsLeft + 1 && m.nowTop > m.needsTop), `SZ the work area is ${twoCols ? 'two columns' : 'one column'} at a ${m.pageW} px page ${tag}`, JSON.stringify(m))
      await checkHeadings(tag)
      check(m.heroBottom > 0 && m.actionsBottom > 0 && m.actionsBottom <= m.vh, `SZ the greeting, status and quick actions sit above the fold ${tag}`, JSON.stringify(m))
      if (h === 640) {
        const scrolled = await page.evaluate(() => {
          const d = document.querySelector('[data-testid=dashboard]')
          d.scrollTop = 300
          return { dashTop: d.scrollTop, winTop: document.scrollingElement?.scrollTop ?? 0, canScroll: d.scrollHeight > d.clientHeight }
        })
        check(scrolled.canScroll && scrolled.dashTop > 0 && scrolled.winTop === 0, `SZ .dashboard is the one page scroll and the window does not scroll ${tag}`, JSON.stringify(scrolled))
        await page.evaluate(() => (document.querySelector('[data-testid=dashboard]').scrollTop = 0))
      }
      if (!twoCols) {
        const col = await page.locator('[data-testid=dash-section]').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size)
        check(col === 1, `SZ every section shares one column at ${w}x${h} ${tag}`, String(col))
      }
      await screenshot(page, `dashboard-${w}x${h}-${theme}`)
    }
  }
  await setTheme('dark')
  await setSize(1600, 1000)
  await setName('Sam')
  await page.evaluate(() => (document.querySelector('[data-testid=dashboard]').scrollTop = 0))
  await page.evaluate(() => (document.querySelector('[data-testid=dashboard]').scrollTop = 0))

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
  // Pick up: each row is a state word, the run's title and one small button (Continue or Open) named with that title.
  const pausedRow = page.locator(`[data-testid=dash-resume-row][data-kind=paused][data-run="${pausedRun.id}"]`)
  await T('dash-resume').waitFor({ timeout: 10_000 }).catch(() => {})
  check((await T('dash-resume').locator('h2').innerText().catch(() => '')).trim() === 'Pick up', 'WK the section is called "Pick up"')
  if (wasPaused && (await pausedRow.waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
    const pAction = pausedRow.locator('[data-testid=dash-resume-action]')
    check((await pausedRow.getAttribute('data-status')) === 'Paused' && /Paused/.test(clean(await pausedRow.locator('.dash-pick-state').innerText())), 'WK a paused run row leads with the state word "Paused"', clean(await pausedRow.innerText()))
    const pName = (await pAction.getAttribute('aria-label')) ?? ''
    check((await pAction.getAttribute('data-action')) === 'resume' && clean(await pAction.innerText()) === 'Continue' && /^Continue .*Limit test.* now$/.test(pName), 'WK a paused row offers Continue, named with the run title ("Continue <title> now")', pName)
    await pAction.click()
    check(!!(await until(async () => (await pausedRow.count()) === 0, 15_000)), 'WK Continue resumes the paused run and its row leaves Pick up')
  } else check(false, 'WK a paused run shows a Pick up row', String(wasPaused))
  await gotoProjects(page)
  const outRow = page.locator(`[data-testid=dash-resume-row][data-run="${outRun.id}"]`)
  if (madeOutput && (await outRow.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
    const oAction = outRow.locator('[data-testid=dash-resume-action]')
    const oName = (await oAction.getAttribute('aria-label')) ?? ''
    check(/^(Finished|Stopped|Ended)/.test((await outRow.getAttribute('data-status')) ?? '') || (await outRow.getAttribute('data-status')) !== null, 'WK an ended run row carries a state word', String(await outRow.getAttribute('data-status')))
    check(['continue', 'open'].includes((await oAction.getAttribute('data-action')) ?? '') && new RegExp(`^(Continue|Open) .*Produce the deliverables`).test(oName), 'WK the ended run offers Continue or Open named with its title', oName)
    await outRow.locator('[data-testid=dash-resume-main]').click()
    const opened = await page.locator('main .topbar h1').first().innerText().then((t) => t.trim() === INLINE, () => false)
    check(opened || !!(await until(async () => (await page.locator('main .topbar h1').first().innerText()).trim() === INLINE, 8000, 100)), 'WK a Pick up row opens its run in its project')
    await gotoProjects(page)
  } else check(false, 'WK an ended run with an output shows a Pick up row', String(madeOutput))
  const pickRows = await T('dash-resume-row').count()
  check((await T('dash-resume-row').evaluateAll((els) => els.every((e) => e.querySelectorAll('button').length === 2))), 'WK every Pick up row is two native buttons: the row (opens the run) and its Continue / Open')
  log(`note: Pick up lists ${pickRows} row(s)`)

  // Several outputs, files that are gone and the cap with "Show N more" are covered by the unit tests (resumeRows).

  // A second window follows a change in the layout (the storage event).
  await T('dash-customise').click()
  const storedLayout = await layoutOf()
  await page.evaluate(([k, cur]) => window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: JSON.stringify({ ...cur, v: 2, order: ['todos', 'week', 'pickup', 'upnext', 'projects', 'engagements', 'commits'], hidden: [] }) })), [LAYOUT_KEY, storedLayout])
  await sleep(300)
  check((await slotOrder()).join() === 'todos,week,pickup,upnext,projects,engagements,commits', 'CU a storage event from another window changes the order here', (await slotOrder()).join())
  await T('dash-customise-reset').click()
  await T('dash-customise').click()

  // The last visit was before this script began, so what ended since then is "since" (a relaunch never advances it).
  await page.evaluate(([k, t]) => localStorage.setItem(k, String(t)), [LAST_SEEN_KEY, T0 - 60_000])
  log('relaunching')
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'dashboard' }))
  log('relaunched')
  watchErrors(page)
  await gotoProjects(page)
  await T('dash-resume-row').first().waitFor({ timeout: 15_000 }).catch(() => {})
  await sleep(600)
  check((await salutationText()).endsWith(', Sam'), 'A7 the name survives a relaunch', await salutationText())
  check((await text('dash-resume')).startsWith('Pick up'), 'WK after a relaunch the section is called "Pick up"', (await text('dash-resume')).slice(0, 40))
  const resumeFacts = await T('dash-resume-row').evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute('data-kind'), run: e.getAttribute('data-run'), project: e.getAttribute('data-project'), status: e.getAttribute('data-status'), since: e.hasAttribute('data-since'), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })))
  const closedWait = resumeFacts.find((r) => r.kind === 'closed' && r.text.includes(WAIT))
  check(!!closedWait && /waiting on you when OrgAI closed/i.test(closedWait.text), 'WK a run ended by quit while waiting says it was waiting on you when OrgAI closed', JSON.stringify(resumeFacts).slice(0, 500))
  const waitResumeRow = page.locator('[data-testid=dash-resume-row][data-kind=closed]', { hasText: WAIT })
  check((await waitResumeRow.locator('[data-testid=dash-resume-action][data-action=continue]').count()) === 1, 'WK that row offers Continue')
  check((await waitResumeRow.locator('[data-testid=dash-resume-action]').getAttribute('aria-label'))?.startsWith('Continue ') === true && (await waitResumeRow.getAttribute('data-since')) !== null && (await waitResumeRow.locator('[data-testid=dash-resume-new]').count()) === 1, 'WK the Continue button is named with the run title and the row carries the "ended since your last visit" marker', String(await waitResumeRow.locator('[data-testid=dash-resume-action]').getAttribute('aria-label')))
  const runKeys = resumeFacts.filter((r) => r.run).map((r) => r.run)
  check(new Set(runKeys).size === runKeys.length, 'WK each chain appears once in Pick up', JSON.stringify(runKeys))
  check((await T('dash-resume-row').locator('[data-action=new-run]').count()) === 0 && !resumeFacts.some((r) => r.kind === 'pinned'), 'WK a pinned project with no runs is not a Pick up row after a relaunch either')
  check((await T('dash-now').count()) === 0 && (await T('dash-now-empty').count()) === 0, 'RN with nothing running Right now is not rendered and there is no dash-now-empty')
  // The since line: what ended after the last visit (a relaunch keeps the stored last-seen time, so the cut runs count).
  const sinceLine = await T('dash-since').first().evaluate((el) => ({ sr: el.querySelector('.sr-only')?.textContent?.trim() ?? '', visible: el.querySelector('.dash-since-visual')?.textContent?.replace(/\s+/g, ' ').trim() ?? '', hiddenVisual: el.querySelector('.dash-since-visual')?.getAttribute('aria-hidden') })).catch(() => null)
  check(!!sinceLine && /^Since .+: \d+ .+\.$/.test(sinceLine.sr) && sinceLine.hiddenVisual === 'true' && sinceLine.visible.startsWith('Since '), 'BR after a relaunch the since line says what ended since the last visit (screen-reader sentence, decorative visual)', JSON.stringify(sinceLine))
  check(!!sinceLine && /was waiting on you when OrgAI closed|were waiting on you when OrgAI closed/.test(sinceLine.sr), 'BR the since line says a run was waiting on you when OrgAI closed, so "Nothing needs you." never stands alone above it', JSON.stringify(sinceLine))
  check((await page.locator('[data-testid=project-tile]').first().getAttribute('data-name')) === PINNED, 'A20 the pin survives a relaunch (the pinned tile is first)')
  const goneIds = await page.evaluate((ids) => ids.filter((id) => document.querySelector(`[data-testid="${id}"]`)), REMOVED_IDS)
  check(goneIds.length === 0, 'the removed test ids are absent after the relaunch too', goneIds.join())
  check(/Nothing needs you\./.test(await briefText()) && !/working/.test(await briefText()), 'BR after a relaunch (no live run, no decision) the status says "Nothing needs you."', await briefText())
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
  // The primary quick action continues the pinned project.
  await gotoProjects(page)
  await T('dash-continue').click()
  await sleep(800)
  const contOpened = await page.evaluate(() => ({ h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '', body: document.activeElement === document.body }))
  check(contOpened.h1 === PINNED && !contOpened.body, 'BR Continue in the Briefing opens the pinned project and focus stays on a real element', JSON.stringify(contOpened))
  await gotoProjects(page)

  // ---------------------------------------------------------------- The last decision, answered by keyboard: focus never falls to the body
  {
    const lastRun = await page.evaluate((id) => window.orgai.runs.start({ projectId: id, prompt: 'First task' }), inline.id)
    await gotoProjects(page)
    const lastRows = page.locator('[data-testid=dash-needs-row][data-kind=permission]')
    if ((await lastRows.first().waitFor({ timeout: 20_000 }).then(() => true, () => false)) && (await T('dash-needs-row').count()) === 1) {
      await lastRows.first().locator('[data-testid=dash-needs-allow]').focus()
      await page.keyboard.press('Enter')
      await until(async () => (await T('dash-needs-you').count()) === 0, 15_000, 100)
      await sleep(500)
      const landed = await page.evaluate(() => {
        const a = document.activeElement
        return { body: !a || a === document.body || a === document.documentElement, testid: a?.getAttribute?.('data-testid') ?? '', id: a?.id ?? '', tag: a?.tagName ?? '', visible: !!a && a.getClientRects().length > 0 }
      })
      check(!landed.body && landed.visible && (landed.id === 'dash-h-now' || landed.testid === 'dash-greeting-brief'), 'A8 after the last decision is answered the Needs you section is gone and focus lands on the Right now heading or the status sentence, not the body', JSON.stringify(landed))
      check((await live()).includes('Nothing else needs you.'), 'A8 dashboard-live says "Nothing else needs you." once', await live())
    } else log('SKIP last-decision focus check: the single permission row did not appear', await T('dash-needs-row').count())
    await page.evaluate((id) => window.orgai.runs.stop(id), lastRun.id).catch(() => {})
    await gotoProjects(page)

    // An unpriced run with usage says "Not priced" in Pick up, as a priced row shows its figure (never a blank).
    const noPrice = await page.evaluate((id) => window.orgai.runs.start({ projectId: id, prompt: 'Unpriced run [mock:no-price]' }), inline.id)
    await until(async () => ['idle', 'finished', 'error'].includes((await page.evaluate((id) => window.orgai.runs.get(id), noPrice.id))?.summary?.status), 20_000)
    await page.evaluate((id) => window.orgai.runs.stop(id), noPrice.id).catch(() => {})
    await until(async () => (await page.evaluate((id) => window.orgai.runs.get(id), noPrice.id))?.summary?.status === 'finished', 20_000)
    await gotoProjects(page)
    const unpricedRow = page.locator(`[data-testid=dash-resume-row][data-run="${noPrice.id}"]`)
    if (await unpricedRow.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
      const unpriced = await unpricedRow.locator('[data-testid=dash-resume-unpriced]').innerText().catch(() => '')
      check(clean(unpriced) === 'Not priced', 'WK an unpriced run row in Pick up says "Not priced" instead of nothing', clean(await unpricedRow.innerText()))
    } else log('SKIP unpriced Pick up row: the [mock:no-price] run did not list')
  }

  // ---------------------------------------------------------------- MO page arrival (motion.md "Page arrival")
  const arrivalFacts = () =>
    page.evaluate(() => ({
      hero: !!document.querySelector('[data-testid=dashboard-hero].motion-arrive-hero'),
      bands: document.querySelectorAll('.motion-arrive-band').length,
      draw: document.querySelectorAll('.motion-draw-col, .motion-draw-line').length,
      flag: document.querySelector('.dash-page')?.hasAttribute('data-arriving') ?? false
    }))
  // The first navigation (a reload starts the session's arrival memory afresh): the hero rises while arriving, then rests.
  await page.reload()
  const arrived = await page.waitForSelector('[data-testid=dashboard-hero].motion-arrive-hero', { timeout: 20_000 }).then(() => true, () => false)
  check(arrived, 'MO on first navigation the Briefing hero carries motion-arrive-hero while the page arrives')
  await sleep(1800)
  const rested = await arrivalFacts()
  check(!rested.hero && rested.bands === 0 && rested.draw === 0 && !rested.flag, 'MO the arrival classes are gone once the page has rested (about 800 ms)', JSON.stringify(rested))
  // Away and back with no data change: no arrival classes at all.
  await page.locator('[data-testid=nav-usage]').click()
  await T('usage-period').waitFor({ timeout: 15_000 })
  await sleep(300)
  await gotoProjects(page)
  const back = await arrivalFacts()
  check(!back.hero && back.bands === 0 && back.draw === 0 && !back.flag, 'MO returning to the Dashboard with no data change shows no arrival classes', JSON.stringify(back))
  // Pause motion (saved in the layout) also stops the page arrival, not only the loops.
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), motionPaused: true })), LAYOUT_KEY)
  await page.reload()
  await page.waitForSelector('[data-testid=dashboard-hero]', { timeout: 20_000 })
  const pausedArrival = await page.evaluate(() => ({
    hero: !!document.querySelector('.motion-arrive-hero'),
    bands: document.querySelectorAll('.motion-arrive-band').length,
    flag: document.querySelector('.dash-page')?.hasAttribute('data-arriving') ?? false,
    paused: document.querySelector('.dash-page')?.hasAttribute('data-motion-paused') ?? false,
    trace: document.querySelectorAll('.plan-gauge-fill.motion-draw-trace').length
  }))
  check(pausedArrival.paused && !pausedArrival.hero && pausedArrival.bands === 0 && !pausedArrival.flag && pausedArrival.trace === 0, 'MO with Pause motion saved, the page stages no arrival (no hero rise, no band rise, no gauge trace)', JSON.stringify(pausedArrival))
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), motionPaused: false })), LAYOUT_KEY)
  await page.reload()
  await page.waitForSelector('[data-testid=dashboard-hero]', { timeout: 20_000 })
  // Reduced motion (Appearance): no arrival, no running animation on the page.
  await setAppearance({ reduceMotion: 'on' })
  await page.reload()
  await page.waitForSelector('[data-testid=dashboard-hero]', { timeout: 20_000 })
  const reducedFacts = await page.evaluate(() => ({
    hero: !!document.querySelector('.motion-arrive-hero'),
    bands: document.querySelectorAll('.motion-arrive-band').length,
    running: document.getAnimations().filter((a) => a.playState === 'running' && !!a.effect?.target?.closest?.('[data-testid=dashboard]')).length
  }))
  await sleep(300)
  const reducedRun = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && !!a.effect?.target?.closest?.('[data-testid=dashboard]') && (a.effect.getComputedTiming().activeDuration ?? 0) > 20).length)
  check(!reducedFacts.hero && reducedFacts.bands === 0 && reducedRun === 0, 'MO with Appearance Reduce motion on, no arrival is staged and no Dashboard animation runs', JSON.stringify({ ...reducedFacts, reducedRun }))
  await setAppearance({ reduceMotion: 'system' })
  await page.reload()
  await page.waitForSelector('[data-testid=dashboard-hero]', { timeout: 20_000 })

  // ---------------------------------------------------------------- MD multi-day history (seeded in this script's own data dir)
  // The mock puts every run on one day. Close the app, move some run records back whole days (the files of this script's
  // throwaway ORGAI_DATA_DIR only; no source is touched), start again and read the map, the movement lines and the since line.
  {
    const DAY = 24 * 60 * 60 * 1000
    await page.evaluate(([k, t]) => localStorage.setItem(k, String(t)), [LAST_SEEN_KEY, T0 - 60_000])
    await app.close().catch(() => {})
    const dir = runRecordsDir()
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
    const recs = files
      .map((f) => {
        try {
          return { file: path.join(dir, f), rec: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }
        } catch {
          return null
        }
      })
      .filter((r) => r && r.rec?.summary && typeof r.rec.summary.startedAt === 'number' && (r.rec.summary.kind === undefined || r.rec.summary.kind === 'work'))
      .sort((a, b) => a.rec.summary.startedAt - b.rec.summary.startedAt)
    const shifts = [3, 3, 5, 9]
    const moved = []
    // The run list is read from the index `<data>/runs.json` (a record's summary comes from it), so patch it and the records alike.
    const indexFile = path.join(path.dirname(dir), 'runs.json')
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    recs.slice(0, shifts.length).forEach((r, i) => {
      const by = shifts[i] * DAY
      for (const s of [r.rec.summary, index.runs.find((x) => x.id === r.rec.summary.id)].filter(Boolean)) {
        s.startedAt -= by
        if (typeof s.endedAt === 'number') s.endedAt -= by
      }
      fs.writeFileSync(r.file, JSON.stringify(r.rec))
      moved.push({ id: r.rec.summary.id, days: shifts[i] })
    })
    fs.writeFileSync(indexFile, JSON.stringify(index))
    log('MD shifted run records:', JSON.stringify(moved), `of ${recs.length} work records`)
    ;({ app, page, shot } = await launch({ shotPrefix: 'dashboard', clearPrefs: false }))
    watchErrors(page)
    await gotoProjects(page)
    await T('dash-heat').waitFor({ timeout: 20_000 }).catch(() => {})
    await sleep(800)
    const md = await page.evaluate(() => {
      const cols = [...document.querySelectorAll('[data-testid=dash-heat-col]')]
      const withRuns = cols.map((c, i) => ({ i, runs: [...c.querySelectorAll('[data-testid=dash-heat-cell]')].reduce((a, x) => a + Number(x.getAttribute('data-runs') || 0), 0) })).filter((c) => c.runs > 0)
      const today = cols.find((c) => c.hasAttribute('data-today'))
      const todayRuns = today ? [...today.querySelectorAll('[data-testid=dash-heat-cell]')].reduce((a, x) => a + Number(x.getAttribute('data-runs') || 0), 0) : -1
      return { withRuns, todayRuns, total: withRuns.reduce((a, c) => a + c.runs, 0), todayText: document.querySelector('[data-testid=dash-activity-today]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '', totalText: document.querySelector('[data-testid=dash-activity-total]')?.textContent?.trim() ?? '' }
    })
    check(moved.length === 4 && md.withRuns.length >= 3, 'MD the activity map shows runs on several day columns after the history is seeded', JSON.stringify(md))
    check(md.withRuns.some((c) => c.i === 14 - 1 - 3) && md.withRuns.some((c) => c.i === 14 - 1 - 5) && md.withRuns.some((c) => c.i === 14 - 1 - 9), 'MD runs 3, 5 and 9 days back sit in the columns that many places left of today', JSON.stringify(md.withRuns))
    check(md.todayText.includes(`${md.todayRuns} run`) || (md.todayRuns === 0 && /No runs started today yet/.test(md.todayText)), 'MD the "Today" footer reads today\'s own count, not the 14-day total', JSON.stringify(md))
    check(md.totalText === `${md.total} runs · 14 days`, 'MD the map total counts every column', JSON.stringify(md))
    const mdCards = await T('dash-stat').evaluateAll((els) => Object.fromEntries(els.map((li) => [li.getAttribute('data-stat'), { value: li.querySelector('[data-testid=dash-stat-value]')?.textContent?.trim(), dir: li.querySelector('[data-testid=dash-stat-move]')?.getAttribute('data-dir'), move: li.querySelector('[data-testid=dash-stat-move]')?.textContent?.replace(/\s+/g, ' ').trim() }])))
    // Runs in the last 7 days = all but the 9-days-back one; the 7 days before hold that one (1): up by (value - 1).
    const runsNow = Number(mdCards.runs?.value)
    check(runsNow === md.total - 1 && mdCards.runs?.dir === 'up' && new RegExp(`^.?\\s*${runsNow - 1} vs the 7 days before`).test(mdCards.runs?.move ?? ''), 'MD the Runs card counts the last 7 days and says how much it moved against the 7 days before', JSON.stringify(mdCards.runs))
    check(['up', 'down', 'same', 'none'].includes(mdCards.spend?.dir ?? '') && /vs the 7 days before|No change|Not compared/.test(mdCards.spend?.move ?? ''), 'MD the Spend card has a movement line', JSON.stringify(mdCards.spend))
    check((await T('dash-stat-move').evaluateAll((els) => els.every((e) => (e.getAttribute('data-dir') === 'up' || e.getAttribute('data-dir') === 'down' ? !!e.querySelector('[aria-hidden=true]') : true)))), 'MD a rise or fall draws its glyph decoratively (the words carry the meaning)')
    const sinceMd = await T('dash-since').first().evaluate((el) => el.querySelector('.sr-only')?.textContent?.trim() ?? '').catch(() => '')
    const endedAfter = await page.evaluate(async (t0) => {
      const projects = await window.orgai.projects.list()
      let n = 0
      for (const p of projects) for (const r of await window.orgai.runs.list(p.id)) if ((r.kind === undefined || r.kind === 'work') && (r.endedAt ?? 0) > t0 - 60_000) n++
      return n
    }, T0).catch(() => -1)
    const sinceBody = sinceMd.replace(/^Since .+?: (?=\d)/, '')
    const sinceCount = [...sinceBody.matchAll(/(\d+) (?:runs? finished|failed|stopped)/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0)
    check(/^Since .+: \d+ .+\.$/.test(sinceMd) && sinceCount >= 1 && sinceCount <= endedAfter, 'MD the since line counts only runs that ended after the last visit (the seeded older ones are not in it)', `${sinceMd} (${endedAfter} work runs ended after the last visit)`)
    await shot('multi-day')
  }

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

// ================================================================ inboxChecks (Inbox view, UI overhaul; owner: sh-inbox)
// Appended block, its own launch (the Dashboard run above has finished and closed its app). Token-free, mock adapter.
//  IB  the Inbox opened from the sidebar: the waiting number is the sidebar badge and the Needs-you popover number, oldest
//      first, the selected decision is the run view's own card, J / K / Home / End, Enter goes to the main action and Esc
//      back to the list, an answer selects the next item and says so, a failed run is listed as finished until it is
//      cleared or marked read, the chips and the project filter, "Answer in order", the empty state, both themes and sizes.
// Not covered here: a run that finished successfully (the mock ends sessions only by stop, which is not news; unit tests
// cover it), a question, proposal, merge or install card in the Inbox, screen-reader speech.
{
  const IB_A = 'E2E inbox alpha (orgai test)'
  const IB_B = 'E2E inbox beta (orgai test)'
  const ibRepoA = makeFixtureRepo('inbox-a')
  const ibRepoB = makeFixtureRepo('inbox-b')
  let ibApp
  const ibClean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
  const ibUntil = async (fn, ms = 20_000, every = 200) => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn().catch(() => null)
      if (v) return v
      if (Date.now() > end) return null
      await sleep(every)
    }
  }
  try {
    const launched = await launch({ shotPrefix: 'inbox' })
    ibApp = launched.app
    const ip = launched.page
    const ipErrors = []
    ip.on('pageerror', (e) => ipErrors.push(e.message))
    const I = (id) => ip.locator(`[data-testid=${id}]`)
    const rows = () => ip.locator('[data-testid=inbox-row]')
    const waitRows = () => ip.locator('[data-testid=inbox-row][data-group=waiting]')
    const rowIds = () => rows().evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
    const selectedId = () => ip.evaluate(() => document.querySelector('[data-testid=inbox-row][aria-current=true]')?.getAttribute('data-id') ?? null)
    const badge = async () => Number(ibClean(await I('nav-inbox-count').first().innerText().catch(() => '0')) || 0)
    const bell = async () => Number(/Needs you · (\d+)/.exec(ibClean(await I('needs-you-row').first().innerText().catch(() => '')))?.[1] ?? 0)
    const summary = async () => ({
      waiting: Number(await I('inbox-summary').getAttribute('data-waiting')),
      finished: Number(await I('inbox-summary').getAttribute('data-finished')),
      text: ibClean(await I('inbox-summary').innerText())
    })
    const focusIn = (sel) => ip.evaluate((s) => !!document.activeElement?.closest?.(s), sel)
    const focusedRowId = () => ip.evaluate(() => (document.activeElement?.matches?.('[data-testid=inbox-row]') ? document.activeElement.getAttribute('data-id') : null))
    const live = async () => ibClean(await I('inbox-live').innerText().catch(() => ''))
    const openInbox = async () => {
      await I('nav-inbox').click()
      await I('inbox-view').waitFor({ timeout: 10_000 })
      await sleep(400)
    }
    const startViaIpc = (projectId, prompt) => ip.evaluate(({ id, p }) => window.orgai.runs.start({ projectId: id, prompt: p }), { id: projectId, p: prompt })
    const runStatus = (runId) => ip.evaluate((id) => window.orgai.runs.get(id).then((r) => r?.summary?.status ?? null), runId)
    const setSize = async (w, h) => {
      await ibApp.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
      await ip.waitForFunction((w2) => Math.abs(window.innerWidth - w2) <= 1, w, { timeout: 10_000 }).catch(() => {})
      await ip.evaluate(() => window.dispatchEvent(new Event('resize')))
      await sleep(500)
    }
    const setTheme = async (theme) => {
      await ip.evaluate(async (t) => {
        const s = await window.orgai.settings.get()
        await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
      }, theme)
      await sleep(600)
    }
    const overflowX = () => ip.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)

    // ---- Empty first: nothing waits, nothing is working.
    await openInbox()
    check((await I('inbox-empty').count()) === 1 && /Nothing is waiting on you/.test(ibClean(await I('inbox-empty').innerText())), 'IB an empty Inbox says "Nothing is waiting on you"')
    check(/(No teams are|\d+ teams? (is|are)) working/.test(ibClean(await I('inbox-empty').innerText())), 'IB the empty state says how many teams are working', ibClean(await I('inbox-empty').innerText()))
    check((await summary()).text === '0 waiting on you · 0 finished', 'IB the summary reads 0 waiting · 0 finished', (await summary()).text)
    check((await I('inbox-answer-order').count()) === 0 && (await I('inbox-chips').count()) === 0, 'IB no "Answer in order" button or chips while the Inbox is empty')

    // ---- Two projects, each with a run that asks for permission.
    const projA = await createProject(ip, { path: ibRepoA, name: IB_A })
    const projB = await createProject(ip, { path: ibRepoB, name: IB_B })
    check(!!projA && !!projB, 'IB two projects created')
    const runA = await startViaIpc(projA.id, 'Inline task')
    await sleep(700)
    const runB = await startViaIpc(projB.id, 'Compound [mock:fatigue]')
    await ibUntil(async () => (await badge()) >= 2, 25_000)
    await openInbox()
    await waitRows().first().waitFor({ timeout: 15_000 })
    await sleep(500)

    // ---- Count consistency: the sidebar badge, the Needs-you popover and the Inbox are one number.
    const n = await waitRows().count()
    const s0 = await summary()
    check(n >= 2 && n === (await badge()) && n === (await bell()) && n === s0.waiting, 'IB the Inbox rows, its summary, the sidebar badge and the Needs-you row are the same number', `${n} rows / badge ${await badge()} / bell ${await bell()} / summary ${s0.waiting}`)
    check(/^\d+ waiting on you · 0 finished$/.test(s0.text), 'IB the summary reads "N waiting on you · M finished"', s0.text)

    // ---- Oldest first: the run that started first is first.
    const ids0 = await rowIds()
    check(ids0[0]?.startsWith(`w:${runA.id}/`) && ids0.slice(1).some((id) => id?.startsWith(`w:${runB.id}/`)), 'IB the oldest waiting decision is listed first', JSON.stringify(ids0))
    check((await selectedId()) === ids0[0], 'IB the first item is selected on arrival', String(await selectedId()))
    check(!(await focusIn('[data-testid=inbox-detail-pane]')), 'IB arriving on the Inbox does not move focus into the first card', JSON.stringify(await ip.evaluate(() => document.activeElement?.getAttribute('data-testid'))))

    // ---- The selected decision is the run view's own card.
    const card = ip.locator('[data-testid=inbox-detail-pane] article.decision-card[data-kind=permission]')
    check((await card.count()) === 1, 'IB the selected permission is the real decision card', String(await card.count()))
    check((await card.locator('.decision-footer .btn.primary').count()) === 1, 'IB the card has its own primary button')
    const rowsNamed = await rows().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
    check(rowsNamed.every((t) => /^(Permission|Question|Rule|Proposal|Review|New tool|Plan|Team files|Finished|Failed): /.test(t) && /run started/.test(t)), 'IB each row is named with its kind, ask, who, project and age', JSON.stringify(rowsNamed.slice(0, 2)))
    await ip.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
    await launched.shot('waiting-dark-1440')

    // ---- Click selects and keeps focus on the list.
    await rows().nth(1).click()
    check((await selectedId()) === ids0[1], 'IB clicking a row selects it', String(await selectedId()))
    check((await focusedRowId()) === ids0[1], 'IB the clicked row keeps focus (the card does not take it)', String(await focusedRowId()))
    check((await ip.locator('[data-testid=inbox-row][aria-current=true]').count()) === 1 && (await ip.locator('[data-testid=inbox-row][tabindex="0"]').count()) === 1, 'IB exactly one row is current and one is a Tab stop')

    // ---- J / K / Home / End.
    await rows().first().click()
    await sleep(200)
    await ip.keyboard.press('j')
    await sleep(200)
    check((await selectedId()) === ids0[1], 'IB J from the first item selects the second', String(await selectedId()))
    check((await focusedRowId()) === ids0[1], 'IB J keeps focus on the selected row', String(await focusedRowId()))
    await ip.keyboard.press('k')
    check((await selectedId()) === ids0[0], 'IB K moves back up', String(await selectedId()))
    await ip.keyboard.press('k')
    check((await selectedId()) === ids0[0], 'IB K at the top stays on the first item')
    await ip.keyboard.press('End')
    check((await selectedId()) === ids0[ids0.length - 1], 'IB End selects the last item', String(await selectedId()))
    await ip.keyboard.press('Home')
    check((await selectedId()) === ids0[0], 'IB Home selects the first item')
    await ip.keyboard.press('ArrowDown')
    check((await selectedId()) === ids0[1], 'IB ArrowDown also moves down')
    await ip.keyboard.press('ArrowUp')

    // ---- No key handling while typing in a field.
    const field = ip.locator('[data-testid=inbox-detail-pane] textarea, [data-testid=inbox-detail-pane] input[type=text]').first()
    if (await field.count()) {
      const before = await selectedId()
      await field.focus()
      await ip.keyboard.type('jkjk')
      check((await selectedId()) === before && (await field.inputValue()) === 'jkjk', 'IB J and K typed into a field do not move the selection', `${before} -> ${await selectedId()}`)
      await field.fill('')
      await rows().first().focus()
    } else log('SKIP typing guard: the selected card has no text field')

    // ---- Enter goes to the main action, Esc goes back to the list.
    await rows().first().focus()
    await ip.keyboard.press('Enter')
    check(await focusIn('[data-testid=inbox-detail-pane]'), 'IB Enter on a row moves focus into the card', JSON.stringify(await ip.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120))))
    check((await selectedId()) === ids0[0] && (await waitRows().count()) === n, 'IB Enter on a row answers nothing', `${await waitRows().count()} of ${n} left`)
    await ip.keyboard.press('j')
    check((await selectedId()) === ids0[0], 'IB J does nothing while focus is inside the card')
    await ip.keyboard.press('Escape')
    await sleep(200)
    check((await focusedRowId()) === ids0[0], 'IB Esc inside the card goes back to the selected row', String(await focusedRowId()))
    check((await waitRows().count()) === n, 'IB Esc answers nothing (a decline is always a visible button)')

    // ---- Chips and the project filter.
    const chipTexts = await I('inbox-chips').locator('button').evaluateAll((els) => els.map((e) => ({ label: (e.textContent ?? '').replace(/\s+/g, ' ').trim(), pressed: e.getAttribute('aria-pressed') })))
    check(chipTexts[0]?.pressed === 'true' && /^All\s*\d+$/.test(chipTexts[0].label) && chipTexts.some((c) => /^Permissions\s*\d+$/.test(c.label)) && !chipTexts.some((c) => /^Finished/.test(c.label)), 'IB the chips are a pressed group: All plus only the kinds present', JSON.stringify(chipTexts))
    await I('inbox-chip-permission').click()
    check((await I('inbox-chip-permission').getAttribute('aria-pressed')) === 'true' && (await I('inbox-chip-all').getAttribute('aria-pressed')) === 'false', 'IB a chip toggles aria-pressed')
    check((await rows().count()) === n, 'IB the Permissions chip keeps the permission rows')
    await I('inbox-chip-all').click()
    const select = ip.getByRole('combobox', { name: 'Project' })
    check((await select.count()) === 1, 'IB a project filter appears when two projects have items')
    const bCount = (await rowIds()).filter((id) => id?.startsWith(`w:${runB.id}/`)).length
    await select.selectOption({ label: `${IB_B} (${bCount})` })
    const onlyB = await rowIds()
    check(onlyB.length >= 1 && onlyB.every((id) => id?.startsWith(`w:${runB.id}/`)), 'IB the project filter keeps only that project\'s items', JSON.stringify(onlyB))
    check((await summary()).waiting === n, 'IB the summary and the badge ignore the filters', String((await summary()).waiting))
    await select.selectOption('all')
    check((await rows().count()) === n, 'IB "All projects" brings every item back')

    // ---- Answer in order: the oldest item, with focus on its main action.
    await rows().last().click()
    await I('inbox-answer-order').click()
    await sleep(500)
    check((await selectedId()) === ids0[0], 'IB "Answer in order" selects the oldest waiting item', String(await selectedId()))
    check(await focusIn('[data-testid=inbox-detail-pane]'), 'IB "Answer in order" moves focus into the card', JSON.stringify(await ip.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120))))

    // ---- Theme and size sweep on the filled Inbox.
    await ip.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
    for (const [theme, w, h] of [['dark', 1024, 640], ['light', 1440, 900], ['light', 1024, 640]]) {
      await setTheme(theme)
      await setSize(w, h)
      check(!(await overflowX()), `IB ${theme} ${w}x${h}: no horizontal overflow`)
      check((await I('inbox-detail-pane').isVisible()) && (await rows().first().isVisible()), `IB ${theme} ${w}x${h}: the list and the card are both on screen or reachable`)
      await launched.shot(`waiting-${theme}-${w}`)
    }
    await setTheme('dark')
    await setSize(1440, 900)

    // ---- Answer one in the Inbox: the next item is selected and announced.
    await rows().first().click()
    const idsBefore = await rowIds()
    const bellBefore = await bell()
    await card.locator('.decision-footer .btn.primary').click()
    await ibUntil(async () => (await waitRows().count()) === n - 1, 15_000)
    await sleep(500)
    const idsAfter = await rowIds()
    check(idsAfter.length === n - 1 && !idsAfter.includes(idsBefore[0]), 'IB answering removes the item from the list', JSON.stringify(idsAfter))
    check((await badge()) === n - 1 && (await bell()) === bellBefore - 1 && (await summary()).waiting === n - 1, 'IB the badge, the Needs-you row and the summary all drop by one', `${await badge()} / ${await bell()} / ${(await summary()).waiting}`)
    check((await selectedId()) === idsAfter[0], 'IB the next item is selected after an answer', String(await selectedId()))
    check(/^Answered\. Next: .+ \d+ of \d+\.$/.test(await live()), 'IB the live region says what was answered and what is next', await live())
    const afterFocus = await ip.evaluate(() => ({ body: document.activeElement === document.body, inView: !!document.activeElement?.closest?.('[data-testid=inbox-view]') }))
    check(afterFocus.inView && !afterFocus.body, 'IB focus stays in the Inbox after an answer (not on the body)', JSON.stringify(afterFocus))
    check((await ip.locator('[data-testid=inbox-detail-pane] article.decision-card').count()) === 1, 'IB the next decision is shown as its card')

    // ---- A failed run is news until it is cleared or marked read.
    const fail1 = await startViaIpc(projA.id, 'Break it [mock:model-switch-error]')
    const failed1 = await ibUntil(async () => (await runStatus(fail1.id)) === 'error', 25_000)
    check(!!failed1, 'IB the [mock:model-switch-error] run ends in error')
    await ibUntil(async () => (await ip.locator('[data-testid=inbox-row][data-group=finished]').count()) === 1, 15_000)
    const fin = ip.locator('[data-testid=inbox-row][data-group=finished]')
    check((await fin.count()) === 1 && (await fin.first().getAttribute('data-kind')) === 'failed', 'IB a run that ended in an error is listed under "Finished since you last looked"', String(await fin.count()))
    const s1 = await summary()
    check(s1.finished === 1 && s1.waiting === n - 1 && /1 finished$/.test(s1.text), 'IB the summary counts it as finished, not waiting', s1.text)
    check((await badge()) === n - 1, 'IB a finished run does not change the sidebar badge', String(await badge()))
    check((await I('inbox-section-finished').locator('h2').innerText()).includes('Finished since you last looked'), 'IB the finished section is named')
    await I('inbox-chip-finished').click()
    check((await rows().count()) === 1 && (await ip.locator('[data-testid=inbox-section-waiting]').count()) === 0, 'IB the Finished chip lists only finished runs')
    await I('inbox-chip-all').click()
    await fin.first().click()
    check((await I('inbox-finished-open').count()) === 1 && (await I('inbox-finished-clear').count()) === 1 && /Failed/.test(ibClean(await I('inbox-detail').innerText())), 'IB a finished run shows what happened with Open run and Clear', ibClean(await I('inbox-detail').innerText()).slice(0, 160))
    await launched.shot('finished-dark-1440')
    await I('inbox-finished-clear').click()
    await ibUntil(async () => (await fin.count()) === 0, 8000)
    check((await fin.count()) === 0 && (await summary()).finished === 0, 'IB Clear removes the finished run for good')
    check(/^Cleared\./.test(await live()), 'IB Clear is announced', await live())
    // Marked read: a second failed run, then "Mark all read".
    const fail2 = await startViaIpc(projB.id, 'Break it again [mock:model-switch-error]')
    await ibUntil(async () => (await runStatus(fail2.id)) === 'error', 25_000)
    await ibUntil(async () => (await fin.count()) === 1, 15_000)
    check((await fin.count()) === 1, 'IB a second failed run is listed')
    await I('inbox-mark-read').click()
    await ibUntil(async () => (await fin.count()) === 0, 8000)
    check((await fin.count()) === 0 && (await I('inbox-mark-read').count()) === 0, 'IB "Mark all read" empties the finished section')
    // The finished list survives leaving and coming back until read (a third run, then Home and back).
    const fail3 = await startViaIpc(projA.id, 'Break it a third time [mock:model-switch-error]')
    await ibUntil(async () => (await runStatus(fail3.id)) === 'error', 25_000)
    await ibUntil(async () => (await fin.count()) === 1, 15_000)
    await I('nav-home').click()
    await sleep(500)
    await openInbox()
    check((await fin.count()) === 1, 'IB an unread finished run is still there after leaving the Inbox and coming back')
    await fin.first().click()
    await I('inbox-finished-open').click()
    await sleep(1200)
    check((await I('inbox-view').count()) === 0, 'IB Open run leaves the Inbox for the run')
    await openInbox()
    check((await fin.count()) === 0, 'IB opening a finished run marks it read')

    // ---- Answer everything left: the empty state.
    // The mock's second card arrives a beat after the first is answered, so stop only after the list stayed empty a while.
    let quiet = 0
    for (let i = 0; i < 24 && quiet < 3; i++) {
      const before = await waitRows().count()
      if (before === 0) {
        quiet++
        await sleep(700)
        continue
      }
      quiet = 0
      const primary = ip.locator('[data-testid=inbox-detail-pane] .decision-footer .btn.primary, [data-testid=inbox-detail-pane] .inbox-main').first()
      if (!(await primary.count())) break
      await primary.click()
      await ibUntil(async () => (await waitRows().count()) < before, 12_000)
    }
    await ibUntil(async () => (await I('inbox-empty').count()) === 1, 10_000)
    check((await waitRows().count()) === 0, 'IB every waiting decision was answered from the Inbox')
    check((await badge()) === 0 && (await I('nav-inbox-count').count()) === 0, 'IB the sidebar badge is gone with the last decision')
    check((await I('inbox-empty').count()) === 1, 'IB the empty state returns when the last decision is answered')
    await launched.shot('empty-dark-1440')
    await setTheme('light')
    await launched.shot('empty-light-1440')
    await setSize(1024, 640)
    check(!(await overflowX()), 'IB light 1024x640: the empty state has no horizontal overflow')
    await launched.shot('empty-light-1024')
    await setTheme('dark')
    await launched.shot('empty-dark-1024')
    await setSize(1440, 900)
    await I('inbox-see-running').click()
    await I('dashboard').waitFor({ timeout: 10_000 }).catch(() => {})
    check((await I('dashboard').count()) === 1 && (await I('inbox-view').count()) === 0, 'IB "See what is running" goes to Home')
    check(ipErrors.length === 0, 'IB no page errors', ipErrors.join(' | ').slice(0, 300))

    for (const name of [IB_A, IB_B]) {
      const left = await deleteProject(ip, name)
      check(left === 0, `IB project "${name}" deleted`, `${left} tile(s) left`)
    }
  } catch (e) {
    check(false, 'inbox checks ran to the end', e.stack ?? e.message)
  } finally {
    await ibApp?.close().catch(() => {})
    removeFixture(ibRepoA)
    removeFixture(ibRepoB)
    finish('inbox')
  }
}
