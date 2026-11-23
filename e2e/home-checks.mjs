// Shared checks for the Home tab of a stored project (docs/design/ui-overhaul/impl-project-home.md). Token-free (mock adapter);
// called from per-project.mjs (code Home) and engagement.mjs / engagement2.mjs (engagement Home) so each script keeps its own
// project, data dir and cleanup. Not a script of its own.
import { check, sleep } from './lib.mjs'

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

async function setSize(app, page, w, h) {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}
async function setTheme(page, theme) {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(400)
}
const openHome = async (page) => {
  await page.locator('[data-testid=tab-home]').click()
  await sleep(500)
}
const selectedTab = (page) => page.locator('[role=tablist][aria-label="Project sections"] [role=tab][aria-selected=true]').first().innerText()

/** The Home page fits its window at this size/theme: no sideways scroll, every section inside the page. */
async function geometry(page, root, what) {
  const g = await page.evaluate((sel) => {
    const r = document.querySelector(sel)
    const scroll = r?.querySelector('.home-scroll')
    if (!r || !scroll) return null
    const box = scroll.getBoundingClientRect()
    const out = [...r.querySelectorAll('.home-section, .eng-hero')].filter((e) => {
      const b = e.getBoundingClientRect()
      return b.width > 0 && (b.left < box.left - 1 || b.right > box.right + 1)
    })
    return { overflowX: scroll.scrollWidth > scroll.clientWidth + 1, outside: out.length, pageScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1 }
  }, root)
  check(!!g && !g.overflowX && g.outside === 0 && !g.pageScroll, `${what}: Home fits (no sideways scroll, nothing outside, window does not scroll)`, JSON.stringify(g))
}

/** Tab until `selector` has focus; true when it got there in `max` presses. */
async function tabTo(page, selector, max = 14) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return true
  }
  return false
}

