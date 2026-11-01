// Token- and network-free (ORGAI_MOCK=1: connector sign-in, token save and "Check connection" are answered in-process).
// Walks the Connectors feature: App settings > Connectors gallery and dialog (oauth, oauthClient, token kinds), linking a
// connected service to a project from Team > Catalog, granting a role, the role inspector's Connections block,
// Disconnect and Remove confirmations that name the project, plus layout checks and screenshots at 1024x640 and
// 1600x1000 in both themes.
import * as path from 'node:path'
import * as fs from 'node:fs'
import { TMP, check, cleanup, createProject, finish, launch, makeFixtureRepo, openAppSettings, openProject, openTeam, projectTab, removeFixture, teamPanelTab, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E connectors (orgai test)'
const REDIRECT = 'http://127.0.0.1:38917/callback'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-cnr-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('cnr', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'cnr' })
const tile = (id) => page.locator(`[data-testid=connector-tile][data-connector=${id}]`)
const dialog = () => page.locator('[data-testid=connector-dialog]')
const noHScroll = async (what) => {
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(ov.sw <= ov.cw, `no horizontal scroll: ${what}`, JSON.stringify(ov))
}
async function openGallery() {
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
  await page.locator('[data-testid=connectors-section]').waitFor({ timeout: 10_000 })
  await tile('notion').waitFor({ timeout: 10_000 })
}
async function openDialog(id) {
  await tile(id).locator('[data-testid=connector-action]').click()
  await dialog().waitFor({ timeout: 10_000 })
}
async function closeDialog() {
  await page.keyboard.press('Escape')
  await dialog().waitFor({ state: 'detached', timeout: 10_000 })
}
/** Click the confirm button of the topmost ConfirmDialog and return its text. */
async function confirmTop(label) {
  const dlg = page.getByRole('dialog').last()
  const text = (await dlg.textContent()) ?? ''
  await dlg.getByRole('button', { name: label, exact: true }).click()
  return text
}

