// Token-free (mock adapter, temp data dir). Changes the user saves reach live team work runs (applyProjectChange): a mock
// work run sits idle while the user (a) creates a skill and grants it to a role in Team > Catalog > Skills, (b) renames a
// role and edits its prompt in the org chart editor (the line beside the canvas hint, from the run.liveChange event, with
// the rename's "keeps calling it" note), (c) removes the skill from the role in the role inspector ("No longer uses"), and
// (d) grants it again while three more runs wait on the mock's host markers ([mock:host-after-idle], [mock:host-slow] with
// its pending line replaced by the final one, [mock:host-reject] with its reason). Checks one line per run, one polite
// status region with text per save, both themes at both sizes, the run's own log line, that the saves started no new turn,
// and that nothing shows without a live run.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, checkRadio, cleanup, createProject, finish, findProject, git, gotoProjects, launch, log, makeFixtureRepo, openProject, openProjectForm, openTeam, projectTab, sleep, teamPanelTab, writeFile } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-live-changes-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 200 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E live changes (orgai test)'
const repo = makeFixtureRepo('livechanges')
log('fixture at', repo)

const { app, page, shot } = await launch({ shotPrefix: 'live-changes' })
const resizeTo = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(500)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(300)
}
const setTheme = (t) => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t)
const record = (id) => page.evaluate((x) => window.orgai.runs.get(x), id)
const logsOf = async (id) => ((await record(id))?.logs ?? []).map((l) => l.message)
const noHScroll = async (what) => {
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(ov.sw <= ov.cw, `no horizontal scroll: ${what}`, JSON.stringify(ov))
}

/** Boxes of the regions around the org chart note: the stage, the Team assistant tray, the footer, the side panel and the inspector. */
const LAYOUT_SELECTORS = ['.frame-toolbar', '.frame-stage', '.frame-tray', '.frame-footer', '[data-testid=team-panel-tabs]', '[data-testid=role-capabilities]']
const layoutRects = () =>
  page.evaluate((sels) => Object.fromEntries(sels.map((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect()
    return [s, r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null]
  })), LAYOUT_SELECTORS)
// The rename itself legitimately changes the inspector's own content above the capabilities block (the slug follows the
// name, hint rows settle, differently on macOS), so that block's y is not compared; its x, width and height are, and
// every region the note could push (stage, tray, footer, tabs, toolbar) is compared exactly.
const SETTLING_Y = '[data-testid=role-capabilities]'
const sameRects = (a, b) =>
  LAYOUT_SELECTORS.every((s) => {
    const x = a[s]
    const y = b[s]
    if (s === SETTLING_Y && x && y) return x[0] === y[0] && x[2] === y[2] && x[3] === y[3]
    return JSON.stringify(x) === JSON.stringify(y)
  })

