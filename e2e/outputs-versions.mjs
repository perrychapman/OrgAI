// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Outputs 2 versions (docs/design/outputs-2.md sections 7, 10, 12): two runs in one
// project (ORGAI_MOCK_SCRIPT set in main, one per run) make version 1 and version 2 of a Markdown file, a CSV, a JSON file, a
// Word document, an Excel workbook and a diagram, plus one registered text file. Checks the version select, the Versions tab
// wording, the old-version banner (Edit hidden, Restore shown), Restore (notice, focus), naming a version, Rename, Delete of a
// produced and of a registered output (confirm wording, focus to the next row), Remove from list, the Larger view's one live
// region, and that nothing scrolls, at 1024x640 and 1600x1000 in both themes. Native Open / Edit in Word are not driven.
// At the end of each size and theme it hands the two-version project to e2e/outputs-compare.part.mjs and
// e2e/outputs-edit.part.mjs when those files exist (default export called with { app, page, project, label, size, theme, check, sleep }).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TMP, check, cleanup, createProject, deleteProject, finish, launch, makeFixtureRepo, openProject, projectTab, screenshot, settleMotion, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E versions (orgai test)'
// The compare and edit parts save versions, so they get a project of their own: the checks here keep exact counts.
const NAME_PARTS = 'E2E versions parts (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-versions-'))
const repo = path.join(base, 'repo')
const repoParts = path.join(base, 'repo-parts')
for (const [name, at] of [
  ['outputs-versions', repo],
  ['outputs-versions-parts', repoParts]
]) {
  makeFixtureRepo(name, { at })
  fs.mkdirSync(path.join(at, 'reg'), { recursive: true })
  fs.writeFileSync(path.join(at, 'reg', 'handoff.txt'), 'Handoff notes for the client.\n')
}

const PLAN1 = '# Project plan\n\nPhase one is design.\n\n- Design\n- Build\n'
const PLAN2 = '# Project plan\n\nPhase one is design and phase two is the build.\n\n- Design\n- Build\n- Launch\n'
const doc = (extra) => `# Brief\n\nThe scope is small.${extra}\n`
const book = (rows) => ({ sheets: [{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Cost' }], rows }] })
const out = (kind, title, fileName, content) => ({ type: 'harness', name: 'produce_output', args: { kind, title, fileName, content } })
const script = (v) => ({
  delayMs: 100,
  work: [
    { type: 'text', text: `Version ${v} of the files.` },
    out('markdown', 'Project plan', 'project-plan', v === 1 ? PLAN1 : PLAN2),
    out('csv', 'Report', 'report', v === 1 ? 'a,b\n1,2\n' : 'a,b\n1,2\n3,4\n'),
    out('json', 'Config', 'config', v === 1 ? '{"mode":"one"}\n' : '{"mode":"two"}\n'),
    out('docx', 'Brief', 'brief', doc(v === 1 ? '' : ' It now has a second paragraph.')),
    { type: 'harness', name: 'produce_output', args: { kind: 'xlsx', title: 'Budget', fileName: 'budget', workbook: book(v === 1 ? [['Design', 1200]] : [['Design', 1200], ['Build', 3400]]) } },
    out('mermaid', 'Flow', 'flow', v === 1 ? 'flowchart LR\n  A --> B\n' : 'flowchart LR\n  A --> B --> C\n'),
    ...(v === 1 ? [{ type: 'harness', name: 'register_output', args: { path: 'reg/handoff.txt', title: 'Handoff', kind: 'text' } }] : []),
    { type: 'text', text: 'Done.' }
  ]
})
const scriptFile = (v) => {
  const f = path.join(base, `script-${v}.json`)
  fs.writeFileSync(f, JSON.stringify(script(v)))
  return f
}

let { app, page } = await launch({ shotPrefix: 'outputs-versions' })
page.setDefaultTimeout(8000)
const snap = (name) => screenshot(page, `outputs-versions-${name}`)
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(600)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await fn()) return true
    } catch {
      /* keep polling */
    }
    await sleep(200)
  }
  return false
}
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const noScroll = async (what) => {
  await settleMotion(page)
  const o = await page.evaluate(() => {
    const el = document.scrollingElement
    const main = document.querySelector('main.main')
    return { sh: el?.scrollHeight ?? 0, ch: el?.clientHeight ?? 0, sw: el?.scrollWidth ?? 0, cw: el?.clientWidth ?? 0, mh: main?.scrollHeight ?? 0, mch: main?.clientHeight ?? 0 }
  })
  check(o.sh <= o.ch + 1 && o.sw <= o.cw + 1 && o.mh <= o.mch + 1, `${what}: the page and the main region do not scroll`, JSON.stringify(o))
}
const active = () => page.evaluate(() => ({ id: document.activeElement?.getAttribute('data-testid') ?? '', n: document.activeElement?.getAttribute('data-n') ?? '' }))

