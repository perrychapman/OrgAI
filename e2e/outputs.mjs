// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Run outputs (docs/design/outputs.md): one work run produces five
// outputs through the harness tools (a document, a workbook, a diagram, a Markdown file and a registered PNG) and one
// refused register. Checks the run side tab (rows, previews, sheet, diagram, Markdown, image), the RunMeta chip, the
// transcript rows ("Refused", "Show" lands on the item), the project Outputs tab (list, filters, keyboard path, actions
// menu, Remove from list) at 1024x640 and 1600x1000 in both themes, and that no page scrolls.
// The default drives the mock marker [mock:outputs]. E2E_OUTPUTS_SCRIPT=1 writes an equivalent ORGAI_MOCK_SCRIPT
// instead (for a build whose mock has no marker); the registered PNG is then written into the project folder first.
// Open / Show in folder / Save as are native and not driven.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { TMP, check, cleanup, createProject, finish, launch, makeFixtureRepo, projectTab, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const USE_SCRIPT = process.env.E2E_OUTPUTS_SCRIPT === '1'
const NAME = 'E2E outputs (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-outputs-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('outputs', { at: repo })

// ---------- the script (E2E_OUTPUTS_SCRIPT=1) ----------
const PLAN_MD = [
  '# Project plan',
  '',
  'This plan covers **three phases** and is *deliberately small*.',
  '',
  '- Design the model',
  '- Build the service',
  '- Launch to the pilot group',
  '',
  '| Phase | Owner | Weeks |',
  '| --- | --- | --- |',
  '| Design | Ana | 2 |',
  '| Build | Ben | 6 |',
  '| Launch | Cy | 1 |',
  '',
  '1. Agree the scope',
  '2. Build it',
  '3. Ship it',
  '',
  '---',
  '',
  '```',
  'npm test',
  '```',
  ''
].join('\n')

function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
/** A real 8x8 solid red PNG. */
function redPng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(8 * (1 + 8 * 3))
  for (let y = 0; y < 8; y++) {
    const o = y * (1 + 24)
    for (let x = 0; x < 8; x++) raw[o + 1 + x * 3] = 255
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

if (USE_SCRIPT) {
  fs.mkdirSync(path.join(repo, 'outputs'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'outputs', 'logo.png'), redPng())
  const script = {
    delayMs: 150,
    work: [
      { type: 'text', text: 'I will produce the deliverables first.' },
      { type: 'harness', name: 'produce_output', args: { kind: 'docx', title: 'Project plan', fileName: 'project-plan', content: PLAN_MD } },
      {
        type: 'harness',
        name: 'produce_output',
        args: {
          kind: 'xlsx',
          title: 'Budget',
          fileName: 'Budget',
          workbook: {
            sheets: [
              {
                name: 'Budget',
                columns: [{ header: 'Item' }, { header: 'Cost' }],
                rows: [
                  ['Design', 1200],
                  ['Build', 3400],
                  ['Launch', 800],
                  ['Total', '=SUM(B2:B4)']
                ]
              },
              { name: 'Notes', rows: [['Figures are estimates.']] }
            ]
          }
        }
      },
      { type: 'harness', name: 'produce_output', args: { kind: 'mermaid', title: 'Architecture diagram', fileName: 'Architecture-diagram', content: 'flowchart LR\n  Client --> API --> Database\n  API --> Queue\n' } },
      { type: 'harness', name: 'produce_output', args: { kind: 'markdown', title: 'Summary', fileName: 'Summary', content: '# Summary\n\nThe plan, the budget and the diagram are ready.\n\n- Plan\n- Budget\n- Diagram\n' } },
      { type: 'harness', name: 'register_output', args: { path: 'outputs/logo.png', title: 'Logo', kind: 'image' } },
      { type: 'harness', name: 'register_output', args: { path: '../outside.txt', title: 'Outside' } },
      { type: 'text', text: 'I produced 5 outputs.' }
    ]
  }
  const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-outputs-script-')), 'script.json')
  fs.writeFileSync(scriptFile, JSON.stringify(script))
  process.env.ORGAI_MOCK_SCRIPT = scriptFile
}

let { app, page } = await launch({ shotPrefix: 'outputs' })
page.setDefaultTimeout(8000)

const snap = (name) => screenshot(page, `outputs-${name}`)
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
  const o = await page.evaluate(() => {
    const el = document.scrollingElement
    const main = document.querySelector('main.main')
    return { sh: el?.scrollHeight ?? 0, ch: el?.clientHeight ?? 0, sw: el?.scrollWidth ?? 0, cw: el?.clientWidth ?? 0, mh: main?.scrollHeight ?? 0, mch: main?.clientHeight ?? 0 }
  })
  check(o.sh <= o.ch + 1 && o.sw <= o.cw + 1 && o.mh <= o.mch + 1, `${what}: the page and the main region do not scroll`, JSON.stringify(o))
}
const kindsInOrder = ['image', 'markdown', 'mermaid', 'xlsx', 'docx']

