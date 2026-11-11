// Token-free (mock adapter). The Assistants group: sidebar rows, virtual-project topbar and tabs, the three start pages,
// Ctrl+Shift+N, the Projects view entry points, App settings > General > Advanced rows, and (when the main-process handlers for
// runs.startQuick / skills.startAssist are merged) the Chat, MCP assistant and Skill assistant runs end to end.
import path from 'node:path'
import { TMP, check, cleanup, createProject, deleteProject, endSession, finish, gotoProjects, launch, log, makeFixtureRepo, openAppSettings, openProject, openTeam, removeFixture, sleep, teamPanelTab, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E assistants (orgai test)'
const LABELS = { quick: 'Chat', harness: 'MCP assistant', skills: 'Skill assistant' }
const IDS = ['quick', 'harness', 'skills']
const repo = makeFixtureRepo('assistants')

const { app, page, shot } = await launch({ shotPrefix: 'assistants' })
page.setDefaultTimeout(5000)
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(400)
}
// Real route: the same settings:set the Appearance pane uses.
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(600)
}
const sidebarWidth = () => page.evaluate(() => Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0))
const row = (id) => page.locator(`[data-testid=nav-assistant][data-id=${id}]`)
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
/** State of a switch whatever its markup (input, button role=switch, or a wrapper holding one). */
const switchState = (sel) =>
  page
    .locator(sel)
    .first()
    .evaluate((el) => {
      const i = el.matches('input,button,[role=switch]') ? el : el.querySelector('input,button,[role=switch]')
      return { disabled: !!(i?.disabled || i?.getAttribute('aria-disabled') === 'true'), checked: !!(i?.checked || i?.getAttribute('aria-checked') === 'true') }
    })
    .catch(() => null)