let project
const outputsOf = () => page.evaluate((id) => window.orgai.outputs.list(id), project.id)
const rows = () => page.locator('[data-testid=output-row]')
const detail = () => page.locator('[data-testid=outputs-detail] [data-testid=output-detail]').first()
const live = () => page.locator('[data-testid=output-live]')

async function startRun(prompt) {
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(prompt)
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
}
async function runWith(v, prompt, expectCount, expectVersion) {
  await app.evaluate((_e, file) => {
    process.env.ORGAI_MOCK_SCRIPT = file
  }, scriptFile(v))
  await startRun(prompt)
  check(
    await until(async () => {
      const l = await outputsOf()
      return l.length >= expectCount && l.every((o) => (o.version ?? 1) >= expectVersion || o.source === 'registered')
    }, 90_000),
    `run ${v} made its outputs`,
    JSON.stringify((await outputsOf()).map((o) => [o.title, o.version]))
  )
  await sleep(1200)
}
async function openOutputsTab() {
  await page.locator('[data-testid=tab-outputs]').click()
  await rows().first().waitFor({ timeout: 10_000 })
}
async function select(title) {
  await openOutputsTab()
  await rows().filter({ hasText: title }).first().click()
  await detail().waitFor({ timeout: 8000 })
  await page.locator('[data-testid=outputs-detail] [data-testid=output-detail-heading]', { hasText: title }).first().waitFor({ timeout: 8000 })
}

