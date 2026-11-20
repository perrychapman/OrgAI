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
import { TMP, check, cleanup, createProject, finish, findProject, launch, log, makeFixtureRepo, openProject, openTeam, projectTab, sleep, teamPanelTab } from './lib.mjs'

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
  check((await ocNote.getAttribute('aria-live')) === 'polite', 'the org chart region is polite')
  for (const [w, h] of [[1600, 1000], [1024, 640]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await sleep(150)
      const box = await ocLine.first().boundingBox()
      const foot = await page.locator('.frame-footer').first().boundingBox()
      check(!!box && !!foot && box.x >= foot.x - 1 && box.x + box.width <= foot.x + foot.width + 1, `the org chart line stays inside the footer at ${w}x${h} ${theme}`)
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
  check(/^Org chart changes are in use now · run “.+”$/.test(promptText), 'a prompt edit shows the org chart line', promptText)
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
  await ocLine.first().waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => /^No longer uses api-design/.test(document.querySelector('[data-testid=live-change-note][data-surface=orgChart] .live-change-text')?.textContent ?? ''), null, { timeout: 20_000 })
  const revokeText = await ocLine.first().locator('.live-change-text').innerText()
  check(/^No longer uses api-design · run “.+”$/.test(revokeText), 'removing a skill in the role inspector says "No longer uses"', revokeText)
  check((await page.locator('[data-testid=live-change-line]').count()) === 1, 'the skill removal produces exactly one line', String(await page.locator('[data-testid=live-change-line]').count()))
  const revRegions = await textRegions()
  check(revRegions.length === 1 && revRegions[0] === 'orgChart', 'one polite region with text for the removal', JSON.stringify(revRegions))
  await shot('role-skill-revoked')

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
  await lineOf(rejectRun).waitFor({ timeout: 15_000 })
  await lineOf(slowRun).waitFor({ timeout: 15_000 })
  const t = async (id) => (await lineOf(id).locator('.live-change-text').innerText()).replace(/ · run .*$/, '')
  check((await t(runId)) === 'Can use api-design now', 'an idle run says now', await t(runId))
  check((await t(idleRun)) === 'Can use api-design once its agents are idle', 'after-idle says once its agents are idle', await t(idleRun))
  check((await t(rejectRun)) === 'Can use api-design from the next run', 'a rejecting run says from the next run', await t(rejectRun))
  const rejectDetail = await lineOf(rejectRun).locator('[data-testid=live-change-details] li').allInnerTexts()
  check(rejectDetail.some((d) => /applies from the next run/.test(d)), 'the rejection reason is plain text under the line', JSON.stringify(rejectDetail))
  check((await lineOf(slowRun).getAttribute('data-availability')) === 'pending' && /^Applying access to api-design/.test(await t(slowRun)), 'a slow run first shows the pending wording', await t(slowRun))
  check((await section.locator('[data-testid=live-change-line]').count()) === 4, 'one line per live run, four runs', String(await section.locator('[data-testid=live-change-line]').count()))
  await shot('four-runs')
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid=live-change-line][data-run-id="${id}"]`)?.getAttribute('data-availability') === 'after-idle',
    slowRun,
    { timeout: 20_000 }
  )
  check((await t(slowRun)) === 'Can use api-design once its agents are idle', 'the pending line is replaced by the final one', await t(slowRun))
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

  finish('live-changes')
} finally {
  await cleanup(app, page, NAME)
}
