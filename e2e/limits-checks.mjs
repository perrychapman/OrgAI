// Shared checks for the Spending limits page and the empty engagement Home (UI overhaul H2 and M12). Token-free (mock
// adapter); called from maintenance.mjs so it keeps its own project, data dir and cleanup. Not a script of its own.
import { check, deleteProject, findProject, gotoProjects, openProject, openProjectForm, pickSetup, projectTab, sleep } from './lib.mjs'

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

/** Spending limits (project Settings): every limit at rest, saved and cleared, spent figures, at-cap choice, warning range. */
export async function limitsChecks({ app, page, shot, name }) {
  const tag = 'limits'
  const reopen = async () => {
    await projectTab(page, 'Settings').click()
    await page.getByRole('tab', { name: 'Spending limits', exact: true }).click()
    await page.locator('.settings-pane-title').waitFor({ timeout: 10_000 })
    await sleep(500)
  }
  const reload = async () => {
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 30_000 })
    await openProject(page, name)
    await reopen()
  }
  const closeAdvanced = () =>
    page.evaluate(() => {
      const el = document.querySelector('details[data-testid=settings-advanced][data-pane="project-limits"]')
      if (el) el.open = false
    })
  const input = (k) => page.locator(`[data-testid=limit-${k}-input]`)
  const commit = async (k, v) => {
    await input(k).fill(v)
    await input(k).press('Enter')
    await sleep(800)
  }
  const proj = () => findProject(page, name)

  await reopen()
  await closeAdvanced()
  await sleep(200)

  // At rest, with Advanced closed: every limit a person sets is on the page.
  const visible = async (sel) => page.locator(sel).first().isVisible().catch(() => false)
  for (const [sel, what] of [
    ['[data-testid=limit-run-input]', 'the per-run limit'],
    ['[data-testid=limit-day-input]', 'the day limit'],
    ['[data-testid=limit-month-input]', 'the month limit'],
    ['[data-testid=agents-per-run-switch]', 'the most-agents switch'],
    ['[data-testid=ask-stronger-switch]', 'the ask-before-stronger-model switch']
  ]) {
    check(await visible(sel), `${tag}: ${what} is visible at rest, Advanced closed`)
  }
  check(await page.getByRole('radiogroup', { name: 'When a limit is reached' }).isVisible(), `${tag}: "When a limit is reached" is visible at rest`)
  check(await page.getByLabel('Warn me at', { exact: true }).isVisible(), `${tag}: "Warn me at" is visible at rest`)
  const panel = clean(await page.locator('[role=tabpanel]').innerText())
  check(!/\$\d+\.\d{5}/.test(panel), `${tag}: no five-decimal money figure on the page`, panel.slice(0, 200))
  check(/Spent in \w+: |Nothing spent in \w+ yet|Loading this month/.test(panel), `${tag}: the hero says what was spent this month`, panel.slice(0, 120))
  check(/does not start while a day or month limit is set/.test(panel), `${tag}: the page says why an unpriced run cannot be limited`)

  // Spent so far: a figure or a stated unknown, never a bare $0.
  await page.waitForFunction(() => !/Measuring spent so far/.test(document.querySelector('[role=tabpanel]')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {})
  const rowText = clean(await page.locator('[role=tabpanel]').innerText())
  const spentLines = [...rowText.matchAll(/Spent so far: ([^.]*(?:\.\d+)?[^.]*)\./g)].map((m) => m[1])
  check(spentLines.length === 2 && spentLines.every((s) => /^(at least )?(\$\d[\d,]*\.\d\d|<\$0\.01)$|^unknown$/.test(s)), `${tag}: "Spent so far" is a two-decimal figure or "unknown" for day and month`, JSON.stringify(spentLines))
  check(!/Spent so far: \$0(?!\.\d\d)/.test(rowText), `${tag}: spent so far never shows a bare $0`)

  // Day and month limits save, survive a reload, and clear on blank or 0.
  await commit('day', '5')
  await commit('month', '20.5')
  let p = await proj()
  check(p?.maxDailyUsd === 5 && p?.maxMonthlyUsd === 20.5, `${tag}: day and month limits save to the project`, JSON.stringify({ d: p?.maxDailyUsd, m: p?.maxMonthlyUsd }))
  await reload()
  check((await input('day').inputValue()) === '5' && (await input('month').inputValue()) === '20.5', `${tag}: both limits are still shown after a reload`)
  await commit('run', '3')
  check((await proj())?.maxBudgetUsd === 3, `${tag}: the per-run limit saves`)
  await commit('run', '0')
  check((await proj())?.maxBudgetUsd === undefined, `${tag}: 0 clears the per-run limit`)
  await commit('day', '0')
  await commit('month', '')
  p = await proj()
  check(p?.maxDailyUsd === undefined && p?.maxMonthlyUsd === undefined, `${tag}: 0 and blank clear the day and month limits`, JSON.stringify({ d: p?.maxDailyUsd, m: p?.maxMonthlyUsd }))
  await commit('day', '-4')
  check((await proj())?.maxDailyUsd === undefined, `${tag}: a negative limit is not saved`)

  // What happens at a limit persists.
  const group = page.getByRole('radiogroup', { name: 'When a limit is reached' })
  await group.locator('label', { hasText: 'Stop the run' }).click()
  await sleep(800)
  check((await proj())?.onSpendLimit === 'stop', `${tag}: "Stop the run" saves`)
  await reload()
  check(await group.locator('input[type=radio]:checked').evaluate((el) => el.closest('label')?.textContent?.includes('Stop the run') ?? false), `${tag}: "Stop the run" is still chosen after a reload`)
  await group.locator('label', { hasText: 'Pause and ask me' }).click()
  await sleep(800)
  check(['pause', undefined].includes((await proj())?.onSpendLimit), `${tag}: "Pause and ask me" saves`)

  // Warn me at accepts only its allowed choices.
  const warn = page.getByLabel('Warn me at', { exact: true })
  const opts = await warn.locator('option').evaluateAll((os) => os.map((o) => o.value))
  check(opts.join(',') === 'off,50,80,90', `${tag}: "Warn me at" offers only off, 50, 80 and 90`, opts.join(','))
  await warn.selectOption('80')
  await sleep(800)
  const warnNow = await page.evaluate(async () => (await window.orgai.settings.get()).spendWarnPercent)
  check(warnNow === 80, `${tag}: "Warn me at" 80 saves`, String(warnNow))
  await warn.selectOption('off')
  await sleep(800)
  const warnOff = await page.evaluate(async () => (await window.orgai.settings.get()).spendWarnPercent ?? null)
  check(warnOff === null, `${tag}: "Warn me at" off clears it`, String(warnOff))

  // A limit lowered below what is already spent: main keeps the project as saved, refuses new runs and pauses or stops
  // live ones; the page says so. Needs some spend, which a fresh mock project does not have: checked only when there is some.
  const spend = await page.evaluate((id) => window.orgai.runInsights.projectSpend(id), (await proj()).id)
  if (spend.day.spentUsd > 0) {
    await commit('day', '0.01')
    const t = clean(await page.locator('[role=tabpanel]').innerText())
    check(/Already reached: new runs will not start until the day ends/.test(t), `${tag}: a day limit below what is spent says it is already reached`)
    await commit('day', '')
  } else {
    check(true, `${tag}: no spend yet on the fixture, the already-reached sentence is covered by limitCopy.test.ts instead`)
  }

  await shot('limits-at-rest')
  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    for (const theme of ['dark', 'light']) {
      await setSize(app, page, w, h)
      await setTheme(page, theme)
      await shot(`limits-${w}x${h}-${theme}`)
    }
  }
  await setSize(app, page, 1600, 1000)
  await setTheme(page, 'dark')
}