/** Read-only checks on the two-version project, at each size and theme. */
async function versionChecks(label, wide) {
  await select('Project plan')
  const sel = detail().locator('[data-testid=output-version-select]')
  check((await sel.count()) === 1, `${label}: a two-version output has a version select`)
  const opts = (await sel.locator('option').allInnerTexts()).map(clean)
  check(opts.length === 2 && /^v2 · now, .+ · \d+ \w+$/.test(opts[0]) && /^v1 · .+ · \d+ \w+$/.test(opts[1]), `${label}: the select lists "v2 · now, <who> · <date>" then v1`, JSON.stringify(opts))
  check((await detail().getAttribute('data-version')) === '2', `${label}: the detail carries data-version 2`)
  check((await detail().locator('[data-testid=output-edit]').count()) === 1, `${label}: a Markdown output offers Edit on its current version`)
  check((await detail().locator('[data-testid=output-revise]').count()) === 1, `${label}: Revise is offered`)
  check((await live().count()) === 1, `${label}: one output-live region on the panel`)

  // Versions tab.
  await detail().locator('[data-testid=output-tab-versions]').click()
  const panel = detail().locator('[data-testid=output-versions]')
  await panel.waitFor({ timeout: 8000 })
  const vrows = panel.locator('[data-testid=output-version-row]')
  check((await vrows.count()) === 2, `${label}: the Versions tab lists two versions`)
  check((await vrows.first().getAttribute('data-n')) === '2' && (await vrows.first().getAttribute('data-current')) === 'true', `${label}: the newest is first and marked current`)
  const t1 = clean(await vrows.nth(1).innerText())
  const t2 = clean(await vrows.nth(0).innerText())
  check(/Produced by/.test(t1), `${label}: version 1 reads "Produced by ..."`, t1)
  check(/Updated by/.test(t2) && /Now/.test(t2), `${label}: version 2 reads "Updated by ..." with a Now badge`, t2)
  check(/\+\d/.test(t2), `${label}: version 2 shows a size change`, t2)
  check((await vrows.first().locator('[data-testid=output-version-restore]').count()) === 0, `${label}: the current version has no Restore`)
  check((await vrows.nth(1).locator('[data-testid=output-version-restore]').count()) === 1 && (await vrows.nth(1).locator('[data-testid=output-version-compare-current]').count()) === 1, `${label}: an older version offers Restore and Compare with current`)
  // Pick two: the compare button appears.
  await vrows.nth(0).locator('[data-testid=output-version-pick]').check()
  await vrows.nth(1).locator('[data-testid=output-version-pick]').check()
  check((await panel.locator('[data-testid=output-compare-picked]').count()) === 1, `${label}: picking two versions shows "Compare 2 versions"`)
  await vrows.nth(0).locator('[data-testid=output-version-pick]').uncheck()
  await vrows.nth(1).locator('[data-testid=output-version-pick]').uncheck()
  await noScroll(`${label}: Versions tab`)
  await snap(`${label}-versions`)

  // Old version banner.
  await vrows.nth(1).locator('[data-testid=output-version-view]').click()
  const banner = detail().locator('[data-testid=output-old-version]')
  await banner.waitFor({ timeout: 8000 })
  check(/You are looking at version 1\. The current version is 2\./.test(clean(await banner.innerText())), `${label}: the banner says which version you are looking at`, clean(await banner.innerText()))
  check((await detail().locator('[data-testid=output-edit]').count()) === 0, `${label}: Edit is hidden on an old version`)
  check(/Restore this version to edit it\./.test(clean(await detail().locator('[data-testid=output-edit-reason]').innerText())), `${label}: the reason Edit is missing is visible text`)
  check((await banner.locator('[data-testid=output-restore]').count()) === 1, `${label}: the banner offers Restore this version`)
  check(/current version/i.test(clean(await detail().locator('[data-testid=output-revise]').innerText())), `${label}: Revise names the current version`)
  check((await detail().getAttribute('data-version')) === '1', `${label}: data-version follows the viewed version`)
  await noScroll(`${label}: old version banner`)
  await snap(`${label}-old`)
  await banner.locator('[data-testid=output-back-current]').click()
  check(await until(async () => (await banner.count()) === 0), `${label}: Back to current removes the banner`)

  // Word and Excel: Edit in the app, no in-app Edit.
  await select('Brief')
  check(/^Edit in Word$/.test(clean(await detail().locator('[data-testid=output-edit-external]').innerText())) && (await detail().locator('[data-testid=output-edit]').count()) === 0, `${label}: a Word document offers "Edit in Word" and no Edit`)
  await select('Budget')
  check(/^Edit in Excel$/.test(clean(await detail().locator('[data-testid=output-edit-external]').innerText())), `${label}: a workbook offers "Edit in Excel"`)

  // Larger view: the version select and one live region.
  await select('Project plan')
  await detail().locator('[data-testid=output-detail-expand]').click()
  const dlg = page.locator('[data-testid=output-dialog]')
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  check((await dlg.locator('[data-testid=output-version-select]').count()) === 1, `${label}: the Larger view has the version select`)
  check((await dlg.locator('[data-testid=output-notes-toggle]').count()) === 1, `${label}: the Larger view has the notes toggle`)
  check((await live().count()) === 1, `${label}: only one output-live region while the Larger view is open`)
  const drawerOpen = (await dlg.locator('[data-testid=output-notes-drawer]').count()) > 0
  check(!drawerOpen, `${label}: the notes drawer starts closed with no open notes`)
  await noScroll(`${label}: Larger view`)
  await snap(`${label}-viewer`)
  await page.keyboard.press('Escape')
  await dlg.waitFor({ state: 'hidden', timeout: 5000 })
  check(await until(async () => (await active()).id === 'output-detail-expand'), `${label}: Esc closes the Larger view and focus returns to its button`)
  void wide
}