/** Rows in order, and names / icons for whichever sidebar mode is showing. */
async function checkSidebar(tag) {
  const ids = await page.locator('[data-testid=nav-assistant]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
  check(ids.join() === IDS.join(), `three assistant rows in order Chat, MCP assistant, Skill assistant ${tag}`, ids.join())
  const rail = (await sidebarWidth()) < 100
  for (const id of IDS) {
    const r = row(id)
    if (!(await r.count())) continue
    if (rail) {
      check((await r.locator('svg').count()) >= 1, `${id} row shows an svg icon in the rail ${tag}`)
      const name = (await r.getAttribute('aria-label')) ?? ''
      check(name.startsWith(LABELS[id]), `${id} row has an accessible name in the rail ${tag}`, name)
    } else {
      check((await r.innerText()).includes(LABELS[id]), `${id} row shows "${LABELS[id]}" in the full sidebar ${tag}`, await r.innerText())
    }
  }
  const t = (await row('quick').getAttribute('title')) ?? ''
  check(/Ctrl\+Shift\+N|⌘⇧N/.test(t), `Chat row title mentions the accelerator ${tag}`, t)
}

/**
 * A Chat, MCP assistant or Skill assistant session in the conversation layout: no run side panel (no landmark, rail or
 * resize handle), one column, and the panel's other tabs in a strip above the conversation. Every tab opens; Conversation
 * comes back; the strip follows the Tabs keyboard pattern. `must` lists tab test ids that have to be there.
 */
async function checkStageTabs(label, must) {
  const shape = await page.evaluate(() => {
    const body = document.querySelector('.run-body')
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect()
    return {
      flag: body?.getAttribute('data-side-panel') ?? null,
      panels: document.querySelectorAll('.run-body aside.side-panel, aside[aria-label="run panel"]').length,
      rails: document.querySelectorAll('.run-body .side-rail').length,
      handles: document.querySelectorAll('[data-testid=side-panel-resize]').length,
      // The frame, not the stage: a wide frame puts an open decision tray beside the stage (an existing layout).
      stage: Math.round(r('.run-body > .canvas-frame')?.width ?? 0),
      body: Math.round(r('.run-body')?.width ?? 0),
      tabs: [...document.querySelectorAll('[data-testid=run-stage-tabs] [role=tablist] [role=tab]')].map((t) => t.getAttribute('data-testid'))
    }
  })
  check(shape.flag === 'none' && shape.panels === 0 && shape.rails === 0 && shape.handles === 0, `${label}: no run side panel, rail or resize handle`, JSON.stringify(shape))
  check(shape.stage > 0 && shape.body - shape.stage <= 2, `${label}: the conversation frame takes the full width`, JSON.stringify(shape))
  check(shape.tabs[0] === 'run-tab-conversation' && must.every((t) => shape.tabs.includes(t)), `${label}: the stage tab strip starts with Conversation and has ${must.join(', ')}`, JSON.stringify(shape.tabs))
  check(!shape.tabs.includes('side-tab-transcript') && !shape.tabs.includes('side-tab-outputs') && !shape.tabs.includes('side-tab-knowledge'), `${label}: no Transcript, Outputs or Knowledge tab`, JSON.stringify(shape.tabs))
  for (const id of shape.tabs.slice(1)) {
    await page.locator(`[data-testid=run-stage-tabs] [data-testid=${id}]`).click()
    await sleep(200)
    const open = await page.evaluate((tid) => {
      const tab = document.querySelector(`[data-testid=run-stage-tabs] [data-testid=${tid}]`)
      const panel = tab ? document.getElementById(tab.getAttribute('aria-controls') ?? '') : null
      return { selected: tab?.getAttribute('aria-selected') === 'true', panel: !!panel && panel.getBoundingClientRect().height > 0, conversation: (document.querySelector('[data-testid=conversation-transcript]')?.getClientRects().length ?? 0) > 0, composer: !!document.querySelector('.run-body .live-composer-bar') }
    }, id)
    check(open.selected && open.panel && !open.conversation && open.composer, `${label}: the ${id} tab opens in the stage, the composer stays`, JSON.stringify(open))
  }
  const conv = page.locator('[data-testid=run-stage-tabs] [data-testid=run-tab-conversation]')
  await conv.click()
  await sleep(200)
  check(await visible('[data-testid=conversation-transcript]'), `${label}: Conversation shows the transcript again`)
  await conv.focus()
  await page.keyboard.press('ArrowRight')
  await sleep(200)
  const key = await page.evaluate(() => ({ focused: document.activeElement?.getAttribute('data-testid'), selected: document.activeElement?.getAttribute('aria-selected') }))
  check(key.focused === shape.tabs[1] && key.selected === 'true', `${label}: ArrowRight moves to and selects the next tab`, JSON.stringify(key))
  await page.keyboard.press('Home')
  await sleep(200)
  check((await conv.getAttribute('aria-selected')) === 'true', `${label}: Home returns to Conversation`)
}

async function openAssistant(id) {
  await row(id).click()
  await page.locator(`[data-testid=assistant-start-${id}]`).waitFor({ timeout: 10_000 }).catch(() => {})
  await sleep(300)
}

try {
  // ---- First launch: no projects yet ----
  await setSize(1600, 1000)
  await gotoProjects(page)
  check(await visible('[data-testid=dash-start-choice]'), 'first launch shows the start choice')
  check((await page.locator('[data-testid=dashboard] form.project-form').count()) === 1, 'first launch shows the inline project form')
  await shot('projects-empty-1600x1000')
  await page.locator('[data-testid=dash-start-choice]').getByRole('radio', { name: 'Chat now' }).check({ force: true })
  check(await visible('[data-testid=empty-chat-now]'), 'choosing Chat now shows the Chat now button')
  await page.locator('[data-testid=empty-chat-now]').click({ timeout: 3000 }).catch(() => {})
  check(await visible('[data-testid=assistant-start-quick]'), 'Chat now opens the Chat start page')

  await createProject(page, { path: repo, name: NAME })
  await gotoProjects(page)
  check(await visible('[data-testid=projects-new-chat]'), 'the Dashboard header has "New chat"')
  await page.locator('[data-testid=projects-new-chat]').click({ timeout: 3000 }).catch(() => {})
  check(await visible('[data-testid=assistant-start-quick]'), 'New chat opens the Chat start page')
  await gotoProjects(page)
  await page.keyboard.press('Control+Shift+N')
  await sleep(500)
  check(await visible('[data-testid=assistant-start-quick]'), 'Ctrl+Shift+N from the Projects view lands on the Chat start page')

  // ---- Per size and theme (dark everywhere, light as one pass per size) ----
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await setSize(w, h)
    for (const theme of ['dark', 'light']) {
      const tag = `at ${w}x${h} ${theme}`
      await setTheme(theme)
      check((await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `theme is ${theme} ${tag}`)
      await gotoProjects(page)
      await checkSidebar(tag)
      await shot(`sidebar-${w}x${h}-${theme}`)
      if (theme === 'dark') {
        // Flip to the other sidebar mode with Ctrl+B, check it, then restore.
        const before = await sidebarWidth()
        await page.keyboard.press('Control+b')
        await sleep(500)
        if ((await sidebarWidth()) !== before) {
          await checkSidebar(`${tag} after Ctrl+B`)
          await shot(`sidebar-toggled-${w}x${h}-${theme}`)
          await page.keyboard.press('Control+b')
          await sleep(500)
        } else log(`Ctrl+B did not change the sidebar width ${tag}`)
      }

      for (const id of IDS) {
        const label = LABELS[id]
        await openAssistant(id)
        check((await page.locator('main .topbar h1').first().innerText().catch(() => '')).trim() === label, `topbar h1 is "${label}" ${tag}`)
        check((await page.locator('[data-testid=tab-live]').count()) === 1 && (await page.locator('[data-testid=tab-history]').count()) === 1, `${label} has Live and History tabs ${tag}`)
        check((await page.locator('[data-testid=tab-team]').count()) === 0 && (await page.locator('[data-testid=tab-settings]').count()) === 0, `${label} has no Team or Settings tab ${tag}`)
        check((await page.locator('[data-testid=project-folder]').count()) === 0, `${label} shows no folder chip ${tag}`)
        check((await page.title()).startsWith(label), `document.title starts with "${label}" ${tag}`, await page.title())
        check(await visible(`[data-testid=assistant-start-${id}]`), `${label} start page is visible ${tag}`)
        const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
        check(ov.sw <= ov.cw, `no horizontal scroll on the ${label} start page ${tag}`, JSON.stringify(ov))
        await shot(`start-${id}-${w}x${h}-${theme}`)

        if (id === 'quick') {
          check((await page.locator('[data-testid=chat-folder-input]').getAttribute('placeholder').catch(() => '')) === 'No folder (a scratch area)', `chat-folder-input says "No folder (a scratch area)" ${tag}`)
          const st = await switchState('[data-testid=chat-allow-edits]')
          check(!!st && !st.disabled && !st.checked, `chat-allow-edits is an enabled, unchecked switch for scratch ${tag}`, JSON.stringify(st))
          const edits = await page.locator('[data-testid=chat-allow-edits]').evaluate((el) => ({
            native: el.disabled === true,
            tab: el.tabIndex,
            hint: document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent?.trim() ?? '',
            label: el.getAttribute('aria-label') ?? ''
          }))
          check(!edits.native && edits.tab >= 0 && edits.hint === 'Changes happen in a private scratch folder. You approve each one.' && edits.label === 'Let it make changes', `scratch edits switch is focusable, named and described ${tag}`, JSON.stringify(edits))
          check((await page.locator('[data-testid=chat-asks-line]').innerText().catch(() => '')).trim() === 'It asks before it changes anything.', `chat-asks-line reads "It asks before it changes anything." ${tag}`)
          const scratchSummary = await page.locator('[data-testid=chat-summary]').innerText().catch(() => '')
          check(scratchSummary.startsWith('Works in a private scratch area. Asks before it changes a file or runs a command.'), `chat-summary scratch + off copy ${tag}`, scratchSummary)
          // M6: composer, Start and the trust line are in view without scrolling the page.
          const fit = await page.evaluate(() => {
            const pane = document.querySelector('[data-testid=assistant-start-quick]')
            const comp = pane?.querySelector('.composer')
            const send = pane?.querySelector('.composer button.btn.primary, .composer button[type=submit]')
            const r = pane?.getBoundingClientRect()
            const c = comp?.getBoundingClientRect()
            return { paneBottom: r ? Math.round(r.bottom) : 0, compBottom: c ? Math.round(c.bottom) : 0, scroll: pane ? pane.scrollHeight - pane.clientHeight : -1, send: !!send }
          })
          check(fit.scroll <= 1 && fit.compBottom <= fit.paneBottom, `Chat start page fits without scrolling ${tag}`, JSON.stringify(fit))
          const team = page.locator('[data-testid=chat-team]')
          check((await team.count()) === 1, `chat-team disclosure exists ${tag}`)
          if (await team.count()) {
            await team.locator('summary').click().catch(() => {})
            check(await team.getByRole('radio', { name: 'One assistant' }).isChecked().catch(() => false), `"One assistant" is selected in Team ${tag}`)
            await team.locator('summary').click().catch(() => {})
          }
          const summaryText = await page.locator('[data-testid=chat-summary]').innerText().catch(() => '')
          check(summaryText.includes(' via '), `chat-summary names the connection ("via") ${tag}`, summaryText)
          check(!summaryText.includes('Defaults'), `chat-summary has no Defaults pointer ${tag}`, summaryText)
          check(await visible('[data-testid=chat-model-change]'), `chat-model-change link is visible ${tag}`)
        } else if (id === 'harness') {
          check((await page.locator('textarea[data-testid=assistant-instruction]').count()) === 1, `MCP start page has the instruction textarea ${tag}`)
          const st = await switchState('[data-testid=mcp-allow-build]')
          check(!!st && !st.checked, `mcp-allow-build switch exists and is off ${tag}`, JSON.stringify(st))
          check(await visible('[data-testid=assistant-start]'), `MCP start page has a Start button ${tag}`)
          check(((await page.locator('[data-testid=assistant-model-line]').innerText().catch(() => '')).includes(' via ')), `MCP assistant model line names the connection ${tag}`)
          const buildLabel = await page.locator('[data-testid=mcp-allow-build]').getAttribute('aria-label')
          check(/data folder/.test(buildLabel ?? ''), `mcp-allow-build names where it builds ${tag}`, buildLabel ?? '')
        } else {
          check((await page.locator('textarea[data-testid=assistant-instruction]').count()) === 1, `Skill start page has the instruction textarea ${tag}`)
          check(await visible('[data-testid=assistant-start]'), `Skill start page has a Start button ${tag}`)
        }
      }

      // chat-model-change lands on App settings > General with Advanced open and the "Assistant models" heading focused
      await openAssistant('quick')
      await page.locator('[data-testid=chat-model-change]').click().catch(() => {})
      await sleep(700)
      check(await visible('[data-testid=settings-advanced][data-pane=app-general] [data-testid=skill-assist-model-row-select]'), `chat-model-change opens General with Advanced open (${tag})`)
      const focusedHeading = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
      check(/Assistant models/i.test(focusedHeading), `focus is on the Assistant models group heading ${tag}`, focusedHeading)
      // N1: the deep link scrolls only the settings scroller, never the window or the app shell (checked after the
      // 900 ms re-land too).
      await sleep(800)
      let shift = await windowShift(page)
      check(shift.ok, `chat-model-change leaves the window unshifted ${tag}`, JSON.stringify(shift))
      // The MCP and Skill assistant start pages' "Change in App settings" (AssistantModelLine).
      for (const id of ['harness', 'skills']) {
        await openAssistant(id)
        const line = page.locator(`[data-testid=assistant-start-${id}] [data-testid=assistant-model-line]`)
        const lineText = await line.innerText().catch(() => '')
        check(/Runs on .+ tier \(.+\) via /.test(lineText), `${LABELS[id]} model line names the resolved model and the connection ${tag}`, lineText)
        await line.getByRole('button', { name: 'Change in App settings' }).click().catch(() => {})
        await sleep(1500)
        const hd = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
        check(/Assistant models/i.test(hd), `${LABELS[id]} model link focuses the Assistant models heading ${tag}`, hd)
        shift = await windowShift(page)
        check(shift.ok, `${LABELS[id]} model link leaves the window unshifted ${tag}`, JSON.stringify(shift))
      }
      if (theme === 'dark') {
        // The MCP assist dialog's hint (Team > Catalog > Add a service > Ask the assistant).
        await openProject(page, NAME)
        await openTeam(page)
        await teamPanelTab(page, 'Catalog').click().catch(() => {})
        await page.locator('[data-testid=mcp-add-service]').scrollIntoViewIfNeeded().catch(() => {})
        await page.locator('[data-testid=mcp-add-service]').click().catch(() => {})
        await page.locator('[data-testid=add-service-assist]').click().catch(() => {})
        const hint = page.locator('[data-testid=mcp-assist-model-hint]')
        const hintText = await hint.innerText().catch(() => '')
        check(/Runs on .+ tier \(.+\) via /.test(hintText), `MCP assist dialog hint names the resolved model and the connection ${tag}`, hintText)
        await hint.getByRole('button', { name: 'Change in App settings' }).click().catch(() => {})
        await sleep(1500)
        const hd = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
        check(/Assistant models/i.test(hd), `MCP assist dialog link focuses the Assistant models heading ${tag}`, hd)
        shift = await windowShift(page)
        check(shift.ok, `MCP assist dialog link leaves the window unshifted ${tag}`, JSON.stringify(shift))
      }

      // App settings > General > Advanced: the assistant model rows
      await openAppSettings(page)
      await page.getByRole('tab', { name: 'General', exact: true }).click().catch(() => {})
      await sleep(400)
      const adv = page.locator('[data-testid=settings-advanced][data-pane=app-general]')
      if ((await adv.count()) && !(await adv.evaluate((d) => d.open).catch(() => false))) await adv.locator('summary').click().catch(() => {})
      await sleep(300)
      check(await visible('[data-testid=skill-assist-model-row-select]'), `General > Advanced has the Skill assistant model row ${tag}`)
      check(await visible('[data-testid=quick-run-model-row-select]'), `General > Advanced has the Chat model row ${tag}`)
      await shot(`general-advanced-${w}x${h}-${theme}`)
    }
  }

  // ---- Model pickers across connections: a mixed-family proxy on the mock host ----
  const PROXY_NAME = 'E2E gateway'
  const proxyId = await page.evaluate(async (name) => {
    const made = await window.orgai.connections.createProxy({ name, anthropicBaseUrl: 'https://mock-proxy.example.com', apiKey: 'whatever' })
    const id = made.connection.id
    await window.orgai.connections.connect(id)
    return id
  }, PROXY_NAME)
  check(!!proxyId, 'a mock proxy was created and connected through IPC', String(proxyId))
  try {
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 30_000 })
    for (const [w, h] of [[1024, 640], [1600, 1000]]) {
      await setSize(w, h)
      for (const theme of ['dark', 'light']) {
        await setTheme(theme)
        const tag = `at ${w}x${h} ${theme}`
        await openAppSettings(page)
        await page.getByRole('tab', { name: 'General', exact: true }).click().catch(() => {})
        await sleep(400)
        const adv = page.locator('[data-testid=settings-advanced][data-pane=app-general]')
        if ((await adv.count()) && !(await adv.evaluate((d) => d.open).catch(() => false))) await adv.locator('summary').click().catch(() => {})
        await sleep(600)
        for (const rowId of ['setup-model-row', 'mcp-assist-model-row', 'skill-assist-model-row', 'quick-run-model-row']) {
          const sel = page.locator(`[data-testid=${rowId}-select]`)
          if (!(await sel.count())) {
            log(`SKIP ${rowId}-select absent`)
            continue
          }
          const groups = await sel.evaluate((s) => [...s.querySelectorAll('optgroup')].map((g) => ({ label: g.label, options: [...g.querySelectorAll('option')].map((o) => o.textContent ?? '') })))
          const labels = groups.map((g) => g.label)
          check(labels[0] === 'Tiers' && labels.includes('Anthropic') && labels.includes(PROXY_NAME), `${rowId} lists a group per connection, tiers first ${tag}`, labels.join(' | '))
          const px = groups.find((g) => g.label === PROXY_NAME)
          check(!!px && px.options.some((o) => / · GPT$/.test(o)) && px.options.some((o) => / · Other$/.test(o)) && px.options.some((o) => / · Claude$/.test(o)), `${rowId} proxy group names each model's family ${tag}`, JSON.stringify(px?.options))
          check(!!px && px.options.every((o) => !o.includes(PROXY_NAME)), `${rowId} does not repeat the proxy name on each option ${tag}`)
        }
      }
    }
    // Pick a non-Claude model for an assistant, make the proxy the default, and read the "Runs on" line.
    await setSize(1600, 1000)
    await setTheme('dark')
    await openAppSettings(page)
    await page.getByRole('tab', { name: 'General', exact: true }).click().catch(() => {})
    await sleep(400)
    const skillSel = page.locator('[data-testid=skill-assist-model-row-select]')
    await skillSel.selectOption('gpt-6-sol')
    await sleep(900)
    const saved = await page.evaluate(async () => (await window.orgai.settings.get()).skillAssistModel)
    check(saved === 'gpt-6-sol', 'picking a GPT model saves it for the Skill assistant', String(saved))
    await page.evaluate((id) => window.orgai.connections.setDefault(id), proxyId)
    await sleep(900)
    await openAssistant('skills')
    const line = await page.locator('[data-testid=assistant-start-skills] [data-testid=assistant-model-line]').innerText().catch(() => '')
    check(new RegExp(`Runs on .*gpt.*6.* via ${PROXY_NAME}`, 'i').test(line), 'the model line names the proxy by its own name', line)
    check(!/LiteLLM/.test(line), 'the model line never says LiteLLM for a named proxy', line)
    await shot('assistant-model-proxy')
  } finally {
    await page.evaluate(async (id) => {
      await window.orgai.connections.setDefault(null).catch(() => {})
      const s = await window.orgai.settings.get()
      await window.orgai.settings.set({ ...s, skillAssistModel: 'deep' }).catch(() => {})
      await window.orgai.connections.removeProxy(id).catch(() => {})
    }, proxyId)
    await sleep(500)
  }

  // ---- Needs the runtime ----
  await setSize(1600, 1000)
  await setTheme('dark')
  const probe = await page.evaluate(async () => {
    try {
      await window.orgai.runs.startQuick({ prompt: '' })
      return 'started'
    } catch (e) {
      return String(e?.message ?? e)
    }
  })
  if (/No handler registered/.test(probe)) {
    for (const s of [
      'Chat run starts from the start page and shows a run tab',
      'Chat run reaches Idle with "Your turn. Reply, ask a follow-up, or end the session."',
      'Save as project is disabled for a scratch chat, with a reason',
      'Chat History shows Scratch in history-folder',
      'Skill assistant run shows a proposal with proposal-skill-item and Approve resolves it'
    ])
      log(`SKIP (runtime not merged): ${s}`)
  } else {
    log('runtime probe:', probe.slice(0, 160))
    // Chat
    await openAssistant('quick')
    const ta = page.locator('[data-testid=assistant-start-quick] .composer textarea')
    await ta.fill('Say hello in one short sentence.')
    await ta.press('Enter')
    await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
    check((await page.locator('.run-tab[aria-selected=true]').count()) === 1, 'Chat run starts and a run tab appears')
    await page.getByText('Your turn. Reply, ask a follow-up, or end the session.').first().waitFor({ timeout: 60_000 }).catch(() => {})
    check((await page.getByText('Your turn. Reply, ask a follow-up, or end the session.').count()) > 0, 'Chat run reaches Idle with the follow-up label')
    await shot('chat-idle-1600x1000')
    const idleChip = page.locator('[data-testid=run-meta-access]')
    check((await idleChip.getAttribute('data-state').catch(() => null)) === 'asks' && ((await idleChip.innerText().catch(() => '')) || '').trim().startsWith('asks first'), 'a scratch Chat started with edits off shows the "asks first" chip')

    // Conversation layout (H1): a one-assistant chat shows its transcript as the stage, the reply and the composer
    // fit at 1024x640 without page scroll, and the toolbar toggle swaps to the canvas and back.
    const toggle = page.locator('[data-testid=run-layout-toggle]')
    check(await visible('[data-testid=run-conversation]'), 'a one-assistant chat opens in the conversation layout')
    check((await page.locator('.run-body').first().getAttribute('data-layout').catch(() => null)) === 'conversation', 'the layout toggle reports the conversation layout')
    await checkStageTabs('Chat at 1600x1000', ['side-tab-usage', 'side-tab-logs'])
    check((await page.locator('[data-testid=run-stage-tabs] [data-testid=side-tab-plan]').count()) === 0, 'a Chat without a plan has no Plan tab in the stage strip')
    // Show thinking: at the right end of the strip, on Conversation only.
    const thinkingBox = page.locator('[data-testid=run-stage-tabs] [data-testid=run-stage-show-thinking]')
    check((await thinkingBox.count()) === 1 && (await page.getByText('Show thinking', { exact: true }).count()) === 1, 'Show thinking is in the strip while Conversation is selected')
    await page.locator('[data-testid=run-stage-tabs] [data-testid=side-tab-usage]').click()
    await sleep(200)
    check((await page.locator('[data-testid=run-stage-show-thinking]').count()) === 0, 'Show thinking is gone on the Usage tab')
    await page.locator('[data-testid=run-stage-tabs] [data-testid=run-tab-conversation]').click()
    await sleep(200)
    check((await page.locator('[data-testid=run-stage-show-thinking]').count()) === 1, 'Show thinking is back on Conversation')
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await setSize(1024, 640)
      await sleep(500)
      await checkStageTabs(`Chat at 1024x640 ${theme}`, ['side-tab-usage', 'side-tab-logs'])
      const bar = await page.evaluate(() => {
        const row = document.querySelector('.run-stage-tabs-row')?.getBoundingClientRect()
        const box = document.querySelector('[data-testid=run-stage-show-thinking]')?.closest('.run-stage-thinking')?.getBoundingClientRect()
        const bar = document.querySelector('.run-stage-tabs-bar')
        return { fits: !!row && !!box && box.right <= row.right + 1 && box.left >= row.left, noScroll: !!bar && bar.scrollWidth <= bar.clientWidth + 1 }
      })
      check(bar.fits && bar.noScroll, `the strip with Show thinking does not overflow at 1024x640 (${theme})`, JSON.stringify(bar))
      const fit = await page.evaluate(() => {
        const vh = window.innerHeight
        const doc = document.scrollingElement
        const reply = [...document.querySelectorAll('[data-testid=run-conversation] *')].filter((el) => el.children.length === 0 && /I can see \d+ OrgAI project/.test(el.textContent ?? '')).pop()
        const r = reply?.getBoundingClientRect()
        const c = document.querySelector('.run-body .composer')?.getBoundingClientRect()
        return {
          pageScroll: doc ? doc.scrollHeight - doc.clientHeight : 0,
          reply: r ? r.height > 0 && r.top >= 0 && r.bottom <= vh : false,
          composer: c ? c.top >= 0 && c.bottom <= vh : false
        }
      })
      check(fit.pageScroll <= 1 && fit.reply && fit.composer, `conversation shows the mock reply and the composer at 1024x640 without page scroll (${theme})`, JSON.stringify(fit))
      await shot(`chat-conversation-1024x640-${theme}`)
      await setSize(1600, 1000)
      await sleep(400)
      await shot(`chat-conversation-1600x1000-${theme}`)
    }
    await setTheme('dark')
    // Sending from another stage tab brings the conversation back, so the reply is seen.
    await page.locator('[data-testid=run-stage-tabs] [data-testid=side-tab-usage]').click()
    await page.locator('.run-body .composer textarea').fill('One more short sentence, please.')
    await page.locator('.run-body .composer textarea').press('Enter')
    await sleep(600)
    check((await page.locator('[data-testid=run-stage-tabs] [data-testid=run-tab-conversation]').getAttribute('aria-selected')) === 'true' && (await visible('[data-testid=conversation-transcript]')), 'a send from the Usage tab returns the stage to Conversation')
    await page.getByText('Your turn. Reply, ask a follow-up, or end the session.').first().waitFor({ timeout: 60_000 }).catch(() => {})
    // New-reply cue: send, move to Usage before the reply lands; Conversation is marked and named, one cue, cleared on selecting it.
    const convTab = page.locator('[data-testid=run-stage-tabs] [data-testid=run-tab-conversation]')
    await page.locator('.run-body .composer textarea').fill('And one more, briefly.')
    await page.locator('.run-body .composer textarea').press('Enter')
    await page.locator('[data-testid=run-stage-tabs] [data-testid=side-tab-usage]').click()
    await sleep(2500)
    const cued = (await convTab.getAttribute('aria-label')) === 'Conversation, new reply' && (await page.locator('[data-testid=run-tab-conversation-dot]').count()) === 1
    const landedOnConversation = (await convTab.getAttribute('aria-selected')) === 'true'
    if (landedOnConversation) console.log('note: the mock reply landed before the Usage tab was chosen; the cue was covered by unit test only')
    else check(cued, 'a reply landing under the Usage tab marks Conversation as "Conversation, new reply"')
    if (!landedOnConversation && cued) {
      await convTab.click()
      await sleep(300)
      check((await convTab.getAttribute('aria-label')) === null && (await page.locator('[data-testid=run-tab-conversation-dot]').count()) === 0, 'selecting Conversation clears the new-reply cue')
    }
    await page.getByText('Your turn. Reply, ask a follow-up, or end the session.').first().waitFor({ timeout: 60_000 }).catch(() => {})
    await toggle.click()
    await sleep(500)
    check((await page.locator('.run-body').first().getAttribute('data-layout')) === 'canvas' && (await page.locator('.react-flow').count()) > 0 && !(await visible('[data-testid=run-conversation]')), '"Show agents" switches to the canvas')
    check((await toggle.getAttribute('aria-label')) === 'Show conversation', 'the toggle then reads "Show conversation"')
    check((await page.locator('.run-body aside.side-panel').count()) === 1 && (await page.locator('[data-testid=run-stage-tabs]').count()) === 0, 'on the canvas a Chat keeps the run side panel (a selected agent is read there)')
    await toggle.click()
    await sleep(400)
    check(await visible('[data-testid=run-conversation]'), '"Show conversation" switches back')
    check((await page.locator('.run-body aside.side-panel').count()) === 0 && (await page.locator('[data-testid=run-stage-tabs]').count()) === 1, 'back in the conversation the side panel is gone again, no stale layout')
    const focusAfter = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)
    check(focusAfter === 'run-layout-toggle', 'focus stays on the layout toggle across the switch', String(focusAfter))

    await endSession(page)
    const save = page.locator('[data-testid=run-save-as-project]')
    const saveOff = (await save.getAttribute('aria-disabled').catch(() => null)) === 'true' || (await save.isDisabled().catch(() => false))
    check((await save.count()) === 1 && saveOff, 'Save as project is disabled for a scratch chat')
    check(/scratch/i.test((await save.locator('xpath=..').getAttribute('title').catch(() => '')) ?? ''), 'the disabled Save as project explains why')
    const looks = await save.evaluate((el) => ({ disabled: el.disabled, opacity: Number(getComputedStyle(el).opacity) }))
    check(looks.disabled || looks.opacity < 1, 'the disabled Save as project looks disabled', JSON.stringify(looks))
    check((await page.locator('.run-tab-new').getAttribute('aria-label')) === 'New chat', 'the "+" tab reads "New chat" on Chat')
    check(!/unattended/i.test(await page.locator('[data-testid=run-meta]').innerText().catch(() => '')), 'Chat run metadata has no "unattended"')
    await page.locator('[data-testid=tab-history]').click()
    await sleep(800)
    check(((await page.locator('[data-testid=history-folder]').first().innerText().catch(() => '')) || '').trim() === 'Scratch', 'Chat History shows "Scratch" in history-folder')
    check((await page.getByRole('radio', { name: 'Run', exact: true }).count()) === 0, 'Chat History has no kind filter chips')
    const histSave = page.locator('[data-testid=history-save-as-project]').first()
    check((await histSave.count()) === 1 && (await histSave.isDisabled()), 'the scratch chat row in History has a disabled Save as project')
    await shot('chat-history-1600x1000')

    // An ended Chat: the sidebar row opens the start page, not the stopped run.
    await row('quick').click()
    await sleep(600)
    check(await visible('[data-testid=assistant-start-quick]'), 'Chat sidebar row after an ended chat shows the start page')

    // Save as project from a chat in a real folder: typed path, then the action is gone once the project exists.
    const chatRepo = makeFixtureRepo('chat-promote')
    const chatProject = path.basename(chatRepo)
    await openAssistant('quick')
    const folderInput = page.locator('[data-testid=chat-folder-input]')
    await folderInput.fill(path.join(TMP, 'orgai-e2e-no-such-folder-xyz'))
    await sleep(900)
    check(await visible('[data-testid=chat-folder-error]'), 'a typed folder that does not exist shows an error')
    // A folder that is already a project gets a note with an Open button (the fixture repo of the project above).
    await folderInput.fill(repo)
    await sleep(900)
    const existingNote = page.locator('[data-testid=chat-existing-project]')
    check((await existingNote.count()) === 1 && (await existingNote.innerText()).includes(NAME), 'a folder that is already a project shows the "already a project" note naming it', await existingNote.innerText().catch(() => ''))
    check(await visible('[data-testid=chat-open-project]'), 'the "already a project" note offers Open')
    await folderInput.fill(chatRepo)
    await sleep(900)
    check(!(await visible('[data-testid=chat-folder-error]')), 'a valid typed folder clears the error')
    check((await switchState('[data-testid=chat-allow-edits]'))?.disabled === false, 'a folder keeps the edits switch enabled')
    const folderSummary = await page.locator('[data-testid=chat-summary]').innerText().catch(() => '')
    check(folderSummary.startsWith(`Works in ${chatProject}. Reads freely, asks before it changes a file or runs a command.`), 'chat-summary folder + off copy', folderSummary)
    await page.locator('[data-testid=chat-allow-edits]').click()
    const onSummary = await page.locator('[data-testid=chat-summary]').innerText().catch(() => '')
    check(onSummary.startsWith(`Works in ${chatProject}. Ready to make changes; asks before each edit and command.`), 'chat-summary on copy', onSummary)
    await page.locator('[data-testid=chat-allow-edits]').click()
    await setSize(1024, 640)
    const fitWithFolder = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid=assistant-start-quick]')
      const c = pane?.querySelector('.composer')?.getBoundingClientRect()
      return { scroll: pane ? pane.scrollHeight - pane.clientHeight : -1, over: c && pane ? Math.round(c.bottom - pane.getBoundingClientRect().bottom) : 0 }
    })
    check(fitWithFolder.scroll <= 1 && fitWithFolder.over <= 0, 'Chat start page with a folder chosen fits at 1024x640', JSON.stringify(fitWithFolder))
    await shot('start-quick-folder-1024x640')
    await setSize(1600, 1000)
    await page.locator('[data-testid=assistant-start-quick] .composer textarea').fill('Say hello in one short sentence.')
    await page.locator('[data-testid=assistant-start-quick] .composer textarea').press('Enter')
    await page.getByText('Your turn. Reply, ask a follow-up, or end the session.').first().waitFor({ timeout: 60_000 }).catch(() => {})
    await endSession(page)
    const promote = page.locator('[data-testid=run-save-as-project]')
    check((await promote.count()) === 1 && !(await promote.isDisabled()), 'Save as project is enabled for a chat in a folder')
    await promote.click()
    check((await page.locator('[data-testid=save-as-project-permissions-note]').innerText().catch(() => '')).trim() === 'Permissions you gave this chat do not carry over.', 'Save as project says permissions do not carry over')
    await page.locator('[data-testid=save-as-project-confirm]').click()
    await page.locator('[data-testid=save-as-project-dialog]').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
    await sleep(800)
    check((await page.locator('main .topbar h1').first().innerText().catch(() => '')).trim() === chatProject, 'the new project is selected after Save as project', await page.locator('main .topbar h1').first().innerText().catch(() => ''))
    check((await page.locator('[data-testid=run-save-as-project]').count()) === 0, 'Save as project is gone from the run strip once the run moved')
    await page.locator('[data-testid=tab-history]').click()
    await sleep(800)
    check((await page.locator('[data-testid=history-save-as-project]').count()) === 0, 'History of the new project has no Save as project')
    await deleteProject(page, chatProject).catch(() => {})
    removeFixture(chatRepo)

    // ---- Chat permission asks (mock markers [mock:chat-edit] and [mock:chat-mcp]) ----
    // Full card flows run once per pair: allow-for-session at 1024x640 dark, deny at 1600x1000 light, install at
    // 1024x640 light. The card, no-page-scroll and visibility checks repeat at all four size/theme pairs while a card is open.
    const startChat = async (prompt) => {
      await openAssistant('quick')
      const box = page.locator('[data-testid=assistant-start-quick] .composer textarea')
      await box.fill(prompt)
      await box.press('Enter')
      await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
    }
    const pageScroll = () => page.evaluate(() => { const d = document.scrollingElement; return d ? d.scrollHeight - d.clientHeight : 0 })
    const cardGeometry = async (selector, tag) => {
      const g = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        const r = el?.getBoundingClientRect()
        const d = document.scrollingElement
        return { shown: !!r && r.width > 0 && r.height > 0, inView: !!r && r.top < innerHeight && r.bottom > 0, scroll: d ? d.scrollHeight - d.clientHeight : 0 }
      }, selector)
      check(g.shown && g.inView && g.scroll <= 1, `the open card is visible and the page does not scroll ${tag}`, JSON.stringify(g))
    }
    const tabTo = async (name) => {
      for (let i = 0; i < 40; i++) {
        const label = await page.evaluate(() => { const a = document.activeElement; return (a?.getAttribute('aria-label') || a?.textContent || '').trim() })
        if (label === name) return true
        await page.keyboard.press('Tab')
      }
      return false
    }
    // Any open decision card; the Chat-specific copy is checked separately (it needs the card branch).
    const waitCard = () => page.locator('article.decision-card').first().waitFor({ timeout: 30_000 }).then(() => true, () => false)
    const dismissLabel = (re) => page.getByRole('button', { name: re })

    // A. Allow for session by keyboard, then the command card.
    await setTheme('dark')
    await setSize(1024, 640)
    await startChat('[mock:chat-edit] create notes')
    check(await waitCard(), 'a scratch Chat edit raises a permission card')
    check((await page.locator('[data-testid=perm-location][data-kind=chat]').count()) === 1, 'the card carries perm-location[data-kind=chat] (needs the card branch)')
    const loc = (await page.locator('[data-testid=perm-location][data-kind=chat]').first().innerText().catch(() => '')).trim()
    check(/^Runs in this chat's scratch area/.test(loc), 'the Chat card says it runs in the scratch area', loc)
    check((await page.locator('[data-testid=perm-quick-readonly]').count()) === 1, 'the card says the chat started read-only (perm-quick-readonly)')
    check((await page.locator('[data-testid=perm-scope-project]').count()) === 0 && (await dismissLabel(/Always allow for project/).count()) === 0, 'a Chat card offers no project scope and no "Always allow for project"')
    check((await page.locator('[data-testid=perm-scope-session]').count()) === 1, 'a Chat card explains Allow for session (perm-scope-session)')
    check((await dismissLabel(/^Allow once$/).count()) === 1 && (await dismissLabel(/^Allow for session$/).count()) === 1 && (await dismissLabel(/^Deny$/).count()) === 1, 'the Chat card has Allow once, Allow for session and Deny')
    const chip = page.locator('[data-testid=run-meta-access]')
    check((await chip.getAttribute('data-state').catch(() => null)) === 'asks', 'the access chip reads asks while the card is open')
    for (const [cw, ch] of [[1024, 640], [1600, 1000]]) {
      for (const theme of ['dark', 'light']) {
        await setTheme(theme)
        await setSize(cw, ch)
        await sleep(300)
        await cardGeometry('article.decision-card', `at ${cw}x${ch} ${theme}`)
        await shot(`chat-edit-card-${cw}x${ch}-${theme}`)
      }
    }
    await setTheme('dark')
    await setSize(1024, 640)
    await sleep(300)
    check(await tabTo('Allow for session'), 'Allow for session is reachable with Tab')
    await page.keyboard.press('Enter')
    await page.locator('[data-testid=run-meta-access][data-state=session]').waitFor({ timeout: 10_000 }).catch(() => {})
    check((await chip.getAttribute('data-state').catch(() => null)) === 'session' && ((await chip.innerText().catch(() => '')) || '').trim().startsWith('changes allowed this session'), 'the chip turns to "changes allowed this session"')
    const said = await page.locator('[data-testid=tray-announce]').filter({ hasText: 'Changes allowed for the rest of this chat.' }).first().waitFor({ timeout: 3000 }).then(() => true, () => false)
    check(said, 'the chip change is announced through tray-announce')
    await page.getByText('I wrote notes.md.').first().waitFor({ timeout: 20_000 }).catch(() => {})
    check((await page.getByText(/You allowed/).count()) > 0, 'a transcript row says "You allowed ..."')
    check((await page.getByText('I wrote notes.md.').count()) > 0, 'after Allow the mock says "I wrote notes.md."')
    check(await waitCard(), 'the npm test command card follows')
    await dismissLabel(/^Allow once$/).first().click()
    await page.getByText(/npm test passed\./).first().waitFor({ timeout: 20_000 }).catch(() => {})
    check((await page.getByText(/npm test passed\./).count()) > 0, 'after Allow once the mock reports "npm test passed."')
    await endSession(page)

    // B. Deny the edit: no Bash card follows.
    await setTheme('light')
    await setSize(1600, 1000)
    await startChat('[mock:chat-edit] create notes')
    check(await waitCard(), 'a second Chat raises the edit card')
    await dismissLabel(/^Deny$/).first().click()
    await page.getByText('I did not change anything.').first().waitFor({ timeout: 20_000 }).catch(() => {})
    check((await page.getByText('I did not change anything.').count()) > 0, 'after Deny the mock says "I did not change anything."')
    await sleep(1500)
    check((await page.locator('[data-testid=perm-location]').count()) === 0, 'no second card appears after Deny')
    check((await page.locator('[data-testid=run-meta-access]').getAttribute('data-state').catch(() => null)) === 'asks', 'the chip stays "asks first" after Deny')
    await endSession(page)

    // C. MCP install card on a Chat.
    await setTheme('light')
    await setSize(1024, 640)
    await startChat('[mock:chat-mcp] add a server')
    await page.locator('[data-testid=mcp-install-card]').first().waitFor({ timeout: 30_000 }).catch(() => {})
    check((await page.locator('[data-testid=mcp-install-card]').count()) === 1, 'a Chat install request raises mcp-install-card')
    check(/^Add a server:/.test((await page.locator('[data-testid=mcp-install-card] h3, [data-testid=mcp-install-card] [data-testid=decision-title]').first().innerText().catch(() => '')).trim()) || (await page.locator('[data-testid=mcp-install-card]').first().innerText().catch(() => '')).includes('Add a server:'), 'the install card title starts "Add a server:"')
    check((await page.locator('[data-testid=mcp-install-run-only]').innerText().catch(() => '')).trim() === 'For this chat only. It is not added to your library.', 'the install card says it is for this chat only')
    check((await page.locator('[data-testid^=mcp-install-scope-]').count()) === 0, 'the install card has no scope radios')
    check((await page.locator('[data-testid=mcp-install-approve]').innerText().catch(() => '')).trim() === 'Add for this chat' && (await page.locator('[data-testid=mcp-install-deny]').innerText().catch(() => '')).trim() === "Don't add", 'install buttons read "Add for this chat" and "Don\'t add"')
    for (const [cw, ch] of [[1024, 640], [1600, 1000]]) {
      for (const theme of ['dark', 'light']) {
        await setTheme(theme)
        await setSize(cw, ch)
        await sleep(300)
        await cardGeometry('article.decision-card', `(install) at ${cw}x${ch} ${theme}`)
      }
    }
    await setTheme('light')
    await setSize(1024, 640)
    const secretInputs = page.locator('[data-testid=mcp-install-card] input[type=password], [data-testid=mcp-install-card] input[type=text]')
    for (let i = 0; i < (await secretInputs.count()); i++) {
      const input = secretInputs.nth(i)
      if (!(await input.inputValue().catch(() => 'x'))) await input.fill('e2e-value').catch(() => {})
    }
    // Falls back to the current card's button until the card branch lands (its testid is checked above).
    const approve = (await page.locator('[data-testid=mcp-install-approve]').count()) ? page.locator('[data-testid=mcp-install-approve]') : page.locator('article.decision-card').getByRole('button', { name: /^(Approve|Add)/ }).first()
    await approve.click()
    await page.getByText('The server was added for this chat.').first().waitFor({ timeout: 20_000 }).catch(() => {})
    check((await page.getByText('The server was added for this chat.').count()) > 0, 'after "Add for this chat" the mock says "The server was added for this chat."')
    await endSession(page)
    await setTheme('dark')
    await setSize(1600, 1000)

    // Default-team chat: more than one agent, so it opens on the canvas and the toolbar toggle shows the conversation.
    await openAssistant('quick')
    await page.locator('[data-testid=chat-team] summary').click()
    await page.getByRole('radio', { name: 'Use the app’s default team' }).check()
    const dta = page.locator('[data-testid=assistant-start-quick] .composer textarea')
    await dta.fill('Say hello in one short sentence.')
    await dta.press('Enter')
    await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
    await page.locator('.run-body').first().waitFor({ timeout: 10_000 }).catch(() => {})
    await sleep(800)
    await shot('default-team-chat')
    check((await page.locator('.run-body').first().getAttribute('data-layout').catch(() => null)) === 'canvas', 'a default-team chat opens in the canvas layout', await page.locator('.run-tab').allInnerTexts().then((t) => t.join(' | ')).catch(() => ''))
    check((await page.locator('.react-flow').count()) > 0 && !(await visible('[data-testid=run-conversation]')), 'a default-team chat shows the canvas, not the conversation')
    await page.locator('[data-testid=run-layout-toggle]').click()
    await sleep(500)
    check(await visible('[data-testid=run-conversation]'), 'the layout toggle shows the conversation for a default-team chat')
    check((await page.locator('.run-body aside.side-panel').count()) === 0 && (await page.locator('[data-testid=run-stage-tabs]').count()) === 1, 'a default-team chat in the conversation has no side panel either')
    await endSession(page)

    // Project-scope Skill assistant from Team > Catalog > Skills: opens in that project's Live tab with a role listed.
    await openProject(page, NAME)
    await openTeam(page)
    await teamPanelTab(page, 'Catalog').click()
    await page.locator('[data-testid=skill-ask-assistant]').click()
    const pitem = page.locator('[data-testid=proposal-skill-item]').first()
    await pitem.waitFor({ timeout: 60_000 }).catch(() => {})
    check((await page.locator('main .topbar h1').first().innerText().catch(() => '')).trim() === NAME, 'the project Skill assistant opens in the project it was asked from')
    check((await page.locator('[data-testid=tab-live]').getAttribute('aria-selected')) === 'true', 'the project Skill assistant opens on the Live tab')
    check((await pitem.count()) > 0, 'the project Skill assistant raises a proposal')
    const roleText = await pitem.locator('.skill-prop-roles').innerText().catch(() => '')
    check(/Who loads it:\s*\S/.test(roleText), 'the project skill proposal says who loads it', roleText)
    await checkStageTabs('project Skill assistant', ['side-tab-usage', 'side-tab-logs'])
    await endSession(page)

    // Skill assistant
    await openAssistant('skills')
    await page.locator('textarea[data-testid=assistant-instruction]').fill('Make my agents better at writing release notes.')
    await page.locator('[data-testid=assistant-start]').click()
    const item = page.locator('[data-testid=proposal-skill-item]').first()
    await item.waitFor({ timeout: 60_000 }).catch(() => {})
    check((await item.count()) > 0, 'Skill assistant raises a proposal with proposal-skill-item')
    if (await item.count()) {
      await shot('skill-proposal-1600x1000')
      await checkStageTabs('Skill assistant', ['side-tab-usage', 'side-tab-logs'])
      check((await page.locator('.run-tab-new').getAttribute('aria-label')) === 'New session', 'the "+" tab reads "New session" on the Skill assistant')
      check(!/unattended/i.test(await page.locator('[data-testid=run-meta]').innerText().catch(() => '')), 'Skill assistant run metadata has no "unattended"')
      const card = page.locator('article.decision-card', { has: page.locator('[data-testid=proposal-skill-item]') }).first()
      await card.getByRole('button', { name: 'Approve' }).click()
      await sleep(2000)
      check((await page.locator('[data-testid=proposal-skill-item]').count()) === 0, 'approving the skills proposal resolves the card')
      check(await visible('[data-testid=proposal-next-skills]'), 'an approved library skills proposal leaves a link to the Skill library')
    }
    await endSession(page)
  }

  // MCP library assistant (mcp.startAssist library scope exists on the current runtime).
  {
    await openAssistant('harness')
    await page.locator('textarea[data-testid=assistant-instruction]').fill('Connect a docs search server.')
    await page.locator('[data-testid=assistant-start]').click()
    await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
    check((await page.locator('[data-testid=run-meta-workspace]').count()) === 0, 'an MCP assistant run without the build switch shows no workspace chip')
    check((await page.locator('.run-tab[aria-selected=true]').count()) === 1, 'MCP assistant run opens a tab in the main window')
    check(app.windows().length === 1, 'the MCP assistant opens no new window', String(app.windows().length))
    check((await page.locator('.run-tab-new').getAttribute('aria-label')) === 'New session', 'the "+" tab reads "New session" on the MCP assistant')
    check(!/unattended/i.test(await page.locator('[data-testid=run-meta]').innerText().catch(() => '')), 'MCP assistant run metadata has no "unattended"')
    await page.locator('[data-testid=run-conversation]').waitFor({ timeout: 10_000 }).catch(() => {})
    await checkStageTabs('MCP assistant', ['side-tab-usage', 'side-tab-logs'])
    await endSession(page)
    // Build switch on: the run strip names the workspace.
    await openAssistant('harness')
    await page.locator('[data-testid=mcp-allow-build]').click()
    check((await switchState('[data-testid=mcp-allow-build]'))?.checked === true, 'the MCP build switch turns on')
    await page.locator('textarea[data-testid=assistant-instruction]').fill('Build a tiny docs server.')
    await page.locator('[data-testid=assistant-start]').click()
    await page.locator('[data-testid=run-meta-workspace]').first().waitFor({ timeout: 20_000 }).catch(() => {})
    check(await visible('[data-testid=run-meta-workspace]'), 'an MCP assistant run with the build switch on shows run-meta-workspace')
    await endSession(page)
    // An ended MCP run: the sidebar row and Configure with AI both land on the start page.
    await row('harness').click()
    await sleep(600)
    check(await visible('[data-testid=assistant-start-harness]'), 'MCP assistant sidebar row after an ended run shows the start page')
    await gotoProjects(page)
    await openAppSettings(page)
    await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
    await page.locator('[data-testid=mcp-library-assist]').click()
    await sleep(800)
    check(await visible('[data-testid=assistant-start-harness]'), 'Configure with AI after an ended MCP run shows the start page')
  }
} catch (e) {
  check(false, 'script ran to the end', e.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e))
  await shot('failure').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(repo)
}
finish('assistants')