/** Empty engagement Home: first steps with real actions, neutral wording, no hole at both sizes and themes. */
export async function engagementEmptyChecks({ app, page, shot, name, dir }) {
  const tag = 'engagement first use'
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Working folder', { exact: true }).fill(dir)
  await pickSetup(form, true)
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  check(!!(await findProject(page, name)), `${tag}: the engagement was created`)

  const openHome = async () => {
    await page.locator('[data-testid=tab-home]').click()
    await page.waitForSelector('[data-testid=engagement-home]', { timeout: 10_000 })
    await sleep(600)
  }
  await openHome()
  const first = page.locator('[data-testid=eng-first-steps]')
  check((await first.count()) === 1, `${tag}: an engagement with no runs shows the first steps`)
  const text = clean(await first.innerText())
  check(/An engagement is an ongoing piece of work/.test(text), `${tag}: one plain line says what an engagement is`, text.slice(0, 160))
  check(!/\b(client|sponsor|deliverable|stage|phase|milestone)s?\b/i.test(text), `${tag}: neutral wording`, text)
  for (const id of ['start', 'notes', 'folders', 'knowledge']) check((await page.locator(`[data-testid=eng-first-${id}]`).count()) === 1, `${tag}: the "${id}" step is a button`)
  const heading = await page.evaluate(() => {
    const h = document.querySelector('[data-testid=eng-first-steps] h2')
    const lead = document.querySelector('.eng-first-lead')
    return { h: h ? getComputedStyle(h).fontFamily : '', lead: lead ? getComputedStyle(lead).fontFamily : '' }
  })
  check(/fraunces|georgia|palatino|iowan|serif/i.test(heading.lead.replace(/sans-serif/gi, '')), `${tag}: the lead line is set in the serif face`, heading.lead)

  // No hole at either size in either theme: the first-steps panel starts at the page's left edge and sits under the start box.
  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    await setSize(app, page, w, h)
    for (const theme of ['dark', 'light']) {
      await setTheme(page, theme)
      const g = await page.evaluate(() => {
        const q = (s) => document.querySelector(s)?.getBoundingClientRect()
        const hero = q('.eng-hero')
        const start = q('[data-testid=eng-start]')
        const firstBox = q('[data-testid=eng-first-steps]')
        const side = q('.eng-col-side')
        const scroll = document.querySelector('.home-scroll')
        if (!hero || !start || !firstBox || !side || !scroll) return null
        return {
          leftGap: Math.round(firstBox.left - hero.left),
          topGap: Math.round(firstBox.top - start.bottom),
          sideBesideOrBelow: side.left >= firstBox.right - 1 || side.top >= firstBox.bottom - 1,
          overflowX: scroll.scrollWidth > scroll.clientWidth + 1
        }
      })
      check(!!g && Math.abs(g.leftGap) <= 2 && g.topGap >= 0 && g.topGap <= 40 && !g.overflowX && g.sideBesideOrBelow, `${tag}: no empty hole at ${w}x${h} ${theme}`, JSON.stringify(g))
      await shot(`engagement-first-${w}x${h}-${theme}`)
    }
  }
  await setSize(app, page, 1600, 1000)
  await setTheme(page, 'dark')

  // The steps are real actions and reachable by keyboard.
  await page.locator('[data-testid=eng-first-start]').click()
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'eng-start-text'), `${tag}: "Go to the box" focuses the start box`)
  await page.locator('[data-testid=eng-first-knowledge]').focus()
  await page.keyboard.press('Enter')
  await sleep(600)
  check((await page.locator('[data-testid=engagement-home]').count()) === 0, `${tag}: "Open Knowledge" leaves Home for Knowledge`)
  await openProject(page, name).catch(() => {})
  await page.locator('[data-testid=tab-home]').click()
  await sleep(500)
  await page.locator('[data-testid=eng-first-notes]').click()
  await sleep(800)
  check((await page.locator('[data-testid=engagement-home]').count()) === 0 && /Context notes/i.test(clean(await page.locator('[role=tabpanel]').innerText().catch(() => ''))), `${tag}: "Add notes" opens the Context notes settings`)
  await deleteProject(page, name)
}