let project
const outputsOf = () => page.evaluate((id) => window.orgai.outputs.list(id), project.id)

/** Start the work run on the Live tab. */
async function startRun() {
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(USE_SCRIPT ? 'Produce the deliverables' : 'Produce the deliverables [mock:outputs]')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
}

/** The run's side panel open (a rail at 1024x640) on the Outputs tab. */
async function openRunOutputsTab() {
  await projectTab(page, 'Live').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  const railed = page.locator('aside.side-panel[data-collapsed=true]')
  if (await railed.count()) {
    await railed.getByRole('button', { name: /^Show run panel/ }).click()
    await sleep(400)
  }
  const tab = page.locator('[data-testid=side-tab-outputs]')
  await tab.waitFor({ state: 'visible', timeout: 8000 })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await page.locator('[data-testid=run-outputs-list], [data-testid=run-outputs-empty], [data-testid=output-detail]').first().waitFor({ timeout: 8000 })
  // A detail left open from an earlier visit (a narrow panel shows it instead of the list): back to the list.
  const back = page.locator('[data-testid=run-output-back]')
  if (await back.count()) {
    await back.click()
    await page.locator('[data-testid=run-outputs-list]').waitFor({ timeout: 5000 })
  }
}
const runRow = (kind) => page.locator(`[data-testid=run-output-row][data-kind=${kind}]`)
/** Show one output of the run side tab and wait for its detail. */
async function showRunOutput(kind) {
  const back = page.locator('[data-testid=run-output-back]')
  if (await back.count()) {
    await back.click()
    await page.locator('[data-testid=run-outputs-list]').waitFor({ timeout: 5000 })
  }
  await runRow(kind).locator('[data-testid=run-output-show]').click()
  await page.locator(`[data-testid=output-detail][data-kind=${kind}]`).waitFor({ timeout: 8000 })
}
const detail = () => page.locator('[data-testid=output-detail]').first()

