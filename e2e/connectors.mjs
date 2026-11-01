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
  check((await tile('github').getAttribute('data-state')) === 'needsSetup', 'GitHub tile is Needs setup after Disconnect')
  check(/Needs setup/.test((await tile('github').locator('[data-testid=connector-state]').textContent()) ?? ''), 'GitHub tile says Needs setup')

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
  check(new RegExp(`Can use: ${role}`).test((await row.textContent()) ?? ''), `Catalog row shows "Can use: ${role}"`, ((await row.textContent()) ?? '').slice(0, 200))
  check((await row.locator('[data-testid=connector-use]').count()) === 0, 'the Use button is gone once linked')

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
  for (const id of ['slack', 'github']) {
    await openDialog(id)
    await dialog().locator('[data-testid=connector-remove]').click()
    await confirmTop('Remove service')
    await dialog().waitFor({ state: 'detached', timeout: 10_000 })
    await page.locator(`[data-testid=connector-tile][data-connector=${id}][data-state=available]`).waitFor({ timeout: 10_000 })
  }
  check(true, 'Slack and GitHub removed')
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
