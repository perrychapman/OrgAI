// Token-free (mock adapter, temp ORGAI_DATA_DIR). The shared context menu (docs/design/context-menus.md section 4,
// components/ui/ContextMenu.tsx) on three surfaces: run tabs, Knowledge rows and Dashboard project tiles. Each opens by
// right click and by keyboard (Shift+F10, the Menu key), takes focus on its first item, moves with the arrows (wrapping,
// Home / End, type-ahead), activates with Enter and returns focus to its invoker on Escape. The platform text menu wins
// in a text field and over a text selection: those contextmenu events are dispatched from script (a real right click
// there would pop the native menu from main, which e2e cannot dismiss) and must not be cancelled.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, checkRadio, cleanup, endSession, findProject, finish, gotoProjects, launch, openProject, openProjectForm, projectTab, sleep, pickSetup, t } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-ctxmenu-'))
const wf = path.join(base, 'ctx-engagement')
fs.mkdirSync(wf, { recursive: true })
const NAME = 'E2E context menus (orgai test)'

const { app, page, shot } = await launch({ shotPrefix: 'context-menus' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(400)
}
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + t(ms)
  while (Date.now() < end) {
    try {
      if (await fn()) return true
    } catch {
      /* keep polling */
    }
    await sleep(150)
  }
  return false
}
/** The focused element: its testid, role and text, for checks and failure details. */
const active = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return { testid: 'body', role: '', text: '' }
    return { testid: el.getAttribute('data-testid') ?? '', role: el.getAttribute('role') ?? '', text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() }
  })
const menuOpen = (testid) => page.locator(`[data-testid=${testid}][role=menu]`)
const itemsOf = async (testid) => (await menuOpen(testid).locator('[role=menuitem]').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
const ctxCount = () => page.locator('.ctx-menu').count()

/**
 * The shared keyboard model, checked on an open menu: focus on the first item, ArrowDown, ArrowUp wrapping to the last,
 * Home, End, a letter jumping to the next matching item.
 */
async function checkKeys(label, testid) {
  const items = await itemsOf(testid)
  const a0 = await active()
  check(a0.role === 'menuitem' && a0.text.startsWith(items[0]), `${label}: focus lands on the first item`, JSON.stringify(a0))
  if (items.length > 1) {
    await page.keyboard.press('ArrowDown')
    check((await active()).text.startsWith(items[1]), `${label}: ArrowDown moves to the second item`, JSON.stringify(await active()))
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowUp')
    check((await active()).text.startsWith(items[items.length - 1]), `${label}: ArrowUp from the first item wraps to the last`, JSON.stringify(await active()))
    await page.keyboard.press('Home')
    check((await active()).text.startsWith(items[0]), `${label}: Home goes to the first item`)
    await page.keyboard.press('End')
    check((await active()).text.startsWith(items[items.length - 1]), `${label}: End goes to the last item`)
    const target = items.findIndex((t, i) => i > 0 && /^[a-z]/i.test(t) && t[0].toLowerCase() !== items[0][0].toLowerCase())
    if (target > 0) {
      await page.keyboard.press('Home')
      await page.keyboard.press(items[target][0].toLowerCase())
      check((await active()).text.startsWith(items[target]), `${label}: typing "${items[target][0].toLowerCase()}" jumps to "${items[target]}"`, JSON.stringify(await active()))
    }
  }
}

/** Escape closes the menu and puts focus back on the element `isInvoker` recognises. */
async function checkEscape(label, testid, isInvoker) {
  await page.keyboard.press('Escape')
  check(await until(async () => (await menuOpen(testid).count()) === 0, 3000), `${label}: Escape closes the menu`)
  check(await until(() => page.evaluate(isInvoker), 3000), `${label}: Escape returns focus to the invoker`, JSON.stringify(await active()))
}

/** A script-dispatched contextmenu on `selector`: was it cancelled, and did a custom menu open? */
const dispatchContextMenu = (selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { found: false, cancelled: false }
    const r = el.getBoundingClientRect()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + 4 })
    const ok = el.dispatchEvent(ev)
    return { found: true, cancelled: !ok }
  }, selector)