try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created')
  const roles = (await page.evaluate(async (n) => (await window.orgai.projects.list()).find((p) => p.name === n)?.roles ?? [], NAME)).map((r) => r.name)
  check(roles.length > 0, 'project has roles', roles.join(', '))
  const role = roles[0]

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  await sleep(300)
  await openGallery()
  check((await tile('notion').getAttribute('data-state')) === 'available', 'Notion starts available')
  if ((await tile('gmail').count()) === 1) check((await tile('gmail').locator('.connector-logo svg').count()) >= 1, 'Gmail tile renders its brand mark svg in .connector-logo')

  // search filters the gallery
  const search = page.locator('[data-testid=connector-search]')
  await search.fill('notion')
  check((await tile('notion').count()) === 1 && (await tile('github').count()) === 0, 'search narrows the gallery to Notion')
  await search.fill('')
  check((await tile('github').count()) === 1, 'clearing the search brings every service back')

  // deep link (requestConnector): the app has no window bridge for it, so set the same key and send the same event
  await search.fill('notion')
  await page.evaluate(() => {
    sessionStorage.setItem('orgai.pendingSettingsSection', 'mcp-library')
    sessionStorage.setItem('orgai.pendingConnector', 'github')
    window.dispatchEvent(new Event('orgai:settings-section'))
  })
  await tile('github').waitFor({ timeout: 5_000 })
  await sleep(300)
  check((await tile('github').getAttribute('data-highlight')) !== null, 'a connector deep link highlights the tile')
  check(await tile('github').locator('[data-testid=connector-action]').evaluate((el) => el === document.activeElement), 'a connector deep link focuses the tile')
  check((await search.inputValue()) === '', 'a connector deep link clears the search that hid the tile')
  check(/Showing GitHub/.test((await page.locator('[data-testid=connector-announce]').textContent()) ?? ''), 'a connector deep link announces "Showing GitHub"')

  // method badge, ordering, filters, ranked search, live count, roving focus
  const easeText = async (id) => ((await tile(id).locator('[data-testid=connector-ease]').textContent()) ?? '').trim()
  check((await easeText('notion')) === 'Sign in', 'Notion shows the "Sign in" method badge')
  if ((await tile('gmail').count()) === 1) check((await easeText('gmail')) === 'Needs your own app', 'Gmail shows "Needs your own app"')
  if ((await tile('deepwiki').count()) === 1) check((await easeText('deepwiki')) === 'No sign-in needed', 'DeepWiki shows "No sign-in needed"')
  check((await tile('github').locator('[data-testid=connector-action]').textContent())?.trim() === 'Add token', 'token tiles say "Add token"')
  check((await tile('notion').locator('[data-testid=connector-action]').textContent())?.trim() === 'Sign in', 'one-click tiles say "Sign in"')
  const eases = await page.locator('[data-testid=connector-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ease')))
  const rankOf = (e) => (e === 'none' || e === 'signIn' ? 0 : e === 'token' ? 1 : 2)
  check(rankOf(eases[0]) === 0, 'the first tile is an easy sign-in, not an own-app service', eases.slice(0, 4).join(','))
  check(eases.every((e, i) => i === 0 || rankOf(eases[i - 1]) <= rankOf(e)), 'tiles run easy sign-in, then tokens, then own-app services')
  const count = async () => ((await page.locator('[data-testid=connector-results-count]').textContent()) ?? '').trim()
  const total = (await page.locator('[data-testid=connector-tile]').count())
  check((await count()) === `${total} services`, 'the live count names the number of services', await count())
  check((await page.locator('[data-testid=connector-tile] .connector-desc').first().evaluate((el) => el.getBoundingClientRect().height)) < 30, 'tile description stays on one line')
  const tileH = await tile('notion').evaluate((el) => el.getBoundingClientRect().height)
  check(tileH < 110, 'a tile is compact (under 110 px)', String(tileH))
  const tabStops = await page.locator('[data-testid=connector-action]').evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length)
  check(tabStops === 1, 'the tile grid is one tab stop (roving focus)', String(tabStops))
  const easyChip = page.locator('[data-testid=connector-filter][data-filter=easy]')
  check((await easyChip.getAttribute('aria-pressed')) === 'false', 'Easy sign-in chip starts unpressed')
  await easyChip.click()
  check((await easyChip.getAttribute('aria-pressed')) === 'true', 'Easy sign-in chip is pressed after a click')
  const easyEases = await page.locator('[data-testid=connector-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ease')))
  check(easyEases.length > 0 && easyEases.every((e) => e === 'signIn' || e === 'none'), 'the Easy sign-in filter shows only sign-in and no-sign-in services')
  await page.locator('[data-testid=connector-filter][data-filter=all]').click()
  // Easy sign-in combines with a category chip.
  const catChips = page.locator('[data-testid=connector-filter]:not([data-filter=all]):not([data-filter=easy]):not([data-filter=connected])')
  if ((await catChips.count()) > 0) {
    await catChips.first().click()
    const catOnly = await page.locator('[data-testid=connector-tile]').count()
    await easyChip.click()
    const bothEases = await page.locator('[data-testid=connector-tile]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ease')))
    check((await easyChip.getAttribute('aria-pressed')) === 'true' && (await catChips.first().getAttribute('aria-pressed')) === 'true', 'Easy sign-in and a category chip are pressed together')
    check(bothEases.length <= catOnly && bothEases.every((e) => e === 'signIn' || e === 'none'), 'Easy sign-in plus a category shows only easy services inside that category', `${bothEases.length}/${catOnly}`)
    await page.locator('[data-testid=connector-filter][data-filter=all]').click()
    check((await easyChip.getAttribute('aria-pressed')) === 'false', 'All resets Easy sign-in and the category')
  }
  await search.fill('postgres')
  check((await tile('neon').count()) === 1, 'search "postgres" finds Neon through its aliases')
  await search.fill('')
  await search.fill('mail')
  check((await tile('gmail').count()) === 1, 'search "mail" finds Gmail through its aliases')
  check((await page.locator('[data-testid=connector-tile]').first().getAttribute('data-connector')) === 'gmail', 'the name match ranks first')
  check(/service/.test(await count()), 'the count updates with the search', await count())
  await search.fill('zzzqqq')
  await page.locator('[data-testid=connector-empty]').waitFor({ timeout: 5_000 })
  check((await page.locator('[data-testid=connector-empty-custom]').count()) === 1, 'the no-results state offers "Add a custom server"')
  check((await count()) === 'No services', 'the count says No services', await count())
  await search.fill('')

  // ---- no sign-in kind: DeepWiki connects without a browser ----
  if ((await tile('deepwiki').count()) === 1) {
    await openDialog('deepwiki')
    check(/^Add DeepWiki/.test(((await page.getByRole('dialog').locator('h2').first().textContent()) ?? '').trim()), 'DeepWiki dialog is headed "Add DeepWiki"')
    check(/No sign-in needed/.test((await dialog().locator('[data-testid=connector-lead]').textContent()) ?? ''), 'DeepWiki dialog says no sign-in is needed')
    await dialog().locator('[data-testid=connector-connect]').click()
    await dialog().locator('[data-testid=connector-status]').waitFor({ timeout: 15_000 })
    check((await dialog().locator('[data-testid=connector-disconnect]').count()) === 0, 'a no-sign-in service has no Disconnect, only Remove')
    await closeDialog()
    check((await tile('deepwiki').getAttribute('data-state')) === 'connected', 'DeepWiki is connected after Add')
  }

  // ---- oauth kind: Notion ----
  await openDialog('notion')
  await dialog().locator('[data-testid=connector-connect]').click()
  await dialog().locator('[data-testid=connector-status]').waitFor({ timeout: 15_000 })
  check(/mock@example\.com/.test((await dialog().locator('[data-testid=connector-status]').textContent()) ?? ''), 'Notion (oauth) connects and shows mock@example.com')
  await dialog().locator('[data-testid=connector-test]').click()
  await dialog().locator('[data-testid=connector-tools]').waitFor({ timeout: 15_000 })
  check((await dialog().locator('[data-testid=connector-tools] li').count()) >= 1, 'Check connection lists tools')
  await closeDialog()
  check((await tile('notion').getAttribute('data-state')) === 'connected', 'Notion tile is connected')
  check(/mock@example\.com/.test((await tile('notion').locator('[data-testid=connector-state]').textContent()) ?? ''), 'Notion tile shows the account')

  // ---- oauthClient kind: Slack ----
  await openDialog('slack')
  const connect = dialog().locator('[data-testid=connector-connect]')
  check(await connect.isDisabled(), 'Slack: Connect is disabled without a client')
  check((await dialog().locator('[data-testid=connector-missing]').textContent())?.trim() === 'Add the Client ID and Client secret to continue.', 'Slack: the missing sentence names both fields')
  check((await dialog().locator('[data-testid=connector-redirect-uri]').textContent())?.trim() === REDIRECT, 'Slack: redirect address box shows the loopback URI')
  await dialog().getByLabel('Client ID', { exact: true }).fill('e2e-client-id')
  check((await connect.isDisabled()) && /Add the Client secret to continue\./.test((await dialog().locator('[data-testid=connector-missing]').textContent()) ?? ''), 'Slack: still disabled with only a client id')
  await dialog().getByLabel('Client secret', { exact: true }).fill('e2e-client-secret')
  check(await dialog().locator('[data-testid=connector-missing]').count() === 0 && !(await connect.isDisabled()), 'Slack: Connect enabled once both are entered')
  await connect.click()
  await dialog().locator('[data-testid=connector-status]').waitFor({ timeout: 15_000 })
  check(/mock@example\.com/.test((await dialog().locator('[data-testid=connector-status]').textContent()) ?? ''), 'Slack (oauthClient) connects')
  await closeDialog()

  // ---- token kind: GitHub ----
  await openDialog('github')
  const gh = dialog().locator('[data-testid=connector-connect]')
  check(await gh.isDisabled(), 'GitHub: Connect is disabled without a token')
  check((await dialog().locator('[data-testid=connector-missing]').textContent())?.trim() === 'Add the Personal access token to continue.', 'GitHub: the missing sentence names the token')
  await dialog().getByLabel('Personal access token', { exact: true }).fill('ghp_e2e_fake_token')
  check(!(await gh.isDisabled()), 'GitHub: Connect enabled once a token is entered')
  await gh.click()
  await dialog().locator('[data-testid=connector-status]').waitFor({ timeout: 15_000 })
  check(true, 'GitHub (token) connects')
  await dialog().locator('[data-testid=connector-test]').click()
  await dialog().locator('[data-testid=connector-tools]').waitFor({ timeout: 15_000 })
  check(true, 'GitHub: Check connection lists tools')
  await dialog().locator('[data-testid=connector-disconnect]').click()
  await confirmTop('Disconnect')
  await dialog().locator('[data-testid=connector-connect]').waitFor({ timeout: 10_000 })
  check(true, 'GitHub: Disconnect returns the dialog to the token form')
  await closeDialog()
  check((await tile('github').getAttribute('data-state')) === 'needsSetup', 'GitHub tile is Not signed in after Disconnect')
  check(/Not signed in/.test((await tile('github').locator('[data-testid=connector-state]').textContent()) ?? ''), 'GitHub tile says Not signed in')

  // ---- link to a project, grant a role ----
  await openProject(page, NAME)
  await openTeam(page)
  await teamPanelTab(page, 'Catalog').click()
  await page.waitForSelector('[data-testid=catalog-connections]', { timeout: 10_000 })
  const row = page.locator('[data-testid=connected-service-row][data-connector=notion]')
  await row.waitFor({ timeout: 10_000 })
  check((await page.locator('[data-testid=connected-service-row][data-connector=slack]').count()) === 1, 'Catalog lists the connected Slack service')
  const nameBox = await row.locator('.mcp-name').boundingBox()
  check(!!nameBox && nameBox.width > 40, 'tool row server name is wider than 40px at 1280', JSON.stringify(nameBox))
  const logoBox = await row.locator('.connector-logo').first().boundingBox()
  check(!!logoBox && !!nameBox && logoBox.x + logoBox.width <= nameBox.x && Math.abs(logoBox.y - nameBox.y) < 40, 'connected service logo sits left of its name (CSS nesting regression)', JSON.stringify({ logoBox, nameBox }))
  const nameH = await row.locator('.mcp-name').evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }))
  check(nameH.h <= nameH.lh * 1.5, 'tool row server name stays on one line at 1280', JSON.stringify(nameH))
  await noHScroll('Catalog at 1280')
  await row.locator('[data-testid=connector-use]').click()
  const use = page.locator('[data-testid=connector-use-dialog]')
  await use.waitFor({ timeout: 10_000 })
  check(await use.locator('[data-testid=connector-use-confirm]').isDisabled(), 'Use in this project is disabled until a role is chosen')
  check((await use.locator('[data-testid=connector-use-blocker]').count()) === 1, 'a blocker sentence explains why')
  for (const r of roles) check((await use.getByRole('checkbox', { name: r, exact: true }).count()) === 1, `role "${r}" is listed in the Use dialog`)
  await use.getByRole('checkbox', { name: role, exact: true }).check()
  check(!(await use.locator('[data-testid=connector-use-confirm]').isDisabled()), 'Use in this project is enabled once a role is chosen')
  await use.locator('[data-testid=connector-use-confirm]').click()
  await use.waitFor({ state: 'detached', timeout: 10_000 })
  await row.locator('.mcp-role-access button').first().waitFor({ timeout: 10_000 })
  check((await row.locator(`[data-testid=catalog-used-by-role]`, { hasText: role }).count()) === 1, `Catalog row shows "Used by ${role}"`, ((await row.textContent()) ?? "").slice(0, 200))
  check((await row.locator('[data-testid=connector-use]').count()) === 0, 'the Use button is gone once linked')

  // ---- Add a service: search-first picker ----
  await page.locator('[data-testid=mcp-add-service]').scrollIntoViewIfNeeded()
  await page.locator('[data-testid=mcp-add-service]').click()
  const add = page.locator('[data-testid=add-service-dialog]')
  await add.waitFor({ timeout: 10_000 })
  const addSearch = add.locator('[data-testid=add-service-search]')
  check(await addSearch.evaluate((el) => el === document.activeElement), 'the picker focuses its search box on open')
  const readyIds = await add.locator('[data-testid=add-service-ready] [data-testid=add-service-option]').evaluateAll((els) => els.map((e) => e.getAttribute('data-connector')))
  check(readyIds.includes('notion') && readyIds.includes('slack'), 'connected services sit under "Ready to use"', readyIds.join(','))
  check((await add.locator('[data-testid=add-service-option][data-connector=notion]').getAttribute('data-used')) === 'true', 'a service already in the project is marked in use')
  check(/Manage roles/.test((await add.locator('[data-testid=add-service-option][data-connector=notion]').textContent()) ?? ''), 'an in-project service offers "Manage roles"')
  check(/Add to project/.test((await add.locator('[data-testid=add-service-option][data-connector=slack]').textContent()) ?? ''), 'a ready service offers "Add to project"')
  check((await add.locator('[data-testid=add-service-option][data-connector=slack]').getAttribute('aria-label')) === 'Slack, Chat, ready to use', 'option names are short (name, category, status)')
  const optionStops = await add.locator('[role=option]').evaluateAll((els) => els.filter((e) => e.tabIndex === 0).length)
  check(optionStops === 1, 'the picker list is one tab stop', String(optionStops))
  check(/services/.test((await add.locator('[data-testid=add-service-count]').textContent()) ?? ''), 'the picker announces a count')
  await addSearch.press('ArrowDown')
  check(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'option'), 'ArrowDown moves from search into the list')
  await page.keyboard.press('ArrowDown')
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'), 'arrow keys select the focused option')
  await addSearch.fill('zzzqqq')
  await add.locator('[data-testid=add-service-empty]').waitFor({ timeout: 5_000 })
  check((await add.locator('[data-testid=add-service-more]').count()) === 1 && (await add.locator('[data-testid=add-service-assist]').count()) === 1, 'the other ways to add stay pinned in one footer row when nothing matches')
  await addSearch.fill('sla')
  check((await add.locator('[data-testid=add-service-option]').first().getAttribute('data-connector')) === 'slack', 'search "sla" lists Slack first')
  await page.keyboard.press('Escape')
  await add.waitFor({ state: 'detached', timeout: 10_000 })

  // ---- role inspector ----
  await projectTab(page, 'Team').click()
  await page.locator('.react-flow__node', { hasText: role }).first().click()
  const svc = page.locator('[data-testid=role-services]')
  await svc.waitFor({ timeout: 10_000 })
  check((await svc.locator('[data-testid=role-service][data-name=Notion]').count()) === 1, 'role inspector Services lists Notion')
  check((await svc.locator('[data-testid=role-service][data-name=Slack]').count()) === 0, 'role inspector does not list a service the role cannot use')
  await shot('role-services')

  // ---- screenshots, layout ----
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(300)
    for (const theme of ['dark', 'light']) {
      const tag = `${w}x${h}-${theme}`
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await openGallery()
      await noHScroll(`gallery ${tag}`)
      const cols = await page.locator('.connector-grid').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
      check(w >= 1600 ? cols === 3 : cols >= 1, `gallery uses ${w >= 1600 ? 3 : 'at least 1'} columns at ${tag}`, String(cols))
      await shot(`gallery-${tag}`)
      await openDialog('github')
      await noHScroll(`token dialog ${tag}`)
      await shot(`dialog-token-${tag}`)
      await closeDialog()
      await openDialog('slack')
      await noHScroll(`connected dialog ${tag}`)
      await shot(`dialog-connected-${tag}`)
      await closeDialog()
      await openProject(page, NAME)
      await openTeam(page)
      await teamPanelTab(page, 'Catalog').click()
      await page.waitForSelector('[data-testid=connected-service-row][data-connector=notion]', { timeout: 10_000 })
      await noHScroll(`Catalog ${tag}`)
      const nb = await page.locator('[data-testid=connected-service-row][data-connector=notion] .mcp-name').boundingBox()
      check(!!nb && nb.width > 40, `server name is not squeezed at ${tag}`, JSON.stringify(nb))
      await shot(`catalog-${tag}`)
    }
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  await sleep(300)

  // ---- disconnect and remove name the project ----
  await openGallery()
  await openDialog('notion')
  await dialog().locator('[data-testid=connector-disconnect]').click()
  const dText = await confirmTop('Disconnect')
  check(dText.includes(NAME) && /will lose access/.test(dText), 'Disconnect confirmation names the project', dText.slice(0, 200))
  await dialog().locator('[data-testid=connector-connect]').waitFor({ timeout: 10_000 })
  check(true, 'Notion Disconnect signs out and shows Connect again')
  await dialog().locator('[data-testid=connector-remove]').click()
  const rText = await confirmTop('Remove service')
  check(rText.includes(NAME) && /will lose access/.test(rText), 'Remove confirmation names the project', rText.slice(0, 200))
  await dialog().waitFor({ state: 'detached', timeout: 10_000 })
  await page.locator('[data-testid=connector-tile][data-connector=notion][data-state=available]').waitFor({ timeout: 10_000 })
  check(true, 'removing Notion returns its tile to available')
  for (const id of ['slack', 'github', 'deepwiki']) {
    await openDialog(id)
    await dialog().locator('[data-testid=connector-remove]').click()
    await confirmTop('Remove service')
    await dialog().waitFor({ state: 'detached', timeout: 10_000 })
    await page.locator(`[data-testid=connector-tile][data-connector=${id}][data-state=available]`).waitFor({ timeout: 10_000 })
  }
  check(true, 'Slack, GitHub and DeepWiki removed')
  await openProject(page, NAME)
  await openTeam(page)
  await teamPanelTab(page, 'Catalog').click()
  await page.waitForSelector('[data-testid=catalog-connections]', { timeout: 10_000 })
  check((await page.locator('[data-testid=connected-service-row]').count()) === 0, 'Catalog no longer lists the removed services')
} catch (e) {
  check(false, 'connectors flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(base)
}
finish('e2e/connectors')
