// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Concurrent runs: two run tabs (R1/R2), the run header names the
// viewed run, the New run page is blank, a finished run defaults to New run with Continue as the second choice, the
// sidebar lists open runs, the History tab lists runs, the run-messaging Switch persists, and "Open in new window"
// opens a window scoped to #/run/<projectId>/<runId> whose title carries the run tag.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, endSession, finish, findProject, launch, log, makeFixtureRepo, openProject, projectTab, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
// Per-run script file: starts as the default work script (only the delay is set); the MCP step rewrites it.
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-runs-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E runs (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-runs-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('runs', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'runs' })
const tabsBar = () => page.getByRole('tablist', { name: 'Project sections' })
const startOnPage = async (text) => {
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}
try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  check(project?.runMessaging !== true, 'run messaging is off by default')
  await tabsBar().getByRole('tab', { name: 'Live', exact: true }).click()
  await page.locator('.new-run').waitFor({ timeout: 10_000 })

  await startOnPage('First concurrent task')
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  check((await page.locator('[data-testid=run-meta]').count()) === 0 && (await page.locator('.agent-node').count()) === 0, 'New run page shows no old run metadata or nodes')
  await startOnPage('Second concurrent task')
  await page.waitForFunction(() => document.querySelectorAll('.run-tablist [role="tab"]').length === 2 && !document.querySelector('.new-run'), null, { timeout: 15_000 })
  await sleep(600)

  const tabs = await page.locator('.run-tablist [role="tab"] .run-tab-index').allInnerTexts()
  check(tabs.length === 2 && new Set(tabs).size === 2 && tabs.includes('R1') && tabs.includes('R2'), 'two concurrent runs have distinct R1/R2 tabs', tabs.join(','))
  const hdr2 = (await page.locator('[data-testid=run-strip] .run-tab[aria-selected=true]').getAttribute('aria-label')) ?? ''
  check(hdr2.startsWith('R2') && /Second concurrent/.test(hdr2), 'the active run tab names the viewed run (R2)', hdr2)
  await page.locator('.run-tablist [role="tab"]', { hasText: 'R1' }).click()
  await sleep(500)
  const hdr1 = (await page.locator('[data-testid=run-strip] .run-tab[aria-selected=true]').getAttribute('aria-label')) ?? ''
  check(hdr1.startsWith('R1') && /First concurrent/.test(hdr1), 'switching tabs changes the active tab to R1', hdr1)
  const liveRuns = await page.evaluate(() => window.orgai.runs.listLive())
  check(Array.isArray(liveRuns) && liveRuns.length === 2, 'runs.listLive reports both runs', String(liveRuns?.length))

  // Sidebar: the project row expands to its open runs.
  const toggle = page.locator('.sidebar button.nav-chevron').first()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await sleep(200)
  check((await page.locator('.sidebar .nav-runs .nav-run').count()) === 2, 'sidebar project row lists its two open runs')
  await shot('two-runs')

  // Hash deep link: a second window scoped to R1.
  const proj = await findProject(page, NAME)
  const runs = await page.evaluate((id) => window.orgai.runs.list(id), proj.id)
  const r1 = [...runs].sort((a, b) => a.startedAt - b.startedAt)[0]
  await page.evaluate((t) => window.orgai.window.openRun(t), { projectId: proj.id, runId: r1.id })
  let win2
  for (let i = 0; i < 30 && !win2; i++) {
    win2 = app.windows().find((w) => w !== page)
    if (!win2) await sleep(500)
  }
  check(!!win2, 'window:openRun opens a second window')
  if (win2) {
    await win2.waitForSelector('[data-testid=run-meta]', { timeout: 20_000 }).catch(() => {})
    await sleep(500)
    check(win2.url().includes(`#/run/${proj.id}/${r1.id}`), 'second window loads the run hash', win2.url())
    const title = await win2.title()
    check(/R1/.test(title), 'second window title carries the run tag R1', title)
    await screenshot(win2, 'runs-window')
    await win2.close().catch(() => {})
  }
  const bad = await page.evaluate(() => window.orgai.window.openRun({ projectId: '../x', runId: 'nope' }).then(() => 'ok', (e) => String(e.message ?? e)))
  check(bad !== 'ok', 'window:openRun refuses a malformed target', bad)

  // Finish R1: the default action is a New run, Continue this run is the second choice.
  await page.locator('.run-tablist [role="tab"]', { hasText: 'R1' }).click()
  await sleep(300)
  // H4: a pending permission card must go away when its session ends.
  const permCards = page.locator('article.decision-card[data-kind="permission"]')
  await permCards.first().waitFor({ timeout: 15_000 }).catch(() => {})
  const permBefore = await permCards.count()
  check(permBefore >= 1, 'a pending permission card is shown before End session', String(permBefore))
  if (permBefore >= 1) {
    const needsRow = page.locator('[data-testid=needs-you-row]')
    check((await needsRow.count()) >= 1, 'the Needs you row appears in the sidebar while a decision is pending')
  }
  if (permBefore >= 1) {
    // Tray placement at 1024x640: under the stage (never beside it), the stage keeps 55 percent of the frame, cards go compact.
    const prevSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
    await sleep(700)
    const tm = await page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && { l: b.left, r: b.right, t: b.top, b: b.bottom } }
      const btn = document.querySelector('section.frame-tray .decision-footer .btn')?.getBoundingClientRect()
      return { stage: r('.frame-stage'), tray: r('section.frame-tray'), frame: r('.canvas-frame'), compact: document.querySelector('section.frame-tray')?.getAttribute('data-compact'), ih: window.innerHeight, btnBottom: btn?.bottom, strip: r('[data-testid=run-strip]'), toolbar: r('.frame-toolbar'), topbar: r('main .topbar') }
    })
    check(!!tm.tray && !!tm.stage && tm.tray.t >= tm.stage.b - 0.5 && tm.tray.l <= tm.stage.l + 0.5, 'the tray sits under the stage at 1024x640', JSON.stringify(tm))
    check(!!tm.frame && !!tm.stage && (tm.stage.b - tm.stage.t) >= 0.55 * (tm.frame.b - tm.frame.t) - 1, 'the stage keeps at least 55 percent of the frame with the tray open', JSON.stringify(tm))
    check(tm.compact === 'true', 'the tray is compact (data-compact) in a frame under 480 px high', String(tm.compact))
    check(tm.btnBottom === undefined || tm.btnBottom <= tm.ih + 0.5, 'the card action row is reachable inside the window at 1024x640', String(tm.btnBottom))
    log('chrome above the canvas at 1024x640 (px from window top to stage):', Math.round(tm.stage?.t ?? 0), 'stage', `${Math.round((tm.stage?.r ?? 0) - (tm.stage?.l ?? 0))}x${Math.round((tm.stage?.b ?? 0) - (tm.stage?.t ?? 0))}`)
    await shot('tray-1024x640')
    // The action row is fully inside the tray's visible box and clear of the card body text.
    const am = await page.evaluate(() => {
      const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom } }
      const tray = document.querySelector('section.frame-tray')
      const card = tray?.querySelector('article.decision-card')
      if (!tray || !card) return null
      const tb = box(tray)
      const btns = [...card.querySelectorAll('footer button')].map(box)
      const foot = card.querySelector('footer') ? box(card.querySelector('footer')) : null
      const texts = [...card.querySelectorAll('.decision-head, .decision-body')].filter((el) => el.getClientRects().length).map(box)
      const inside = btns.every((b) => b.t >= tb.t - 0.5 && b.b <= tb.b + 0.5 && b.l >= tb.l - 0.5 && b.r <= tb.r + 0.5)
      const overlap = texts.some((t) => btns.some((b) => b.l < t.r && b.r > t.l && b.t < t.b - 0.5 && b.b > t.t + 0.5))
      // A bare "0" (a falsy count rendered by `n && <x/>`) anywhere in the tray.
      const w = document.createTreeWalker(tray, NodeFilter.SHOW_TEXT)
      let stray = 0
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim() === '0') stray++
      const small = []
      for (const el of document.querySelectorAll('main *')) {
        if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) || !el.getClientRects().length) continue
        const fs = parseFloat(getComputedStyle(el).fontSize)
        if (fs < 12) small.push(`${el.className || el.tagName}:${fs}`)
      }
      const meta = document.querySelector('[data-testid=run-meta]')
      const badges = meta ? [...meta.querySelectorAll('.badge')].map((b) => b.className) : null
      return { n: btns.length, inside, overlap, stray, foot, tb, badges, small }
    })
    check(!!am && am.n > 0 && am.inside, 'the decision card action row is fully inside the tray at 1024x640', JSON.stringify(am))
    check(!!am && !am.overlap, 'the action row does not overlap the card body text at 1024x640')
    check(!!am && am.small.length === 0, 'no visible text under 12 px in the Live view at 1024x640', JSON.stringify(am?.small))
    check(!!am && am.stray === 0, 'no stray "0" text node in the tray')
    check(!!am && am.badges !== null && am.badges.every((c) => /neutral/.test(c)), 'run-meta holds text, not coloured badges', JSON.stringify(am?.badges))
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), prevSize)
    await sleep(500)
    // Side tabs are real tabs: ArrowRight moves from Transcript to Plan.
    const tTab = page.locator('[data-testid=side-tab-transcript]')
    if ((await tTab.count()) && !(await tTab.isVisible())) {
      await page.getByRole('button', { name: /^Show run panel/ }).click().catch(() => {})
      await sleep(300)
    }
    if (await tTab.isVisible().catch(() => false)) {
      check((await tTab.getAttribute('role')) === 'tab', 'the Transcript side tab has role=tab')
      await tTab.focus()
      await page.keyboard.press('ArrowRight')
      await sleep(200)
      const sel = await page.locator('[data-testid=side-tab-plan]').getAttribute('aria-selected')
      check(sel === 'true', 'ArrowRight on the Transcript tab selects Plan', String(sel))
      await tTab.click()
    } else {
      check(false, 'the side panel tabs are reachable on the Live view')
    }
  }
  await endSession(page)
  await sleep(500)
  const permAfter = await permCards.count()
  check(permAfter < permBefore, 'the permission card disappears after End session (H4)', `${permBefore} -> ${permAfter}`)
  const mode = (await page.locator('.composer').innerText()).replace(/\s+/g, ' ')
  check(/New run/.test(mode) && !/Continuing this run/.test(mode), 'a finished run defaults to New run', mode.slice(0, 120))
  check((await page.locator('.composer .btn.primary').innerText()).trim() === 'Start', 'finished run primary action is Start')
  check((await page.locator('.composer').getByText('Continue this run', { exact: true }).count()) === 1, 'Continue this run is offered as the second choice')
  await shot('finished-run')

  // History tab lists both runs.
  await tabsBar().getByRole('tab', { name: 'History', exact: true }).click()
  await sleep(500)
  const rows = await page.locator('.run-row').count()
  check(rows === 2, 'History tab lists both runs', String(rows))
  await shot('history')

  // A1: a pending request_mcp_install must render a card in the tray; denying it clears the card and the run goes on.
  fs.writeFileSync(scriptFile, JSON.stringify({
    delayMs: 300,
    work: [
      { type: 'text', text: 'I need a docs server for this task.' },
      { type: 'harness', name: 'request_mcp_install', args: { reason: 'Read the vendor docs.', manual: { name: 'e2e-docs', transport: 'stdio', command: 'npx', args: ['-y', 'e2e-docs-server@1.0.0'] } } },
      { type: 'text', text: 'Carrying on without the docs server.' }
    ]
  }))
  await tabsBar().getByRole('tab', { name: 'Live', exact: true }).click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage('Needs an MCP server')
  const mcpCard = page.locator('[data-testid=mcp-install-card]')
  await mcpCard.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  check((await mcpCard.count()) === 1 && (await mcpCard.first().isVisible()), 'a pending MCP install request renders a card (A1)')
  check((await mcpCard.getByRole('button', { name: 'Approve', exact: true }).count()) === 1 && (await mcpCard.getByRole('button', { name: 'Deny', exact: true }).count()) === 1, 'the MCP card has Approve and Deny buttons')
  await shot('mcp-card')
  await mcpCard.getByRole('button', { name: 'Deny', exact: true }).click()
  // A denied request stays as a resolved card (Denied badge, Dismiss) with no Approve or Deny left; Dismiss removes it.
  await mcpCard.getByRole('button', { name: 'Dismiss', exact: true }).waitFor({ timeout: 10_000 }).catch(() => {})
  check((await mcpCard.getByText('Denied', { exact: true }).count()) >= 1 && (await mcpCard.getByRole('button', { name: 'Deny', exact: true }).count()) === 0 && (await mcpCard.getByRole('button', { name: 'Approve', exact: true }).count()) === 0, 'the MCP card resolves to Denied with no Approve or Deny buttons')
  await mcpCard.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await sleep(300)
  check((await mcpCard.count()) === 0, 'Dismiss removes the resolved MCP card')
  await page.getByText('Carrying on without the docs server.').first().waitFor({ timeout: 15_000 }).catch(() => {})
  check((await page.getByText('Carrying on without the docs server.').count()) >= 1, 'the run proceeds after the MCP request is denied')
  await endSession(page)

  // Three open decisions (two background permission asks, then ask_user): the question's options are answerable at
  // 1024x640, the chips never overflow, End session keeps its words, Needs you counts decisions, the tray docks beside
  // the stage only in a frame of 1500 px or more.
  fs.writeFileSync(scriptFile, JSON.stringify({
    delayMs: 250,
    work: [
      { type: 'text', text: 'Starting.' },
      { type: 'spawn', id: 'mock-report-1', description: 'Implement the limiter' },
      { type: 'tool', agent: 'mock-report-1', name: 'Bash', input: { command: 'npm test' }, ask: true, background: true, result: 'ok' },
      { type: 'tool', agent: 'mock-report-1', name: 'Edit', input: { file_path: 'src/limiter.js', old_string: 'a', new_string: 'b' }, ask: true, background: true, result: 'ok' },
      { type: 'harness', name: 'ask_user', args: { question: 'Which limiter strategy should the notes API use for write requests?', options: [{ label: 'Token bucket', description: 'Allows short bursts.' }, { label: 'Fixed window', description: 'Simple counter per minute.' }, { label: 'Sliding window', description: 'Most accurate.' }], allowMultiple: false, allowFreeText: true } },
      { type: 'text', text: 'Done.' }
    ]
  }))
  await tabsBar().getByRole('tab', { name: 'Live', exact: true }).click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage('Add rate limiting with three decisions')
  await page.locator('.decision-chip').nth(2).waitFor({ timeout: 20_000 }).catch(() => {})
  await sleep(1500)
  const prev3 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  const setSize = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(800)
  }
  const panelToggle = () => page.locator('.side-panel').getByRole('button').first()
  const trayState = () => page.evaluate(() => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom } }
    const list = document.querySelector('.decision-list')
    const chips = [...document.querySelectorAll('.decision-chip')]
    const card = document.querySelector('section.frame-tray article.decision-card')
    const tray = box('section.frame-tray')
    const radios = card ? [...card.querySelectorAll('input[type=radio]')].map((r) => { const b = r.getBoundingClientRect(); return { t: b.top, b: b.bottom } }) : []
    const submit = card?.querySelector('.decision-footer .btn.primary')?.getBoundingClientRect()
    const end = [...document.querySelectorAll('.run-actions button')].find((b) => /End session/.test(b.getAttribute('aria-label') ?? ''))
    const label = end?.querySelector('.run-act-label')?.getBoundingClientRect()
    return {
      kind: card?.getAttribute('data-kind'),
      chips: chips.length,
      tabbable: chips.filter((c) => c.tabIndex === 0).length,
      overflow: list ? list.scrollWidth - list.clientWidth : -1,
      numbered: chips.length > 0 && getComputedStyle(chips[0].querySelector('.decision-chip-label')).display === 'none',
      overlap: chips.some((c, i) => i > 0 && c.getBoundingClientRect().left < chips[i - 1].getBoundingClientRect().right - 0.5),
      tray,
      stage: box('.frame-stage'),
      radiosInside: radios.length >= 3 && tray ? radios.every((r) => r.t >= tray.t && r.b <= tray.b) : false,
      submitInside: !!submit && !!tray && submit.bottom <= tray.b - 1 && submit.top >= tray.t,
      endLabelW: label ? label.width : 0,
      composerH: document.querySelector('.composer')?.getBoundingClientRect().height ?? 0
    }
  })
  await setSize(1024, 640)
  let ts = await trayState()
  check(ts.chips === 3 && ts.kind === 'question', 'three decisions open and the tray opens on the question (first open decision)', JSON.stringify(ts))
  check(ts.radiosInside && ts.submitInside, 'the question options and Submit are visible inside the tray at 1024x640 (side panel closed)', JSON.stringify(ts))
  check(ts.overflow <= 0 && !ts.overlap && ts.tabbable === 1, 'decision chips do not overflow or overlap and are one Tab stop (1024)', JSON.stringify(ts))
  check(ts.endLabelW > 20, 'End session keeps its text label at 1024', String(ts.endLabelW))
  check(ts.composerH <= 100, 'the composer is at most 100 px tall', String(ts.composerH))
  await shot('three-decisions-1024')
  // Side panel open: a narrower tray (numbered chips), options still visible, End session still labelled.
  await panelToggle().click().catch(() => {})
  await sleep(600)
  ts = await trayState()
  check(ts.overflow <= 0 && !ts.overlap && ts.tabbable === 1, 'chips do not overflow or overlap with the side panel open at 1024', JSON.stringify(ts))
  check(ts.radiosInside && ts.submitInside, 'the question options and Submit stay visible with the side panel open at 1024x640', JSON.stringify(ts))
  check(ts.endLabelW > 20, 'End session keeps its text label with the side panel open at 1024', String(ts.endLabelW))
  await shot('three-decisions-1024-panel')
  // Side panel resize on a live run at 1024 (sidebar is a rail here): pointer drag to the max keeps the canvas >= 360 px.
  {
    const handle = page.locator('[data-testid=side-panel-resize]').first()
    const geo = () => page.evaluate(() => ({
      panel: Math.round(document.querySelector('.side-panel')?.getBoundingClientRect().width ?? 0),
      stage: Math.round(document.querySelector('.frame-stage')?.getBoundingClientRect().width ?? 0),
      sidebar: Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0)
    }))
    check((await page.locator('[data-testid=sidebar-resize]').count()) === 0 && (await geo()).sidebar <= 60, 'no sidebar resize handle while the sidebar is a rail (1024)', JSON.stringify(await geo()))
    const g0 = await geo()
    const hb = await handle.boundingBox()
    check(!!hb, 'the run view side panel has a resize handle with a live run')
    if (hb) {
      const y = hb.y + hb.height / 2
      await page.mouse.move(hb.x + hb.width / 2, y)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2 - 40, y, { steps: 4 })
      await page.mouse.up()
      await sleep(200)
      const g1 = await geo()
      check(g1.panel - g0.panel >= 30, 'dragging the run side panel handle left widens the panel', `${g0.panel} -> ${g1.panel}`)
      const hb2 = await handle.boundingBox()
      await page.mouse.move(hb2.x + hb2.width / 2, y)
      await page.mouse.down()
      await page.mouse.move(hb2.x + hb2.width / 2 - 900, y, { steps: 8 })
      await page.mouse.up()
      await sleep(250)
      const g2 = await geo()
      check(g2.stage >= 359, 'dragged to max at 1024 the canvas stage keeps at least 360 px', JSON.stringify(g2))
      check(g2.panel <= 640 && g2.panel >= g1.panel, 'the panel stays within 280-640 px', JSON.stringify(g2))
      await shot('side-panel-max-1024')
      await handle.dblclick()
      await sleep(200)
      check(Math.abs((await geo()).panel - g0.panel) <= 1, 'double-click restores the run side panel default width', JSON.stringify(await geo()))
      // Enter on the focused handle resets too (keyboard path): widen with ArrowLeft, then Enter.
      await handle.focus()
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowLeft')
      await sleep(150)
      const gk = await geo()
      await page.keyboard.press('Enter')
      await sleep(200)
      const gr = await geo()
      check(Math.abs(gr.panel - g0.panel) <= 1 && gr.stage >= 359, 'Enter on the focused side panel handle resets to the default width', `${g0.panel} -> ${gk.panel} -> ${gr.panel}`)
    }
    await panelToggle().click().catch(() => {})
    await sleep(500)
    check((await page.locator('[data-testid=side-panel-resize]:visible').count()) === 0, 'no side panel handle while the panel is collapsed')
    await panelToggle().click().catch(() => {})
    await sleep(500)
  }
  // ArrowRight moves focus along the chips without a second Tab stop.
  await page.locator('.decision-chip[tabindex="0"]').focus()
  await page.keyboard.press('ArrowRight')
  const rovedTo = await page.evaluate(() => document.activeElement?.textContent ?? '')
  check(/^2/.test(rovedTo), 'ArrowRight moves focus to the next decision chip', rovedTo)
  // 1424: labelled chips, no overflow, the tray stays under the stage when the panel collapses.
  await setSize(1424, 881)
  ts = await trayState()
  check(ts.overflow <= 0 && !ts.overlap, 'chips do not overflow at 1424x881 (panel open)', JSON.stringify(ts))
  check(!!ts.tray && !!ts.stage && ts.tray.t >= ts.stage.b - 0.5, 'the tray is under the stage at 1424 with the panel open', JSON.stringify(ts))
  await panelToggle().click().catch(() => {})
  await sleep(600)
  ts = await trayState()
  check(!!ts.tray && !!ts.stage && ts.tray.t >= ts.stage.b - 0.5, 'collapsing the side panel at 1424 keeps the tray under the stage', JSON.stringify(ts))
  // Needs you counts decisions at every level (an older run may hold one more) and the list names the ask first.
  const needs = (await page.locator('[data-testid=needs-you-row]').innerText()).replace(/\s+/g, ' ')
  const needsN = Number(/Needs you · (\d+)/.exec(needs)?.[1] ?? 0)
  await page.locator('[data-testid=needs-you-row]').click()
  const items = page.locator('[data-testid=needs-you-list] .needs-item')
  await items.first().waitFor({ timeout: 5000 }).catch(() => {})
  await sleep(300)
  check((await items.count()) === needsN && needsN >= 3, 'the Needs you row counts decisions: its number equals the list length', `${needs} / ${await items.count()}`)
  const q = items.filter({ hasText: 'Question: Which limiter' })
  const qText = ((await q.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(/^Question: Which limiter/.test(qText) && /R\d/.test(qText), 'a Needs you item shows the kind and ask first, then the location', qText)
  const navBadge = ((await page.locator('[data-testid=nav-project][data-name="' + NAME + '"] .badge').first().innerText().catch(() => '')) || '').trim()
  check(navBadge === String(needsN), 'the project row badge counts decisions, like the Needs you row', `${navBadge} vs ${needsN}`)
  const navTip = (await page.locator('[data-testid=nav-project][data-name="' + NAME + '"]').getAttribute('title').catch(() => '')) ?? ''
  check(new RegExp(`${needsN} decisions · \\d+ runs?`).test(navTip), 'the project row subtitle reads "n decisions · m runs"', navTip)
  // Open the Bash permission: the tray shows that card, not the default one.
  await items.filter({ hasText: 'Allow: Run npm test' }).first().click()
  await sleep(500)
  const opened = await page.evaluate(() => document.querySelector('section.frame-tray article.decision-card')?.getAttribute('aria-label') ?? '')
  check(/^Permission: Run npm test/.test(opened), 'clicking a Needs you item opens that decision', opened)
  // Beside only in a frame of 1500 px or more.
  await setSize(2400, 1000)
  ts = await trayState()
  check(!!ts.tray && !!ts.stage && ts.tray.l >= ts.stage.r - 0.5, 'the tray docks beside the stage in a frame of 1500 px or more', JSON.stringify(ts))
  await shot('three-decisions-2400')
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), prev3)
  await sleep(400)
  await endSession(page)

  // AI run titles (mock adapter: the title is the first 4 words of the prompt, capitalised).
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
  const TITLED_PROMPT = 'Please refactor the billing module and add tests'
  const TITLE = 'Please refactor the billing'
  await tabsBar().getByRole('tab', { name: 'Live', exact: true }).click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage(TITLED_PROMPT)
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  const projNow = await findProject(page, NAME)
  const summaryFor = async (needle) => (await page.evaluate((id) => window.orgai.runs.list(id), projNow.id)).find((r) => r.prompt.includes(needle))
  let titled
  for (let i = 0; i < 30 && !titled?.title; i++) {
    titled = await summaryFor('billing module')
    if (!titled?.title) await sleep(300)
  }
  check(titled?.title === TITLE, 'the mock run title is the first four words of the prompt, persisted on RunSummary', String(titled?.title))
  const titledTab = page.locator('.run-tablist [role="tab"]', { hasText: TITLE })
  await titledTab.first().waitFor({ timeout: 10_000 }).catch(() => {})
  const tabText = ((await titledTab.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(tabText.includes(TITLE) && !tabText.includes('module'), 'the run tab shows the 4-word title, not the prompt', tabText)
  const tabTip = (await titledTab.first().getAttribute('title').catch(() => '')) ?? ''
  check(tabTip.includes(TITLED_PROMPT), 'the run tab tooltip still carries the full prompt', tabTip)
  const head = ((await page.locator('[data-testid=run-strip] .run-tab[aria-selected=true] .run-tab-title').first().innerText()) || '').replace(/\s+/g, ' ').trim()
  check(head === TITLE, 'the active run tab shows the title', head)
  check((await page.locator('.run-header').count()) === 0, 'the 44 px run header is gone (strip + toolbar)')
  const metaText = ((await page.locator('[data-testid=run-meta]').innerText()) || '').toLowerCase()
  check(!metaText.includes('add tests') && /agent/.test(metaText), 'the metadata line shows facts, not the prompt', metaText.slice(0, 120))
  const sbToggle = page.locator('.sidebar button.nav-chevron').first()
  if ((await sbToggle.getAttribute('aria-expanded')) !== 'true') await sbToggle.click()
  await sleep(200)
  const sbRow = (await page.locator('.sidebar .nav-runs .nav-run-title').allInnerTexts()).map((t) => t.trim())
  check(sbRow.includes(TITLE), 'the sidebar row shows the title', sbRow.join(' | '))
  await shot('run-title')

  // A run window (new window, fresh renderer) loads the persisted title.
  await page.evaluate((t) => window.orgai.window.openRun(t), { projectId: projNow.id, runId: titled.id })
  let win3
  for (let i = 0; i < 30 && !win3; i++) {
    win3 = app.windows().find((w) => w !== page)
    if (!win3) await sleep(500)
  }
  if (win3) {
    await win3.waitForSelector('[data-testid=run-meta]', { timeout: 20_000 }).catch(() => {})
    await sleep(500)
    const heading = ((await win3.locator('[data-testid=run-strip] .run-tab[aria-selected=true] .run-tab-title').first().innerText().catch(() => '')) || '').trim()
    check(heading === TITLE, 'a run opened in a new window still shows the title', heading)
    const wt = await win3.title()
    check(wt.includes(TITLE), 'the run window document title carries the run title', wt)
    await win3.close().catch(() => {})
  } else check(false, 'a run window opened for the titled run')
  await endSession(page)

  // A failed title generation falls back to the prompt excerpt.
  const FAIL_PROMPT = 'Do [mock:title-fail] something with a long enough prompt to be cut'
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage(FAIL_PROMPT)
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  await sleep(2500)
  const failed = await summaryFor('title-fail')
  check(!!failed && !failed.title, 'a failed title generation leaves RunSummary.title unset', String(failed?.title))
  const failTab = page.locator('.run-tablist [role="tab"]', { hasText: 'title-fail' })
  const failText = ((await failTab.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(failText.includes('Do [mock:title-fail] something'), 'a run without a title shows the prompt excerpt on its tab', failText)
  await endSession(page)

  // An auth failure ends the run Failed with the readable connection message.
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage('Check the setup [mock:auth-fail]')
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  let authRun
  for (let i = 0; i < 40 && !(authRun?.endedAt); i++) {
    authRun = await summaryFor('mock:auth-fail')
    await sleep(300)
  }
  check(authRun?.status === 'error' && /connection was refused/.test(authRun?.error ?? ''), 'a [mock:auth-fail] run ends in error with the readable message', JSON.stringify(authRun))
  await page.getByText(/connection was refused/).first().waitFor({ timeout: 10_000 }).catch(() => {})
  const refused = await page.getByText(/connection was refused/).count()
  check(refused > 0, 'the readable "connection was refused" error shows in the UI', String(refused))
  await page.getByText('Failed', { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => {})
  check((await page.getByText('Failed', { exact: true }).count()) > 0, 'the run status word is Failed')
  await shot('run-auth-fail')
  await endSession(page)

  // A2: the Maintenance sub-nav item must not scroll the page away from the tabs.
  await tabsBar().getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Maintenance', exact: true }).click()
  await sleep(600)
  const a2 = await page.evaluate(() => {
    const r = [...document.querySelectorAll('[role=tablist][aria-label="Project sections"] [role=tab]')].find((b) => b.textContent?.trim() === 'Live')?.getBoundingClientRect()
    return { top: document.documentElement.scrollTop, live: r ? { t: r.top, b: r.bottom } : null, h: window.innerHeight }
  })
  check(a2.top === 0, 'Maintenance sub-nav leaves the document scrollTop at 0 (A2)', String(a2.top))
  check(!!a2.live && a2.live.t >= 0 && a2.live.b <= a2.h, 'the Live tab button stays inside the viewport after the sub-nav click', JSON.stringify(a2))
  await shot('settings-maintenance')

  // Run messaging switch persists through projects:save.
  await tabsBar().getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  const sw =page.getByRole('switch', { name: 'Let runs message each other' })
  await sw.waitFor({ timeout: 10_000 })
  check((await sw.getAttribute('aria-checked')) === 'false', 'run messaging switch starts off')
  await sw.click()
  await sleep(1500)
  check((await findProject(page, NAME)).runMessaging === true, 'switch saved runMessaging=true')
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await tabsBar().getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  const sw2 =page.getByRole('switch', { name: 'Let runs message each other' })
  await sw2.waitFor({ timeout: 10_000 })
  check((await sw2.getAttribute('aria-checked')) === 'true', 'switch is still on after reload')
  await shot('settings-messaging')
} catch (e) {
  check(false, 'runs e2e ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('e2e/runs')
