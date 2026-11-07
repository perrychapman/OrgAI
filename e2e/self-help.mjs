// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Self-help (docs/design/self-help.md): Help > Ask OrgAI about itself
// opens a fresh Chat start page with "How do I " and focus in the field, the example chips fill it, the About pane and
// the shortcuts dialog offer "Ask OrgAI". A `[mock:self-config]` Chat run calls app_reference, open_in_app
// 'app-settings-general-appearance' and propose_app_settings (theme -> light): the app lands on App settings > General
// > Appearance with the visible banner and the announcement, Back to chat returns to the run with the composer
// focused, the App settings card shows Setting / Now / New, Approve makes <html data-theme> light and the transcript
// shows the Done line. A `[mock:self-config-project]` run proposes a $5 cap on a mock project: the card names the
// project, Approve, then Project settings > Limits shows 5. 1024x640 and 1600x1000, dark and light, keyboard steps.
// Needs the mock markers (src/main/runtime/mock.ts on dev at e2deb561); without them the run checks SKIP.
import { check, createProject, finish, launch, log, makeFixtureRepo, openProject, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

const NAME = 'E2E self-help (orgai test)'
const repo = makeFixtureRepo('self-help')

const { app, page, shot } = await launch({ shotPrefix: 'self-help' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(400)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await page.waitForFunction((t) => document.documentElement.getAttribute('data-theme') === t, theme, { timeout: 5000 }).catch(() => {})
}
const menu = (id) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const noPageScroll = () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1 && document.body.scrollHeight <= window.innerHeight + 1)
const activeTestId = () => page.evaluate(() => document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? '')
const startField = () => page.locator('[data-testid=assistant-start-quick] .composer textarea')
const transcriptHas = (needle) => page.evaluate((n) => (document.querySelector('#main-content')?.textContent ?? '').includes(n), needle)
const waitText = async (needle, timeout = 30_000) => {
  await page.waitForFunction((n) => (document.querySelector('#main-content')?.textContent ?? '').includes(n), needle, { timeout }).catch(() => {})
  return transcriptHas(needle)
}

/** Help > Ask OrgAI about itself: a fresh Chat start page with the seed, focus in the field, caret at the end. */
async function askFromMenu(tag) {
  await menu('ask-about-orgai')
  await page.locator('[data-testid=assistant-start-quick]').waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('[data-testid=assistant-start-quick] .composer textarea')?.value === 'How do I ', null, { timeout: 5000 }).catch(() => {})
  check((await startField().inputValue()) === 'How do I ', `Help > Ask OrgAI about itself seeds "How do I " ${tag}`)
  const caret = await page.evaluate(() => {
    const ta = document.activeElement
    return ta instanceof HTMLTextAreaElement ? { focused: !!ta.closest('[data-testid=assistant-start-quick]'), at: ta.selectionStart, len: ta.value.length } : null
  })
  check(!!caret?.focused && caret.at === caret.len, `focus is in the Chat field with the caret after the seed ${tag}`, JSON.stringify(caret))
}

/** Type a prompt on the Chat start page and start the run. */
async function startChat(prompt) {
  await startField().fill(prompt)
  await startField().press('Enter')
  await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
}

/** Push an AppNavigateEvent from main exactly as DesktopHooks.navigate does (channel 'app:navigate'). */
const pushNavigate = (event) =>
  app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0].webContents.send('app:navigate', ev)
  }, event)

/**
 * Token-free router checks without the mock markers: the chat run already on screen asks (its id from the run tab),
 * main's push is simulated. App settings > Appearance, a project's Settings > Limits, a menu path, an unknown project.
 */
