// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The native application menu: items are clicked from main
// (Menu.getMenuItemById(id).click(), item ids equal the MenuAction names) and the renderer's router acts on them.
// Checks File > New chat, View > Team, Help > About, Show conversation, Interrupt turn enabled while
// the session is open, Org retrospective on a live run announced in the run tabs' status line,
// Ctrl+T on the Projects page announced in the app-wide status region,
// Keyboard shortcuts (open, Esc, focus returns), one draft for Ctrl+T and New run, and that main's item state follows
// the screen (show-team enabled in a project, disabled on the Projects page). 1024x640 and 1600x1000, dark and light.
import { check, cleanup, createProject, finish, launch, makeFixtureRepo, openProject, removeFixture, sleep, gotoProjects } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

const NAME = 'E2E menu (orgai test)'
const repo = makeFixtureRepo('menu')

const { app, page, shot } = await launch({ shotPrefix: 'menu' })
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
  await sleep(500)
}
/** Click a native menu item by id, as the menu bar does. */
const menu = (id) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)
const enabled = (id) => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? null, id)
/** Poll main's menu state: the renderer pushes it asynchronously. */
const waitEnabled = async (id, want) => {
  let last = null
  for (let i = 0; i < 30; i++) {
    last = await enabled(id)
    if (last === want) return true
    await sleep(200)
  }
  return false
}
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const text = async (sel) => (await page.locator(sel).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const draftCount = () => page.locator('.new-run').count()

try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')

  // Start one mock run that goes idle (a chat-style default work script).
  await page.locator('[data-testid=tab-live]').click()
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  await page.locator('.composer textarea').fill('Menu check task')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => /idle|finished|needs you/i.test(document.querySelector('.run-tab[aria-selected=true]')?.getAttribute('aria-label') ?? ''), null, { timeout: 60_000 }).catch(() => {})

  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    for (const theme of ['dark', 'light']) {
      const tag = `at ${w}x${h} ${theme}`
      await setSize(w, h)
      await setTheme(theme)
      await openProject(page, NAME)

      // Menu state follows the screen.
      check(await waitEnabled('show-team', true), `View > Team is enabled in a project ${tag}`)

      // View > Team
      await page.locator('[data-testid=tab-live]').click()
      await menu('show-team')
      await page.locator('[data-testid=tab-team]').waitFor()
      await page.waitForFunction(() => document.querySelector('[data-testid=tab-team]')?.getAttribute('aria-selected') === 'true', null, { timeout: 5000 }).catch(() => {})
      check((await page.locator('[data-testid=tab-team]').getAttribute('aria-selected')) === 'true', `View > Team selects the Team tab ${tag}`)
      await page.locator('[data-testid=tab-live]').click()

      // One draft for Ctrl+T and for File > New run.
      await page.keyboard.press('Control+t')
      await page.locator('.new-run').waitFor({ timeout: 5000 }).catch(() => {})
      await sleep(300)
      check((await draftCount()) === 1, `Ctrl+T opens exactly one draft ${tag}`, String(await draftCount()))
      await menu('new-run')
      await sleep(400)
      check((await draftCount()) === 1, `New run from the menu keeps exactly one draft ${tag}`, String(await draftCount()))

      // Back to the run (the first run tab) for the run actions.
      await page.locator('.run-tablist [role="tab"]').first().click()
      await sleep(300)

      // View > Canvas > Show conversation (a 'focused' run action) switches the layout and back.
      const layout = () => page.evaluate(() => document.querySelector('.run-body')?.getAttribute('data-layout') ?? '')
      const before = await layout()
      await menu('toggle-conversation')
      await page.waitForFunction((b) => (document.querySelector('.run-body')?.getAttribute('data-layout') ?? '') !== b, before, { timeout: 3000 }).catch(() => {})
      const after = await layout()
      check(!!before && after !== before, `View > Show conversation switches the run layout ${tag}`, `${before} -> ${after}`)
      await menu('toggle-conversation')
      await sleep(300)

      // The mock run waits on a card with its session open: Interrupt turn and End session are enabled (runLive).
      // (Not clicked: they would really interrupt or end the run.)
      check(await waitEnabled('interrupt-run', true), `Run > Interrupt turn is enabled while the session is open ${tag}`)
      // Run > Org retrospective on a live run: enabled (a run tab is shown) but it does not apply, so the router says
      // why in the run tabs' status line.
      await menu('org-retrospective')
      await page.waitForFunction(() => /Not available for this run/.test(document.querySelector('.run-tabs-notice')?.textContent ?? ''), null, { timeout: 3000 }).catch(() => {})
      const said = await text('.run-tabs-notice')
      check(/Not available for this run/.test(said), `Run > Org retrospective on a live run says it does not apply ${tag}`, said)

      // Keyboard shortcuts dialog: open, Esc, focus returns somewhere real.
      await menu('keyboard-shortcuts')
      await page.locator('[data-testid=keyboard-shortcuts-dialog]').waitFor({ timeout: 5000 }).catch(() => {})
      check(await visible('[data-testid=keyboard-shortcuts-dialog]'), `Keyboard shortcuts opens its dialog ${tag}`)
      await shot(`shortcuts-${w}x${h}-${theme}`)
      await page.keyboard.press('Escape')
      await page.locator('[data-testid=keyboard-shortcuts-dialog]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
      check(!(await visible('[data-testid=keyboard-shortcuts-dialog]')), `Esc closes the shortcuts dialog ${tag}`)
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? '')
      check(focused !== '' && focused !== 'BODY', `focus returns to a real element after the dialog ${tag}`, focused)

      // File > New chat
      await menu('new-chat')
      await page.locator('[data-testid=assistant-start-quick]').waitFor({ timeout: 8000 }).catch(() => {})
      check(await visible('[data-testid=assistant-start-quick]'), `File > New chat opens the Chat start page ${tag}`)

      // Help > About
      await menu('open-about')
      await page.locator('[data-testid=about-block]').waitFor({ timeout: 8000 }).catch(() => {})
      check(await visible('[data-testid=about-block]'), `Help > About lands on the App settings About pane ${tag}`)

      // Projects page: show-team is off.
      await gotoProjects(page)
      check(await waitEnabled('show-team', false), `View > Team is disabled on the Projects page ${tag}`)

      // A key press that reaches the renderer for something that does not apply is announced (Ctrl+T, no project).
      await page.keyboard.press('Control+t')
      await page.waitForFunction(() => /Open a project first/.test(document.querySelector('[data-testid=menu-announce]')?.textContent ?? ''), null, { timeout: 3000 }).catch(() => {})
      check(/Open a project first/.test(await text('[data-testid=menu-announce]')), `Ctrl+T on the Projects page announces "Open a project first." ${tag}`, await text('[data-testid=menu-announce]'))
    }
  }
} finally {
  await cleanup(app, page, NAME)
  removeFixture(repo)
}
finish('menu')
