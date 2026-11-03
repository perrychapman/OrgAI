// Token-free (mock adapter). The Assistants group: sidebar rows, virtual-project topbar and tabs, the three start pages,
// Ctrl+Shift+N, the Projects view entry points, App settings > General > Advanced rows, and (when the main-process handlers for
// runs.startQuick / skills.startAssist are merged) the Chat, MCP assistant and Skill assistant runs end to end.
import path from 'node:path'
import { TMP, check, cleanup, createProject, deleteProject, endSession, finish, gotoProjects, launch, log, makeFixtureRepo, openAppSettings, openProject, openTeam, removeFixture, sleep, teamPanelTab } from './lib.mjs'

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

async function openAssistant(id) {
  await row(id).click()
  await page.locator(`[data-testid=assistant-start-${id}]`).waitFor({ timeout: 10_000 }).catch(() => {})
  await sleep(300)
}

try {
  // ---- First launch: no projects yet ----
  await setSize(1600, 1000)
  await gotoProjects(page)
  check(await visible('[data-testid=empty-chat-now]'), 'first launch shows "Chat now" beside the project form')
  check((await page.locator('form.card').count()) === 1, 'first launch still shows the project form')
  await shot('projects-empty-1600x1000')
  await page.locator('[data-testid=empty-chat-now]').click({ timeout: 3000 }).catch(() => {})
  check(await visible('[data-testid=assistant-start-quick]'), 'Chat now opens the Chat start page')

  await createProject(page, { path: repo, name: NAME })
  await gotoProjects(page)
  check(await visible('[data-testid=projects-new-chat]'), 'the Projects view header has "New chat"')
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
          check(!!st && st.disabled && !st.checked, `chat-allow-edits is a disabled, unchecked switch for scratch ${tag}`, JSON.stringify(st))
          // L2: aria-disabled keeps it in the tab order, with the hint as a separate described-by element.
          const edits = await page.locator('[data-testid=chat-allow-edits]').evaluate((el) => ({
            native: el.disabled === true,
            tab: el.tabIndex,
            hint: document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent?.trim() ?? '',
            label: document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() ?? ''
          }))
          check(!edits.native && edits.tab >= 0 && edits.hint === 'Choose a folder to allow edits.' && edits.label === 'Allow edits in this folder', `scratch edits switch stays focusable with its hint ${tag}`, JSON.stringify(edits))
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

    // Conversation layout (H1): a one-assistant chat shows its transcript as the stage, the reply and the composer
    // fit at 1024x640 without page scroll, and the toolbar toggle swaps to the canvas and back.
    const toggle = page.locator('[data-testid=run-layout-toggle]')
    check(await visible('[data-testid=run-conversation]'), 'a one-assistant chat opens in the conversation layout')
    check((await page.locator('.run-body').first().getAttribute('data-layout').catch(() => null)) === 'conversation', 'the layout toggle reports the conversation layout')
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await setSize(1024, 640)
      await sleep(500)
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
    await toggle.click()
    await sleep(500)
    check((await page.locator('.run-body').first().getAttribute('data-layout')) === 'canvas' && (await page.locator('.react-flow').count()) > 0 && !(await visible('[data-testid=run-conversation]')), '"Show agents" switches to the canvas')
    check((await toggle.getAttribute('aria-label')) === 'Show conversation', 'the toggle then reads "Show conversation"')
    await toggle.click()
    await sleep(400)
    check(await visible('[data-testid=run-conversation]'), '"Show conversation" switches back')

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
    check((await switchState('[data-testid=chat-allow-edits]'))?.disabled === false, 'a folder enables the edits switch')
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
    check((await page.locator('.run-body').first().getAttribute('data-layout').catch(() => null)) === 'canvas', 'a default-team chat opens in the canvas layout')
    check((await page.locator('.react-flow').count()) > 0 && !(await visible('[data-testid=run-conversation]')), 'a default-team chat shows the canvas, not the conversation')
    await page.locator('[data-testid=run-layout-toggle]').click()
    await sleep(500)
    check(await visible('[data-testid=run-conversation]'), 'the layout toggle shows the conversation for a default-team chat')
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