async function pushedNavigation(tag, project) {
  const runId = await page.locator('.run-tab-wrap[data-run]').first().getAttribute('data-run').catch(() => null)
  check(!!runId, `a Chat run is on screen to ask ${tag}`)
  if (!runId) return
  await pushNavigate({ surfaceId: 'app-settings-general-appearance', runId, agentLabel: 'Assistant' })
  await page.locator('[data-testid=app-navigate-banner]').waitFor({ timeout: 10_000 }).catch(() => {})
  check(await visible('[data-testid=appearance-section]'), `a pushed navigation opens App settings > General > Appearance ${tag}`)
  check((await text('[data-testid=app-navigate-text]')) === 'Assistant opened App settings › General › Appearance for you.', `the banner names the path ${tag}`, await text('[data-testid=app-navigate-text]'))
  const announced = await page
    .waitForFunction(() => /App settings › General › Appearance/.test(document.querySelector('[data-testid=menu-announce]')?.textContent ?? ''), null, { timeout: 3000 })
    .then(
      () => true,
      () => false
    )
  check(announced, `the navigation is announced in menu-announce ${tag}`)
  check(await page.evaluate(() => /^H[1-4]$/.test(document.activeElement?.tagName ?? '')), `focus lands on the destination heading ${tag}`, await activeTestId())
  check(await noPageScroll(), `App settings with the banner does not scroll the page ${tag}`)
  await shot(`pushed-banner-${tag.replace(/\W+/g, '-')}-dark`)
  await setTheme('light')
  check(await visible('[data-testid=app-navigate-banner]'), `the banner stays through a theme change (light) ${tag}`)
  await shot(`pushed-banner-${tag.replace(/\W+/g, '-')}-light`)
  await setTheme('dark')
  await page.locator('[data-testid=app-navigate-back]').focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement && !!document.activeElement.closest('.composer'), null, { timeout: 5000 }).catch(() => {})
  check(!(await visible('[data-testid=app-navigate-banner]')), `Back to chat clears the banner ${tag}`)
  check(await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement && !!document.activeElement.closest('.composer')), `Back to chat focuses the composer ${tag}`)
  check((await page.locator(`.run-tab-wrap[data-run="${runId}"] .run-tab[aria-selected=true]`).count()) === 1, `Back to chat shows the run that asked ${tag}`)

  if (project) {
    await sleep(2100)
    await pushNavigate({ surfaceId: 'project-settings-limits', projectId: project.id, runId, agentLabel: 'Assistant' })
    await page.locator('[data-testid=app-navigate-banner]').waitFor({ timeout: 10_000 }).catch(() => {})
    check((await text('[data-testid=app-navigate-text]')) === `Assistant opened ${NAME} › Settings › Limits for you.`, `a project place names the project ${tag}`, await text('[data-testid=app-navigate-text]'))
    check((await page.getByRole('tab', { name: 'Limits' }).getAttribute('aria-selected')) === 'true', `the project's Limits pane is shown ${tag}`)
    check(await page.evaluate(() => document.activeElement?.classList.contains('settings-pane-title') ?? false), `focus is on the Limits pane heading ${tag}`, await activeTestId())
    // Leaving the place clears the banner.
    await page.locator('[data-testid=tab-history]').click()
    check(!(await visible('[data-testid=app-navigate-banner]')), `leaving the destination clears the banner ${tag}`)
  }
  await pushNavigate({ surfaceId: 'project-team', projectId: 'p_missing', runId, agentLabel: 'Assistant' })
  await page.locator('[data-testid=app-navigate-banner]').waitFor({ timeout: 5000 }).catch(() => {})
  check(/tried to open a project this window does not have/.test(await text('[data-testid=app-navigate-text]')), `an unknown project is refused with a visible line ${tag}`)
  await page.locator('[data-testid=app-navigate-banner]').getByRole('button', { name: 'Dismiss notice' }).focus()
  await page.keyboard.press('Escape')
  check(!(await visible('[data-testid=app-navigate-banner]')), `Esc in the banner dismisses it ${tag}`)
  await pushNavigate({ surfaceId: 'menu-help', runId, agentLabel: 'Assistant' })
  await page.locator('[data-testid=app-navigate-banner]').waitFor({ timeout: 5000 }).catch(() => {})
  check((await text('[data-testid=app-navigate-text]')) === 'Assistant pointed you to Help in the menu bar.', `a menu place only names the menu path ${tag}`)
  await page.locator('[data-testid=app-navigate-banner]').getByRole('button', { name: 'Dismiss notice' }).click()
}