export async function codeHomeChecks({ app, page, shot, pid, name, folderName }) {
  const tag = 'code home'
  const nav = () => page.locator(`.sidebar [data-testid=nav-project][data-name="${name.replace(/"/g, '\\"')}"]`).first()
  // Not for the assistants.
  const helper = page.locator('[data-testid=nav-assistant]').first()
  if (await helper.count()) {
    await helper.click()
    await sleep(600)
    check((await page.locator('[data-testid=tab-home]').count()) === 0, `${tag}: no Home tab for an assistant (Chat and helpers)`)
  }
  await nav().click()
  await sleep(500)
  check((await page.locator('[data-testid=tab-home]').count()) === 1, `${tag}: a stored project has a Home tab`)
  await openHome(page)
  check((await page.locator('[data-testid=project-home]').count()) === 1 && (await page.locator('[data-testid=engagement-home]').count()) === 0, `${tag}: a code project opens ProjectHome, not EngagementHome`)
  check((await selectedTab(page)).trim() === 'Home', `${tag}: the Home tab is the selected tab`)

  // Look: workbench (mono lowercase labels), not serif.
  const look = await page.evaluate(() => {
    const h = document.querySelector('[data-testid=home-new-run] h2')
    const t = document.querySelector('[data-testid=home-team] h2')
    return { label: h?.textContent, font: h ? getComputedStyle(h).fontFamily : '', teamFont: t ? getComputedStyle(t).fontFamily : '', teamText: t?.textContent }
  })
  check(look.label === '> new run' && /mono|consolas|cascadia/i.test(look.font), `${tag}: section labels are monospace and lowercase`, JSON.stringify(look))
  check(look.teamText === 'team' && !/serif|fraunces|georgia/i.test(look.teamFont.replace(/sans-serif/gi, '')), `${tag}: no serif on the code Home`, look.teamFont)

  // Repo strip: the folder is always known.
  const strip = clean(await page.locator('[data-testid=home-repo]').innerText())
  check(strip.includes('folder') && strip.includes(folderName), `${tag}: the repo strip names the folder`, strip)

  // Team section from the real chart, with plain permission words; Edit opens Team.
  const teamLine = clean(await page.locator('[data-testid=home-team-line]').innerText())
  check(/^\d+ roles? · .+/.test(teamLine), `${tag}: team line reads "N roles · <permission words>"`, teamLine)

  // To-dos: only with open items; Run fills the New run box (never sends).
  check((await page.locator('[data-testid=home-todos]').count()) === 0, `${tag}: no to-do section while the list is empty`)
  await page.evaluate(async (id) => {
    await window.orgai.todos.save({ scope: { kind: 'project', projectId: id }, title: 'Upgrade the test runner' })
    await window.orgai.todos.save({ scope: { kind: 'project', projectId: id }, title: 'Add an index on notes.updated_at' })
  }, pid)
  await page.locator('[data-testid=home-todos]').waitFor({ state: 'visible' })
  check((await page.locator('[data-testid=home-todo-run]').count()) === 2, `${tag}: one Run button per open to-do`)
  await page.locator('[data-testid=home-todo-run]').first().click()
  const composer = page.locator('.composer textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  check(/^To-do:/.test(await composer.inputValue()), `${tag}: a to-do's Run fills the New run box`, await composer.inputValue())
  check((await page.locator('[data-testid=home-todos]').count()) === 0, `${tag}: the New run page replaced Home`)
  await openHome(page)

  // The new run box: chips and Start run open New run with the text; Ctrl+Enter does the same; nothing is sent.
  const runsBefore = await page.evaluate(async (id) => (await window.orgai.runs.list(id)).length, pid)
  await page.locator('[data-testid=home-quick]').first().click()
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  const v1 = await composer.inputValue()
  check(v1.includes('Fix a failing test') && /^To-do:/.test(v1), `${tag}: a quick chip adds its text to the draft and keeps the earlier one`, v1)
  await openHome(page)
  await page.locator('[data-testid=home-new-run-text]').fill('Plan the pagination work')
  await page.locator('[data-testid=home-new-run-text]').press('Control+Enter')
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  check((await composer.inputValue()).includes('Plan the pagination work'), `${tag}: Ctrl+Enter in the box opens New run with the text`)
  const runsAfter = await page.evaluate(async (id) => (await window.orgai.runs.list(id)).length, pid)
  check(runsAfter === runsBefore, `${tag}: opening New run from Home starts nothing`)
  await openHome(page)

  // Keyboard: the box, its chips and Start run are reachable in order.
  await page.locator('[data-testid=home-new-run-text]').focus()
  check(await tabTo(page, '[data-testid=home-quick]', 2), `${tag}: Tab moves from the box to the chips`)
  check(await tabTo(page, '[data-testid=home-start-run]', 4), `${tag}: Start run is reachable by keyboard`)
  await page.keyboard.press('Enter')
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  check(true, `${tag}: Enter on Start run opens New run`)
  await openHome(page)

  // Team Edit -> Team tab; To-dos link -> To-dos tab.
  await page.locator('[data-testid=home-team-edit]').click()
  await page.locator('.editor [data-testid=team-panel-tabs]').waitFor({ state: 'visible', timeout: 10_000 })
  check(/^Team/.test((await selectedTab(page)).trim()), `${tag}: the team's Edit opens the Team tab`)
  await openHome(page)
  await page.locator('[data-testid=home-todos-open]').click()
  await page.locator('[data-testid=todos-view], [data-testid=todo-list], .todos-view').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  check(/^To-dos/.test((await selectedTab(page)).trim()), `${tag}: All to-dos opens the To-dos tab`)
  await openHome(page)

  // Schedules: only this project's, with the last result; the link opens Schedules.
  check((await page.locator('[data-testid=home-schedules]').count()) === 0, `${tag}: no schedules section without a schedule`)
  await page.evaluate(
    (id) => window.orgai.schedules.save({ name: 'Nightly dependency check', prompt: 'Check dependencies', target: { kind: 'team', projectId: id }, timing: { kind: 'daily', time: '02:00' } }),
    pid
  )
  await page.locator('[data-testid=home-schedules]').waitFor({ state: 'visible' })
  check(clean(await page.locator('[data-testid=home-schedules]').innerText()).includes('Nightly dependency check'), `${tag}: the project's schedule is listed`)
  await page.locator('[data-testid=home-schedules-open]').click()
  await page.locator('[data-testid=schedules-view]').waitFor({ state: 'visible', timeout: 10_000 })
  check(true, `${tag}: the Schedules link opens the Schedules page`)
  await nav().click()
  await sleep(400)
  await openHome(page)

  // Running now: a live run shows, with the agent strip as one image with a text alternative; Open opens it.
  check((await page.locator('[data-testid=home-running]').count()) === 0, `${tag}: nothing running, no "running now"`)
  // A month with no run reads "No spend yet" (projectSpend is the source; never $0 and never the old overview fallback).
  const emptySpend = page.locator('[data-testid=home-spend-figure]')
  const hadRuns = await page.evaluate(async (id) => (await window.orgai.runInsights.projectSpend(id)).month.runs, pid)
  if (hadRuns === 0) {
    check(await emptySpend.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false), `${tag}: an empty month still shows the spend section`)
    check(clean(await emptySpend.innerText()) === 'No spend yet', `${tag}: an empty month reads "No spend yet"`, clean(await emptySpend.innerText().catch(() => '')))
  }
  await page.evaluate((id) => window.orgai.runs.start({ projectId: id, prompt: 'Add response caching' }), pid)
  await page.locator('[data-testid=home-running]').waitFor({ state: 'visible', timeout: 15_000 })
  check(clean(await page.locator('[data-testid=home-running]').innerText()).includes('Add response caching'), `${tag}: "running now" names the run`)
  const marks = page.locator('[data-testid=home-running-marks]')
  if (await marks.count()) check(!!(await marks.getAttribute('aria-label')), `${tag}: the agent strip has a text alternative`)
  await shot('code-home-running')
  await page.locator('[data-testid=home-running-open]').click()
  await page.locator('[data-testid=project-home]').waitFor({ state: 'detached', timeout: 10_000 })
  check(/^Live|^Work/.test((await selectedTab(page)).trim()), `${tag}: Open goes to the run`, await selectedTab(page))
  // Month spend appears once the run is in the usage numbers (a fresh Home reads it at once).
  await openHome(page)
  check(await page.locator('[data-testid=home-spend]').waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false), `${tag}: "spend this month" appears for a project with a run this month`)
  const spendNow = await page.evaluate(async (id) => (await window.orgai.runInsights.projectSpend(id)).month.runs, pid)
  if (spendNow > 0) {
    await page.waitForFunction(() => !/No spend yet/.test(document.querySelector('[data-testid=home-spend-figure]')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => {})
    check(!/No spend yet/.test(await page.locator('[data-testid=home-spend-figure]').innerText()), `${tag}: once a run is counted the month is no longer "No spend yet"`)
  }

  // The schedule's outcome bar is the Schedules page's RunBars: bars with a shape under each, a keyboard readout.
  const schedId = await page.evaluate(async (id) => (await window.orgai.schedules.list()).find((s) => s.target?.projectId === id)?.id, pid)
  if (schedId) {
    await page.evaluate((sid) => window.orgai.schedules.runNow(sid), schedId)
    const bars = page.locator('[data-testid=home-schedules] [data-testid=home-nightly]')
    check(await bars.first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false), `${tag}: the schedule row draws its recent runs`)
    check((await bars.first().locator('.runbars-bar').count()) >= 1 && (await bars.first().locator('.runbars-mark-fill, .runbars-mark-line, .runbars-mark-ring').count()) >= 1, `${tag}: each bar has a shape under it (the outcome is not colour alone)`)
    const chart = bars.first().locator('.runbars-chart')
    check((await chart.getAttribute('tabindex')) === '0' && /Last \d+ runs?/.test((await chart.getAttribute('aria-label')) ?? ''), `${tag}: the bars are one focusable group with every run in its label`)
    await chart.focus()
    await page.keyboard.press('ArrowRight')
    check(await page.waitForFunction(() => /still running|finished|failed|stopped|needed you/.test(document.querySelector('[data-testid=home-nightly-readout]')?.textContent ?? ''), null, { timeout: 5000 }).then(() => true, () => false), `${tag}: Right arrow reads one run in words`)
  }

  // Both sizes and themes.
  for (const [w, h] of [[1440, 900], [1024, 640]]) {
    for (const theme of ['dark', 'light']) {
      await setSize(app, page, w, h)
      await setTheme(page, theme)
      await geometry(page, '[data-testid=project-home]', `${tag} ${w}x${h} ${theme}`)
      await shot(`code-home-${w}-${theme}`)
    }
  }
  await setSize(app, page, 1440, 900)
  await setTheme(page, 'dark')
}

