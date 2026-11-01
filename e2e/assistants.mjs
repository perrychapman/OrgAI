// Token-free (mock adapter). The Assistants group: sidebar rows, virtual-project topbar and tabs, the three start pages,
// Ctrl+Shift+N, the Projects view entry points, App settings > Defaults rows, and (when the main-process handlers for
// runs.startQuick / skills.startAssist are merged) the Chat, MCP assistant and Skill assistant runs end to end.
import { check, cleanup, createProject, endSession, finish, gotoProjects, launch, log, makeFixtureRepo, openAppSettings, removeFixture, sleep } from './lib.mjs'

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
          check((await page.locator('[data-testid=chat-folder]').innerText().catch(() => '')).includes('No folder (a scratch area)'), `chat-folder says "No folder (a scratch area)" ${tag}`)
          const st = await switchState('[data-testid=chat-allow-edits]')
          check(!!st && st.disabled && !st.checked, `chat-allow-edits is a disabled, unchecked switch for scratch ${tag}`, JSON.stringify(st))
          const team = page.locator('[data-testid=chat-team]')
          check((await team.count()) === 1, `chat-team disclosure exists ${tag}`)
          if (await team.count()) {
            await team.locator('summary').click().catch(() => {})
            check(await team.getByRole('radio', { name: 'One assistant' }).isChecked().catch(() => false), `"One assistant" is selected in Team ${tag}`)
            await team.locator('summary').click().catch(() => {})
          }
          check((await page.locator('[data-testid=chat-summary]').innerText().catch(() => '')).includes('Change in App settings > Defaults'), `chat-summary points to App settings > Defaults ${tag}`)
        } else if (id === 'harness') {
          check((await page.locator('textarea[data-testid=assistant-instruction]').count()) === 1, `MCP start page has the instruction textarea ${tag}`)
          const st = await switchState('[data-testid=mcp-allow-build]')
          check(!!st && !st.checked, `mcp-allow-build switch exists and is off ${tag}`, JSON.stringify(st))
          check(await visible('[data-testid=assistant-start]'), `MCP start page has a Start button ${tag}`)
        } else {
          check((await page.locator('textarea[data-testid=assistant-instruction]').count()) === 1, `Skill start page has the instruction textarea ${tag}`)
          check(await visible('[data-testid=assistant-start]'), `Skill start page has a Start button ${tag}`)
        }
      }

      // App settings > Defaults rows
      await openAppSettings(page)
      await page.getByRole('tab', { name: 'Defaults', exact: true }).click().catch(() => {})
      await sleep(500)
      check(await visible('[data-testid=skill-assist-model-row-select]'), `Defaults has the Skill assistant model row ${tag}`)
      check(await visible('[data-testid=quick-run-model-row-select]'), `Defaults has the Chat model row ${tag}`)
      await shot(`defaults-${w}x${h}-${theme}`)
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
      'Chat run reaches Idle with "Done. Ask a follow-up or end the session."',
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
    await page.getByText('Done. Ask a follow-up or end the session.').first().waitFor({ timeout: 60_000 }).catch(() => {})
    check((await page.getByText('Done. Ask a follow-up or end the session.').count()) > 0, 'Chat run reaches Idle with the follow-up label')
    await shot('chat-idle-1600x1000')
    await endSession(page)
    const save = page.locator('[data-testid=run-save-as-project]')
    const saveOff = (await save.getAttribute('aria-disabled').catch(() => null)) === 'true' || (await save.isDisabled().catch(() => false))
    check((await save.count()) === 1 && saveOff, 'Save as project is disabled for a scratch chat')
    check(/scratch/i.test((await save.getAttribute('title').catch(() => '')) ?? ''), 'the disabled Save as project explains why')
    await page.locator('[data-testid=tab-history]').click()
    await sleep(800)
    check(((await page.locator('[data-testid=history-folder]').first().innerText().catch(() => '')) || '').trim() === 'Scratch', 'Chat History shows "Scratch" in history-folder')
    await shot('chat-history-1600x1000')

    // Skill assistant
    await openAssistant('skills')
    await page.locator('textarea[data-testid=assistant-instruction]').fill('Make my agents better at writing release notes.')
    await page.locator('[data-testid=assistant-start]').click()
    const item = page.locator('[data-testid=proposal-skill-item]').first()
    await item.waitFor({ timeout: 60_000 }).catch(() => {})
    check((await item.count()) > 0, 'Skill assistant raises a proposal with proposal-skill-item')
    if (await item.count()) {
      await shot('skill-proposal-1600x1000')
      const card = page.locator('article.decision-card', { has: page.locator('[data-testid=proposal-skill-item]') }).first()
      await card.getByRole('button', { name: 'Approve' }).click()
      await sleep(2000)
      check((await page.locator('[data-testid=proposal-skill-item]').count()) === 0, 'approving the skills proposal resolves the card')
    }
    await endSession(page)
  }

  // MCP library assistant (mcp.startAssist library scope exists on the current runtime).
  {
    await openAssistant('harness')
    await page.locator('textarea[data-testid=assistant-instruction]').fill('Connect a docs search server.')
    await page.locator('[data-testid=assistant-start]').click()
    await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
    check((await page.locator('.run-tab[aria-selected=true]').count()) === 1, 'MCP assistant run opens a tab in the main window')
    check(app.windows().length === 1, 'the MCP assistant opens no new window', String(app.windows().length))
    await endSession(page)
  }
} catch (e) {
  check(false, 'script ran to the end', e.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e))
  await shot('failure').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(repo)
}
finish('assistants')