try {
  await setSize(1600, 1000)

  // ---- An engagement with a [mock:knowledge] run: one run tab and five Knowledge rows ----
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await checkRadio(form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]'), 'the Engagement kind')
  await form.getByLabel('Name', { exact: true }).fill(NAME)
  await form.locator('[data-testid=new-project-client]').fill('Ctx Corp')
  await form.getByLabel('Working folder', { exact: true }).fill(wf)
  await pickSetup(form, true)
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  const eng = await findProject(page, NAME)
  check(!!eng, 'engagement created')

  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  await page.locator('.composer textarea').fill('Summarise the kickoff [mock:knowledge]')
  await page.locator('.composer .btn.primary').click()
  check(await until(async () => (await page.evaluate((id) => window.orgai.knowledge.get(id), eng.id)).nodes.length === 4, 60_000), 'the mock run recorded its knowledge items')
  // The root's last knowledge step retires a fact; then end the session, so no late card or event moves focus (which
  // rightly dismisses an open menu) while the checks run. The tab stays after End session.
  check(await until(async () => (await page.evaluate((id) => window.orgai.knowledge.get(id), eng.id)).nodes.some((n) => n.facts?.some((f) => f.retired)), 30_000), 'the mock run finished its knowledge writes')
  await endSession(page)
  check(await until(async () => (await page.evaluate((id) => window.orgai.runs.list(id), eng.id)).every((r) => !['starting', 'running', 'idle', 'stopping'].includes(r.status)), 20_000), 'the session ended')
  await sleep(500)

  // ======== 1. Run tabs ========
  const runTab = page.locator('.run-tablist .run-tab-wrap:not([data-run="new"]) .run-tab').first()
  const runId = await page.locator('.run-tablist .run-tab-wrap:not([data-run="new"])').first().getAttribute('data-run')
  const tabIsActive = `(() => document.activeElement?.closest('.run-tab-wrap')?.getAttribute('data-run') === ${JSON.stringify(runId)})`
  await runTab.click({ button: 'right' })
  await menuOpen('run-tab-ctx').waitFor({ timeout: 5000 })
  // Focusing the tab scrolls the tab strip into view as the menu opens: that programmatic scroll must not close it.
  await sleep(400)
  check((await menuOpen('run-tab-ctx').count()) === 1, 'run tab menu: stays open through the tab strip scrolling the focused tab into view')
  check((await itemsOf('run-tab-ctx')).join('|') === 'Open in new window|Hide', 'run tab menu: Open in new window, then Hide', (await itemsOf('run-tab-ctx')).join('|'))
  check((await menuOpen('run-tab-ctx').locator('[role=separator]').count()) === 1, 'run tab menu: a separator before Hide')
  check((await page.locator('[data-testid=run-tab-ctx]').evaluate((el) => el.matches(':popover-open'))) === true, 'run tab menu: shown in the top layer')
  await checkKeys('run tab (right click)', 'run-tab-ctx')
  await shot('run-tab-menu')
  await checkEscape('run tab (right click)', 'run-tab-ctx', new Function(`return ${tabIsActive}()`))
  await runTab.focus()
  await page.keyboard.press('Shift+F10')
  check(await until(async () => (await menuOpen('run-tab-ctx').count()) === 1, 3000), 'run tab: Shift+F10 on the focused tab opens the menu')
  await checkEscape('run tab (Shift+F10)', 'run-tab-ctx', new Function(`return ${tabIsActive}()`))
  await runTab.focus()
  await page.keyboard.press('ContextMenu')
  check(await until(async () => (await menuOpen('run-tab-ctx').count()) === 1, 3000), 'run tab: the Menu key on the focused tab opens the menu')
  // Activation: End then Enter on Hide removes the tab (the session keeps going) and focus stays on a real element.
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  check(await until(async () => (await page.locator(`.run-tablist .run-tab-wrap[data-run="${runId}"]`).count()) === 0, 3000), 'run tab: Enter on Hide hides the tab')
  check(await until(async () => (await ctxCount()) === 0, 2000), 'run tab: the menu closes on activation')
  await sleep(300)
  check((await active()).testid !== 'body', 'run tab: focus does not drop to the body after Hide', JSON.stringify(await active()))
  check((await page.evaluate((id) => window.orgai.runs.list(id), eng.id)).some((r) => r.id === runId), 'run tab: hiding keeps the run (it only leaves the tab strip)')

  // ---- Sidebar run row menu: Open, Open in new window, then Close (ends an idle run and hides its tab) ----
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  await page.locator('.composer textarea').fill('A second, idle run for the sidebar menu [mock:model-switch]')
  await page.locator('.composer .btn.primary').click()
  const navRun = page.locator('.sidebar [data-testid=nav-run]').first()
  await navRun.waitFor({ timeout: 20_000 })
  const navRunId = await navRun.getAttribute('data-run')
  const statusOfNav = () => page.evaluate(async (id) => (await window.orgai.runs.listLive()).find((r) => r.id === id)?.status ?? 'ended', navRunId)
  check(await until(async () => (await statusOfNav()) === 'idle', 30_000), 'the second mock run settles idle')
  // Close asks first unless the renderer's own view of the run is idle (closeConfirmFor), and main reporting idle does not
  // prove that. CI run 44688833784 (macOS): the Close confirm opened 0.2 s after main reported idle. The row's status word
  // is the renderer's view; checking it separately keeps a main/renderer disagreement visible instead of a later timeout.
  const rowIdle = () => navRun.locator('.sr-only').first().innerText().then((t) => t.trim() === 'Idle')
  check(await until(rowIdle, 5000), 'the sidebar row shows Idle once main reports idle', await navRun.locator('.sr-only').first().innerText().catch(() => ''))
  await navRun.click({ button: 'right' })
  await menuOpen('nav-run-menu').waitFor({ timeout: 5000 })
  check((await itemsOf('nav-run-menu')).join('|') === 'Open|Open in new window|Close', 'sidebar run menu: Open, Open in new window, Close', (await itemsOf('nav-run-menu')).join('|'))
  check((await menuOpen('nav-run-menu').locator('[role=separator]').count()) === 1, 'sidebar run menu: a separator before Close')
  await page.locator('[data-testid=nav-run-menu-close]').click()
  check(await until(async () => (await ctxCount()) === 0, 2000), 'sidebar run menu: the menu closes on Close')
  check(await until(async () => (await statusOfNav()) === 'ended', 10_000), 'Close on an idle run ended its session')
  check(await until(async () => (await page.locator(`.sidebar [data-testid=nav-run][data-run="${navRunId}"]`).count()) === 0, 5000), 'Close removed the row from the sidebar open runs')
  check((await page.locator(`.run-tablist .run-tab-wrap[data-run="${navRunId}"]`).count()) === 0, 'Close hid the run tab')
  await sleep(300)
  check((await active()).testid !== 'body', 'sidebar run menu: focus does not drop to the body after Close', JSON.stringify(await active()))
  check((await page.evaluate((id) => window.orgai.runs.list(id), eng.id)).some((r) => r.id === navRunId), 'Close keeps the run in History')

  // ======== 2. Knowledge rows ========
  await page.locator('[data-testid=tab-knowledge]').click()
  await page.locator('[data-testid=knowledge-row]').first().waitFor({ state: 'visible', timeout: 15_000 })
  const kRow = page.locator('[data-testid=knowledge-row]').first()
  const kId = await kRow.getAttribute('data-id')
  const rowIsActive = new Function(`return document.activeElement?.getAttribute('data-id') === ${JSON.stringify(kId)} && document.activeElement?.getAttribute('role') === 'option'`)
  await kRow.click({ button: 'right', position: { x: 8, y: 8 } })
  await menuOpen('knowledge-row-more').waitFor({ timeout: 5000 })
  check((await itemsOf('knowledge-row-more')).join('|') === 'Open|Retire', 'knowledge row menu: Open, Retire', (await itemsOf('knowledge-row-more')).join('|'))
  check((await kRow.getAttribute('aria-selected')) === 'true', 'knowledge row: opening its menu selects the row')
  await checkKeys('knowledge row (right click)', 'knowledge-row-more')
  await shot('knowledge-row-menu')
  await checkEscape('knowledge row (right click)', 'knowledge-row-more', rowIsActive)
  await page.keyboard.press('Shift+F10')
  check(await until(async () => (await menuOpen('knowledge-row-more').count()) === 1, 3000), 'knowledge row: Shift+F10 on the focused row opens the menu')
  await checkEscape('knowledge row (Shift+F10)', 'knowledge-row-more', rowIsActive)
  await page.keyboard.press('ContextMenu')
  check(await until(async () => (await menuOpen('knowledge-row-more').count()) === 1, 3000), 'knowledge row: the Menu key on the focused row opens the menu')
  await page.keyboard.press('Enter')
  check(await until(async () => (await page.evaluate(() => document.activeElement?.id)) === 'knowledge-detail-heading', 5000), 'knowledge row: Enter on Open opens the detail pane with focus on its heading', JSON.stringify(await active()))
  await page.keyboard.press('Escape')
  // Past the primitive's 600 ms guard against the platform's echo of a keyboard open.
  await sleep(800)

  // The platform menu wins: a text selection inside a row, and a text field inside a row.
  const nameSel = `[data-testid=knowledge-row][data-id="${kId}"] [data-testid=knowledge-row-name]`
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    const range = document.createRange()
    range.selectNodeContents(el)
    const s = window.getSelection()
    s.removeAllRanges()
    s.addRange(range)
  }, nameSel)
  const onSelection = await dispatchContextMenu(nameSel)
  check(onSelection.found && !onSelection.cancelled && (await ctxCount()) === 0, 'knowledge row: over a text selection the contextmenu is not cancelled and no custom menu opens', JSON.stringify(onSelection))
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  const noSelection = await dispatchContextMenu(nameSel)
  check(noSelection.cancelled && (await until(async () => (await ctxCount()) === 1, 2000)), 'knowledge row: without a selection the same contextmenu opens the custom menu (control)', JSON.stringify(noSelection))
  await page.keyboard.press('Escape')
  await until(async () => (await ctxCount()) === 0, 2000)
  await page.evaluate((id) => {
    const row = document.querySelector(`[data-testid=knowledge-row][data-id="${id}"]`)
    const input = document.createElement('input')
    input.type = 'text'
    input.setAttribute('data-testid', 'ctx-probe-input')
    row?.appendChild(input)
  }, kId)
  const inField = await dispatchContextMenu('[data-testid=ctx-probe-input]')
  check(inField.found && !inField.cancelled && (await ctxCount()) === 0, 'knowledge row: in a text field the contextmenu is not cancelled and no custom menu opens', JSON.stringify(inField))
  await page.evaluate(() => document.querySelector('[data-testid=ctx-probe-input]')?.remove())
  const searchBox = await dispatchContextMenu('[data-testid=knowledge-search]')
  check(searchBox.found && !searchBox.cancelled && (await ctxCount()) === 0, 'the Knowledge search field keeps the platform menu', JSON.stringify(searchBox))

  // ======== 3. Dashboard project tiles ========
  await gotoProjects(page)
  const tile = page.locator(`[data-testid=project-tile][data-name="${NAME}"]`)
  await tile.waitFor()
  const mainIsActive = new Function(`return document.activeElement?.getAttribute('data-testid') === 'project-tile-main' && document.activeElement.closest('[data-testid=project-tile]')?.getAttribute('data-name') === ${JSON.stringify(NAME)}`)
  const moreIsActive = new Function(`return document.activeElement?.getAttribute('data-testid') === 'project-tile-more' && document.activeElement.closest('[data-testid=project-tile]')?.getAttribute('data-name') === ${JSON.stringify(NAME)}`)
  // The tile body (the Open button's cover spans the whole tile), away from More and the chips.
  const tb = await tile.boundingBox()
  const at = { x: 24, y: Math.round((tb?.height ?? 80) - 16) }
  await tile.click({ button: 'right', position: at })
  await menuOpen('project-tile-menu').waitFor({ timeout: 5000 })
  const tileItems = await itemsOf('project-tile-menu')
  check(tileItems[0] === 'Open' && tileItems[1] === 'New run' && tileItems.includes('Open folder') && tileItems[tileItems.length - 1] === 'Forget engagement…', 'tile menu: Open, New run, ..., Open folder, then Forget engagement… last', tileItems.join('|'))
  check((await menuOpen('project-tile-menu').locator('[data-testid=project-tile-delete]').getAttribute('class'))?.includes('danger'), 'tile menu: the destructive item is styled as danger')
  check((await menuOpen('project-tile-menu').locator('[role=separator]').count()) === 1, 'tile menu: a separator before the destructive item')
  const box = await menuOpen('project-tile-menu').boundingBox()
  check(!!box && !!tb && Math.abs(box.x - (tb.x + at.x)) <= 2, 'tile menu: a right click opens it at the pointer', JSON.stringify({ box, tb, at }))
  await checkKeys('tile (right click)', 'project-tile-menu')
  await shot('tile-menu')
  await checkEscape('tile (right click)', 'project-tile-menu', mainIsActive)
  await tile.locator('[data-testid=project-tile-main]').focus()
  await page.keyboard.press('Shift+F10')
  check(await until(async () => (await menuOpen('project-tile-menu').count()) === 1, 3000), 'tile: Shift+F10 on the Open button opens the menu')
  await checkEscape('tile (Shift+F10)', 'project-tile-menu', mainIsActive)
  const more = tile.locator('[data-testid=project-tile-more]')
  check((await more.getAttribute('aria-haspopup')) === 'menu' && (await more.getAttribute('aria-expanded')) === 'false', 'tile: More is a menu button, collapsed')
  await more.click()
  await menuOpen('project-tile-menu').waitFor({ timeout: 5000 })
  check((await more.getAttribute('aria-expanded')) === 'true', 'tile: More is expanded while its menu is open')
  check((await itemsOf('project-tile-menu')).join('|') === tileItems.join('|'), 'tile: More opens the same menu as the right click')
  await checkEscape('tile (More)', 'project-tile-menu', moreIsActive)
  await more.click()
  await menuOpen('project-tile-menu').waitFor({ timeout: 5000 })
  await more.click()
  check(await until(async () => (await menuOpen('project-tile-menu').count()) === 0, 2000), 'tile: a second click on More closes its menu')
  await more.click()
  await menuOpen('project-tile-menu').waitFor({ timeout: 5000 })
  // Wheel over the tile's own top-left corner, measured now: tb above was taken before the page scrolled the tile into
  // view (on the tall Dashboard the tile starts at the window's bottom edge, so tb.y + 10 was below the viewport and a
  // wheel there reaches nothing). The corner is left of the menu (it opens at the pointer, x + 24 and right) and over the page.
  const tNow = await tile.boundingBox()
  const wheelAt = { x: Math.round((tNow?.x ?? 300) + 10), y: Math.round((tNow?.y ?? 300) + 10) }
  const winNow = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const menuNow = await menuOpen('project-tile-menu').boundingBox()
  check(wheelAt.y < winNow.h && wheelAt.x < winNow.w && !!menuNow && (wheelAt.x < menuNow.x || wheelAt.x > menuNow.x + menuNow.width || wheelAt.y < menuNow.y || wheelAt.y > menuNow.y + menuNow.height), 'tile: the wheel point is inside the window and outside the menu', JSON.stringify({ wheelAt, winNow, menuNow }))
  await page.mouse.move(wheelAt.x, wheelAt.y)
  await page.mouse.wheel(0, 200)
  check(await until(async () => (await menuOpen('project-tile-menu').count()) === 0, 2000), 'tile: a wheel scroll outside the menu closes it')
  check(await until(() => page.evaluate(moreIsActive), 2000), 'tile: focus returns to More after the wheel dismissal', JSON.stringify(await active()))
  // Reduced motion (the OS preference, then the app setting): the global 0.01ms transition rule once made the items
  // transition the visibility they inherit as the panel unhid, so focus() in the same task did nothing (CI runners
  // report reduced motion). Focus must be on the first item at once, not after a frame.
  const openedFocus = () =>
    page.evaluate(() => {
      const a = document.activeElement
      const first = document.querySelector('[data-testid=project-tile-menu] [role=menuitem]')
      return { role: a?.getAttribute('role') ?? a?.tagName ?? '', firstVisibility: first ? getComputedStyle(first).visibility : 'none' }
    })
  for (const how of ['os', 'app']) {
    if (how === 'os') await page.emulateMedia({ reducedMotion: 'reduce' })
    else
      await page.evaluate(async () => {
        const { dataDir: _d, appVersion: _v, ...s } = await window.orgai.settings.get()
        await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, reduceMotion: 'on' } })
      })
    await until(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-fast').trim() === '0.01ms'), 3000)
    await more.click()
    const f = await openedFocus()
    check(f.role === 'menuitem' && f.firstVisibility === 'visible', `tile (${how} reduced motion): More moves focus to the first item at once`, JSON.stringify(f))
    await checkEscape(`tile (${how} reduced motion)`, 'project-tile-menu', moreIsActive)
    if (how === 'os') await page.emulateMedia({ reducedMotion: null })
    else
      await page.evaluate(async () => {
        const { dataDir: _d, appVersion: _v, ...s } = await window.orgai.settings.get()
        await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, reduceMotion: 'system' } })
      })
  }
  // Activation: the Menu key on Open, then Enter on Open, opens the project.
  await tile.locator('[data-testid=project-tile-main]').focus()
  await page.keyboard.press('ContextMenu')
  check(await until(async () => (await menuOpen('project-tile-menu').count()) === 1, 3000), 'tile: the Menu key on the Open button opens the menu')
  await page.keyboard.press('Enter')
  check(await until(async () => (await page.locator('[data-testid=dashboard]').count()) === 0, 5000), 'tile: Enter on Open opens the project')

  // ---- Both themes at the small size: the menu stays inside the window ----
  await setSize(1024, 640)
  await gotoProjects(page)
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const vt = page.locator(`[data-testid=project-tile][data-name="${NAME}"] [data-testid=project-tile-more]`)
    await vt.click()
    await menuOpen('project-tile-menu').waitFor({ timeout: 5000 })
    const b = await menuOpen('project-tile-menu').boundingBox()
    const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
    check(!!b && b.x >= 8 && b.y >= 8 && b.x + b.width <= vp.width - 7 && b.y + b.height <= vp.height - 7, `tile menu stays 8 px inside the window at 1024x640 ${theme}`, JSON.stringify({ b, vp }))
    await shot(`tile-menu-1024-${theme}`)
    await page.keyboard.press('Escape')
    await until(async () => (await ctxCount()) === 0, 2000)
  }

  // ======== 4. Real right clicks: custom menu XOR native text menu (main process) ========
  // A trusted right click through the driver, with Menu.prototype.popup stubbed in main so no native menu really opens,
  // and a counting listener on the window's 'context-menu' event. A surface whose renderer cancels the DOM contextmenu
  // must not reach main; a field or a selection must reach it and build the text menu; a plain background reaches
  // main but builds nothing.
  await setSize(1600, 1000)
  await app.evaluate(({ BrowserWindow, Menu }) => {
    globalThis.__ctxProbe = { events: 0, popups: [] }
    Menu.prototype.popup = function () {
      globalThis.__ctxProbe.popups.push(this.items.map((i) => (i.type === 'separator' ? '---' : i.label)).join('|'))
    }
    BrowserWindow.getAllWindows()[0].webContents.on('context-menu', () => {
      globalThis.__ctxProbe.events++
    })
  })
  const probeReset = () => app.evaluate(() => { globalThis.__ctxProbe.events = 0; globalThis.__ctxProbe.popups = [] })
  const probeRead = () => app.evaluate(() => JSON.parse(JSON.stringify(globalThis.__ctxProbe)))
  const rightClickAt = async (loc, pos) => {
    const b = await loc.boundingBox()
    await page.mouse.click(b.x + (pos?.x ?? b.width / 2), b.y + (pos?.y ?? b.height / 2), { button: 'right' })
    await sleep(600)
  }
  const dismissCustom = async () => {
    await page.keyboard.press('Escape')
    await until(async () => (await ctxCount()) === 0, 2000)
  }
  await gotoProjects(page)
  const navRow = page.locator(`.sidebar [data-testid=nav-project][data-name="${NAME}"]`).first()
  await probeReset()
  await rightClickAt(navRow, { x: 30, y: 10 })
  let pr = await probeRead()
  check((await ctxCount()) === 1 && pr.events === 0 && pr.popups.length === 0, 'real right click on a sidebar project row: the custom menu opens and main sees no context-menu event', JSON.stringify(pr))
  await dismissCustom()
  await navRow.click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 10_000 })
  await page.locator('[data-testid=tab-live]').click()
  const composer = page.locator('.composer textarea, textarea').first()
  await composer.fill('ctx probe text')
  await probeReset()
  await rightClickAt(composer)
  pr = await probeRead()
  check((await ctxCount()) === 0 && pr.events === 1 && pr.popups.join(';') === 'Cut|Copy|Paste|---|Select all', 'real right click in a text field: no custom menu, the native Cut / Copy / Paste / Select all menu is built', JSON.stringify(pr))
  await composer.fill('')
  const heading = page.locator('main h1, main h2, .topbar h1, h1, h2').first()
  await page.evaluate(() => {
    const el = document.querySelector('main h1, main h2, .topbar h1, h1, h2')
    const range = document.createRange()
    range.selectNodeContents(el)
    const s = window.getSelection()
    s?.removeAllRanges()
    s?.addRange(range)
  })
  await probeReset()
  await rightClickAt(heading, { x: 5, y: 5 })
  pr = await probeRead()
  check((await ctxCount()) === 0 && pr.events === 1 && pr.popups.join(';') === 'Copy', 'real right click on selected text: no custom menu, the native Copy menu is built', JSON.stringify(pr))
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  const vpNow = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
  await probeReset()
  await page.mouse.click(vpNow.width - 20, Math.round(vpNow.height / 2), { button: 'right' })
  await sleep(600)
  pr = await probeRead()
  check((await ctxCount()) === 0 && pr.popups.length === 0, 'real right click on plain background: no custom menu and no native menu', JSON.stringify(pr))
} catch (e) {
  check(false, 'context menus flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await setSize(1600, 1000).catch(() => {})
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('e2e/context-menus')