export async function engagementHomeChecks({ app, page, shot, name, client, purpose, refFolderName, expectReadOnlyRef = true }) {
  const tag = 'engagement home'
  check((await page.locator('[data-testid=tab-home]').count()) === 1, `${tag}: the engagement has a Home tab`)
  await openHome(page)
  check((await page.locator('[data-testid=engagement-home]').count()) === 1 && (await page.locator('[data-testid=project-home]').count()) === 0, `${tag}: an engagement opens EngagementHome, not ProjectHome`)
  check((await page.locator('main[data-kind=engagement]').count()) === 1, `${tag}: the page sits under the engagement accent`)

  // Look: serif title, coral accent, no monospace labels.
  const look = await page.evaluate(() => {
    const t = document.querySelector('.eng-hero-title')
    const e = document.querySelector('.eng-eyebrow')
    const s = document.querySelector('[data-testid=eng-start] h2')
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--eng').trim()
    return { titleFont: t ? getComputedStyle(t).fontFamily : '', eyebrow: e?.textContent, eyebrowColor: e ? getComputedStyle(e).color : '', startFont: s ? getComputedStyle(s).fontFamily : '', accent, mono: [...document.querySelectorAll('.eng-home h2')].some((h) => /cascadia|consolas|monospace/i.test(getComputedStyle(h).fontFamily)) }
  })
  check(/fraunces|georgia|palatino|iowan|serif/i.test(look.titleFont.replace(/sans-serif/gi, '')), `${tag}: the title is set in the serif face`, look.titleFont)
  check(/serif|fraunces|georgia/i.test(look.startFont.replace(/sans-serif/gi, '')) && !look.mono, `${tag}: headings are serif, none monospace`, look.startFont)
  check(look.eyebrow === 'What this engagement is for', `${tag}: the first heading is "What this engagement is for"`, look.eyebrow)

  // Neutral wording: no stages, sponsors or deliverables.
  const text = clean(await page.locator('[data-testid=engagement-home]').innerText())
  check(!/\b(stage|phase|sponsor|deliverable|milestone)s?\b/i.test(text), `${tag}: neutral wording (no stage, sponsor or deliverable words)`)

  // Facts and description from real data.
  const facts = clean(await page.locator('[data-testid=eng-facts]').innerText())
  if (client) check(facts.includes('For') && facts.includes(client), `${tag}: the facts name who it is for`, facts)
  check(/Started/.test(facts), `${tag}: the facts give the start date`, facts)
  if (purpose) check(clean(await page.locator('[data-testid=eng-purpose]').innerText()).includes(purpose), `${tag}: the description shows the engagement document`, clean(await page.locator('[data-testid=eng-purpose]').innerText()))

  // Folders: the working folder writes, a reference folder is read only.
  if (refFolderName) {
    const folders = clean(await page.locator('[data-testid=eng-folders]').innerText())
    check(folders.includes(refFolderName) && (!expectReadOnlyRef || /Read only/.test(folders)), `${tag}: Folders lists the reference folder as read only`, folders)
  }

  // Two-mode toggle: aria-pressed group; Ask opens New run in Ask mode with the text; nothing is started.
  const team = page.locator('[data-testid=eng-mode-team]')
  const ask = page.locator('[data-testid=eng-mode-ask]')
  check((await team.getAttribute('aria-pressed')) === 'true' && (await ask.getAttribute('aria-pressed')) === 'false', `${tag}: the toggle starts on the whole team (aria-pressed)`)
  await ask.click()
  check((await ask.getAttribute('aria-pressed')) === 'true' && (await team.getAttribute('aria-pressed')) === 'false', `${tag}: choosing One assistant flips aria-pressed`)
  check(/One assistant/.test(await page.locator('[data-testid=eng-start] .eng-note').innerText()), `${tag}: the note under the box follows the mode`)
  await page.locator('[data-testid=eng-start-text]').fill('What did we agree on the kickoff call?')
  const stickyModes = () => page.evaluate(() => JSON.stringify(Object.keys(localStorage).filter((k) => k.startsWith('orgai.newRunMode.')).sort().map((k) => [k, localStorage.getItem(k)])))
  const stickyBefore = await stickyModes()
  await page.locator('[data-testid=eng-start-button]').click()
  const composer = page.locator('.composer textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  check((await composer.inputValue()).includes('What did we agree on the kickoff call?'), `${tag}: Start opens New run with the text`)
  check(/Ask/.test(await page.locator('[data-testid=new-run-mode]').innerText().catch(() => '')) || (await page.locator('[data-testid=new-run-ask-lead]').count()) === 1, `${tag}: New run opens in Ask mode`)
  // The Ask choice is a one-shot for this opening (store newRunMode): the sticky Team / Ask choice in storage is untouched,
  // right away and after the page has settled, and the one-shot is used up.
  await sleep(600)
  check((await stickyModes()) === stickyBefore, `${tag}: Start from Home leaves the sticky New run mode in storage unchanged`, `${stickyBefore} -> ${await stickyModes()}`)
  await openHome(page)
  await team.click()

  // Keyboard: the toggle, the box and Start are in the tab order.
  await page.locator('[data-testid=eng-mode-team]').focus()
  check(await tabTo(page, '[data-testid=eng-start-text]', 4), `${tag}: Tab goes from the toggle to the box`)
  check(await tabTo(page, '[data-testid=eng-start-button]', 3), `${tag}: Start is reachable by keyboard`)

  // Links to their tabs.
  await page.locator('[data-testid=eng-edit-description]').click()
  await page.locator('#settings-section-engagement-plan, [data-testid=engagement-plan-section]').first().waitFor({ state: 'visible', timeout: 10_000 })
  check(/^Settings/.test((await selectedTab(page)).trim()), `${tag}: "Edit the description" opens the engagement plan in Settings`)
  await openHome(page)
  await page.locator('[data-testid=eng-open-team]').click()
  await page.locator('.editor [data-testid=team-panel-tabs]').waitFor({ state: 'visible', timeout: 10_000 })
  check(/^Team/.test((await selectedTab(page)).trim()), `${tag}: the team's Open opens the Team tab`)
  await openHome(page)
  const know = page.locator('[data-testid=eng-add-knowledge]')
  if (await know.count()) {
    await know.click()
    await page.locator('[data-testid=knowledge-view]').waitFor({ state: 'visible', timeout: 10_000 })
    check(/^Knowledge/.test((await selectedTab(page)).trim()), `${tag}: "Add something you know" opens Knowledge`)
    await openHome(page)
  }
  await page.locator('[data-testid=eng-manage-connections]').click().then(
    async () => {
      await page.locator('.editor [data-testid=team-panel-tabs]').waitFor({ state: 'visible', timeout: 10_000 })
      check(true, `${tag}: Connections > Manage opens where connections are managed (Team catalog)`)
      await openHome(page)
    },
    () => check(true, `${tag}: no connections section without the MCP list (skipped)`)
  )

  // Recent work and Waiting on you: a live run shows; Review jumps to its card.
  const before = await page.locator('[data-testid=eng-run]').count()
  const pid = await page.evaluate(async (n) => (await window.orgai.projects.list()).find((p) => p.name === n)?.id, name)
  await page.evaluate((id) => window.orgai.runs.start({ projectId: id, prompt: 'Draft the plan' }), pid)
  await page.locator('[data-testid=eng-run]').first().waitFor({ state: 'visible', timeout: 15_000 })
  check((await page.locator('[data-testid=eng-run]').count()) === Math.min(4, before + 1), `${tag}: starting a run adds one row to Recent work (${before} before)`)
  check(clean(await page.locator('[data-testid=eng-recent]').innerText()).includes('Draft the plan'), `${tag}: Recent work lists the run`)
  const asked = await page.locator('[data-testid=eng-waiting]').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
  check(asked, `${tag}: a decision of the run shows under "Waiting on you"`)
  await shot('engagement-home-run')
  if (asked) {
    await page.locator('[data-testid=eng-review]').first().click()
    await page.locator('[data-testid=engagement-home]').waitFor({ state: 'detached', timeout: 10_000 })
    check(/^Live|^Work/.test((await selectedTab(page)).trim()), `${tag}: Review opens the run with its decision`, await selectedTab(page))
    await openHome(page)
  }
  await page.locator('[data-testid=eng-run]').first().click()
  await page.locator('[data-testid=engagement-home]').waitFor({ state: 'detached', timeout: 10_000 })
  check(/^Live|^Work/.test((await selectedTab(page)).trim()), `${tag}: a recent run opens the run`, await selectedTab(page))
  await openHome(page)

  for (const [w, h] of [[1440, 900], [1024, 640]]) {
    for (const theme of ['dark', 'light']) {
      await setSize(app, page, w, h)
      await setTheme(page, theme)
      await geometry(page, '[data-testid=engagement-home]', `${tag} ${w}x${h} ${theme}`)
      await shot(`engagement-home-${w}-${theme}`)
    }
  }
  await setSize(app, page, 1440, 900)
  await setTheme(page, 'dark')
  // Leave no live run behind for the script that called us.
  await page.evaluate(async () => {
    for (const r of await window.orgai.runs.listLive()) await window.orgai.runs.stop(r.id)
  })
  await sleep(800)
}
