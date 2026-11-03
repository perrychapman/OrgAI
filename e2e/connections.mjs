// Token-free. Opens App settings > Connections and a project's Settings (connection picker, MCP servers, plugins,
// role model picker), checks the markup exists in either its loaded or its error state (the IPC handlers may
// still be stubs), and takes screenshots at 1024x640 and 1600x1000 in both themes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, TMP, check, openAppSettings, openProject, openTeam, projectTab, teamPanelTab, cleanup, createProject, finish, launch, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const savedProvider = (page, name) => page.evaluate(async (n) => (await window.orgai.projects.list()).find((p) => p.name === n)?.provider?.id, name)
let toggleDone = false
const NAME = 'E2E connections (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-conn-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('conn', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'conn' })
const details = (pane) => page.locator(`[data-testid=settings-advanced][data-pane=${pane}]`)
const advSummary = (pane) => page.locator(`[data-testid=settings-advanced][data-pane=${pane}] > summary`)
const openAdvanced = async (pane) => {
  if (!(await details(pane).evaluate((el) => el.open))) await advSummary(pane).click()
}
const closeAdvanced = async (pane) => {
  if (await details(pane).evaluate((el) => el.open)) await advSummary(pane).click()
}

try {
  // The built renderer no longer names the removed Defaults pane (spec 8.1).
  const rendererOut = fileURLToPath(new URL('../out/renderer', import.meta.url))
  const bundled = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? bundled(path.join(d, e.name)) : /.(js|html|css)$/.test(e.name) ? [path.join(d, e.name)] : []))
  const withDefaults = fs.existsSync(rendererOut) ? bundled(rendererOut).filter((f) => fs.readFileSync(f, 'utf8').includes('App settings > Defaults')) : []
  check(fs.existsSync(rendererOut) && withDefaults.length === 0, 'the built renderer has no "App settings > Defaults" text', withDefaults.join(', '))
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME, useMock: false })
  check(!!project, 'project created')

  const sizes = [[1024, 640], [1600, 1000]]
  for (const [w, h] of sizes) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(300)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)

      // App settings > Connections
      await openAppSettings(page)
      await page.getByRole('tab', { name: 'Connections', exact: true }).click()
      await page.waitForSelector('#connections-title', { timeout: 10_000 })
      await sleep(800)
      const cards = await page.locator('[data-testid=connection-card]').count()
      const errBanner = await page.getByText('Could not load connections').count()
      check(cards === 3 || errBanner === 1, `connections page shows three cards or a load error at ${w}x${h} ${theme}`, `${cards}/${errBanner}`)
      const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      check(ov.sw <= ov.cw, `no horizontal scroll on connections at ${w}x${h} ${theme}`, JSON.stringify(ov))
      await shot(`connections-${w}x${h}-${theme}`)

      // Five panes, no Defaults tab (config-review spec 8.1)
      const tabNames = await page.getByRole('tab').allTextContents()
      check(!tabNames.includes('Defaults') && ['General', 'Connections', 'Connectors', 'Skill library', 'About'].every((n) => tabNames.includes(n)), `App settings has no Defaults tab at ${w}x${h} ${theme}`, tabNames.join(', '))

      // Connections: one default badge, "Use for new projects" only on other connected cards, one polite live region
      check((await page.locator('[data-testid=default-connection-badge]').count()) === 1, `exactly one default-connection badge at ${w}x${h} ${theme}`)
      const badgeCard = page.locator('[data-testid=connection-card]:has([data-testid=default-connection-badge])')
      check(/Default for new projects and assistants/.test((await badgeCard.locator('[data-testid=default-connection-badge]').textContent()) ?? ''), 'default badge text reads "Default for new projects and assistants"')
      check(/^(Chosen|Automatic)$/.test(((await badgeCard.locator('[data-testid=default-connection-mode]').textContent()) ?? '').trim()), 'default badge is followed by Chosen or Automatic')
      const listed = await page.evaluate(() => window.orgai.connections.list())
      for (const c of listed) {
        const card = page.locator(`[data-testid=connection-card][data-provider=${c.connection.id}]`)
        const makeDefault = card.locator('[data-testid=connection-make-default]')
        if (c.status.state !== 'connected') {
          check((await makeDefault.count()) === 0, `${c.connection.id} is not connected, so it has no "Use for new projects" button at ${w}x${h} ${theme}`)
        } else if (!c.isDefault) {
          check((await makeDefault.count()) === 1 && ((await makeDefault.getAttribute('aria-label')) ?? '').startsWith('Use for new projects'), `${c.connection.id} connected non-default card offers "Use for new projects" with a label-in-name`)
        }
      }
      const liveRegions = await page.locator('#appsettings-section-connections [role=status], #appsettings-section-connections [aria-live=polite]').count()
      check(liveRegions === 1, `the Connections pane has one polite live region at ${w}x${h} ${theme}`, String(liveRegions))
      // Costs live in the pane's Advanced
      await closeAdvanced('app-connections')
      check(!(await page.locator('[data-testid=model-prices]').isVisible()) && !(await page.locator('#community-prices-row').isVisible()), `Costs and Model prices are hidden while Connections Advanced is closed at ${w}x${h} ${theme}`)
      await openAdvanced('app-connections')
      check((await page.locator('[data-testid=model-prices]').isVisible()) && (await page.locator('#community-prices-row').isVisible()), `Costs and Model prices show with Connections Advanced open at ${w}x${h} ${theme}`)
      check((await page.locator('#appsettings-section-costs .settings-section-lead').textContent())?.trim() === 'Where cost estimates come from.', 'Costs lead reads "Where cost estimates come from."')
      await shot(`connections-advanced-${w}x${h}-${theme}`)
      await closeAdvanced('app-connections')

      // General: at rest no model select (spec 8.3); Advanced holds the model rows
      await page.getByRole('tab', { name: 'General', exact: true }).click()
      await page.locator('[data-testid=new-projects-section]').waitFor({ timeout: 10_000 })
      await closeAdvanced('app-general')
      const restSelects = page.locator('select')
      const rest = { modelSelects: 0, labels: [] }
      for (let i = 0; i < (await restSelects.count()); i++) {
        const sel = restSelects.nth(i)
        if (!(await sel.isVisible())) continue
        if (/-model-row-select$/.test((await sel.getAttribute('data-testid')) ?? '')) rest.modelSelects++
        rest.labels.push(...(await sel.locator('option').allTextContents()).map((t) => t.trim()))
      }
      const concrete = rest.labels.filter((t) => !/\s/.test(t) && /[-.\d]/.test(t) && !/\b(top|deep|everyday|fast)\b/i.test(t))
      check(rest.modelSelects === 0, `App General at rest shows no model select at ${w}x${h} ${theme}`, String(rest.modelSelects))
      check(concrete.length === 0, `no visible select option at rest is a concrete model id at ${w}x${h} ${theme}`, concrete.join(', '))
      const modeSel = page.locator('[data-testid=default-mode-select]')
      check((await modeSel.count()) === 1, 'Permission mode select (default-mode-select) is in New projects')
      const mb = await modeSel.boundingBox()
      check(!!mb && mb.width >= 170 && mb.width <= 250, `Permission mode select is about 240 px wide at ${w}x${h} ${theme}`, JSON.stringify(mb))
      check(/Starting values for new projects\. Existing projects keep their own\./.test((await page.locator('[data-testid=new-projects-section]').textContent()) ?? ''), 'New projects lead reads as specced')
      await shot(`general-${w}x${h}-${theme}`)
      await openAdvanced('app-general')
      for (const name of ['Setup model', 'MCP assistant model', 'Skill assistant model', 'Chat model', 'Orchestrator starting tier', 'Report starting tier']) {
        check((await page.getByRole('combobox', { name, exact: true }).count()) === 1, `${name} select in General Advanced at ${w}x${h} ${theme}`)
      }
      const note = page.getByText("Tiers resolve through each project's connection.", { exact: true })
      check((await note.count()) === 1, `Assistant models note present at ${w}x${h} ${theme}`)
      await note.scrollIntoViewIfNeeded()
      const defOv = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      check(defOv.sw <= defOv.cw, `no horizontal scroll on General at ${w}x${h} ${theme}`, JSON.stringify(defOv))
      const nb = await note.boundingBox()
      check(!!nb && nb.x >= 0 && nb.x + nb.width <= w + 0.5, `Assistant models note inside the viewport at ${w}x${h} ${theme}`, JSON.stringify(nb))
      await shot(`general-advanced-${w}x${h}-${theme}`)
      const tierLabels = await page.locator('[data-testid=setup-model-row-select] option').evaluateAll((os) => os.map((o) => (o.textContent ?? '').trim()))
      check(['Top', 'Deep', 'Everyday', 'Fast'].every((t) => tierLabels.some((l) => l.startsWith(`${t} tier`))) && tierLabels.every((l) => !/^(deep|everyday|fast|top)$/i.test(l)), `model selects list the four tiers with labels, not raw ids at ${w}x${h} ${theme}`, tierLabels.join(' | '))
      const resolved = tierLabels.filter((l) => /^(Top|Deep|Everyday|Fast) tier \(.+\)$/.test(l))
      check(resolved.length > 0, `tier options name the model they resolve to on the default connection at ${w}x${h} ${theme}`, tierLabels.join(' | '))
      // The selected tier label must fit its select (no ellipsis on the label itself).
      const clipped = await page.evaluate(() => {
        const c = document.createElement('canvas').getContext('2d')
        return [...document.querySelectorAll('.model-select select, select.mono-select')].flatMap((el) => {
          const cs = getComputedStyle(el)
          c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
          const label = (el.selectedOptions[0]?.textContent ?? '').trim()
          const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20
          return / tier( \(.+\))?$/i.test(label) && c.measureText(label).width > avail ? [`${label} ${Math.round(c.measureText(label).width)}>${Math.round(avail)}`] : []
        })
      })
      check(clipped.length === 0, `tier labels are not clipped in General Advanced selects at ${w}x${h} ${theme}`, clipped.join(', '))
      if (w === 1024 && theme === 'dark') {
        // Setup model persists across reopening App settings, and Advanced is remembered open
        const sm = () => page.getByRole('combobox', { name: 'Setup model', exact: true })
        const smOpts = await sm().locator('option').evaluateAll((os) => os.map((o) => o.value))
        const smBefore = await sm().inputValue()
        const smWant = smOpts.find((v) => v !== smBefore)
        if (smWant) {
          await sm().selectOption(smWant)
          await sleep(600)
          await page.reload()
          await page.waitForSelector('.nav-item', { timeout: 15_000 })
          await openAppSettings(page)
          await page.getByRole('tab', { name: 'General', exact: true }).click()
          await page.locator('[data-testid=new-projects-section]').waitFor({ timeout: 10_000 })
          check(await page.locator('[data-testid=settings-advanced][data-pane=app-general]').evaluate((el) => el.open), 'General Advanced is still open after reopening App settings')
          check((await sm().inputValue()) === smWant, 'Setup model persists after reopening App settings', smWant)
          // Restore only a listed value (temp data dir; the leftover is harmless).
          if ((await sm().locator('option').evaluateAll((os) => os.map((o) => o.value))).includes(smBefore)) await sm().selectOption(smBefore)
          await sleep(600)
          await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        }

        // Spec 8.6: the Advanced summary's name, keys, focus ring and per-pane persistence
        for (const pane of ['app-general', 'app-connections']) {
          if (pane === 'app-connections') {
            await page.getByRole('tab', { name: 'Connections', exact: true }).click()
            await page.waitForSelector('#connections-title', { timeout: 10_000 })
          }
          const sum = advSummary(pane)
          check(((await sum.innerText()) ?? '').trim() === 'Advanced settings' && (await sum.getAttribute('aria-label')) === null, `${pane} Advanced summary is named exactly "Advanced settings"`)
          await closeAdvanced(pane)
          await sum.focus()
          await page.keyboard.press('Enter')
          check(await details(pane).evaluate((el) => el.open), `${pane} Advanced opens with Enter`)
          await page.keyboard.press('Space')
          check(!(await details(pane).evaluate((el) => el.open)), `${pane} Advanced closes with Space`)
          await page.keyboard.press('Space')
          check(await details(pane).evaluate((el) => el.open), `${pane} Advanced opens with Space`)
          await page.keyboard.press('Shift+Tab')
          await page.keyboard.press('Tab')
          const ring = await sum.evaluate((el) => {
            const cs = getComputedStyle(el)
            return { fv: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }
          })
          check(ring.fv && ring.style !== 'none' && ring.width > 0, `${pane} Advanced summary shows a focus ring`, JSON.stringify(ring))
          await page.reload()
          await page.waitForSelector('.nav-item', { timeout: 15_000 })
          await openAppSettings(page)
          await page.getByRole('tab', { name: pane === 'app-general' ? 'General' : 'Connections', exact: true }).click()
          await page.locator(`[data-testid=settings-advanced][data-pane=${pane}]`).waitFor({ timeout: 10_000 })
          check(await details(pane).evaluate((el) => el.open), `${pane} Advanced stays open after a reload`)
          await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        }
        await page.getByRole('tab', { name: 'General', exact: true }).click()

        // Spec 8.7: deep links land on the right pane with Advanced open and focus on the heading
        const deepLink = async (section) => {
          await page.evaluate((s) => {
            sessionStorage.setItem('orgai.pendingSettingsSection', s)
            window.dispatchEvent(new Event('orgai:settings-section'))
          }, section)
          await sleep(1200)
        }
        await closeAdvanced('app-general')
        await page.getByRole('tab', { name: 'Connections', exact: true }).click()
        await closeAdvanced('app-connections')
        await page.getByRole('tab', { name: 'About', exact: true }).click()
        await deepLink('appsettings-section-model-prices')
        check((await page.getByRole('tab', { name: 'Connections', exact: true }).getAttribute('aria-selected')) === 'true', 'model-price deep link lands on Connections')
        check(await details('app-connections').evaluate((el) => el.open), 'model-price deep link opens Connections Advanced')
        const priceFocus = await page.evaluate(() => {
          const a = document.activeElement
          return { inSection: !!a?.closest('#appsettings-section-model-prices'), text: (a?.textContent ?? '').trim().slice(0, 40) }
        })
        check(priceFocus.inSection, 'model-price deep link focuses the Model prices section', JSON.stringify(priceFocus))
        await deepLink('appsettings-section-costs')
        check(await page.evaluate(() => document.activeElement?.closest('#appsettings-section-costs') !== null), 'costs deep link focuses the Costs section title')
        await page.getByRole('tab', { name: 'About', exact: true }).click()
        await deepLink('appsettings-section-assistant-models')
        check((await page.getByRole('tab', { name: 'General', exact: true }).getAttribute('aria-selected')) === 'true' && (await details('app-general').evaluate((el) => el.open)), 'assistant-models deep link lands on General with Advanced open')
        check(await page.evaluate(() => document.activeElement?.matches('#appsettings-section-assistant-models h4') === true), 'assistant-models deep link focuses the group heading')
        await page.getByRole('tab', { name: 'About', exact: true }).click()
        await deepLink('appsettings-section-defaults')
        check((await page.getByRole('tab', { name: 'General', exact: true }).getAttribute('aria-selected')) === 'true', 'the removed Defaults id opens General')
        // Section ids that used to sit under Defaults are gone from the DOM
        check((await page.locator('#appsettings-section-defaults, #appsettings-section-usage').count()) === 0, 'no Defaults or usage sections in the DOM')
      }

      // About block
      await page.getByRole('tab', { name: 'About', exact: true }).click()
      const about = page.locator('[data-testid=about-block]')
      check((await about.count()) === 1, `about block present at ${w}x${h} ${theme}`)
      await about.scrollIntoViewIfNeeded()
      const aboutText = (await about.textContent()) ?? ''
      check(aboutText.includes(PKG_VERSION), `about block shows version ${PKG_VERSION}`, aboutText.slice(0, 80))
      const info = await page.evaluate(() => window.orgai.app.info())
      check(fs.realpathSync(info.dataDir) === fs.realpathSync(DATA_DIR), 'app.info dataDir equals ORGAI_DATA_DIR', info.dataDir)
      const shownPaths = await about.locator('.about-path .mono').allTextContents()
      check(shownPaths.some((t) => { try { return fs.realpathSync(t) === fs.realpathSync(DATA_DIR) } catch { return false } }), 'about block shows the data folder', shownPaths.join(' | '))
      const aboutOv = await about.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
      check(aboutOv.sw <= aboutOv.cw + 1, `about block does not overflow at ${w}x${h} ${theme}`, JSON.stringify(aboutOv))
      await shot(`about-${w}x${h}-${theme}`)

      // Project settings
      await openProject(page, NAME)
      await openTeam(page)
      await teamPanelTab(page, 'Catalog').click()
      await page.waitForSelector('[data-testid=catalog-connections]', { timeout: 10_000 })
      await sleep(600)
      check((await page.locator('[data-testid=catalog-connections]').count()) === 1, `Connections section present in the Catalog at ${w}x${h} ${theme}`)
      check((await page.locator('[data-testid=catalog-plugins]').count()) === 1, `Plugins section present in the Catalog at ${w}x${h} ${theme}`)
      check((await page.locator('[data-testid=catalog-plugins] [data-testid=plugins-section]').count()) === 1, `plugins-section sits inside the Catalog plugins group at ${w}x${h} ${theme}`)
      check((await page.locator('[data-testid=catalog-skills]').count()) === 1, `Skills section present in the Catalog at ${w}x${h} ${theme}`)
      check((await page.locator('[data-testid=mcp-add-service]').count()) === 1 && (await page.locator('[data-testid=mcp-add-other]').count()) === 0, 'exactly one Add a connection button, no second add menu')
      const toolsOv = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      check(toolsOv.sw <= toolsOv.cw, `no horizontal scroll on the Catalog at ${w}x${h} ${theme}`, JSON.stringify(toolsOv))
      await page.locator('[data-testid=catalog-connections]').scrollIntoViewIfNeeded()
      await shot(`catalog-connections-${w}x${h}-${theme}`)
      await page.locator('[data-testid=catalog-skills]').scrollIntoViewIfNeeded()
      await shot(`catalog-skills-${w}x${h}-${theme}`)
      await projectTab(page, 'Settings').click()
      await page.getByRole('tab', { name: 'General', exact: true }).click()
      await page.waitForSelector('#settings-section-connection', { timeout: 10_000 })
      await page.locator('#settings-section-connection').scrollIntoViewIfNeeded()
      const toggle = page.locator('[data-testid=mock-adapter-toggle]')
      check((await toggle.count()) === 1, `mock toggle present at ${w}x${h} ${theme}`)
      if (!toggleDone) {
        toggleDone = true
        const before = await savedProvider(page, NAME)
        check((await toggle.getAttribute('aria-checked')) === 'false', 'mock toggle starts unchecked', String(before))
        await toggle.click()
        await sleep(800)
        check((await toggle.getAttribute('aria-checked')) === 'true', 'mock toggle is checked after click')
        check((await savedProvider(page, NAME)) === 'mock', 'saved provider.id is mock when toggled on')
        if (await page.locator('[data-testid=project-connection]').count()) check(await page.locator('[data-testid=project-connection]').evaluate((el) => el.disabled), 'connection fieldset disabled while mock is on')
        else check((await page.locator('[data-testid=project-connection-line]').count()) === 1, 'one connection connected: the project shows its connection line')
        await shot(`mock-on-${w}x${h}-${theme}`)
        await toggle.click()
        await sleep(800)
        check((await toggle.getAttribute('aria-checked')) === 'false', 'mock toggle unchecked after second click')
        const after = await savedProvider(page, NAME)
        check(after === before && (after === 'claude' || after === 'codex'), 'provider.id restored to the connection adapter', String(after))
        if (await page.locator('[data-testid=project-connection]').count()) check(!(await page.locator('[data-testid=project-connection]').evaluate((el) => el.disabled)), 'connection fieldset enabled again')
      }
      await shot(`project-connection-${w}x${h}-${theme}`)

      // Role inspector model picker
      await projectTab(page, 'Team').click()
      await page.locator('.react-flow__node').first().click()
      // The Model fold is closed when the inspector is not roomy; open it first.
      await page.waitForSelector('[data-testid=role-model-fold]', { timeout: 5000 })
      await page.evaluate(() => { const d = document.querySelector('[data-testid=role-model-fold]'); if (d) d.open = true })
      await page.waitForSelector('[data-testid=role-model]', { timeout: 5000 })
      const roleLabel = ((await page.locator('[data-testid=role-model]').evaluate((el) => (el.matches('select') ? el : el.querySelector('select'))?.selectedOptions[0]?.textContent ?? '')) || '').trim()
      // Spec 5: tier options read "Everyday (sonnet)" (tier word first); Inherit / the connection default otherwise.
      check(/^(top|deep|everyday|fast)\b/i.test(roleLabel) || /inherit|connection default/i.test(roleLabel), `role model select shows a tier or Inherit at ${w}x${h} ${theme}`, roleLabel)
      // Spec 8.3: at rest (role Advanced closed) no option of the Model select is a bare concrete model id.
      const bareIds = await page.locator('[data-testid=role-model]').evaluate((el) =>
        [...((el.matches('select') ? el : el.querySelector('select'))?.options ?? [])].map((o) => (o.textContent ?? '').trim()).filter((t) => !/^(top|deep|everyday|fast)\b|inherit|connection default|custom/i.test(t))
      )
      check(bareIds.length === 0, `role Model select lists only tiers and Inherit at ${w}x${h} ${theme}`, bareIds.join(', '))
      await shot(`role-model-${w}x${h}-${theme}`)
    }
  }

  // MCP library: add a stdio server by hand in App settings, then link it from the project's settings.
  try {
    await openAppSettings(page)
    await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
    const libSec = page.locator('[data-testid=mcp-library-section]')
    await libSec.waitFor({ timeout: 10_000 })
    await libSec.scrollIntoViewIfNeeded()
    await libSec.locator('[data-testid=mcp-library-add-manual]').click()
    const form = page.locator('[data-testid=mcp-form]')
    await form.getByLabel('Name', { exact: true }).fill('e2e-lib-server')
    await form.getByLabel('Command', { exact: true }).fill('npx')
    await form.getByLabel('Arguments').fill('-y\ne2e-lib-server@1.0.0')
    await form.getByRole('button', { name: 'Add variable' }).click()
    await form.getByLabel('Name of variable 1').fill('E2E_TOKEN')
    await form.getByRole('checkbox', { name: 'Secret' }).check()
    await form.getByRole('button', { name: 'Add server' }).click()
    await form.waitFor({ state: 'detached', timeout: 10_000 })
    const row = libSec.locator('[data-testid=mcp-library-row][data-server=e2e-lib-server]')
    await row.waitFor({ timeout: 10_000 })
    check(/Secrets: \d+ of 1 set/.test((await row.textContent()) ?? ''), 'library row shows the secrets summary')
    await shot('mcp-library-row')
    await openProject(page, NAME)
    await openTeam(page)
    await teamPanelTab(page, 'Catalog').click()
    await page.locator('[data-testid=catalog-connections]').scrollIntoViewIfNeeded()
    await page.locator('[data-testid=mcp-add-service]').click()
    await page.locator('[data-testid=add-service-more]').click()
    await page.locator('[data-testid=add-service-link]').click()
    const dlg = page.locator('[data-testid=mcp-link-dialog]')
    await dlg.getByText('e2e-lib-server').first().click()
    const roleBoxes = dlg.getByRole('checkbox')
    if (await roleBoxes.count()) await roleBoxes.first().check()
    await dlg.locator('[data-testid=mcp-link-confirm]').click()
    await dlg.waitFor({ state: 'detached', timeout: 10_000 })
    const linked = page.locator('[data-testid=catalog-connections] [data-testid=mcp-row-library-badge]')
    await linked.first().waitFor({ timeout: 10_000 })
    check((await linked.count()) >= 1, 'linked library server shows the library badge in project settings')
    await shot('mcp-linked-row')
  } catch (e) {
    check(false, 'MCP library add and link flow', String(e.message ?? e).split('\n')[0])
    await shot('mcp-library-error').catch(() => {})
  }

  // Connectors gallery: connect Notion (mock sign-in), check it, disconnect, remove.
  try {
    await openAppSettings(page)
    await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
    const gal = page.locator('[data-testid=connectors-section]')
    await gal.waitFor({ timeout: 10_000 })
    const tile = gal.locator('[data-testid=connector-tile][data-connector=notion]')
    await tile.waitFor({ timeout: 10_000 })
    check((await tile.getAttribute('data-state')) === 'available', 'Notion tile starts available')
    await shot('connectors-gallery')
    await tile.locator('[data-testid=connector-action]').click()
    const cd = page.locator('[data-testid=connector-dialog]')
    await cd.locator('[data-testid=connector-connect]').click()
    await cd.locator('[data-testid=connector-status]').waitFor({ timeout: 15_000 })
    await shot('connectors-dialog-connected')
    await cd.locator('[data-testid=connector-test]').click()
    await cd.locator('[data-testid=connector-tools]').waitFor({ timeout: 15_000 })
    check(true, 'connector dialog connects and lists tools')
    await cd.locator('[data-testid=connector-remove]').click()
    await page.getByRole('button', { name: 'Remove service', exact: true }).last().click()
    await cd.waitFor({ state: 'detached', timeout: 10_000 })
    await tile.and(page.locator('[data-state=available]')).waitFor({ timeout: 10_000 })
    check(true, 'removing a connector returns its tile to available')
  } catch (e) {
    check(false, 'Connectors gallery connect flow', String(e.message ?? e).split('\n')[0])
    await shot('connectors-error').catch(() => {})
  }

  // LiteLLM against an unreachable proxy: error state (no crash), and the key never lands in plain text on disk.
  const CANARY = 'sk-e2e-canary-9f3a7c1d'
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Connections', exact: true }).click()
  await page.waitForSelector('#connections-title', { timeout: 10_000 })
  const lite = page.locator('[data-testid=connection-card][data-provider=litellm]')
  if ((await lite.count()) === 1) {
    check((await lite.locator('.conn-mark svg').count()) >= 1, 'LiteLLM card renders its fallback icon svg in .conn-mark')
    if ((await lite.locator('#litellm-url').count()) === 0) await lite.getByRole('button', { name: /^Expand/ }).click()
    const stored = await page.evaluate((k) => window.orgai.connections.setSecret({ id: 'litellm', apiKey: k }).then(() => true, () => false), CANARY)
    console.log('canary key stored:', stored)
    await lite.locator('#litellm-url').fill('http://127.0.0.1:9')
    await lite.getByRole('button', { name: 'Test and connect' }).click()
    await page.waitForFunction(
      () => /error|fail|reach|refused|ECONN|timed/i.test(document.querySelector('[data-provider=litellm] [data-testid=connection-status]')?.textContent ?? ''),
      null,
      { timeout: 30_000 }
    ).catch(() => {})
    const status = (await lite.locator('[data-testid=connection-status]').textContent()) ?? ''
    check(/error|fail|reach|refused|ECONN|timed/i.test(status), 'LiteLLM test against an unreachable URL shows an error state', status)
    check(!status.includes(CANARY), 'status text has no secret')
    check((await page.locator('[data-testid=connection-card]').count()) === 3, 'connections page still lists three cards after the failed test')
    await shot('litellm-unreachable')
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['runs', 'Cache', 'Code Cache', 'GPUCache', 'blob_storage'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]))
    const leaks = walk(userData).filter((f) => { try { return fs.statSync(f).size < 20e6 && fs.readFileSync(f).includes(CANARY) } catch { return false } })
    check(leaks.length === 0, 'no plain-text secret in settings, projects or logs in the data dir', leaks.join(', '))
    await lite.getByRole('button', { name: 'Remove connection' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove connection' }).click()
    await sleep(800)
    check((await page.evaluate(() => window.orgai.connections.list())).find((c) => c.connection.id === 'litellm')?.connection.hasApiKey !== true, 'Remove connection clears the stored key')
    await openProject(page, NAME)
  } else {
    check(false, 'LiteLLM card present')
  }
} catch (e) {
  check(false, 'connections flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(base)
}
finish('e2e/connections')