try {
  await createProject(page, { path: repo, name: NAME })
  await openProject(page, NAME)

  // Before any run is live: a save shows no line.
  await openTeam(page)
  await teamPanelTab(page, 'Catalog').click()
  const section = page.locator('[data-testid=skills-section]')
  await section.waitFor({ timeout: 10_000 })
  check((await section.locator('[data-testid=live-change-line]').count()) === 0, 'no status line before a run is live')
  check((await section.locator('[data-testid=live-change-note][role=status][aria-live=polite]').count()) === 1, 'the status region is polite and always mounted')

  // A work run, left idle after the mock turn.
  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Idle run for live changes [mock:model-switch]')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 20_000 })
  const runId = await page.locator('.run-tab[aria-selected=true]').first().evaluate((el) => el.closest('.run-tab-wrap')?.getAttribute('data-run'))
  check(!!runId, 'a work run started', String(runId))
  let status = ''
  for (let i = 0; i < 120 && status !== 'idle'; i++) {
    status = (await record(runId))?.summary.status ?? ''
    if (status !== 'idle') await sleep(500)
  }
  check(status === 'idle', 'the mock run settles idle', status)
  const before = await record(runId)
  const turnsBefore = before.transcript.length

  // (a) A skill granted to a role.
  await openTeam(page)
  await teamPanelTab(page, 'Catalog').click()
  await section.waitFor({ timeout: 10_000 })
  await page.locator('[data-testid=catalog-skills-add]').click()
  await page.locator('[data-testid=skill-new]').click()
  const form = page.locator('[data-testid=skill-form]')
  await form.waitFor({ timeout: 5000 })
  await form.locator('[data-testid=skill-name]').fill('api-design')
  await form.locator('[data-testid=skill-description]').fill('Use when designing REST endpoints.')
  await form.locator('[data-testid=skill-body]').fill('Prefer nouns. Version the API.')
  await form.locator('[data-testid=skill-save]').click()
  await form.waitFor({ state: 'detached', timeout: 10_000 })
  const row = section.locator('[data-testid=skill-row][data-name="api-design"]')
  await row.waitFor({ timeout: 10_000 })
  const line = section.locator('[data-testid=live-change-line]')
  await line.first().waitFor({ timeout: 15_000 })
  const createdText = await line.first().locator('.live-change-text').innerText()
  check(/^(Has|Gets|Applying) api-design.*; no role can load it yet · run “.+”$/.test(createdText), 'a skill saved with no role says no role can load it yet (not "in use now")', createdText)
  await row.locator('[data-testid=skill-choose-roles]').click()
  await row.locator('[data-testid=skill-roles][aria-expanded=true]').waitFor({ timeout: 5000 })
  await row.locator('input[type=checkbox]').first().check({ force: true })
  await section.locator('[data-testid=live-change-line]', { hasText: /Can use api-design|Applying access to api-design/ }).first().waitFor({ timeout: 15_000 })
  check((await line.count()) === 1, 'one status line for the one live run', String(await line.count()))
  const text = await line.first().locator('.live-change-text').innerText()
  check(/^(Can use api-design (now|once its agents are idle|from the next run)|Applying access to api-design) · run “.+”$/.test(text), 'the line says what changed, then names the run', text)
  check(!/in use now/.test(text) || /Updated|Change/.test(text), 'a grant does not use the bare "in use now" wording', text)
  check(((await line.first().getAttribute('title')) ?? '').length >= text.length - 1, 'the full text is available on hover')
  // One save, one line, one announcing region: the Connections section and the role inspector stay silent.
  const visible = await page.evaluate(() => document.querySelectorAll('[data-testid=live-change-line]').length)
  check(visible === 1, 'one save produces exactly one visible line on the page', String(visible))
  const regions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=live-change-note][role=status]')].filter((n) => (n.textContent ?? '').trim().length > 0).map((n) => n.getAttribute('data-surface'))
  )
  check(regions.length === 1 && regions[0] === 'skills', 'exactly one role=status region has text, the skills one', JSON.stringify(regions))
  check((await page.locator('[data-testid=catalog-connections] [data-testid=live-change-line]').count()) === 0, 'the Connections section shows no line for a skill save')
  check((await line.first().getAttribute('data-run-id')) === runId, 'the line belongs to the live run')
  const sh = await line.first().locator('.live-change-text').evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }))
  check(sh.ellipsis === 'ellipsis', 'long lines truncate with an ellipsis', JSON.stringify(sh))
  await sleep(500)
  const skillLogs = (await logsOf(runId)).filter((m) => /^You changed .*skills?/i.test(m) || /^You changed role grants/.test(m))
  check(skillLogs.length >= 1 && skillLogs.every((m) => /from the next run|uses it now|once the agents are idle/.test(m)), "the run's log says what happened", JSON.stringify(skillLogs))

  // Both themes at both sizes: the line stays one row, nothing scrolls sideways.
  for (const [w, h] of [[1600, 1000], [1024, 640]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await sleep(150)
      await line.first().scrollIntoViewIfNeeded().catch(() => {})
      const box = await line.first().boundingBox()
      const secBox = await section.boundingBox()
      check(!!box && !!secBox && box.x + box.width <= secBox.x + secBox.width + 1, `the line stays inside the section at ${w}x${h} ${theme}`)
      await noHScroll(`${w}x${h} ${theme}`)
      await shot(`skill-line-${w}x${h}-${theme}`)
    }
  }
  await resizeTo(1600, 1000)
  await setTheme('dark')

  // Nothing moves when the line clears: the row below the note keeps its place (the region keeps the room while a run is live).
  await row.scrollIntoViewIfNeeded().catch(() => {})
  if ((await line.count()) === 1) {
    const topWith = (await row.boundingBox())?.y
    await section.locator('[data-testid=live-change-line]').first().waitFor({ state: 'detached', timeout: 30_000 })
    const topWithout = (await row.boundingBox())?.y
    check(topWith !== undefined && topWith === topWithout, 'the block below does not move when the line clears', `${topWith} -> ${topWithout}`)
    check((await section.locator('[data-testid=live-change-note][role=status]').count()) === 1, 'the status region stays mounted after the line clears')
  } else {
    check(false, 'the line was still up for the layout check', String(await line.count()))
  }

  // (b) The org chart editor: rename a role. projects:save has no result; the run's log says what happened.
  await page.locator('.react-flow__node').first().click()
  await teamPanelTab(page, 'Role').waitFor({ timeout: 10_000 })
  const nameInput = page.locator('#role-name-input')
  await nameInput.waitFor({ timeout: 10_000 })
  const renamed = `${await nameInput.inputValue()} Prime`
  const rectsBefore = await layoutRects()
  await nameInput.fill(renamed)
  // The line beside the canvas hint comes from the run.liveChange event (projects:save returns nothing).
  const ocNote = page.locator('[data-testid=live-change-note][data-surface=orgChart]')
  const ocLine = ocNote.locator('[data-testid=live-change-line]')
  const textRegions = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=live-change-note][role=status]')].filter((n) => (n.textContent ?? '').trim().length > 0).map((n) => n.getAttribute('data-surface'))
    )
  await ocLine.first().waitFor({ timeout: 20_000 })
  const ocText = await ocLine.first().locator('.live-change-text').innerText()
  check(/^Org chart changes are in use now · run “.+”$/.test(ocText), 'a rename shows the org chart line, status first then the run', ocText)
  const ocDetails = await ocLine.first().locator('[data-testid=live-change-details] li').allInnerTexts()
  check(ocDetails.some((d) => /^Renamed to .+\. This run keeps calling it [a-z0-9-]+ until the next run\.$/.test(d)), 'the rename note says the run keeps calling the old slug, as plain text', JSON.stringify(ocDetails))
  check(await ocLine.first().locator('[data-testid=live-change-details]').isVisible(), 'the note is on screen without a hover')
  check((await ocLine.count()) === 1 && (await page.locator('[data-testid=live-change-line]').count()) === 1, 'one rename save produces exactly one line on the page', String(await page.locator('[data-testid=live-change-line]').count()))
  const ocRegions = await textRegions()
  check(ocRegions.length === 1 && ocRegions[0] === 'orgChart', 'exactly one role=status region has text, the org chart one', JSON.stringify(ocRegions))
  check((await ocNote.getAttribute('aria-atomic')) === 'true', 'the org chart region reads whole (aria-atomic)')
  const rectsWith = await layoutRects()
  check(sameRects(rectsBefore, rectsWith), 'nothing around the org chart note moves when it appears', JSON.stringify({ before: rectsBefore, with: rectsWith }))
  check((await ocNote.getAttribute('aria-live')) === 'polite', 'the org chart region is polite')
  for (const [w, h] of [[1600, 1000], [1024, 640]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await sleep(150)
      const box = await ocLine.first().boundingBox()
      const stage = await page.locator('.frame-stage').first().boundingBox()
      check(!!box && !!stage && box.x >= stage.x - 1 && box.x + box.width <= stage.x + stage.width + 1 && box.y >= stage.y - 1 && box.y + box.height <= stage.y + stage.height + 1, `the org chart line stays inside the canvas stage at ${w}x${h} ${theme}`, JSON.stringify({ box, stage }))
      check((await page.locator('.frame-footer [data-testid=live-change-note]').count()) === 0, 'the org chart note is not in the footer')
      await noHScroll(`org chart ${w}x${h} ${theme}`)
      await shot(`org-chart-line-${w}x${h}-${theme}`)
    }
  }
  await resizeTo(1600, 1000)
  await setTheme('dark')
  // A prompt edit gets its own line (no rename note).
  const prompt = page.locator('#role-prompt')
  await prompt.waitFor({ timeout: 10_000 })
  const chartLogs = async () => (await logsOf(runId)).filter((m) => /^You changed the org chart/.test(m)).length
  const logsBefore = await chartLogs()
  await prompt.fill(`${await prompt.inputValue()} Keep answers short.`)
  for (let i = 0; i < 40 && (await chartLogs()) <= logsBefore; i++) await sleep(500)
  check((await chartLogs()) > logsBefore, 'the prompt edit reached the run')
  await ocLine.first().waitFor({ timeout: 5000 })
  const promptText = await ocLine.first().locator('.live-change-text').innerText()
  check(/^Updated .+ is in use now · run “.+”$/.test(promptText), 'a prompt edit says which role was updated', promptText)
  check((await page.locator('[data-testid=live-change-line]').count()) === 1, 'a prompt edit shows the org chart line once', String(await page.locator('[data-testid=live-change-line]').count()))
  let chartLog = ''
  for (let i = 0; i < 40 && !chartLog; i++) {
    chartLog = (await logsOf(runId)).find((m) => /^You changed the org chart/.test(m)) ?? ''
    if (!chartLog) await sleep(500)
  }
  check(!!chartLog, "the org chart edit is in the run's log", chartLog)
  check(/this run uses it|from the next run|once the agents are idle/.test(chartLog), 'the log line says when the run uses it', chartLog)
  check((await findProject(page, NAME))?.roles.some((r) => r.name === renamed), 'the rename is saved')

  // The saves started no turn of their own.
  const after = await record(runId)
  check(after.summary.status === 'idle', 'the run is still idle after the saves', after.summary.status)
  const added = after.transcript.slice(turnsBefore)
  check(
    added.every((e) => e.source === 'harness' && e.block.kind === 'system'),
    'the saves added only harness notices to the transcript (no user or assistant turn)',
    JSON.stringify(added.map((e) => `${e.source}/${e.block.kind}`))
  )
  check(added.length >= 1, 'the idle orchestrator is told about the change', String(added.length))

  // (c) Removing a skill from a role in the role inspector (the org chart save path): "No longer uses".
  const nodes = page.locator('.react-flow__node')
  const nodeCount = await nodes.count()
  let removeBtn = null
  for (let i = 0; i < nodeCount && !removeBtn; i++) {
    await nodes.nth(i).click()
    await sleep(300)
    const btn = page.locator('[data-testid=role-skill][data-name="api-design"] [data-testid=role-skill-remove]')
    if (await btn.count()) removeBtn = btn.first()
  }
  check(!!removeBtn, 'the role that holds api-design shows it in the role inspector')
  await removeBtn.click()
  // The inspector made the save, so its line sits under Skills in the inspector, not in the org chart note.
  const skillNote = page.locator('[data-testid=live-change-note][data-surface^="role:"][data-part=skills]')
  await skillNote.locator('[data-testid=live-change-line]').first().waitFor({ timeout: 20_000 })
  const revokeText = await skillNote.locator('.live-change-text').first().innerText()
  check(/^No longer uses api-design · run “.+”$/.test(revokeText), 'removing a skill in the role inspector says "No longer uses"', revokeText)
  check((await page.locator('[data-testid=live-change-line]').count()) === 1, 'the skill removal produces exactly one line', String(await page.locator('[data-testid=live-change-line]').count()))
  check((await ocNote.locator('[data-testid=live-change-line]').count()) === 0, 'the skill removal puts nothing in the org chart note')
  const revRegions = await textRegions()
  check(revRegions.length === 1 && revRegions[0].startsWith('role:'), 'one polite region with text for the removal, the inspector one', JSON.stringify(revRegions))
  const afterSkillHeader = await page.evaluate(() => {
    const add = document.querySelector('[data-testid=role-add-skill]')
    const note = document.querySelector('[data-testid=live-change-note][data-part=skills]')
    const conn = document.querySelector('[data-testid=role-add-connection]')
    return !!add && !!note && !!conn && !!(add.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(conn.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  check(afterSkillHeader, 'the skill line sits with Skills (after its header), not with Connections')
  await shot('role-skill-revoked')
  // A connection revoke reports in the inspector too, under Connections.
  const roleName = await nameInput.inputValue()
  await page.evaluate(
    async ({ id, name }) => {
      const p = (await window.orgai.projects.list()).find((x) => x.id === id)
      const slug = p.roles.find((r) => r.name === name)?.slug
      const base = { transport: 'http', enabled: true, source: 'user', addedAt: new Date().toISOString() }
      await window.orgai.mcp.upsert({ projectId: id, spec: { ...base, id: 'e2e-docs', name: 'docs-server', url: 'https://example.invalid/mcp', description: 'Docs', roles: [slug] } })
    },
    { id: (await findProject(page, NAME)).id, name: roleName }
  )
  // The renderer's project list only learns of a server saved behind its back after a reload.
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await openTeam(page)
  await page.locator('.react-flow__node', { hasText: roleName }).first().click()
  await teamPanelTab(page, 'Role').waitFor({ timeout: 10_000 })
  const connRemove = page.locator('[data-testid=role-service][data-name="docs-server"] [data-testid=role-connection-remove]')
  await connRemove.waitFor({ timeout: 15_000 })
  await connRemove.click()
  const connNote = page.locator('[data-testid=live-change-note][data-surface^="role:"][data-part=connections]')
  await connNote.locator('[data-testid=live-change-line]').first().waitFor({ timeout: 20_000 })
  const connText = await connNote.locator('.live-change-text').first().innerText()
  check(/^No longer uses docs-server/.test(connText), 'removing a connection in the role inspector says "No longer uses"', connText)
  check((await ocNote.locator('[data-testid=live-change-line]').count()) === 0, 'the connection removal puts nothing in the org chart note')
  await shot('role-connection-revoked')

  // (d) Three more live runs answer the next save in their own ways.
  const pid = (await findProject(page, NAME)).id
  const startMarked = async (marker) => {
    const r = await page.evaluate(({ id, prompt }) => window.orgai.runs.start({ projectId: id, prompt }), { id: pid, prompt: `${marker} wording run [mock:model-switch]` })
    const rid = r.id ?? r.runId ?? r
    for (let i = 0; i < 120; i++) {
      if ((await record(rid))?.summary.status === 'idle') break
      await sleep(500)
    }
    check((await record(rid))?.summary.status === 'idle', `the ${marker} run settles idle`)
    return rid
  }
  const idleRun = await startMarked('[mock:host-after-idle]')
  const slowRun = await startMarked('[mock:host-slow] [mock:host-after-idle]')
  const rejectRun = await startMarked('[mock:host-reject]')
  await openTeam(page)
  await teamPanelTab(page, 'Catalog').click()
  await section.waitFor({ timeout: 10_000 })
  const row2 = section.locator('[data-testid=skill-row][data-name="api-design"]')
  await row2.waitFor({ timeout: 10_000 })
  // The skill still has other roles, so the role list opens from "Change roles"; the role it was removed from is unchecked.
  const choose = row2.locator('[data-testid=skill-choose-roles]')
  if (await choose.count()) await choose.click()
  else await row2.locator('[data-testid=skill-roles]').click()
  await row2.locator('[data-testid=skill-roles][aria-expanded=true]').waitFor({ timeout: 5000 })
  await row2.locator('input[type=checkbox]:not(:checked)').first().click({ force: true }) // the box flips once the save returns (up to 2 s with a slow run)
  const lineOf = (id) => section.locator(`[data-testid=live-change-line][data-run-id="${id}"]`)
  // Several runs: one summary line and a native disclosure with the run by run rows.
  const more = section.locator('[data-testid=live-change-more]')
  await more.waitFor({ timeout: 15_000 })
  await section.locator('[data-testid=live-change-summary-text]').waitFor({ timeout: 15_000 })
  check((await more.evaluate((el) => el.tagName)) === 'DETAILS' && (await more.locator('summary').count()) === 1, 'several runs use a native details disclosure')
  check(!(await more.evaluate((el) => el.open)), 'the run list starts closed (the summary is the whole note)')
  const summaryOf = () => more.locator('[data-testid=live-change-summary-text]').innerText()
  check(/^Access to api-design given · 4 live runs: 1 now · 1 being applied · 1 once idle · 1 from the next run$/.test(await summaryOf()), 'the summary counts the runs by when they apply', await summaryOf())
  await more.locator('summary').focus()
  await page.keyboard.press('Enter')
  check(await more.evaluate((el) => el.open), 'Enter on the summary opens the run list')
  await lineOf(rejectRun).waitFor({ timeout: 15_000 })
  await lineOf(slowRun).waitFor({ timeout: 15_000 })
  const t = async (id) => (await lineOf(id).locator('[data-testid=live-change-effect]').innerText()).trim()
  const runFirst = await lineOf(runId).evaluate((el) => el.firstElementChild?.getAttribute('data-testid'))
  check(runFirst === 'live-change-run', 'each row starts with the run, so a cut-off tail never hides which run it is', String(runFirst))
  check((await t(runId)) === 'Can use api-design now', 'an idle run says now', await t(runId))
  check((await t(idleRun)) === 'Can use api-design once its agents are idle', 'after-idle says once its agents are idle', await t(idleRun))
  check((await t(rejectRun)) === 'Can use api-design from the next run', 'a rejecting run says from the next run', await t(rejectRun))
  const rejectDetail = await lineOf(rejectRun).locator('[data-testid=live-change-details] li').allInnerTexts()
  check(rejectDetail.some((d) => /applies from the next run/.test(d)), 'the rejection reason is plain text under the line', JSON.stringify(rejectDetail))
  check((await lineOf(slowRun).getAttribute('data-availability')) === 'pending' && /^Applying access to api-design/.test(await t(slowRun)), 'a slow run first shows the pending wording', await t(slowRun))
  check((await section.locator('[data-testid=live-change-line]').count()) === 4, 'one line per live run, four runs', String(await section.locator('[data-testid=live-change-line]').count()))
  await shot('four-runs')
  const rowOrderBefore = await section.locator('[data-testid=live-change-line]').evaluateAll((els) => els.map((e) => e.getAttribute('data-run-id')))
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid=live-change-line][data-run-id="${id}"]`)?.getAttribute('data-availability') === 'after-idle',
    slowRun,
    { timeout: 20_000 }
  )
  check((await t(slowRun)) === 'Can use api-design once its agents are idle', 'the pending line is replaced by the final one', await t(slowRun))
  check(/: 1 now · 2 once idle · 1 from the next run$/.test(await summaryOf()), 'the summary follows the final answer', await summaryOf())
  const rowOrderAfter = await section.locator('[data-testid=live-change-line]').evaluateAll((els) => els.map((e) => e.getAttribute('data-run-id')))
  check(JSON.stringify(rowOrderAfter) === JSON.stringify(rowOrderBefore), 'a slow answer does not move its row', JSON.stringify({ rowOrderBefore, rowOrderAfter }))
  check((await section.locator('[data-testid=live-change-line]').count()) === 4, 'the final answer replaced the pending line, no extra line', String(await section.locator('[data-testid=live-change-line]').count()))
  const fourRegions = await textRegions()
  check(fourRegions.length === 1 && fourRegions[0] === 'skills', 'one polite region with text for the save', JSON.stringify(fourRegions))
  check((await page.locator('[data-testid=live-change-line]').count()) === 4, 'no line elsewhere on the page', String(await page.locator('[data-testid=live-change-line]').count()))
  for (const [w, h] of [[1024, 640]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await sleep(150)
      await noHScroll(`four runs ${w}x${h} ${theme}`)
      await shot(`four-runs-${w}x${h}-${theme}`)
    }
  }
  await resizeTo(1600, 1000)
  await setTheme('dark')

  // (e) Four live runs answer an org chart rename at 1024x640: one bounded summary in the canvas stage, nothing moves.
  await resizeTo(1024, 640)
  await openTeam(page)
  await page.locator('.react-flow__node').first().click()
  await teamPanelTab(page, 'Role').waitFor({ timeout: 10_000 })
  const nameInput2 = page.locator('#role-name-input')
  await nameInput2.waitFor({ timeout: 10_000 })
  await ocNote.locator('[data-testid=live-change-line]').first().waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {})
  const quiet = await layoutRects()
  await nameInput2.fill(`${await nameInput2.inputValue()} Two`)
  const summaryText = ocNote.locator('[data-testid=live-change-summary-text]')
  await page.waitForFunction(() => /· 4 live runs: /.test(document.querySelector('[data-testid=live-change-note][data-surface=orgChart] [data-testid=live-change-summary-text]')?.textContent ?? ''), null, { timeout: 25_000 })
  const sumOc = await summaryText.innerText()
  check(/^Org chart changes · 4 live runs: /.test(sumOc), 'four runs give one summary line in the org chart note', sumOc)
  check((await page.locator('[data-testid=live-change-summary]').count()) === 1, 'one summary on the page')
  const withFour = await layoutRects()
  check(sameRects(quiet, withFour), 'four live runs move nothing around the note (the Team assistant keeps its height)', JSON.stringify({ quiet, withFour }))
  check(quiet['.frame-tray'][3] === withFour['.frame-tray'][3] && withFour['.frame-footer'][3] === quiet['.frame-footer'][3], 'the Team assistant and the footer keep their height', JSON.stringify([quiet['.frame-tray'], withFour['.frame-tray']]))
  const bounded = async (what) => {
    const nb = await ocNote.boundingBox()
    const st = await page.locator('.frame-stage').first().boundingBox()
    const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    check(!!nb && !!st && nb.height <= 11 * 16 + 1 && nb.y >= st.y && nb.y + nb.height <= st.y + st.height + 1 && nb.y + nb.height <= win.h && nb.x + nb.width <= win.w, `the note stays within its maximum height and the stage ${what}`, JSON.stringify({ nb, st }))
  }
  await bounded('collapsed')
  const sum2 = ocNote.locator('summary')
  await sum2.focus()
  const openBefore = await ocNote.locator('details').evaluate((el) => el.open)
  await page.keyboard.press('Space')
  await sleep(200)
  check(await ocNote.locator('details').evaluate((el) => el.open), 'Space on the summary opens the run list', `${openBefore} ${await page.evaluate(() => document.activeElement?.tagName)}`)
  await ocNote.locator('[data-testid=live-change-line]').nth(3).waitFor({ state: 'visible', timeout: 5000 })
  check((await ocNote.locator('[data-testid=live-change-line]').count()) === 4, 'the list holds one row per run')
  await bounded('open')
  // A sentence every run shares is said once (unit tested); here the first run kept the older slug, so its sentence differs
  // from the three that joined after the first rename, and each run's own sentence stays with its row.
  const detailRows = await ocNote.locator('[data-testid=live-change-details] li').allInnerTexts()
  const lineRows = await ocNote.locator('[data-testid=live-change-line]').count()
  check(detailRows.filter((r) => /Renamed to/.test(r)).length <= lineRows, 'no rename sentence is repeated beyond one per run', JSON.stringify(detailRows))
  check(sameRects(quiet, await layoutRects()), 'opening the list moves nothing either')
  await shot('org-chart-four-runs-open-1024x640-dark')
  await setTheme('light')
  await sleep(200)
  await bounded('open (light)')
  await shot('org-chart-four-runs-open-1024x640-light')
  await sum2.focus()
  await page.keyboard.press('Space')
  await shot('org-chart-four-runs-1024x640-light')
  await setTheme('dark')
  await ocNote.locator('[data-testid=live-change-line]').first().waitFor({ state: 'detached', timeout: 40_000 })
  check(sameRects(quiet, await layoutRects()), 'nothing moves when the note clears')

  // (f) The team files approval card open at a height under 720: the footer is hidden then, the note is still visible.
  const q = (s) => JSON.stringify(s)
  const roleFile = ({ name, description, tools, canSpawn = false, spawnable = [], reportsTo = null, color, prompt }) =>
    `---\nname: ${q(name)}\ndescription: ${q(description)}\nresponsibilities: []\ntools:\n${tools.map((x) => `  - ${q(x)}`).join('\n')}\ntier: "everyday"\ncanSpawn: ${canSpawn}\n${spawnable.length ? `spawnable:\n${spawnable.map((x) => `  - ${q(x)}`).join('\n')}` : 'spawnable: []'}\nreportsTo: ${reportsTo === null ? 'null' : q(reportsTo)}\ncolor: ${q(color)}\nskills: []\nmcpServers: []\n---\n\n${prompt}\n`
  const leadFile = roleFile({ name: 'Lead', description: 'Leads the team', tools: ['Read', 'Glob', 'Grep'], canSpawn: true, spawnable: ['dev'], color: '#6d5ae6', prompt: 'You lead the team.' })
  const devFile = (tools) => roleFile({ name: 'Dev', description: 'Builds features', tools, reportsTo: 'lead', color: '#2f9e6e', prompt: 'You build features.' })
  const NAME2 = 'E2E live changes team files (orgai test)'
  const repo2 = makeFixtureRepo('livechanges-team')
  writeFile(repo2, '.orgai/team.json', `${JSON.stringify({ format: 'orgai.team/1', brief: 'A tiny notes API.', permissionMode: 'default' }, null, 2)}\n`)
  writeFile(repo2, '.orgai/agents/lead.md', leadFile)
  writeFile(repo2, '.orgai/agents/dev.md', devFile(['Read', 'Grep']))
  git(repo2, ['add', '-A'])
  git(repo2, ['commit', '-q', '-m', 'add team files'])
  {
    await gotoProjects(page)
    const form2 = await openProjectForm(page)
    await checkRadio(form2.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]'), 'the Code kind')
    await checkRadio(form2.getByRole('radio', { name: 'Existing code', exact: true }), 'the Existing code choice')
    await form2.locator('input[placeholder*="repo"]').fill(repo2)
    await form2.locator('input[placeholder*="Defaults to the folder name"]').fill(NAME2)
    await page.locator('[data-testid=team-found]').waitFor({ timeout: 15_000 })
    await form2.locator('[data-testid=new-project-submit]').click()
    await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
    const pid2 = (await findProject(page, NAME2)).id
    const r2 = await page.evaluate(({ id, prompt }) => window.orgai.runs.start({ projectId: id, prompt }), { id: pid2, prompt: 'Team files run [mock:model-switch]' })
    const rid2 = r2.id ?? r2.runId ?? r2
    for (let i = 0; i < 120 && (await record(rid2))?.summary.status !== 'idle'; i++) await sleep(500)
    check((await record(rid2))?.summary.status === 'idle', 'the team files project run settles idle')
    await openTeam(page)
    fs.writeFileSync(path.join(repo2, '.orgai/agents/dev.md'), devFile(['Read', 'Grep', 'Bash']))
    await page.evaluate((i) => window.orgai.teamFiles.status({ projectId: i }), pid2)
    const card2 = page.locator('[data-testid=team-files-card]')
    await card2.waitFor({ timeout: 15_000 })
    for (const [w, h] of [[1024, 640], [1600, 1000]]) {
      await resizeTo(w, h)
      await page.locator('.react-flow__node', { hasText: 'Lead' }).first().click()
      await teamPanelTab(page, 'Role').waitFor({ timeout: 10_000 })
      const nm = page.locator('#role-name-input')
      await nm.waitFor({ timeout: 10_000 })
      await nm.fill(`${(await nm.inputValue()).replace(/ Prime\d*$/, '')} Prime${w}`)
      const note3 = page.locator('[data-testid=live-change-note][data-surface=orgChart] [data-testid=live-change-line]').first()
      await note3.waitFor({ timeout: 20_000 })
      // Team tab phase 2: the footer is the always-rendered notice row (errors, Undo), so it stays under the card; the card
      // must still fit: Approve and Reject fully inside the window and not covered by the notice row.
      const row = page.locator('[data-testid=team-notice-row]').first()
      const rowBox = await row.boundingBox()
      check(await row.isVisible() && !!rowBox && rowBox.height >= 28 && rowBox.height <= 34, `the notice row stays visible under the approval card at ${w}x${h}`, JSON.stringify(rowBox))
      for (const id of ['team-files-approve', 'team-files-reject']) {
        const b = await page.locator(`[data-testid=${id}]`).first().boundingBox()
        const inside = !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= w && b.y + b.height <= h
        const clear = !!b && !!rowBox && (b.y + b.height <= rowBox.y + 0.5 || b.y >= rowBox.y + rowBox.height - 0.5)
        check(inside && clear, `${id} is fully inside the window and clear of the notice row at ${w}x${h}`, JSON.stringify({ b, rowBox }))
      }
      for (const theme of ['dark', 'light']) {
        await setTheme(theme)
        await sleep(150)
        const nb = await note3.boundingBox()
        const cb = await card2.boundingBox()
        const stage = await page.locator('.frame-stage').first().boundingBox()
        check(await note3.isVisible(), `the org chart note is visible with the approval card open at ${w}x${h} ${theme}`)
        check(!!nb && !!cb && !!stage && nb.y + nb.height <= cb.y + 1 && nb.y >= stage.y && nb.y + nb.height <= stage.y + stage.height + 1, `the note does not overlap the approval card at ${w}x${h} ${theme}`, JSON.stringify({ nb, cb, stage }))
        await shot(`card-note-${w}x${h}-${theme}`)
      }
      await ocNote.locator('[data-testid=live-change-line]').first().waitFor({ state: 'detached', timeout: 40_000 }).catch(() => {})
    }
  }
  await resizeTo(1600, 1000)
  await setTheme('dark')

  finish('live-changes')
} finally {
  await cleanup(app, page, NAME)
}