/** Mutating checks, once. */
async function mutatingChecks(label) {
  // Restore version 1 as version 3.
  await select('Project plan')
  await detail().locator('[data-testid=output-tab-versions]').click()
  const panel = detail().locator('[data-testid=output-versions]')
  const vrows = panel.locator('[data-testid=output-version-row]')
  await vrows.nth(1).locator('[data-testid=output-version-view]').click()
  await detail().locator('[data-testid=output-restore]').click()
  check(await until(async () => /Restored version 1 as version 3\./.test(clean(await live().innerText())), 8000), `${label}: Restore says "Restored version 1 as version 3."`, clean(await live().innerText()))
  check(await until(async () => (await panel.locator('[data-testid=output-version-row]').count()) === 3), `${label}: the list has three versions`)
  check((await outputsOf()).find((o) => o.title === 'Project plan')?.version === 3, `${label}: the index says version 3`)
  check(await until(async () => (await active()).id === 'output-version-row' && (await active()).n === '3'), `${label}: focus lands on the new current version's row`, JSON.stringify(await active()))
  check((await detail().locator('[data-testid=output-old-version]').count()) === 0, `${label}: the banner is gone after a restore`)
  check(/Restored from version 1/.test(clean(await panel.locator('[data-testid=output-version-row][data-n="3"]').innerText())), `${label}: version 3 reads "Restored from version 1"`)

  // Name a version.
  const v1 = panel.locator('[data-testid=output-version-row][data-n="1"]')
  await v1.locator('[data-testid=output-version-name]').click()
  await v1.locator('[data-testid=output-version-name-input]').fill('First draft')
  await v1.locator('[data-testid=output-version-name-save]').click()
  check(await until(async () => /First draft/.test(clean(await v1.locator('[data-testid=output-version-label]').innerText().catch(() => '')))), `${label}: a named version shows its name`)
  const opts = (await detail().locator('[data-testid=output-version-select] option').allInnerTexts()).map(clean)
  check(opts.some((o) => /^v1 · First draft/.test(o)), `${label}: the select shows the name`, JSON.stringify(opts))

  // Rename.
  await detail().locator('[data-testid=output-more]').click()
  await page.locator('[data-testid=output-rename]').click()
  await page.locator('[data-testid=output-rename-dialog]').waitFor({ timeout: 5000 })
  await page.locator('[data-testid=output-rename-title]').fill('Project plan final')
  await page.locator('[data-testid=output-rename-save]').click()
  check(await until(async () => /Project plan final/.test(clean(await detail().locator('[data-testid=output-detail-heading]').innerText()))), `${label}: Rename changes the heading`)
  check((await outputsOf()).find((o) => o.title === 'Project plan final')?.version === 3, `${label}: Rename adds no version`)

  // Delete a produced output.
  const before = (await outputsOf()).length
  await select('Config')
  await detail().locator('[data-testid=output-more]').click()
  await page.locator('[data-testid=output-delete]').click()
  const confirmBtn = page.locator('[data-testid=output-delete-confirm]')
  await confirmBtn.waitFor({ timeout: 5000 })
  const text = clean(await page.locator('dialog[open]').innerText())
  check(/Delete Config\?/.test(text) && /outputs\/config\.json and its 1 earlier version from your computer\./.test(text), `${label}: the produced-delete confirm names the file and its earlier versions`, text.slice(0, 260))
  check(/Recycle Bin or Trash|deleted for good/.test(text), `${label}: the confirm says where the file goes`)
  await snap(`${label}-delete`)
  await confirmBtn.click()
  check(await until(async () => (await outputsOf()).length === before - 1), `${label}: Delete removes the output`)
  check(await until(async () => (await active()).id === 'output-row'), `${label}: focus moves to another row after Delete`, JSON.stringify(await active()))
  check(await until(async () => /Deleted Config\./.test(clean(await page.locator('[data-testid=output-notice]').innerText().catch(() => ''))), 3000), `${label}: the surface says "Deleted Config."`)

  // Delete a registered output: its full path is shown.
  await select('Handoff')
  await detail().locator('[data-testid=output-more]').click()
  await page.locator('[data-testid=output-delete]').click()
  await confirmBtn.waitFor({ timeout: 5000 })
  const rtext = clean(await page.locator('dialog[open]').innerText())
  const shownPath = clean(await page.locator('[data-testid=output-delete-path]').innerText()).replace(/\\/g, '/')
  check(/Delete Handoff and its file\?/.test(rtext) && /a file the team registered/.test(rtext), `${label}: the registered-delete confirm says the team registered it`, rtext.slice(0, 260))
  check(shownPath.endsWith('/reg/handoff.txt') && path.isAbsolute(shownPath.replace(/\//g, path.sep)), `${label}: the confirm shows the full path`, shownPath)
  await page.keyboard.press('Escape')
  await confirmBtn.waitFor({ state: 'hidden', timeout: 5000 })
  check((await outputsOf()).some((o) => o.title === 'Handoff'), `${label}: cancelling keeps the registered output`)
  await detail().locator('[data-testid=output-more]').click()
  await page.locator('[data-testid=output-delete]').click()
  await confirmBtn.click()
  check(await until(async () => !(await outputsOf()).some((o) => o.title === 'Handoff'), 15_000), `${label}: Delete removes the registered output`)

  // Remove from list.
  await select('Report')
  await detail().locator('[data-testid=output-more]').click()
  await page.locator('[data-testid=output-forget]').click()
  const forget = page.locator('[data-testid=output-forget-confirm]')
  await forget.waitFor({ timeout: 5000 })
  const ftext = clean(await page.locator('dialog[open]').innerText())
  check(/Remove Report from OrgAI\?/.test(ftext) && /The file stays at outputs\/report\.csv\. OrgAI's earlier versions and notes are deleted\./.test(ftext), `${label}: the Remove confirm names where the file stays`, ftext.slice(0, 240))
  await forget.click()
  check(await until(async () => !(await outputsOf()).some((o) => o.title === 'Report')), `${label}: Remove from list drops the output`)
  check(fs.existsSync(path.join(repo, 'outputs', 'report.csv')), `${label}: the file stays on disk`)
  await noScroll(`${label}: after the removals`)
}

let mainProject
let partsProject
async function runParts(label, size, theme) {
  if (!partsProject) return
  project = partsProject
  await openProject(page, NAME_PARTS)
  await openOutputsTab()
  for (const name of ['outputs-compare.part.mjs', 'outputs-edit.part.mjs']) {
    const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), name)
    if (!fs.existsSync(file)) continue
    try {
      const mod = await import(pathToFileURL(file).href)
      await mod.default({ app, page, project, label, size, theme, check, sleep })
    } catch (e) {
      check(false, `${label}: ${name}`, String(e?.message ?? e).split('\n')[0])
    }
    // A part may leave a dialog or the editor open: Esc twice, then answer a leave guard with "Don't save".
    await page.keyboard.press('Escape').catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
    const discard = page.locator('[data-testid=output-guard-discard]')
    if (await discard.count()) await discard.click().catch(() => {})
  }
  project = mainProject
  await openProject(page, NAME)
}

try {
  partsProject = await createProject(page, { mode: 'existing', path: repoParts, name: NAME_PARTS })
  project = partsProject
  if (partsProject) {
    await runWith(1, 'Make the files', 7, 1)
    await runWith(2, 'Update the files', 7, 2)
  }
  mainProject = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  project = mainProject
  check(!!project, 'project created on the mock adapter')
  await runWith(1, 'Make the files', 7, 1)
  await runWith(2, 'Update the files', 7, 2)
  const list = await outputsOf()
  check(list.filter((o) => o.source === 'produced').every((o) => o.version === 2), 'every produced output is at version 2', JSON.stringify(list.map((o) => [o.title, o.version])))
  const combos = [
    { w: 1600, h: 1000, theme: 'dark' },
    { w: 1600, h: 1000, theme: 'light' },
    { w: 1024, h: 640, theme: 'dark' },
    { w: 1024, h: 640, theme: 'light' }
  ]
  for (const c of combos) {
    const label = `${c.w}x${c.h} ${c.theme}`
    await setSize(c.w, c.h)
    await setTheme(c.theme)
    try {
      await versionChecks(label, c.w >= 1100)
    } catch (e) {
      check(false, `${label}: version checks`, e.message.split('\n')[0])
    }
    await runParts(label, [c.w, c.h], c.theme)
  }
  try {
    await mutatingChecks('1024x640 light')
  } catch (e) {
    check(false, 'mutating checks', e.message.split('\n')[0])
  }
} finally {
  await deleteProject(page, NAME_PARTS).catch(() => {})
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
void projectTab
void screenshot
finish('outputs-versions')
