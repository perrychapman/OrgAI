// Token-free (mock adapter, temp data dir). Changes the user saves reach live team work runs (applyProjectChange): a mock
// work run sits idle while the user (a) creates a skill and grants it to a role in Team > Catalog > Skills, and (b) renames
// a role in the org chart editor. Checks the status line beside the save (one line per run, aria-live polite, in both
// themes at both sizes), the run's own log line, that the save started no new turn, and that nothing shows without a
// live run. The mock session has no live-config hook answers 'now' for an idle run; the other wordings are covered by the
// helper's unit test and main's runManagerHostChange tests.
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
  await row.locator('[data-testid=skill-choose-roles]').click()
  await row.locator('[data-testid=skill-roles][aria-expanded=true]').waitFor({ timeout: 5000 })
  await row.locator('input[type=checkbox]').first().check({ force: true })
  const line = section.locator('[data-testid=live-change-line]')
  await line.first().waitFor({ timeout: 15_000 })
  check((await line.count()) === 1, 'one status line for the one live run', String(await line.count()))
  const text = await line.first().innerText()
  check(/^.+: (in use now|once the agents are idle|from the next run.*|being applied)$/.test(text),'the line names the run and when it applies', text)
  check(((await line.first().getAttribute('title')) ?? '').length >= text.length - 1, 'the full text is available on hover')
  check((await line.first().getAttribute('data-run-id')) === runId, 'the line belongs to the live run')
  const sh = await line.first().evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }))
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

  // (b) The org chart editor: rename a role. projects:save has no result; the run's log says what happened.
  await page.locator('.react-flow__node').first().click()
  await teamPanelTab(page, 'Role').waitFor({ timeout: 10_000 })
  const nameInput = page.locator('#role-name-input')
  await nameInput.waitFor({ timeout: 10_000 })
  const renamed = `${await nameInput.inputValue()} Prime`
  await nameInput.fill(renamed)
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

  finish('live-changes')
} finally {
  await cleanup(app, page, NAME)
}