/** Run side tab: rows, previews, chip. */
async function runSideChecks(label, wide) {
  await openRunOutputsTab()
  const kinds = await page.locator('[data-testid=run-output-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  check(kinds.length === 5 && ['docx', 'xlsx', 'mermaid', 'markdown', 'image'].every((k) => kinds.includes(k)), `${label}: the run side tab lists five outputs of the right kinds`, kinds.join(','))
  await noScroll(`${label}: run Outputs tab`)

  // RunMeta chip: "5 outputs" (icon and count under 1100 px, the label in the title).
  const chip = page.locator('[data-testid=run-meta-outputs]')
  const chipText = (await chip.count()) ? `${await chip.innerText()} ${(await chip.textContent()) ?? ''} ${(await chip.getAttribute('title')) ?? ''}` : ''
  check(wide ? /5 outputs/.test(chipText) : /\b5\b/.test(chipText) && /output/.test(chipText), `${label}: the RunMeta chip counts the outputs`, clean(chipText))

  // Document
  await showRunOutput('docx')
  const doc = detail().locator('[data-testid=output-doc]')
  await doc.waitFor({ timeout: 8000 })
  check((await doc.locator('h4, h5, h6').count()) >= 1 && (await doc.locator('strong').count()) >= 1 && (await doc.locator('table').count()) === 1, `${label}: the document preview shows a heading, a bold run and a table`)
  check((await doc.locator('table tr').count()) === 4 && (await doc.locator('ul > li').count()) === 3, `${label}: the table has three rows under its header and the list three bullets`)
  await noScroll(`${label}: document preview`)
  if (wide) await snap(`${label}-doc`)

  // Spreadsheet
  await showRunOutput('xlsx')
  const sheets = detail().locator('[data-testid=output-sheets]')
  await sheets.waitFor({ timeout: 8000 })
  check((await detail().locator('[data-testid=output-sheet-tab]').count()) === 2, `${label}: the sheet view has two sheet tabs`)
  const cells = clean(await sheets.locator('[data-testid=output-sheet-table]').first().innerText()).replace(/,/g, '')
  check(/1200/.test(cells) && /3400/.test(cells) && /\b800\b/.test(cells), `${label}: the Cost cells read 1200, 3400 and 800`, cells.slice(0, 120))
  check(cells.includes('=SUM(B2:B4)'), `${label}: the formula-looking cell is shown as text`, cells.slice(0, 160))
  await noScroll(`${label}: sheet preview`)

  // Diagram
  await showRunOutput('mermaid')
  const svg = detail().locator('[data-testid=output-mermaid-svg] svg')
  await svg.first().waitFor({ timeout: 20_000 })
  const labels = clean(await detail().locator('[data-testid=output-mermaid-svg]').innerText())
  check(['Client', 'API', 'Database', 'Queue'].every((w) => labels.includes(w)), `${label}: the diagram draws its four nodes`, labels)
  await detail().locator('[data-testid=output-mermaid-view]').getByText('Source', { exact: true }).click()
  const src = clean(await detail().locator('[data-testid=output-source]').first().innerText())
  check(/flowchart/.test(src) && /Client/.test(src), `${label}: the diagram source shows the text`, src.slice(0, 80))
  await detail().locator('[data-testid=output-mermaid-view]').getByText('Diagram', { exact: true }).click()
  await noScroll(`${label}: diagram preview`)
  if (wide) await snap(`${label}-diagram`)

  // Markdown
  await showRunOutput('markdown')
  const md = detail().locator('[data-testid=output-md-rendered]')
  await md.waitFor({ timeout: 8000 })
  check((await md.locator('h1, h2, h3, h4, h5, h6').count()) >= 1, `${label}: the Markdown output renders a heading`)
  await detail().locator('[data-testid=output-md-view]').getByText('Source', { exact: true }).click()
  const mdSrc = clean(await detail().locator('[data-testid=output-source]').first().innerText())
  check(/^#/.test(mdSrc), `${label}: the Markdown source shows the text`, mdSrc.slice(0, 60))

  // Image
  await showRunOutput('image')
  const img = detail().locator('img[data-testid=output-image]')
  await img.waitFor({ timeout: 8000 })
  check(await until(async () => (await img.evaluate((el) => el.complete && el.naturalWidth > 0)) === true, 6000), `${label}: the image preview is loaded`)
  await noScroll(`${label}: image preview`)
}

/** Transcript rows: the refused register, and a Show link that lands on the item. */
async function transcriptChecks(label) {
  await projectTab(page, 'Live').click()
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('.react-flow__node:has(.agent-node.is-root)').first().click()
  await sleep(300)
  const railed = page.locator('aside.side-panel[data-collapsed=true]')
  if (await railed.count()) {
    await railed.getByRole('button', { name: /^Show run panel/ }).click()
    await sleep(400)
  }
  const tTab = page.locator('[data-testid=side-tab-transcript]')
  if ((await tTab.getAttribute('aria-selected')) !== 'true') await tTab.click()
  await page.locator('.side-run .transcript .entry').first().waitFor({ state: 'visible', timeout: 10_000 })
  const rows = page.locator('[data-testid=output-write-row]')
  check(await until(async () => (await rows.count()) >= 5), `${label}: the transcript folds each produce / register call into one row`, String(await rows.count()))
  const states = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  check(states.filter((s) => s === 'produced').length === 4 && states.filter((s) => s === 'registered').length === 1 && states.filter((s) => s === 'refused').length === 1, `${label}: four produced, one registered and one refused row`, states.join(','))
  const refused = page.locator('[data-testid=output-write-row][data-state=refused]')
  check(/Refused/.test(clean(await refused.first().innerText())) && (await refused.first().locator('[data-testid=output-write-show]').count()) === 0, `${label}: the refused row reads "Refused" and has no Show link`, clean(await refused.first().innerText()))
  check((await outputsOf()).length === 5, `${label}: the refused register added no entry`)
  // Show lands on the item in the side tab.
  const budget = (await outputsOf()).find((o) => o.title === 'Budget')
  const row = rows.filter({ hasText: 'Budget' }).first()
  await row.locator('[data-testid=output-write-show]').click()
  const ok = await until(async () => (await page.locator('[data-testid=side-tab-outputs]').getAttribute('aria-selected')) === 'true' && (await page.locator('[data-testid=output-detail]').first().getAttribute('data-id')) === budget?.id)
  check(ok, `${label}: a transcript row's Show opens that item in the Outputs side tab`)
}

/** The project Outputs tab: list, filters, keyboard. */
async function projectTabChecks(label) {
  await page.locator('[data-testid=tab-outputs]').click()
  const list = page.locator('[data-testid=outputs-list]')
  await list.waitFor({ timeout: 10_000 })
  const rows = page.locator('[data-testid=output-row]')
  check((await rows.count()) === 5, `${label}: the Outputs tab lists the same five outputs`, String(await rows.count()))
  const kinds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  check(kinds.join(',') === kindsInOrder.join(','), `${label}: newest first`, kinds.join(','))
  const roles = await list.evaluate((ul) => ({ options: ul.querySelectorAll('[role=option]').length, tab0: ul.querySelectorAll('[role=option][tabindex="0"]').length, headings: ul.querySelectorAll('h2').length }))
  check(roles.options === 5 && roles.tab0 === 1 && roles.headings >= 1, `${label}: one Tab stop, rows under a day heading`, JSON.stringify(roles))
  const group = clean(await page.locator('[data-testid=outputs-group-title]').first().innerText())
  check(/^Today/.test(group), `${label}: rows are grouped under Today`, group)
  check(/5 outputs/.test(clean(await page.locator('[data-testid=outputs-count]').innerText())), `${label}: the count line says 5 outputs`)
  await noScroll(`${label}: Outputs tab`)
  await snap(`${label}-list`)
}

async function filterChecks(label) {
  const rows = page.locator('[data-testid=output-row]')
  await page.locator('[data-testid=outputs-kind-all]').waitFor()
  check((await page.locator('[data-testid=outputs-kind]').count()) === 5, `${label}: five kind chips with counts`)
  await page.locator('[data-testid=outputs-kind][data-kind=docx]').click()
  check((await rows.count()) === 1 && (await page.locator('[data-testid=outputs-kind][data-kind=docx]').getAttribute('aria-pressed')) === 'true', `${label}: a kind chip filters`)
  check(/1 of 5 outputs/.test(clean(await page.locator('[data-testid=outputs-count]').innerText())), `${label}: the count line follows the filter`)
  await page.locator('[data-testid=outputs-kind][data-kind=image]').click()
  check((await rows.count()) === 2, `${label}: kinds are OR`)
  await page.locator('[data-testid=outputs-kind-all]').click()
  check((await rows.count()) === 5, `${label}: All kinds resets`)
  const search = page.locator('[data-testid=outputs-search]')
  await search.fill('budget')
  check(await until(async () => (await rows.count()) === 1), `${label}: search narrows to the Budget row`)
  await search.fill('zzzz-nothing')
  check(await until(async () => (await page.locator('[data-testid=outputs-clear-filters]').count()) === 1), `${label}: no matches offers Clear the filters`)
  await page.locator('[data-testid=outputs-clear-filters]').click()
  check(await until(async () => (await rows.count()) === 5 && (await search.inputValue()) === ''), `${label}: Clear the filters restores the list and the box`)
  await search.fill('plan')
  await until(async () => (await rows.count()) === 1)
  await search.press('Escape')
  check((await search.inputValue()) === '' && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'outputs-search', `${label}: Esc clears the search and keeps focus in it`)
  await until(async () => (await rows.count()) === 5)
  const opts = await page.locator('[data-testid=outputs-run-filter] select option').allInnerTexts()
  check(opts.length === 2 && /^All runs/.test(opts[0]) && /^R1 · /.test(opts[1]), `${label}: the run filter offers All runs and the run`, opts.join(' | '))
  await page.locator('[data-testid=outputs-run-filter] select').selectOption({ index: 1 })
  check((await rows.count()) === 5, `${label}: filtering by the run keeps its five outputs`)
  await page.locator('[data-testid=outputs-run-filter] select').selectOption({ index: 0 })
}

async function keyboardChecks(label) {
  const active = () => page.evaluate(() => ({ id: document.activeElement?.id ?? '', tid: document.activeElement?.getAttribute('data-testid') ?? '', row: document.activeElement?.getAttribute('data-id') ?? '' }))
  await page.locator('[data-testid=outputs-run-filter] select').focus()
  await page.keyboard.press('Tab')
  const landed = await active()
  check(landed.tid === 'output-row', `${label}: Tab from the run filter lands on a row (one stop)`, JSON.stringify(landed))
  // The roving stop is the last row used (the filters above visited others): start from the top.
  await page.keyboard.press('Home')
  await until(async () => (await page.locator('[data-testid=output-row]').first().getAttribute('data-id')) === (await active()).row, 3000)
  const first = await active()
  await page.keyboard.press('ArrowDown')
  await until(async () => (await active()).row !== first.row, 3000)
  const second = await active()
  check(second.tid === 'output-row' && second.row !== first.row, `${label}: ArrowDown moves to the next row`, JSON.stringify(second))
  await page.keyboard.press('Enter')
  const ok = await until(async () => (await active()).id === 'output-detail-heading')
  check(ok, `${label}: Enter shows the output and focus lands on its heading`, JSON.stringify(await active()))
  check((await page.locator(`[data-testid=output-detail][data-id="${second.row}"]`).count()) === 1, `${label}: the pane shows the chosen output`)
  await page.keyboard.press('Escape')
  const back = await until(async () => {
    const a = await active()
    return a.tid === 'output-row' && a.row === second.row
  })
  check(back, `${label}: Esc in the pane returns focus to the row`, JSON.stringify(await active()))
  await page.keyboard.press('End')
  const end = await active()
  check(end.row === (await page.locator('[data-testid=output-row]').last().getAttribute('data-id')), `${label}: End goes to the last row`)
  await page.keyboard.press('Home')
  await page.keyboard.type('b')
  check(await until(async () => (await page.evaluate(() => document.activeElement?.querySelector('[data-testid=output-row-title]')?.textContent)) === 'Budget'), `${label}: type-ahead lands on Budget`)
  await noScroll(`${label}: after the keyboard pass`)
}

async function actionChecks(label) {
  const rows = page.locator('[data-testid=output-row]')
  const more = page.locator('[data-testid=outputs-detail] [data-testid=output-more]')
  await rows.filter({ hasText: 'Summary' }).first().click()
  await more.first().waitFor({ timeout: 8000 })
  await more.first().click()
  const actions = page.locator('[data-testid=output-actions]')
  await actions.waitFor({ state: 'visible', timeout: 5000 })
  const ids = ['output-open', 'output-reveal', 'output-save-as', 'output-copy-path', 'output-forget', 'output-delete']
  const have = await Promise.all(ids.map(async (id) => (await actions.locator(`[data-testid=${id}]`).count()) > 0))
  check(have.every(Boolean), `${label}: a produced output's actions are Open, Show in folder, Save as, Copy path, Remove and Delete`, ids.filter((_, i) => !have[i]).join(','))
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  // The registered PNG: no Delete.
  await rows.filter({ hasText: 'Logo' }).first().click()
  await page.locator('[data-testid=output-detail][data-kind=image]').waitFor({ timeout: 8000 })
  await more.first().click()
  await actions.waitFor({ state: 'visible', timeout: 5000 })
  check((await actions.locator('[data-testid=output-delete]').count()) === 0 && (await actions.locator('[data-testid=output-forget]').count()) === 1, `${label}: a registered file offers Remove from list but no Delete`)
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
}

async function removeChecks(label) {
  const rows = page.locator('[data-testid=output-row]')
  const more = page.locator('[data-testid=outputs-detail] [data-testid=output-more]')
  await rows.filter({ hasText: 'Summary' }).first().click()
  await more.first().waitFor({ timeout: 8000 })
  await more.first().click()
  await page.locator('[data-testid=output-forget]').click()
  check(await until(async () => (await rows.count()) === 4), `${label}: Remove from list drops the row`)
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'output-row'), `${label}: focus moves to another row`)
  check((await outputsOf()).length === 4, `${label}: the index no longer lists it`)
  await noScroll(`${label}: after Remove`)
  await projectTab(page, 'Live').click()
  await openRunOutputsTab()
  check(await until(async () => (await page.locator('[data-testid=run-output-row]').count()) === 4), `${label}: the run side tab dropped it too`)
}

