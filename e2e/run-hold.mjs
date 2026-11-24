// Token-free. Mock adapter. The run view's hold card ([mock:provider-error], [mock:provider-error]) and the one-agent view
// (AgentFocus: opened from the side panel and by double click, Escape returns focus to the opener), in both themes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, finish, findProject, launch, makeFixtureRepo, projectTab, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E run hold (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-hold-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('hold', { at: repo })

// A script file the Find check at the end rewrites (seven agents); until then the mock keeps its default script.
const scriptFile = path.join(base, 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const { app, page, shot } = await launch({ shotPrefix: 'run-hold' })
const start = async (text) => {
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}
try {
  await createProject(page, { mode: 'existing', path: repo, name: NAME })
  await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Live', exact: true }).click()
  await page.locator('.new-run').waitFor({ timeout: 10_000 })

  // ---- Budget stop: the card names what stopped the run and what can be done.
  await start('Do some work [mock:provider-error]')
  const hold = page.locator('[data-testid=run-hold]')
  await hold.waitFor({ timeout: 30_000 })
  check((await hold.getAttribute('data-kind')) !== null, 'the hold card shows for a provider error', await hold.getAttribute('data-kind'))
  check((await page.locator('.pause-banner, [data-testid=run-hold]').count()) >= 1, 'the card sits in the decisions tray')
  check((await page.locator('[data-testid=live-settings-bar]').count()) === 1, 'the composer region and model switch stay mounted beside the card')
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await sleep(300)
    await shot(`provider-${theme}`)
  }
  // A confirmation must name what an action does before it spends.
  const add = hold.getByRole('button', { name: /Add and continue/ })
  if ((await add.count()) > 0) {
    await add.click()
    const dlg = page.locator('dialog[open]')
    await dlg.waitFor({ timeout: 5000 }).catch(() => {})
    check((await dlg.count()) > 0, 'adding budget asks for an explicit confirmation')
    await page.keyboard.press('Escape')
    await sleep(300)
  }

  // ---- Conversation dock: the composer lives in the dock; hiding keeps everything mounted; the toolbar button shows it again.
  const geo = () => page.evaluate(() => {
    const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) } }
    return { panel: r('.run-body > .side-panel'), composer: r('.run-body > .live-composer-region'), hold: r('[data-testid=run-hold]'), stage: r('.frame-stage'), frame: r('.canvas-frame'), dock: document.querySelector('.run-body')?.getAttribute('data-dock') }
  })
  const scrollEnd = () => page.evaluate(() => {
    const tp = [...document.querySelectorAll('.run-body > .side-panel [role=tabpanel]')].find((e) => e.scrollHeight > e.clientHeight + 4 && e.offsetParent !== null) ?? document.querySelector('.run-body > .side-panel [role=tabpanel]')
    return tp ? Math.round(tp.scrollHeight - tp.scrollTop - tp.clientHeight) : null
  })
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(800)
    const g = await geo()
    check(g.dock === 'open' && !!g.panel && !!g.composer && g.composer.l >= g.panel.l - 1 && g.composer.t >= g.panel.b - 1, `the dock is open with the composer in it (${w}x${h})`, JSON.stringify(g))
    check(!!g.hold && !!g.panel && g.hold.r <= g.panel.l + 1, `the hold card is not covered by the dock (${w}x${h})`, JSON.stringify(g))
    check(!!g.panel && g.panel.r - g.panel.l <= 480 && (g.panel.r - g.panel.l) / w < 0.45, `the dock is a compact column (${w}x${h})`, JSON.stringify(g))
    check((await scrollEnd()) !== null && (await scrollEnd()) <= 2, `the conversation opens at the newest message (${w}x${h})`, String(await scrollEnd()))
    await shot(`dock-open-${w}`)
  }
  // Narrow fallback (a small window with the sidebar expanded leaves the run view under 900 px, no saved choice): the dock is
  // never hidden by the width alone. The composer, settings row and model switch stay under the canvas with the rail.
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [1024, 640])
  await sleep(800)
  const wide = await page.evaluate(() => document.querySelector('.run-body')?.clientWidth ?? 0)
  if (await page.evaluate(() => document.querySelector('.app')?.getAttribute('data-sidebar') === 'rail')) await page.locator('[data-testid=sidebar-toggle], .brand-lockup-expand').first().click()
  await sleep(400)
  // Folding follows window resizes only (a sidebar toggle never folds an open dock): resize once, as the window would.
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [1025, 640])
  await page.waitForFunction(() => document.querySelector('.run-body')?.getAttribute('data-dock') === 'rail', null, { timeout: 5000 }).catch(() => {})
  await sleep(300)
  const gn = await geo()
  const narrowW = await page.evaluate(() => document.querySelector('.run-body')?.clientWidth ?? 0)
  const stageBox = await page.evaluate(() => { const b = document.querySelector('.canvas-frame')?.getBoundingClientRect(); return b && { w: Math.round(b.width), h: Math.round(b.height) } })
  console.log(`narrow fallback: run view ${wide} -> ${narrowW} px wide, canvas frame ${stageBox?.w}x${stageBox?.h}, dock ${gn.dock}`)
  check(narrowW < 900 && gn.dock === 'rail', 'a run view under 900 px with no saved choice shows the rail layout, not a hidden dock', JSON.stringify({ narrowW, dock: gn.dock }))
  check((await page.evaluate(() => localStorage.getItem('orgai.sidePanel.run'))) === null, 'the width alone saved no choice')
  check((await page.locator('.composer textarea').isVisible()) && (await page.locator('[data-testid=live-settings-bar]').isVisible()) && (await page.locator('[data-testid=live-model-change]').first().isVisible()), 'the composer, settings row and model switch are on screen without a click')
  check(!!gn.composer && !!gn.hold && !!gn.frame && gn.hold.t >= gn.frame.t && gn.hold.l >= gn.frame.l - 1 && gn.hold.r <= gn.frame.r + 1 && gn.frame.b <= gn.composer.t + 1, 'the hold card sits inside the canvas frame and the composer does not cover it', JSON.stringify(gn))
  check(!!stageBox && stageBox.w >= 560 && stageBox.h >= 200, 'the canvas keeps a usable area', JSON.stringify(stageBox))
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.run-body').scrollWidth <= document.querySelector('.run-body').clientWidth + 1), 'no horizontal overflow in the narrow fallback')
  check((await page.locator('[data-testid=dock-show]').isVisible()) && (await page.locator('.side-rail button').first().isVisible()), 'the rail and the toolbar Conversation button both reach the feed')
  await shot('dock-rail-1024')
  // Keyboard show from the fallback: the dock opens and focus goes to the composer; that is an explicit choice and is saved.
  await page.locator('[data-testid=dock-show]').focus()
  await page.keyboard.press('Enter')
  await sleep(700)
  check((await geo()).dock === 'open' && (await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.live-composer-region'))), 'Enter on Conversation opens the dock from the fallback and focuses the composer')
  // The saved choice is dropped again: the rail comes back at the next window resize and unfolds when the room returns.
  await page.evaluate(() => localStorage.removeItem('orgai.sidePanel.run'))
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [1026, 640])
  await page.waitForFunction(() => document.querySelector('.run-body')?.getAttribute('data-dock') === 'rail', null, { timeout: 5000 }).catch(() => {})
  check((await geo()).dock === 'rail', 'with no saved choice a window resize folds the narrow run view to the rail again')
  await page.locator('[data-testid=sidebar-toggle], .brand-lockup-expand').first().click()
  await page.waitForFunction(() => document.querySelector('.run-body')?.getAttribute('data-dock') === 'open', null, { timeout: 5000 }).catch(() => {})
  check((await geo()).dock === 'open', 'the rail unfolds to the dock when the sidebar collapses and the room returns')
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [1600, 1000])
  await sleep(600)
  if (await page.evaluate(() => document.querySelector('.app')?.getAttribute('data-sidebar') === 'rail')) await page.locator('[data-testid=sidebar-toggle], .brand-lockup-expand').first().click()
  await sleep(500)
  // Hide: a draft, the model switch element and its focus survive; focus moves to the toolbar button; decisions stay on the stage.
  const draft = page.locator('.composer textarea')
  await draft.fill('A draft that must survive hiding the dock')
  await page.evaluate(() => { document.querySelector('[data-testid=live-settings-bar]').__keep = 'same node' })
  await page.getByRole('button', { name: /^Hide run panel/ }).click()
  await sleep(700)
  let gh = await geo()
  check(gh.dock === 'hidden' && (await page.locator('[data-testid=dock-show]').isVisible()), 'hiding the dock shows the Conversation button in the canvas toolbar', JSON.stringify(gh))
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'dock-show'), 'focus moves to the Conversation button after Hide')
  check(!(await page.locator('.composer textarea').isVisible()), 'the composer is not drawn while the dock is hidden')
  check((await page.locator('[data-testid=run-hold]').isVisible()) && !!gh.stage && gh.stage.r - gh.stage.l > 900 * 0.6, 'the hold card stays on the stage and the stage takes the width', JSON.stringify(gh))
  check((await page.locator('[data-testid=live-settings-bar]').count()) === 1 && (await page.evaluate(() => document.querySelector('[data-testid=live-settings-bar]').__keep)) === 'same node', 'the model switch row stays the same mounted element while hidden')
  await shot('dock-hidden-1600')
  // Show by keyboard: Enter on the button puts focus in the composer with the draft intact; by mouse focus stays put.
  await page.locator('[data-testid=dock-show]').focus()
  await page.keyboard.press('Enter')
  await sleep(700)
  check((await geo()).dock === 'open', 'Enter on the Conversation button shows the dock')
  check(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.live-composer-region')), 'a keyboard show moves focus to the composer')
  check((await page.locator('.composer textarea').inputValue()) === 'A draft that must survive hiding the dock', 'the draft survived hide and show')
  check((await page.evaluate(() => document.querySelector('[data-testid=live-settings-bar]').__keep)) === 'same node', 'the model switch row was not remounted by hide and show')
  check((await scrollEnd()) !== null && (await scrollEnd()) <= 2, 'the conversation is at the newest message after hide and show', String(await scrollEnd()))
  await page.getByRole('button', { name: /^Hide run panel/ }).click()
  await sleep(500)
  await page.locator('[data-testid=dock-show]').click()
  await sleep(600)
  check(await page.evaluate(() => document.activeElement?.tagName !== 'TEXTAREA'), 'a mouse show leaves focus where the click put it')
  // Reduced motion: the dock appears at its end state, no slide.
  await page.evaluate(() => document.documentElement.setAttribute('data-reduce-motion', 'on'))
  await page.getByRole('button', { name: /^Hide run panel/ }).click()
  await sleep(150)
  check((await geo()).dock === 'hidden', 'reduced motion: hidden at once')
  await page.locator('[data-testid=dock-show]').click()
  await sleep(150)
  check((await geo()).dock === 'open', 'reduced motion: shown at once')
  await page.evaluate(() => document.documentElement.removeAttribute('data-reduce-motion'))
  await draft.fill('')
  // Find an agent is drawn only once the run has more than a handful of agents (checked with a seven-agent run at the end).
  check((await page.locator('[data-testid=find-agent]').count()) === 0, 'a one-agent run has no Find an agent button')

  // ---- One-agent view.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const node = page.locator('.react-flow__node').first()
  await node.waitFor({ timeout: 10_000 })
  await node.click()
  const open = page.locator('[data-testid=agent-focus-open]')
  await open.waitFor({ timeout: 5000 })
  await open.click()
  await page.locator('.agent-focus').waitFor({ timeout: 5000 })
  check((await page.locator('.react-flow').count()) === 0, 'the one-agent view takes the stage')
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await sleep(300)
    await shot(`focus-${theme}`)
  }
  await page.keyboard.press('Escape')
  await sleep(700)
  check((await page.locator('.agent-focus').count()) === 0 && (await page.locator('.react-flow').count()) === 1, 'Escape closes the one-agent view')
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'agent-focus-open'), 'focus returns to the button that opened it')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

  // ---- Budget stop: needs the project's per-run cap (set through the project's Settings, Spending limits).
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'Spending limits', exact: true }).click()
  await page.locator('.settings-pane-title').waitFor({ timeout: 10_000 })
  await page.evaluate(() => { const d = document.querySelector('details[data-testid=settings-advanced][data-pane="project-limits"]'); if (d) d.open = true })
  const cap = page.locator('[data-testid=limit-run-input]')
  await cap.waitFor({ timeout: 10_000 })
  await cap.fill('1')
  await cap.press('Enter')
  await sleep(800)
  await projectTab(page, 'Live').click()
  await page.waitForFunction(async (n) => (await window.orgai.projects.list()).find((p) => p.name === n)?.maxBudgetUsd === 1, NAME, { timeout: 8000 }).catch(() => {})
  check((await findProject(page, NAME))?.maxBudgetUsd === 1, 'the per-run cost cap of $1 saved through Settings')
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  await start('Work until the limit [mock:budget-stop]')
  await hold.waitFor({ timeout: 30_000 })
  check((await hold.getAttribute('data-kind')) === 'budget', 'the hold card names the spending limit', String(await hold.getAttribute('data-kind')))
  const choose = hold.getByRole('radio', { name: /Add to the limit/ })
  if (await choose.count()) await choose.check()
  const addBtn = hold.getByRole('button', { name: /^Add and continue/ })
  const dlg = page.locator('dialog[open]')
  // Cancel adds nothing; the held Enter (key repeat) lands on Cancel and cannot confirm.
  await addBtn.focus()
  await page.keyboard.down('Enter')
  await dlg.first().waitFor({ timeout: 5000 })
  check(await page.evaluate(() => /^Cancel$/.test(document.activeElement?.textContent?.trim() ?? '')), 'the add-budget confirmation opens with focus on Cancel')
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await sleep(500)
  check((await dlg.count()) === 0 && (await hold.count()) === 1 && (await hold.getAttribute('data-kind')) === 'budget', 'a held Enter cannot confirm: nothing was added and the hold stays')
  await addBtn.click()
  await dlg.first().waitFor({ timeout: 5000 })
  await dlg.first().getByRole('button', { name: 'Cancel' }).click()
  await sleep(400)
  check((await hold.count()) === 1, 'Cancel adds nothing and the run stays held')
  // A refusal from main shows inline: $5 is more than the $1 the project allows for one run.
  await hold.getByLabel('Add to this run’s limit').fill('5')
  await addBtn.click()
  await page.locator('[data-testid=run-hold-confirm]').click()
  await hold.locator('.run-hold-error').waitFor({ timeout: 10_000 })
  check(/more than this project allows|project/i.test(await hold.locator('.run-hold-error').innerText()), 'a refusal from main shows inline in the card', await hold.locator('.run-hold-error').innerText())
  check((await hold.count()) === 1, 'the refused amount did not continue the run')
  // A confirmed amount within the cap continues the run.
  await hold.getByLabel('Add to this run’s limit').fill('0.5')
  await addBtn.click()
  await page.locator('[data-testid=run-hold-confirm]').click()
  await page.locator('[data-testid=run-hold][data-kind=budget]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
  check((await page.locator('[data-testid=run-hold][data-kind=budget]').count()) === 0, 'a confirmed amount continues the run and the hold goes')
  await shot('budget-continued')

  // ---- Usage limit: "Resume now" starts a new provider turn before the reset and can spend, so it asks first like
  // "Try again": the confirmation names it, focus starts on Cancel, and a held Enter cannot confirm.
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  await start('Hit the limit [mock:model-switch-limit]')
  const limitHold = page.locator('[data-testid=run-hold][data-kind=usage-limit]')
  await limitHold.waitFor({ timeout: 30_000 })
  const resumeBtn = limitHold.getByRole('button', { name: /^Resume now$/ })
  check((await resumeBtn.count()) === 1, 'the usage-limit hold offers Resume now')
  await resumeBtn.focus()
  await page.keyboard.down('Enter')
  await dlg.first().waitFor({ timeout: 5000 })
  check(/Resume now\?/.test(await dlg.first().innerText()) && /spend/i.test(await dlg.first().innerText()), 'Resume now asks first and says it can spend', (await dlg.first().innerText()).replace(/\s+/g, ' ').slice(0, 160))
  check(await page.evaluate(() => /^Cancel$/.test(document.activeElement?.textContent?.trim() ?? '')), 'the Resume now confirmation opens with focus on Cancel')
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await sleep(500)
  check((await dlg.count()) === 0 && (await limitHold.count()) === 1, 'a held Enter on Resume now cannot confirm: the hold stays')
  check((await resumeBtn.isEnabled()) && !(await resumeBtn.getAttribute('disabled')), 'the action button stays enabled (never a disabled button under focus)')

  // ---- Find an agent (canvas toolbar): drawn with more than a handful of agents, and it shows a hidden dock.
  const proj = await findProject(page, NAME)
  const rootRole = proj.roles.find((r) => r.reportsTo === null)
  const slug = (proj.roles.find((r) => rootRole.spawnable.includes(r.id)) ?? proj.roles.find((r) => r.reportsTo !== null)).slug
  fs.writeFileSync(
    scriptFile,
    JSON.stringify({
      delayMs: 150,
      work: [
        ...[1, 2, 3, 4, 5, 6].map((i) => ({ type: 'spawn', id: `find-${i}`, name: `find-${i}`, role: slug, description: `Report ${i}`, ...(i > 3 ? { parent: 'find-1' } : {}) })),
        { type: 'text', text: 'Staffed.' },
        { type: 'tool', agent: 'find-1', name: 'Read', input: { file_path: 'a.ts' }, result: 'x', holdMs: 120_000 }
      ]
    })
  )
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  await start('Six reports to find')
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 7, null, { timeout: 60_000, polling: 300 })
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [1600, 1000])
  await sleep(800)
  const findBtn = page.locator('[data-testid=find-agent]')
  check((await findBtn.count()) === 1 && (await findBtn.getAttribute('aria-label')) === 'Find an agent', 'with seven agents the toolbar draws the Find an agent button')
  // The hide button may be under the run panel's header at some sizes: hide with the dock's own button, then Find shows it again.
  await page.getByRole('button', { name: /^Hide run panel/ }).click()
  await sleep(600)
  await findBtn.click()
  await sleep(700)
  check((await geo()).dock === 'open', 'Find an agent shows a hidden dock')
  check(await page.evaluate(() => document.querySelector('.side-panel [role=tab][aria-selected=true]')?.textContent?.includes('Agents') ?? false), 'Find an agent opens the Agents tab', await page.evaluate(() => document.querySelector('.side-panel [role=tab][aria-selected=true]')?.textContent ?? ''))
  finish('run-hold')
} finally {
  await cleanup(app, page, NAME)
}
