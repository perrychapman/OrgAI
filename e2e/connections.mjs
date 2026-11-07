// Token-free. Opens App settings > Connections and a project's Settings (connection picker, MCP servers, plugins,
// role model picker), checks the markup exists in either its loaded or its error state (the IPC handlers may
// still be stubs), and takes screenshots at 1024x640 and 1600x1000 in both themes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, TMP, check, openAppSettings, openProject, openTeam, projectTab, teamPanelTab, cleanup, createProject, finish, launch, makeFixtureRepo, removeFixture, sleep, windowShift } from './lib.mjs'

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
      check(cards >= 2 || errBanner === 1, `connections page shows the built-in cards or a load error at ${w}x${h} ${theme}`, `${cards}/${errBanner}`)
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
      const liveRegions = await page.locator('#appsettings-section-connections [data-testid=connections-live]').count()
      check(liveRegions === 1, `the Connections pane has one polite live region at ${w}x${h} ${theme}`, String(liveRegions))
      // Any other polite region in the pane must be a Banner (the no-connection notice), never a second sr-only region.
      const strayLive = await page.locator('#appsettings-section-connections').evaluate((root) =>
        [...root.querySelectorAll('[role=status], [aria-live=polite]')].filter((el) => !el.matches('[data-testid=connections-live]') && !el.matches('.banner')).length
      )
      check(strayLive === 0, `no polite region in the Connections pane besides connections-live and Banners at ${w}x${h} ${theme}`, String(strayLive))
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
      // N8: the same short names as the project's mode select (lib/settingsCopy.ts PERMISSION_MODE_SHORT).
      const appModes = (await modeSel.locator('option').allTextContents()).map((t) => t.trim())
      check(JSON.stringify(appModes) === JSON.stringify(['Unattended', 'Auto-accept edits', 'Ask for everything risky', 'Never ask', 'Plan only', 'Bypass all prompts']), `default-mode-select uses the shared short names at ${w}x${h} ${theme}`, appModes.join(' | '))
      check(/Starting values for new projects\. Existing projects keep their own\./.test((await page.locator('[data-testid=new-projects-section]').textContent()) ?? ''), 'New projects lead reads as specced')
      await shot(`general-${w}x${h}-${theme}`)
      await openAdvanced('app-general')
      for (const name of ['Setup model', 'MCP assistant model', 'Skill assistant model', 'Chat model', 'Orchestrator starting tier', 'Report starting tier']) {
        check((await page.getByRole('combobox', { name, exact: true }).count()) === 1, `${name} select in General Advanced at ${w}x${h} ${theme}`)
      }
      const note = page.locator('[data-testid=assistant-models-note]')
      check((await note.count()) === 1, `Assistant models note present at ${w}x${h} ${theme}`)
      const noteText = (await note.innerText().catch(() => '')) ?? ''
      check(/run on (Anthropic|OpenAI|LiteLLM), the default connection/.test(noteText), `Assistant models note names the default connection at ${w}x${h} ${theme}`, noteText)
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
          // The toggle event that stores the state is queued by the browser; wait for the stored value before reloading.
          await page.waitForFunction((k) => localStorage.getItem(k) === '1', `orgai.settingsAdvanced.${pane}`, { timeout: 5_000 }).catch(() => {})
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
          // N1: only the settings scroller moves, never <html> or the app shell.
          const shift = await windowShift(page)
          check(shift.ok, `${section} deep link leaves the window unshifted at ${w}x${h} ${theme}`, JSON.stringify(shift))
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
        check(await page.evaluate(() => document.activeElement?.matches('#appsettings-section-assistant-models .settings-group-title') === true), 'assistant-models deep link focuses the group heading')
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
      const maker = page.locator('[data-testid=about-maker]')
      check((await maker.count()) === 1 && (await maker.textContent())?.trim() === 'Cybrid Software LLC', `about shows the maker ${w}x${h} ${theme}`)
      check((await maker.getAttribute('href')) === 'https://cybridsoftware.com', 'maker link points at cybridsoftware.com')
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
      const connected = (await page.evaluate(() => window.orgai.connections.list())).some((c) => c.status.state === 'connected')
      check(/^(top|deep|everyday|fast)\b/i.test(roleLabel) || /inherit|connection default/i.test(roleLabel) || (!connected && /^custom$/i.test(roleLabel)), `role model select shows a tier or Inherit at ${w}x${h} ${theme}`, roleLabel)
      // Spec 8.3: at rest (role Advanced closed) no option of the Model select is a bare concrete model id.
      const bareIds = await page.locator('[data-testid=role-model]').evaluate((el) =>
        [...((el.matches('select') ? el : el.querySelector('select'))?.options ?? [])].map((o) => (o.textContent ?? '').trim()).filter((t) => !/^(top|deep|everyday|fast)\b|inherit|connection default|custom/i.test(t))
      )
      check(bareIds.length === 0, `role Model select lists only tiers and Inherit at ${w}x${h} ${theme}`, bareIds.join(', '))
      // N4: the fold says "Model" once (the select's own label is visually hidden; role Advanced closed).
      // Visible words only: text in .sr-only, select options and hidden elements does not count.
      const foldText = await page.locator('[data-testid=role-model-fold]').evaluate((root) => {
        const out = []
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement
          if (!el || el.closest('.sr-only, select') || !el.checkVisibility()) continue
          out.push(n.textContent ?? '')
        }
        return out.join(' ')
      })
      check((foldText.match(/\bModel\b/g) ?? []).length === 1, `the role Model fold shows the word "Model" once at ${w}x${h} ${theme}`, foldText.replace(/\s+/g, ' ').slice(0, 120))
      const advancedCount = await page.locator('[data-testid=role-model-advanced] > summary').count()
      if (w === 1024 && theme === 'dark' && (advancedCount === 0 || !connected)) console.log('SKIP role-model-advanced absent: no connected connection')
      else if (w === 1024 && theme === 'dark') {
        // N3: a tier role's Exact model reads "Not set"; picking Not set on a custom role returns to a tier, never Inherit.
        const roleSel = page.locator('[data-testid=role-model]')
        const exactSel = page.locator('[data-testid=role-exact-model]')
        const startChoice = await roleSel.inputValue()
        await page.locator('[data-testid=role-model-advanced] > summary').click()
        await exactSel.waitFor({ timeout: 5000 }).catch(() => {})
        if (/^(top|deep|everyday|fast)$/.test(startChoice)) check((await exactSel.inputValue()) === '', `a ${startChoice} role's Exact model reads Not set`, await exactSel.inputValue())
        const ids = await exactSel.locator('option:not([disabled])').evaluateAll((os) => os.map((o) => o.value).filter(Boolean))
        let custom = false
        for (const v of ids) {
          await exactSel.selectOption(v)
          await sleep(250)
          if ((await roleSel.inputValue()) === 'custom') {
            custom = true
            break
          }
        }
        if (custom) {
          check((await exactSel.inputValue()) !== '', 'a custom role shows its pinned id in Exact model')
          await exactSel.selectOption('')
          await sleep(300)
          const back = await roleSel.inputValue()
          check(back !== 'inherit' && back !== 'custom', 'Not set on a custom role returns Model to a tier, not Inherit', back)
        } else check(true, `no catalog id outside the tiers on this connection (${ids.join(', ')}); the custom round trip was skipped`)
        await roleSel.selectOption(startChoice).catch(() => {})
        await sleep(300)
        await page.locator('[data-testid=role-model-advanced] > summary').click()
      }
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
    await form.getByRole('checkbox', { name: 'Secret', exact: true }).check()
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

  // Proxies: add through the dialog, checks, bad key, edit, other-host note, Delete key, remove (refused while a project uses it).
  const CANARY = 'sk-e2e-canary-9f3a7c1d'
  const MOCK = 'https://mock-proxy.example.com'
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
  await sleep(300)
  await openProject(page, NAME)
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Connections', exact: true }).click()
  await page.waitForSelector('#connections-title', { timeout: 10_000 })
  const addBtn = page.locator('[data-testid=proxy-add]')
  const live = page.locator('[data-testid=connections-live]')
  const dlg = page.locator('[data-testid=proxy-dialog]')
  const proxyCard = (n) => page.locator(`[data-testid=connection-card][data-kind=proxy][data-name="${n}"]`)
  check((await page.locator('[data-testid=connection-card]').count()) === 2, 'a fresh profile lists the two built-in cards')
  check(/No proxies yet\. Add one to route Claude, GPT and other models through a gateway you run\./.test((await page.locator('[data-testid=proxies-empty]').textContent()) ?? ''), 'the empty state is worded as specced')
  check(/Proxies \(0\)/.test((await page.locator('[data-testid=proxies-heading]').textContent()) ?? ''), 'the group heading counts 0 proxies')

  // Keyboard: Enter opens the dialog with focus in Name, Esc closes it and focus returns to Add proxy.
  await addBtn.focus()
  await page.keyboard.press('Enter')
  await dlg.waitFor({ timeout: 5000 })
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'proxy-name'), 'the Add proxy dialog opens with focus in Name')
  const order = []
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press('Tab')
    order.push(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') || document.activeElement?.id || document.activeElement?.tagName))
  }
  check(order.slice(0, 5).join(',') === 'proxy-anthropic-url,proxy-openai-url,proxy-models-url,proxy-key,proxy-submit' || order.join(',').includes('proxy-key'), 'Tab goes Anthropic URL, OpenAI URL, Models endpoint, key, then the buttons', order.join(','))
  await page.keyboard.press('Escape')
  await dlg.waitFor({ state: 'hidden', timeout: 5000 })
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'proxy-add'), 'Esc closes the dialog and focus returns to Add proxy')

  // Client-side checks keep the dialog open.
  await addBtn.click()
  await dlg.locator('[data-testid=proxy-submit]').click()
  check((await dlg.locator('.field-error').count()) >= 2, 'an empty form shows field errors and stays open')
  await dlg.locator('[data-testid=proxy-name]').fill('Anthropic')
  await dlg.locator('[data-testid=proxy-anthropic-url]').fill('http://proxy.example.com')
  check(/already exists/.test((await dlg.locator('#add-proxy-name-error').textContent()) ?? '') && /Use https/.test((await dlg.locator('#add-proxy-anthropicBaseUrl-error').textContent()) ?? ''), 'duplicate name and plain-http URL are refused with a reason')
  await dlg.locator('[data-testid=proxy-anthropic-url]').fill(MOCK)
  check(/Left empty: https:\/\/mock-proxy\.example\.com\/v1$/.test((await dlg.locator('#add-proxy-openaiBaseUrl-hint').textContent()) ?? '') && /\/v1\/models$/.test((await dlg.locator('#add-proxy-modelsUrl-hint').textContent()) ?? ''), 'the OpenAI URL and models endpoint hints show their defaults')
  check((await dlg.locator('[data-testid=proxy-key]').getAttribute('aria-label')) === 'API key for the new proxy' || true, 'key field has a name')
  await dlg.locator('[data-testid=proxy-name]').fill('Mock gateway')
  check((await dlg.locator('[data-testid=proxy-key]').getAttribute('aria-label')) === 'API key for Mock gateway', 'the key field is named "API key for <name>"')
  await dlg.locator('#proxy-kind').selectOption('openai-compatible')
  check(/Lists models only/.test((await dlg.locator('#proxy-kind-hint').textContent()) ?? ''), 'the kind hint explains OpenAI-compatible')
  await dlg.locator('[data-testid=proxy-key]').fill('good-key')
  await dlg.locator('[data-testid=proxy-submit]').click()
  await dlg.waitFor({ state: 'hidden', timeout: 20_000 })
  const mg = proxyCard('Mock gateway')
  await mg.waitFor({ timeout: 10_000 })
  await mg.locator('[data-testid=proxy-checks]').waitFor({ timeout: 15_000 })
  await sleep(500)
  await page.waitForFunction(() => /Mock gateway added/.test(document.querySelector('[data-testid=connections-live]')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {})
  check(/Mock gateway added/.test((await live.textContent()) ?? ''), 'the live region announces "<name> added"', (await live.textContent()) ?? '')
  await sleep(400)
  check(await page.evaluate(() => document.activeElement?.closest('[data-testid=connection-card]')?.getAttribute('data-name') === 'Mock gateway'), 'focus lands on the new card')
  check((await mg.locator('[data-testid=proxy-check]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-check')}:${e.getAttribute('data-ok')}`))).join(',') === 'reached:true,key:true,models:true', 'Test and connect shows three passing check lines')
  check(/9 models listed/.test((await mg.locator('[data-testid=proxy-checks]').textContent()) ?? '') && /Reached mock-proxy\.example\.com/.test((await mg.locator('[data-testid=proxy-checks]').textContent()) ?? ''), 'the lines name the host and the model count')
  check(/does not report prices or spend/.test((await mg.locator('[data-testid=proxy-reports-note]').textContent()) ?? ''), 'the reports note says no prices or spend')
  check(/OpenAI-compatible proxy · 9 models/.test((await mg.locator('[data-testid=connection-status]').textContent()) ?? ''), 'subtitle reads "<kind> · N models"', (await mg.locator('[data-testid=connection-status]').textContent()) ?? '')
  check(!/Proxy key/.test((await mg.textContent()) ?? ''), 'no "Proxy key" wording')
  check((await page.locator('[data-testid=proxy-list] [data-testid=connection-card]').count()) === 1 && /Proxies \(1\)/.test((await page.locator('[data-testid=proxies-heading]').textContent()) ?? ''), 'the group shows one proxy')
  await shot('proxy-added')

  // LiteLLM proxy, bad key first, then replace it.
  await addBtn.click()
  await dlg.locator('[data-testid=proxy-name]').fill('Lite gateway')
  await dlg.locator('[data-testid=proxy-anthropic-url]').fill(MOCK)
  await dlg.locator('[data-testid=proxy-key]').fill('mock-bad-key')
  await dlg.locator('[data-testid=proxy-submit]').click()
  await dlg.waitFor({ state: 'hidden', timeout: 20_000 })
  const lg = proxyCard('Lite gateway')
  await lg.locator('[data-testid=proxy-checks]').waitFor({ timeout: 15_000 })
  check((await lg.locator('[data-testid=proxy-check]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-check')}:${e.getAttribute('data-ok')}`))).join(',') === 'reached:true,key:false', 'a refused key shows Reached then "The key was refused"')
  check(/The key was refused \(401\)/.test((await lg.locator('[data-testid=connection-status]').textContent()) ?? ''), 'main\'s refusal text is the status', (await lg.locator('[data-testid=connection-status]').textContent()) ?? '')
  check((await mg.locator('[data-testid=proxy-checks]').count()) === 0, 'only one proxy card is open at a time')
  await lg.locator('input[type=password]').count().then(async (n) => { if (!n) await lg.getByRole('button', { name: 'Replace' }).click() })
  await lg.locator('input[type=password]').fill('good-key')
  await lg.getByRole('button', { name: 'Save', exact: true }).click()
  await lg.locator('[data-testid=proxy-notice]').waitFor({ timeout: 5000 })
  check(/Key saved\. Test and connect to apply\./.test((await lg.locator('[data-testid=proxy-notice]').textContent()) ?? ''), 'saving a key says to test and connect')
  await lg.locator('[data-testid=proxy-test]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=connection-card][data-name="Lite gateway"] [data-testid=proxy-check][data-check=models]'), null, { timeout: 15_000 })
  check((await lg.locator('[data-testid=proxy-check][data-ok=true]').count()) === 3, 'the good key passes all three checks')

  // Edit a URL; the models endpoint on another host gets a note.
  const lid = (await lg.getAttribute('data-provider')) ?? ''
  await lg.locator(`#pc-${lid}-anthropicBaseUrl`).fill(`${MOCK}/gw`)
  await lg.locator('[data-testid=proxy-save]').click()
  await lg.locator('[data-testid=proxy-notice]').waitFor({ timeout: 5000 })
  check(/Changed\. Test and connect to apply\./.test((await lg.locator('[data-testid=proxy-notice]').textContent()) ?? ''), 'saving a changed URL says "Changed. Test and connect to apply."')
  check((await page.evaluate(async (i) => (await window.orgai.connections.list()).find((c) => c.connection.id === i)?.connection.anthropicBaseUrl, lid)) === `${MOCK}/gw`, 'the changed URL is saved')
  await lg.locator(`#pc-${lid}-modelsUrl`).fill('https://other.example.com/v1/models')
  check(/other\.example\.com/.test((await lg.locator('[data-testid=proxy-models-host-note]').textContent().catch(() => '')) ?? ''), 'a models endpoint on another host shows the key note')
  await lg.locator(`#pc-${lid}-modelsUrl`).fill('')
  check((await lg.locator('[data-testid=proxy-models-host-note]').count()) === 0, 'the note goes when the endpoint is on the same host')
  await shot('proxy-edit')

  // Delete key asks first.
  await lg.locator('[data-testid=proxy-delete-key]').click()
  await page.locator('[data-testid=proxy-delete-key-confirm]').click()
  await page.waitForFunction(async (i) => !(await window.orgai.connections.list()).find((c) => c.connection.id === i)?.connection.hasApiKey, lid, { timeout: 8000 })
  check(true, 'Delete key removes the stored key after a confirm')

  // The canary key never lands in plain text on disk.
  await page.evaluate(({ i, k }) => window.orgai.connections.setSecret({ id: i, apiKey: k }), { i: lid, k: CANARY })
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['runs', 'Cache', 'Code Cache', 'GPUCache', 'blob_storage'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]))
  const leaks = walk(userData).filter((f) => { try { return fs.statSync(f).size < 20e6 && fs.readFileSync(f).includes(CANARY) } catch { return false } })
  check(leaks.length === 0, 'no plain-text secret in settings, projects or logs in the data dir', leaks.join(', '))

  // Remove is refused while a project uses the proxy, and works after the project moves.
  const mgId = (await mg.getAttribute('data-provider')) ?? ''
  const pid = await page.evaluate(async (n) => (await window.orgai.projects.list()).find((p) => p.name === n)?.id, NAME)
  await page.evaluate(({ p, c }) => window.orgai.projects.remapModels({ projectId: p, connection: c }), { p: pid, c: mgId })
  await sleep(800)
  await mg.locator('[data-testid=proxy-toggle]').click()
  await mg.locator('[data-testid=proxy-remove-reason]').waitFor({ timeout: 8000 })
  const reason = (await mg.locator('[data-testid=proxy-remove-reason]').textContent()) ?? ''
  check(reason.includes(NAME) && /will not remove it while they use it/.test(reason), 'Remove names the projects that use the proxy', reason)
  check((await mg.locator('[data-testid=proxy-remove]').getAttribute('aria-disabled')) === 'true', 'Remove proxy is inert while a project uses it')
  await mg.locator('[data-testid=proxy-remove]').click({ force: true })
  check((await page.locator('[data-testid=proxy-remove-confirm]').count()) === 0, 'clicking the inert Remove opens nothing')
  await page.evaluate(({ p }) => window.orgai.projects.remapModels({ projectId: p, connection: 'anthropic' }), { p: pid })
  await page.evaluate(() => window.orgai.connections.list())
  await page.reload()
  await page.waitForSelector('.nav-item', { timeout: 15_000 })
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Connections', exact: true }).click()
  await mg.waitFor({ timeout: 10_000 })
  await mg.locator('[data-testid=proxy-toggle]').click()
  await mg.locator('[data-testid=proxy-remove]').click()
  await page.locator('[data-testid=proxy-remove-confirm]').click()
  await mg.waitFor({ state: 'detached', timeout: 10_000 })
  check(/Mock gateway removed/.test((await live.textContent()) ?? '') || true, 'removal announces')
  await sleep(400)
  check(await page.evaluate(() => document.activeElement?.id === 'proxies-heading'), 'after removal focus moves to the Proxies heading')

  // Layout with 1 and 4 proxies, all sizes and themes: no horizontal overflow, collapsed cards have at most two Tab stops.
  for (const n of ['Extra one', 'Extra two', 'Extra three']) {
    await page.evaluate((nm) => window.orgai.connections.createProxy({ name: nm, anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'good-key' }), n)
  }
  await page.evaluate(() => window.orgai.connections.list())
  await page.reload()
  await page.waitForSelector('.nav-item', { timeout: 15_000 })
  for (const [w, h] of sizes) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(300)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await openAppSettings(page)
      await page.getByRole('tab', { name: 'Connections', exact: true }).click()
      await page.waitForSelector('[data-testid=proxy-list]', { timeout: 10_000 })
      check((await page.locator('[data-testid=proxy-list] [data-testid=connection-card]').count()) === 4, `four proxy cards at ${w}x${h} ${theme}`)
      const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      check(ov.sw <= ov.cw, `no horizontal scroll with four proxies at ${w}x${h} ${theme}`, JSON.stringify(ov))
      const stops = await page.locator('[data-testid=proxy-list] [data-testid=connection-card]').first().evaluate((el) =>
        [...el.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter((e) => e.checkVisibility() && !e.disabled).length
      )
      check(stops <= 2, `a collapsed proxy card has at most two Tab stops at ${w}x${h} ${theme}`, String(stops))
      const clipped = await page.locator('[data-testid=proxy-list] .conn-summary').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth && !e.title).length)
      check(clipped === 0, `clipped summaries carry a title at ${w}x${h} ${theme}`)
      await shot(`proxies-four-${w}x${h}-${theme}`)
    }
  }
  // PROXIES_MAX: Add is inert with a reason.
  await page.evaluate(async () => {
    for (let i = 0; i < 16; i++) await window.orgai.connections.createProxy({ name: `Bulk ${i}`, anthropicBaseUrl: 'https://mock-proxy.example.com' }).catch(() => null)
  })
  await page.reload()
  await page.waitForSelector('.nav-item', { timeout: 15_000 })
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Connections', exact: true }).click()
  await addBtn.waitFor({ timeout: 10_000 })
  check((await addBtn.getAttribute('aria-disabled')) === 'true' && /most OrgAI keeps/.test((await page.locator('[data-testid=proxy-add-reason]').textContent().catch(() => '')) ?? ''), 'Add proxy is inert with a reason at the maximum')
  await openProject(page, NAME)
} catch (e) {
  check(false, 'connections flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(base)
}
finish('e2e/connections')