try {
  // Is the runtime side (the mock markers) in this build? The mock answers app_reference only once it is.
  const runtimeReady = await page.evaluate(async () => {
    try {
      return typeof window.orgai?.app?.reference === 'function' && typeof window.orgai?.onAppNavigate === 'function'
    } catch {
      return false
    }
  })
  check(runtimeReady, 'the preload exposes app.reference and onAppNavigate')

  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')

  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    const tag = `at ${w}x${h}`
    await setSize(w, h)
    await setTheme('dark')

    // ---- entry points ----
    await askFromMenu(`${tag} dark`)
    const chips = await page.locator('[data-testid=chat-example]').evaluateAll((els) => els.map((e) => e.getAttribute('data-example')))
    check(chips.length === 3 && chips.includes('theme'), `the Chat start page shows three example chips ${tag}`, chips.join(','))
    check(await visible('.chat-examples-hint'), `the start page hint names what Chat can answer ${tag}`)
    // Keyboard: the theme chip by Tab order and Enter.
    await page.locator('[data-testid=chat-example][data-example=theme]').focus()
    await page.keyboard.press('Enter')
    await sleep(150)
    check((await startField().inputValue()) === 'Where do I change the theme?', `Enter on a chip fills the instruction ${tag}`)
    check((await activeTestId()) !== 'chat-example', `focus moves to the field after a chip ${tag}`)
    check(await noPageScroll(), `the Chat start page does not scroll the page ${tag}`)
    await shot(`start-${w}x${h}-dark`)

    // ---- [mock:self-config]: locate, open App settings > Appearance, propose theme light ----
    await startChat('[mock:self-config] Where do I change the theme? Make it light.')
    const landed = await page.locator('[data-testid=app-navigate-banner]').waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false
    )
    if (!landed) {
      log(`SKIP (mock markers not merged): the [mock:self-config] navigation, card and Done line ${tag}`)
      await pushedNavigation(tag, project)
      continue
    }
    check(await visible('[data-testid=appearance-section]'), `the app opened App settings > General > Appearance ${tag}`)
    const bannerText = await text('[data-testid=app-navigate-text]')
    check(/opened App settings › General › Appearance for you\./.test(bannerText), `the banner names the path ${tag}`, bannerText)
    check(await visible('[data-testid=app-navigate-back]'), `the banner offers Back to chat ${tag}`)
    const announced = await page.waitForFunction(() => /App settings › General › Appearance/.test(document.querySelector('[data-testid=menu-announce]')?.textContent ?? ''), null, { timeout: 3000 }).then(
      () => true,
      () => false
    )
    check(announced, `the navigation is announced in menu-announce ${tag}`)
    const focusOk = await page.evaluate(() => {
      const a = document.activeElement
      return !!a && !!document.getElementById('main-content')?.contains(a) && /^H[1-4]$/.test(a.tagName)
    })
    check(focusOk, `focus lands on the destination heading, not on an action ${tag}`, await activeTestId())
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Appearance', null, { timeout: 3000 }).catch(() => {})
    const headingText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    check(headingText === 'Appearance', `focus lands on the Appearance section heading, not the pane title ${tag}`, headingText)
    // The asking run has a card open by now: the banner says so and Back reads "Back to chat to decide".
    await page.waitForFunction(() => /A change is waiting for you in the chat\./.test(document.querySelector('[data-testid=app-navigate-banner]')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {})
    check(/A change is waiting for you in the chat\./.test(await text('[data-testid=app-navigate-banner]')), `the banner says a change is waiting ${tag}`, await text('[data-testid=app-navigate-banner]'))
    check((await text('[data-testid=app-navigate-back]')) === 'Back to chat to decide', `Back reads "Back to chat to decide" ${tag}`, await text('[data-testid=app-navigate-back]'))
    await page.keyboard.press('Tab')
    check((await activeTestId()) === 'app-navigate-back', `Tab from the heading reaches Back to chat ${tag}`, await activeTestId())
    await page.locator('[data-testid=appearance-section] .settings-section-title').focus()
    check(await noPageScroll(), `App settings with the banner does not scroll the page ${tag}`)
    await shot(`banner-${w}x${h}-dark`)

    // Back to chat (keyboard): the run again, composer focused, banner gone.
    await page.locator('[data-testid=app-navigate-back]').focus()
    await page.keyboard.press('Enter')
    await page.locator('[data-testid=app-navigate-banner]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    check(!(await visible('[data-testid=app-navigate-banner]')), `Back to chat clears the banner ${tag}`)
    await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement && !!document.activeElement.closest('.composer'), null, { timeout: 5000 }).catch(() => {})
    check(await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement && !!document.activeElement.closest('.composer')), `Back to chat focuses the composer ${tag}`)
    check((await page.locator('.run-tab[aria-selected=true]').count()) === 1, `Back to chat shows the run ${tag}`)

    // The App settings card: Setting / Now / New, the theme row, Apply and Decline in view.
    const card = page.locator('article.decision-card', { has: page.locator('[data-testid=appsettings-proposal]') }).first()
    await card.waitFor({ timeout: 30_000 }).catch(() => {})
    check((await card.count()) === 1, `the App settings card appears ${tag}`)
    check((await text('[data-testid=proposal-target-badge]')) === 'App settings', `the card head says App settings ${tag}`)
    const details = card.locator('.decision-details')
    if ((await details.count()) && (await details.isVisible()) && (await details.getAttribute('aria-expanded')) !== 'true') await details.click()
    const heads = await card.locator('[data-testid=appsettings-proposal] thead th').allInnerTexts()
    check(heads.join('|') === 'Setting|Now|New', `the card table has Setting, Now and New ${tag}`, heads.join('|'))
    const row = card.locator('[data-testid=appsettings-change][data-field="appearance.theme"]')
    check((await row.count()) === 1, `the theme row is listed ${tag}`)
    check((await row.locator('[data-testid=appsettings-change-now]').innerText()).trim() === 'Dark', `Now reads Dark ${tag}`)
    check((await row.locator('[data-testid=appsettings-change-new]').innerText()).trim() === 'Light', `New reads Light ${tag}`)
    const approve = card.locator('[data-testid=proposal-approve]')
    check((await approve.innerText()).trim() === 'Apply to App settings', `Approve reads Apply to App settings ${tag}`)
    check(await card.locator('[data-testid=proposal-decline]').isVisible(), `Decline sits on the primary row ${tag}`)
    check(await noPageScroll(), `the card does not scroll the page ${tag}`)
    await shot(`card-${w}x${h}-dark`)
    await approve.click()
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 10_000 }).catch(() => {})
    check((await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', `Approve makes the theme light ${tag}`)
    check(await waitText('Done: the theme is now light.'), `the transcript shows the Done line ${tag}`)
    check((await page.locator('[data-testid=self-help-row][data-tool=app_reference]').count()) >= 1, `the reference lookup is one quiet row ${tag}`)
    // The conversation stage and the side panel's Transcript tab both render the feed, so count in the stage only.
    const opened = await page.locator('[data-testid=conversation-transcript] [data-testid=self-help-row][data-tool=open_in_app]').count()
    check(opened === 1, `the navigation is one row, not two ${tag}`, String(opened))
    await shot(`done-${w}x${h}-light`)

    // ---- light theme: the same navigation again; nothing to change, the banner still shows ----
    await askFromMenu(`${tag} light`)
    await startChat('[mock:self-config] Make it light.')
    const again = await page.locator('[data-testid=app-navigate-banner]').waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false
    )
    check(again, `the banner shows in the light theme ${tag}`)
    await shot(`banner-${w}x${h}-light`)
    // Dismiss is a plain button in the banner.
    await page.locator('[data-testid=app-navigate-banner]').getByRole('button', { name: 'Dismiss notice' }).click()
    check(!(await visible('[data-testid=app-navigate-banner]')), `Dismiss removes the banner ${tag}`)
    await page.locator('[data-testid=nav-assistant][data-id=quick]').click()
    check(await waitText('The theme is already light.'), `with nothing to change the assistant says so ${tag}`)

    // ---- [mock:self-config-project]: a $5 cap on the first project ----
    await menu('new-chat')
    await page.locator('[data-testid=assistant-start-quick]').waitFor({ timeout: 10_000 })
    await startChat('[mock:self-config-project] Cap my project at $5 per run.')
    const pcard = page.locator('article.decision-card', { has: page.locator('[data-testid=proposal-target-badge]') }).first()
    await pcard.waitFor({ timeout: 30_000 }).catch(() => {})
    check((await pcard.count()) === 1, `the project settings card appears ${tag}`)
    check((await pcard.locator('[data-testid=proposal-target-badge]').innerText()).includes(NAME.slice(0, 20)), `the card names the project ${tag}`)
    check((await pcard.locator('[data-testid=proposal-target]').innerText()).startsWith('Applies to'), `the card says which project it applies to ${tag}`)
    const pdetails = pcard.locator('.decision-details')
    if ((await pdetails.count()) && (await pdetails.isVisible()) && (await pdetails.getAttribute('aria-expanded')) !== 'true') await pdetails.click()
    check((await pcard.locator('[data-testid=settings-change][data-field=maxBudgetUsd]').count()) === 1, `the cap row is listed ${tag}`)
    check(/^Apply to /.test((await pcard.locator('[data-testid=proposal-approve]').innerText()).trim()), `Approve names the project ${tag}`)
    await shot(`project-card-${w}x${h}-light`)
    await pcard.locator('[data-testid=proposal-approve]').click()
    check(await waitText('Done: that project now has a $5 cap from its next run.'), `the transcript confirms the cap ${tag}`)
    await openProject(page, NAME)
    await page.locator('[data-testid=tab-settings]').click()
    await page.getByRole('tab', { name: 'Limits' }).click()
    const cap = await page.locator('input[type=number][placeholder="No cap"]').first().inputValue().catch(() => '')
    check(cap === '5', `Project settings > Limits shows the $5 cap ${tag}`, cap)
    // Reset for the next size.
    await page.evaluate(async (id) => {
      const p = (await window.orgai.projects.list()).find((x) => x.id === id)
      if (p) await window.orgai.projects.save({ ...p, maxBudgetUsd: undefined })
    }, project?.id)
  }

  // ---- About pane and the shortcuts dialog ----
  await menu('open-about')
  await page.locator('[data-testid=ask-orgai-button]').waitFor({ timeout: 10_000 }).catch(() => {})
  check(await visible('[data-testid=ask-orgai-button]'), 'App settings > About offers Ask OrgAI about itself')
  await page.locator('[data-testid=ask-orgai-button]').click()
  await page.locator('[data-testid=assistant-start-quick]').waitFor({ timeout: 10_000 }).catch(() => {})
  check(await visible('[data-testid=assistant-start-quick]'), 'the About button opens the Chat start page')
  await menu('keyboard-shortcuts')
  await page.locator('[data-testid=shortcuts-ask-orgai]').waitFor({ timeout: 5000 }).catch(() => {})
  check(await visible('[data-testid=shortcuts-ask-orgai]'), 'the shortcuts dialog offers Ask OrgAI')
  await page.locator('[data-testid=shortcuts-ask-orgai]').click()
  check(!(await visible('[data-testid=keyboard-shortcuts-dialog]')), 'Ask OrgAI closes the shortcuts dialog')
  check(await visible('[data-testid=assistant-start-quick]'), 'Ask OrgAI from the dialog lands on the Chat start page')
} catch (e) {
  check(false, 'self-help script ran to the end', e instanceof Error ? e.message : String(e))
  await shot('error').catch(() => {})
} finally {
  await app.close().catch(() => {})
  removeFixture(repo)
}
finish('self-help')