try {
  project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  // The tab exists on a stored project.
  check((await page.locator('[data-testid=tab-outputs]').count()) === 1, 'the project has an Outputs tab')
  await page.locator('[data-testid=tab-outputs]').click()
  check(await page.locator('[data-testid=outputs-empty]').isVisible(), 'an empty project says "No outputs yet."')
  check(/No outputs yet\./.test(clean(await page.locator('[data-testid=outputs-empty]').innerText())), 'the empty copy names what appears here')

  await startRun()
  check(await until(async () => (await outputsOf()).length >= 5, 60_000), 'the run produced five outputs', String((await outputsOf()).length))
  await sleep(1500)

  const combos = [
    { w: 1600, h: 1000, theme: 'dark' },
    { w: 1600, h: 1000, theme: 'light' },
    { w: 1024, h: 640, theme: 'dark' },
    { w: 1024, h: 640, theme: 'light' }
  ]
  for (const [i, c] of combos.entries()) {
    const label = `${c.w}x${c.h} ${c.theme}`
    await setSize(c.w, c.h)
    await setTheme(c.theme)
    try {
      await runSideChecks(label, c.w >= 1100)
    } catch (e) {
      check(false, `${label}: run side tab checks`, e.message.split('\n')[0])
    }
    if (i === 0 || i === 3) {
      try {
        await transcriptChecks(label)
      } catch (e) {
        check(false, `${label}: transcript checks`, e.message.split('\n')[0])
      }
    }
    try {
      await projectTabChecks(label)
      if (i === 0 || i === 3) {
        await filterChecks(label)
        await keyboardChecks(label)
        await actionChecks(label)
      }
    } catch (e) {
      check(false, `${label}: project tab checks`, e.message.split('\n')[0])
    }
  }
  // Last: Remove from list drops the item from both lists.
  try {
    await removeChecks('1024x640 light')
  } catch (e) {
    check(false, 'remove checks', e.message.split('\n')[0])
  }
} finally {
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('outputs')
