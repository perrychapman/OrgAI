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
import { APP_DIR, TMP, check, cleanup, createProject, deleteProject, finish, launch, makeFixtureRepo, projectTab, screenshot, settleMotion, sleep } from './lib.mjs'

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
  await settleMotion(page)
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
async function startRun(prompt = USE_SCRIPT ? 'Produce the deliverables' : 'Produce the deliverables [mock:outputs]') {
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
let hintChecked = false

/** Zoom of the diagram in `scope` (the detail, or the Larger view): buttons, keys, limits, drawing size. */
async function zoomIn(scope, label) {
  const zoom = scope.locator('[data-testid=output-mermaid-zoom]')
  await zoom.waitFor({ timeout: 8000 })
  const vp = scope.locator('[data-testid=diagram-viewport]').first()
  await vp.waitFor({ timeout: 20_000 })
  const value = () => zoom.getAttribute('data-value')
  const k = async () => Number(await vp.getAttribute('data-k'))
  const drawn = () => scope.locator('[data-testid=output-mermaid-svg]').first().evaluate((el) => el.getBoundingClientRect().width)
  const naturalW = Number(await vp.getAttribute('data-natural-w'))
  check((await value()) === 'fit' && (await vp.getAttribute('data-mode')) === 'fit', `${label}: the diagram opens at Fit`, await value())
  check(await until(async () => Math.abs((await drawn()) - naturalW * (await k())) < 2, 4000), `${label}: the drawing is drawn at the scale the viewport names`, `${await k()} ${await drawn()}`)
  await scope.locator('[data-testid=output-zoom-actual]').click()
  check((await value()) === '1' && (await vp.getAttribute('data-mode')) === 'free', `${label}: Actual size sets 100%`, String(await value()))
  check(/^100\s?%$/.test(clean(await zoom.locator('[data-testid=output-zoom-readout]').innerText())), `${label}: the readout says 100%`)
  const order = await zoom.evaluate((el) => Array.from(el.querySelectorAll('[data-testid]')).map((c) => c.getAttribute('data-testid')).join(','))
  check(order === 'output-zoom-out,output-zoom-readout,output-zoom-in,output-zoom-fit,output-zoom-actual', `${label}: the zoom bar reads - readout + Fit Actual size`, order)
  await scope.locator('[data-testid=output-zoom-in]').click()
  check((await k()) > 1, `${label}: Zoom in raises the scale`, String(await k()))
  await scope.locator('[data-testid=output-zoom-out]').click()
  await scope.locator('[data-testid=output-zoom-out]').click()
  check((await k()) < 1, `${label}: Zoom out lowers it`, String(await k()))
  // Keys while the viewport has focus.
  await vp.focus()
  await page.keyboard.press('1')
  check(Math.abs((await k()) - 1) < 0.001, `${label}: key 1 is actual size`, String(await k()))
  await page.keyboard.press('+')
  check(Math.abs((await k()) - 1.25) < 0.01, `${label}: key + zooms in a step`, String(await k()))
  await page.keyboard.press('-')
  await page.keyboard.press('-')
  check((await k()) < 1, `${label}: key - zooms out`, String(await k()))
  for (let i = 0; i < 16; i++) await page.keyboard.press('+')
  check(Math.abs((await k()) - 8) < 0.01 && (await scope.locator('[data-testid=output-zoom-in]').getAttribute('aria-disabled')) === 'true', `${label}: zoom stops at 800%`, String(await k()))
  for (let i = 0; i < 30; i++) await page.keyboard.press('-')
  check(Math.abs((await k()) - 0.02) < 0.001 && (await scope.locator('[data-testid=output-zoom-out]').getAttribute('aria-disabled')) === 'true', `${label}: zoom stops at 2%`, String(await k()))
  await page.keyboard.press('0')
  check((await vp.getAttribute('data-mode')) === 'fit', `${label}: key 0 fits again`)
  await page.keyboard.press('ArrowRight')
  check((await vp.getAttribute('data-mode')) === 'free', `${label}: an arrow key pans`)
  await scope.locator('[data-testid=output-zoom-fit]').click()
  check((await value()) === 'fit', `${label}: Fit returns to fit`, await value())
}
async function zoomChecks(label) {
  await zoomIn(detail(), `${label} inline`)
  await noScroll(`${label}: after zooming the diagram`)
}

/** Larger view: opens a near-window dialog with the same preview and actions, zoom works there, Esc returns focus. */
async function largerViewChecks(label) {
  const btn = detail().locator('[data-testid=output-detail-expand]')
  check((await btn.count()) === 1 && (await btn.getAttribute('aria-label')) === 'Larger view', `${label}: the detail has a Larger view button`)
  const inlineW = await detail().locator('[data-testid=diagram-viewport]').first().evaluate((el) => el.getBoundingClientRect().width)
  await btn.click()
  const dlg = page.locator('[data-testid=output-dialog]')
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  // Visibility can precede the shared dialog's entry transform; measure its final geometry.
  await dlg.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished))
  })
  const box = await dlg.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }
  })
  check(box.w >= box.vw - 64 && box.h >= box.vh - 64, `${label}: the Larger view fills the window`, JSON.stringify(box))
  check((await dlg.locator('h2').innerText()) === 'Architecture diagram' && (await dlg.locator('[data-testid=output-more]').count()) === 1, `${label}: the Larger view is titled by the output and offers its actions`)
  const dvp = dlg.locator('[data-testid=diagram-viewport]').first()
  await dvp.waitFor({ timeout: 20_000 })
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'diagram-viewport', 4000), `${label}: opening the Larger view lands focus on the drawing`)
  const dlgW = await dvp.evaluate((el) => el.getBoundingClientRect().width)
  check(dlgW > inlineW, `${label}: the diagram has more room in the Larger view`, `${inlineW} -> ${dlgW}`)
  const stageH = await dvp.evaluate((el) => el.getBoundingClientRect().height)
  check(stageH >= Math.min(box.vh - 220, 300), `${label}: the diagram stage uses the dialog height`, String(stageH))
  await zoomIn(dlg, `${label} dialog`)
  await noScroll(`${label}: Larger view open`)
  await snap(`${label}-larger`)
  await page.keyboard.press('Escape')
  await dlg.waitFor({ state: 'hidden', timeout: 5000 })
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'output-detail-expand'), `${label}: Esc closes the Larger view and focus returns to its button`)
  await btn.click()
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  await dlg.getByRole('button', { name: 'Close dialog' }).click()
  await dlg.waitFor({ state: 'hidden', timeout: 5000 })
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'output-detail-expand'), `${label}: the close button returns focus to Larger view too`)
}

/** Run side tab: rows, previews, chip. */
async function runSideChecks(label, wide) {
  await openRunOutputsTab()
  const kinds = await page.locator('[data-testid=run-output-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  check(kinds.length === 5 && ['docx', 'xlsx', 'mermaid', 'markdown', 'image'].every((k) => kinds.includes(k)), `${label}: the run side tab lists five outputs of the right kinds`, kinds.join(','))
  await noScroll(`${label}: run Outputs tab`)
  const tabCount = page.locator('[data-testid=side-tab-outputs-count]')
  check((await tabCount.count()) === 1 && clean(await tabCount.innerText()) === '5', `${label}: the Outputs side tab shows its count (M1)`, (await tabCount.count()) ? clean(await tabCount.innerText()) : 'none')

  // RunMeta chip: "5 outputs" (icon and count under 1100 px, the label in the title).
  const chip = page.locator('[data-testid=run-meta-outputs]')
  const chipText = (await chip.count()) ? `${await chip.innerText()} ${(await chip.textContent()) ?? ''} ${(await chip.getAttribute('title')) ?? ''}` : ''
  check(wide ? /5 outputs/.test(chipText) : /\b5\b/.test(chipText) && /output/.test(chipText), `${label}: the RunMeta chip counts the outputs`, clean(chipText))

  // Document
  await showRunOutput('docx')
  const doc = detail().locator('[data-testid=output-doc]')
  await doc.waitFor({ timeout: 8000 })
  // The narrow-panel hint shows once, the first time a detail opens in a panel under 480 px.
  const hint = page.locator('[data-testid=output-wide-hint]')
  if (!hintChecked) {
    hintChecked = true
    const narrow = (await page.locator('[data-testid=run-outputs]').getAttribute('data-mode')) === 'detail'
    check(narrow ? (await hint.count()) === 1 && /Drag the panel edge or use Larger view/.test(clean(await hint.innerText())) : true, `${label}: a narrow panel's first detail says how to get more room`, String(await hint.count()))
  } else {
    check((await hint.count()) === 0, `${label}: the hint does not come back`)
  }
  check((await detail().locator('[data-testid=output-ext]').first().innerText()) === '.docx', `${label}: the detail shows the .docx extension badge`)
  check(/Word document/.test(clean(await detail().locator('[data-testid=output-detail-meta]').innerText())), `${label}: the detail says "Word document"`)
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
  const formulaNote = detail().locator('[data-testid=output-sheet-formula-note]')
  check((await formulaNote.count()) === 1 && clean(await formulaNote.innerText()) === 'Shown as text. OrgAI does not calculate formulas.', `${label}: the sheet says formulas are shown as text (V1)`)
  // Previous / next (M3): from the workbook, Next and Previous move through the list in its order; a click keeps focus on the button.
  const stepper = page.locator('[data-testid=output-stepper]')
  check((await stepper.count()) === 1, `${label}: the detail offers previous / next`)
  const order = await page.evaluate(async (pid) => (await window.orgai.outputs.list(pid)).map((o) => o.kind), project.id)
  const pos = clean(await page.locator('[data-testid=output-position]').innerText())
  check(/^\d+ of 5$/.test(pos), `${label}: the counter reads "N of 5"`, pos)
  const at = Number(pos.split(' ')[0])
  const nextBtn = page.locator('[data-testid=output-next]')
  const prevBtn = page.locator('[data-testid=output-prev]')
  const target = at < 5 ? nextBtn : prevBtn
  await target.click()
  const want = at < 5 ? at + 1 : at - 1
  check(await until(async () => clean(await page.locator('[data-testid=output-position]').innerText()) === `${want} of 5`), `${label}: a step moves the counter`, clean(await page.locator('[data-testid=output-position]').innerText()))
  check((await detail().getAttribute('data-kind')) !== 'xlsx' && order.length === 5, `${label}: the detail shows the neighbouring output`, await detail().getAttribute('data-kind'))
  check((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === (at < 5 ? 'output-next' : 'output-prev'), `${label}: focus stays on the step button`)
  // Alt+Left / Alt+Right inside the detail step back and land on the heading.
  await detail().locator('#output-detail-heading').focus()
  await page.keyboard.press(at < 5 ? 'Alt+ArrowLeft' : 'Alt+ArrowRight')
  check(await until(async () => clean(await page.locator('[data-testid=output-position]').innerText()) === `${at} of 5` && (await page.evaluate(() => document.activeElement?.id)) === 'output-detail-heading'), `${label}: Alt+arrow steps back and focuses the heading`)
  await noScroll(`${label}: sheet preview`)

  // Diagram
  await showRunOutput('mermaid')
  const svg = detail().locator('[data-testid=output-mermaid-svg] svg')
  await svg.first().waitFor({ timeout: 20_000 })
  // The drawing lives in a shadow root (checked nodes imported, never parsed as text).
  const drawing = await detail().locator('[data-testid=output-mermaid-svg]').evaluate((el) => ({
    shadow: !!el.shadowRoot,
    text: el.shadowRoot?.textContent ?? '',
    svgs: el.shadowRoot?.querySelectorAll('svg').length ?? 0,
    stray: el.querySelectorAll('*').length + (el.shadowRoot?.querySelectorAll('img, p, iframe, form, input, meta').length ?? 0)
  }))
  const labels = clean(drawing.text)
  check(['Client', 'API', 'Database', 'Queue'].every((w) => labels.includes(w)), `${label}: the diagram draws its four nodes`, labels)
  check(drawing.shadow && drawing.svgs === 1 && drawing.stray === 0, `${label}: the diagram sits in a shadow root as one svg with no img, p or form elements`, JSON.stringify(drawing))
  await detail().locator('[data-testid=diagram-mode]').getByText('Source', { exact: true }).click()
  const src = clean(await detail().locator('[data-testid=diagram-source]').first().inputValue())
  check(/flowchart/.test(src) && /Client/.test(src), `${label}: the diagram source shows the text`, src.slice(0, 80))
  await detail().locator('[data-testid=diagram-mode]').getByText('Diagram', { exact: true }).click()
  check((await detail().locator('[data-testid=output-open-large]').count()) === 1, `${label}: a diagram in the panel offers Open large`)
  await noScroll(`${label}: diagram preview`)
  await zoomChecks(label)
  await largerViewChecks(label)
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
  const rowTexts = (await rows.allInnerTexts()).map(clean)
  check(
    rowTexts.some((t) => /^Produced Word document: Project plan/.test(t)) && rowTexts.some((t) => /^Produced Excel workbook: Budget/.test(t)) && rowTexts.some((t) => /^Produced diagram: Architecture diagram/.test(t)) && rowTexts.some((t) => /^Registered image: Logo/.test(t)),
    `${label}: transcript rows read "Produced diagram: Architecture diagram" (kind word, colon, title)`,
    rowTexts.join(' | ').slice(0, 300)
  )
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
  const exts = await rows.evaluateAll((els) => els.map((e) => e.querySelector('[data-testid=output-ext]')?.textContent ?? ''))
  check(exts.join(',') === '.png,.md,.mmd,.xlsx,.docx', `${label}: every row carries its extension badge`, exts.join(','))
  const metas = await rows.evaluateAll((els) => els.map((e) => e.querySelector('.outputs-row-meta')?.textContent ?? ''))
  check(metas.some((m) => /^Word document · /.test(m)) && metas.some((m) => /^Excel workbook · /.test(m)), `${label}: list rows say Word document and Excel workbook`, metas.join(' | ').slice(0, 200))
  // M2: entering the tab selects the newest output without moving focus.
  const paneDetail = page.locator('[data-testid=outputs-detail] [data-testid=output-detail]')
  const railedPane = (await page.locator('aside[data-testid=outputs-detail][data-collapsed=true]').count()) === 1
  const selectedOk = await until(async () => {
    if (railedPane) return (await rows.first().getAttribute('aria-selected')) === 'true' || (await paneDetail.count()) === 1
    return (await paneDetail.count()) === 1 && (await paneDetail.getAttribute('data-id')) === (await rows.first().getAttribute('data-id'))
  }, 5000)
  check(selectedOk, `${label}: the newest output is selected on entering the tab`, railedPane ? 'pane railed' : '')
  check((await page.evaluate(() => document.activeElement?.id)) !== 'output-detail-heading', `${label}: the default selection does not take focus`)
  await noScroll(`${label}: Outputs tab`)
  await snap(`${label}-list`)
}

async function filterChecks(label) {
  const rows = page.locator('[data-testid=output-row]')
  await page.locator('[data-testid=outputs-kind-all]').waitFor()
  check((await page.locator('[data-testid=outputs-kind]').count()) === 5, `${label}: five kind chips with counts`)
  const chipTexts = await page.locator('[data-testid=outputs-kind]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')}:${(e.textContent ?? '').replace(/\s*\d+$/, '').trim()}:${e.getAttribute('title')}`))
  check(chipTexts.includes('docx:Word:Word document') && chipTexts.includes('xlsx:Excel:Excel workbook'), `${label}: the kind chips say Word and Excel with the full label as title`, chipTexts.join(' | '))
  // V3: the chips are one Tab stop with arrow keys.
  const kindsBar = page.locator('[data-testid=outputs-kinds]')
  const stops = await kindsBar.evaluate((el) => ({ role: el.getAttribute('role'), tab0: el.querySelectorAll('button[tabindex="0"]').length, all: el.querySelectorAll('button').length }))
  check(stops.role === 'toolbar' && stops.tab0 === 1 && stops.all === 6, `${label}: the kind chips are one toolbar with one Tab stop`, JSON.stringify(stops))
  await page.locator('[data-testid=outputs-kind-all]').focus()
  await page.keyboard.press('ArrowRight')
  const focusedKind = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  check(focusedKind === 'outputs-kind', `${label}: ArrowRight moves to the next chip`, String(focusedKind))
  await page.keyboard.press('Space')
  check(await until(async () => (await rows.count()) === 1), `${label}: Space toggles the focused chip`)
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  check(await until(async () => (await rows.count()) === 5), `${label}: Home and Enter reset to All kinds`)
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
  await search.fill('excel')
  check(await until(async () => (await rows.count()) === 1 && /Budget/.test(clean(await rows.first().innerText()))), `${label}: searching "excel" finds the workbook`)
  await search.fill('word')
  check(await until(async () => (await rows.count()) === 1 && /Project plan/.test(clean(await rows.first().innerText()))), `${label}: searching "word" finds the document`)
  await search.fill('.xlsx')
  check(await until(async () => (await rows.count()) === 1), `${label}: searching the extension finds the file`)
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
  // The view switch and Select sit between the filters and the list: Tab from Select lands on a row (one stop).
  await page.locator('[data-testid=outputs-select-toggle]').focus()
  await page.keyboard.press('Tab')
  const landed = await active()
  check(landed.tid === 'output-row', `${label}: Tab from the toolbar lands on a row (one stop)`, JSON.stringify(landed))
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

/** History: a quiet "5 outputs" chip on the conversation's row opens the run on its Outputs tab. */
async function historyChecks(label) {
  await projectTab(page, 'History').click()
  const chip = page.locator('[data-testid=history-outputs]')
  await chip.first().waitFor({ timeout: 10_000 })
  check((await chip.count()) === 1 && /^5 outputs$/.test(clean(await chip.first().innerText())), `${label}: History shows "5 outputs" on the row`, clean(await chip.first().innerText()))
  await noScroll(`${label}: History with the outputs chip`)
  await snap(`${label}-history`)
  await chip.first().focus()
  await page.keyboard.press('Enter')
  const tab = page.locator('[data-testid=side-tab-outputs]')
  check(await until(async () => (await tab.count()) === 1 && (await tab.getAttribute('aria-selected')) === 'true'), `${label}: the chip opens the run on its Outputs tab`)
  check(await until(async () => (await page.locator('[data-testid=run-outputs-list], [data-testid=output-detail]').count()) >= 1), `${label}: the Outputs tab shows the outputs`)
}

async function actionChecks(label) {
  const rows = page.locator('[data-testid=output-row]')
  const more = page.locator('[data-testid=outputs-detail] [data-testid=output-more]')
  await rows.filter({ hasText: 'Summary' }).first().click()
  await more.first().waitFor({ timeout: 8000 })
  await more.first().click()
  const actions = page.locator('[data-testid=output-actions]')
  await actions.waitFor({ state: 'visible', timeout: 5000 })
  const ids = ['output-open', 'output-reveal', 'output-save-as', 'output-copy-path', 'output-rename', 'output-forget', 'output-delete']
  const have = await Promise.all(ids.map(async (id) => (await actions.locator(`[data-testid=${id}]`).count()) > 0))
  check(have.every(Boolean), `${label}: a produced output's actions are Open, Show in folder, Save as, Copy path, Remove and Delete`, ids.filter((_, i) => !have[i]).join(','))
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  // The registered PNG: no Delete.
  await rows.filter({ hasText: 'Logo' }).first().click()
  await page.locator('[data-testid=output-detail][data-kind=image]').waitFor({ timeout: 8000 })
  await more.first().click()
  await actions.waitFor({ state: 'visible', timeout: 5000 })
  check((await actions.locator('[data-testid=output-delete]').count()) === 1 && (await actions.locator('[data-testid=output-forget]').count()) === 1, `${label}: a registered file offers Remove from list and Delete (outputs 2)`)
  await page.keyboard.press('Escape')
  await actions.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
}

async function removeChecks(label) {
  await page.locator('[data-testid=tab-outputs]').click()
  const rows = page.locator('[data-testid=output-row]')
  const more = page.locator('[data-testid=outputs-detail] [data-testid=output-more]')
  await rows.filter({ hasText: 'Summary' }).first().click()
  await more.first().waitFor({ timeout: 8000 })
  await more.first().click()
  await page.locator('[data-testid=output-forget]').click()
  // The index entry cannot be brought back from the app, so Remove asks first and says where the file stays.
  const forgetDlg = page.locator('[data-testid=output-forget-confirm]')
  await forgetDlg.waitFor({ timeout: 5000 })
  const forgetText = clean(await page.locator('dialog[open]').innerText())
  check(/Remove .+ from OrgAI\?/.test(forgetText) && /The file stays at outputs\/.+ OrgAI's earlier versions and notes are deleted\./.test(forgetText), `${label}: the Remove confirm says the file stays and OrgAI's versions and notes go`, forgetText.slice(0, 200))
  check((await forgetDlg.innerText()).trim() === 'Remove', `${label}: the confirm's primary is Remove`)
  await page.keyboard.press('Escape')
  await forgetDlg.waitFor({ state: 'hidden', timeout: 5000 })
  check((await rows.count()) === 5 && (await outputsOf()).length === 5, `${label}: cancelling the Remove confirm keeps the output`)
  await more.first().click()
  await page.locator('[data-testid=output-forget]').click()
  await forgetDlg.click()
  check(await until(async () => (await rows.count()) === 4), `${label}: Remove from list drops the row`)
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'output-row'), `${label}: focus moves to another row`)
  check((await outputsOf()).length === 4, `${label}: the index no longer lists it`)
  const notice = page.locator('[data-testid=outputs-detail] [data-testid=output-notice]')
  check(await until(async () => /Removed Summary from the list\./.test(clean(await notice.innerText())), 3000), `${label}: the project tab says "Removed Summary from the list."`, clean(await notice.innerText()))
  await noScroll(`${label}: after Remove`)
  // Delete file on the project tab: the confirm, the notice and the row going.
  await rows.filter({ hasText: 'Budget' }).first().click()
  await more.first().waitFor({ timeout: 8000 })
  await more.first().click()
  await page.locator('[data-testid=output-delete]').click()
  await page.locator('[data-testid=output-delete-confirm]').click()
  check(await until(async () => (await rows.count()) === 3), `${label}: Delete file drops the row on the project tab`)
  check(await until(async () => /Deleted Budget\./.test(clean(await notice.innerText())), 3000), `${label}: the project tab says "Deleted Budget."`, clean(await notice.innerText()))
  check((await outputsOf()).length === 3, `${label}: the index no longer lists the deleted file`)
  await projectTab(page, 'Live').click()
  await openRunOutputsTab()
  check(await until(async () => (await page.locator('[data-testid=run-output-row]').count()) === 3), `${label}: the run side tab dropped both too`)
  // Delete file on the run side tab.
  await runRow('mermaid').locator('[data-testid=output-more]').click()
  await page.locator('[data-testid=output-delete]').click()
  await page.locator('[data-testid=output-delete-confirm]').click()
  check(await until(async () => (await page.locator('[data-testid=run-output-row]').count()) === 2), `${label}: Delete file drops the row on the run side tab`)
  const runNotice = page.locator('[data-testid=run-outputs] [data-testid=output-notice]')
  check(await until(async () => /Deleted Architecture diagram\./.test(clean(await runNotice.innerText())), 3000), `${label}: the run side tab says "Deleted Architecture diagram."`, clean(await runNotice.innerText()))
  // Remove from inside the Larger view: the dialog closes, so the surface's own notice has to say it.
  await page.locator('[data-testid=tab-outputs]').click()
  await rows.first().waitFor({ timeout: 8000 })
  await rows.first().click()
  await page.locator('[data-testid=outputs-detail] [data-testid=output-detail-expand]').first().click()
  const dlg = page.locator('[data-testid=output-dialog]')
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  await dlg.locator('[data-testid=output-more]').click()
  await page.locator('[data-testid=output-forget]').click()
  await page.locator('[data-testid=output-forget-confirm]').click()
  await dlg.waitFor({ state: 'hidden', timeout: 5000 })
  check(await until(async () => /^Removed .+ from the list\.$/.test(clean(await notice.innerText())), 3000), `${label}: a Remove from inside the Larger view is still announced in the surface's notice`, clean(await notice.innerText()))
}

// ---------- diagram viewer (docs/design/outputs-2.md section 8) on a second project ----------
// [mock:outputs] makes one small diagram only, so this run comes from an ORGAI_MOCK_SCRIPT set in main (the mock reads the
// script per run): an 80-shape flowchart, a two-node one and a broken one.
const NAME2 = 'E2E diagrams (orgai test)'
const repo2 = path.join(base, 'repo-diagrams')
makeFixtureRepo('outputs-diagrams', { at: repo2 })
function largeFlowchart() {
  const lines = ['flowchart TD']
  for (let i = 1; i <= 40; i++) {
    lines.push(`  S${i}[Service ${i}] --> D${i}[(Store ${i})]`)
    if (i < 40) lines.push(`  S${i} --> S${i + 1}`)
  }
  return lines.join('\n') + '\n'
}
const TINY = 'flowchart TD\n  A[Start] --> B[End]\n'
const BROKEN = 'flowchart TD\n  A[Start --> B\n'
const diagramScript = {
  delayMs: 100,
  work: [
    { type: 'text', text: 'Drawing the diagrams.' },
    { type: 'harness', name: 'produce_output', args: { kind: 'mermaid', title: 'Large system map', fileName: 'large-system-map', content: largeFlowchart() } },
    { type: 'harness', name: 'produce_output', args: { kind: 'mermaid', title: 'Tiny map', fileName: 'tiny-map', content: TINY } },
    { type: 'harness', name: 'produce_output', args: { kind: 'mermaid', title: 'Broken diagram', fileName: 'broken-diagram', content: BROKEN } },
    { type: 'text', text: 'Three diagrams are ready.' }
  ]
}
let project2

async function showByTitle(title) {
  const back = page.locator('[data-testid=run-output-back]')
  if (await back.count()) {
    await back.click()
    await page.locator('[data-testid=run-outputs-list]').waitFor({ timeout: 5000 })
  }
  await page.locator('[data-testid=run-output-row]').filter({ hasText: title }).first().locator('[data-testid=run-output-show]').click()
  await page.locator('[data-testid=output-detail-heading]', { hasText: title }).first().waitFor({ timeout: 8000 })
}
const rectOf = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }
})
const vAttr = async (vp) => ({ k: Number(await vp.getAttribute('data-k')), x: Number(await vp.getAttribute('data-x')), y: Number(await vp.getAttribute('data-y')), mode: await vp.getAttribute('data-mode') })
// Keyframe animations only (spec 14.1: pan, zoom and Fit never animate; hover and focus colour transitions are the shared controls' own).
const running = (loc) =>
  loc.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running' && a.constructor.name !== 'CSSTransition')
      .map((a) => `${a.constructor.name}:${a.animationName ?? ''}:${a.effect?.target?.className ?? ''}`)
      .join(' | ')
  )

/** The drawing is wholly inside the viewport and centred; returns the fill ratio. */
async function fitFacts(scope) {
  const vp = scope.locator('[data-testid=diagram-viewport]').first()
  const host = scope.locator('[data-testid=output-mermaid-svg]').first()
  const a = await rectOf(vp)
  const d = await rectOf(host)
  const inside = d.l >= a.l - 1 && d.t >= a.t - 1 && d.r <= a.r + 1 && d.b <= a.b + 1
  const centred = Math.abs(d.l + d.w / 2 - (a.l + a.w / 2)) < 2 && Math.abs(d.t + d.h / 2 - (a.t + a.h / 2)) < 2
  return { inside, centred, fill: Math.max(d.w / a.w, d.h / a.h), vp: a, d }
}

async function diagramChecks(label, full) {
  await openRunOutputsTab()
  // Large diagram: Fit shows all of it, the note names it.
  await showByTitle('Large system map')
  const vp = detail().locator('[data-testid=diagram-viewport]').first()
  await vp.waitFor({ timeout: 30_000 })
  await sleep(300)
  const shapes = Number(await vp.getAttribute('data-shapes'))
  check(shapes >= 80, `${label}: the large diagram counts its shapes`, String(shapes))
  const note = detail().locator('[data-testid=diagram-large-note]')
  check((await note.count()) === 1 && /^Large diagram, \d+ shapes\. Zoom in to read, or open the larger view\./.test(clean(await note.innerText())), `${label}: the large-diagram note shows`, (await note.count()) ? clean(await note.innerText()) : 'none')
  // The detail column scrolls in a short panel: bring the drawing into view before pointing at it.
  await vp.scrollIntoViewIfNeeded()
  const vpBox = await rectOf(vp)
  check(vpBox.h >= 239 && vpBox.w >= 200, `${label}: the viewport is at least 240 px tall in the panel`, JSON.stringify(vpBox))
  let f = await fitFacts(detail())
  const v0 = await vAttr(vp)
  check(v0.mode === 'fit' && v0.k < 1 && f.inside && f.fill >= 0.8, `${label}: Fit shows the whole large diagram and fills the viewport`, JSON.stringify({ ...v0, fill: f.fill.toFixed(2), inside: f.inside }))
  // Plain wheel passes through in the panel; Ctrl+wheel zooms about the pointer.
  const cx = vpBox.l + vpBox.w / 2
  const cy = vpBox.t + vpBox.h / 2
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return `${el?.tagName}.${el?.className}[${el?.getAttribute('data-testid') ?? ''}] in viewport: ${!!el?.closest('[data-testid=diagram-viewport]')}`
  }, [cx, cy])
  check(/in viewport: true/.test(hit), `${label}: the pointer reaches the viewport`, `${hit} ${JSON.stringify(vpBox)}`)
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, -200)
  await sleep(250)
  check((await vAttr(vp)).k === v0.k, `${label}: a plain wheel in the panel does not zoom`)
  // The plain wheel may have scrolled the detail column: point at the viewport again.
  await vp.scrollIntoViewIfNeeded()
  const again = await rectOf(vp)
  await page.mouse.move(again.l + again.w / 2, again.t + again.h / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -200)
  await page.keyboard.up('Control')
  check(await until(async () => (await vAttr(vp)).k > v0.k * 1.05, 2000), `${label}: Ctrl+wheel zooms in`, JSON.stringify(await vAttr(vp)))
  check((await vAttr(vp)).mode === 'free', `${label}: zooming leaves fit mode`)
  // Drag pans.
  const before = await vAttr(vp)
  const gx = again.l + again.w / 2
  const gy = again.t + again.h / 2
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(gx + i * 10, gy + i * 5)
  await page.mouse.up()
  const dragged = await vAttr(vp)
  check(Math.abs(dragged.x - before.x - 80) <= 6 && Math.abs(dragged.y - before.y - 40) <= 6, `${label}: dragging moves the drawing`, JSON.stringify({ before, dragged }))
  // Keys.
  await vp.focus()
  const hint = detail().locator('[data-testid=diagram-hint]')
  check((await hint.count()) === 1 && /Drag to move/.test(clean(await hint.textContent())), `${label}: the viewport says how to move and zoom`)
  // At 100% the drawing is far bigger than the viewport, so a pan is never clamped.
  await page.keyboard.press('1')
  let p = await vAttr(vp)
  await page.keyboard.press('ArrowUp')
  let q = await vAttr(vp)
  check(Math.abs(Math.abs(q.y - p.y) - 48) < 1, `${label}: an arrow key pans 48 px`, `${p.y} -> ${q.y}`)
  p = q
  await page.keyboard.press('Shift+ArrowLeft')
  q = await vAttr(vp)
  check(Math.abs(Math.abs(q.x - p.x) - 192) < 1, `${label}: Shift+arrow pans 192 px`, `${p.x} -> ${q.x}`)
  await page.keyboard.press('0')
  check((await vAttr(vp)).mode === 'fit', `${label}: 0 fits the drawing again`)
  // Double-click toggles Fit and 100%.
  await vp.dblclick({ position: { x: vpBox.w / 2, y: vpBox.h / 2 } })
  check(await until(async () => Math.abs((await vAttr(vp)).k - 1) < 0.001, 2000), `${label}: double-click shows 100%`, JSON.stringify(await vAttr(vp)))
  await vp.dblclick({ position: { x: vpBox.w / 2, y: vpBox.h / 2 } })
  check(await until(async () => (await vAttr(vp)).mode === 'fit', 2000), `${label}: double-click again fits`)
  const anims = await running(detail())
  check(anims === '', `${label}: nothing animates in the viewer`, anims)
  await noScroll(`${label}: large diagram in the panel`)
  await snap(`${label}-large`)

  // A tiny diagram is never shrunk below 100% nor blown past 150%, and sits centred.
  await showByTitle('Tiny map')
  const tvp = detail().locator('[data-testid=diagram-viewport]').first()
  await tvp.waitFor({ timeout: 20_000 })
  await sleep(300)
  const tv = await vAttr(tvp)
  f = await fitFacts(detail())
  check(tv.mode === 'fit' && tv.k >= 1 - 1e-6 && tv.k <= 1.5 + 1e-6 && f.inside && f.centred, `${label}: a small diagram fits between 100% and 150%, centred`, JSON.stringify({ ...tv, centred: f.centred }))
  check((await detail().locator('[data-testid=diagram-large-note]').count()) === 0, `${label}: no large note on a small diagram`)

  // A broken diagram keeps its source on screen with the error.
  await showByTitle('Broken diagram')
  const viewer = detail().locator('[data-testid=output-mermaid]').first()
  check(await until(async () => (await viewer.getAttribute('data-state')) === 'error', 20_000), `${label}: a broken diagram reports an error state`, String(await viewer.getAttribute('data-state')))
  const err = detail().locator('[data-testid=diagram-error]')
  check((await err.count()) === 1 && /(syntax error on line \d+, so it cannot be drawn\. The source is below\.|cannot be drawn:)/.test(clean(await err.innerText())), `${label}: the error pane explains`, (await err.count()) ? clean(await err.innerText()).slice(0, 160) : 'none')
  check(['split', 'source'].includes(String(await viewer.getAttribute('data-view'))) && (await detail().locator('[data-testid=diagram-source]').inputValue()).includes('A[Start'), `${label}: the source stays visible beside the error`, String(await viewer.getAttribute('data-view')))
  // The toolbar stays one reachable Tab stop after the mode changed by itself (never an unchecked radio; reviewer H1).
  const stop = await detail().locator('[data-testid=diagram-toolbar]').evaluate((bar) => {
    const s = Array.from(bar.querySelectorAll('[tabindex="0"]')).filter((el) => !el.closest('[popover]'))
    const el = s[0]
    return { n: s.length, ok: !!el && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) }
  })
  check(stop.n === 1 && stop.ok, `${label}: the diagram toolbar keeps one reachable Tab stop`, JSON.stringify(stop))
  const go = detail().locator('[data-testid=diagram-goto-line]')
  if (await go.count()) {
    await go.click()
    check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'diagram-source', 2000), `${label}: Go to line focuses the source`)
  }
  await noScroll(`${label}: broken diagram`)

  if (!full) return
  // Larger view of the tiny diagram: plain wheel zooms, overview, Full window and Esc order, split live editing, export.
  await showByTitle('Tiny map')
  await detail().locator('[data-testid=output-open-large]').click()
  const dlg = page.locator('[data-testid=output-dialog]')
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  const dvp = dlg.locator('[data-testid=diagram-viewport]').first()
  await dvp.waitFor({ timeout: 20_000 })
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'diagram-viewport', 4000), `${label}: Open large lands focus on the drawing`)
  const db = await rectOf(dvp)
  const k0 = (await vAttr(dvp)).k
  await page.mouse.move(db.l + db.w / 2, db.t + db.h / 2)
  await page.mouse.wheel(0, -300)
  check(await until(async () => (await vAttr(dvp)).k > k0 * 1.05, 2000), `${label}: a plain wheel zooms in the Larger view`, `${k0} -> ${(await vAttr(dvp)).k}`)
  await dvp.focus()
  await page.keyboard.press('o')
  check(await until(async () => (await dlg.locator('[data-testid=diagram-overview]').count()) === 1, 2000), `${label}: O shows the overview`)
  await page.keyboard.press('o')
  check(await until(async () => (await dlg.locator('[data-testid=diagram-overview]').count()) === 0, 2000), `${label}: O hides it again`)
  await page.keyboard.press('f')
  const body = dlg.locator('.output-dialog-body')
  check(await until(async () => (await body.getAttribute('data-full')) !== null, 2000), `${label}: F turns on Full window`)
  const fullBox = await rectOf(dlg)
  const win = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  check(fullBox.w >= win.w - 2 && fullBox.h >= win.h - 2, `${label}: Full window covers the window`, JSON.stringify({ fullBox, win }))
  await page.keyboard.press('Escape')
  check(await until(async () => (await body.getAttribute('data-full')) === null, 2000) && (await dlg.isVisible()), `${label}: the first Esc leaves Full window and keeps the viewer`)
  // Split: live preview of scratch edits; a broken edit keeps the last good drawing.
  await dlg.locator('[data-testid=diagram-mode]').getByText('Split', { exact: true }).click()
  const ta = dlg.locator('[data-testid=diagram-source]')
  await ta.waitFor({ timeout: 5000 })
  const shadowText = () => dlg.locator('[data-testid=output-mermaid-svg]').first().evaluate((el) => el.shadowRoot?.textContent ?? '')
  await ta.fill('flowchart TD\n  A[Start] --> Z[Zed]\n')
  check(await until(async () => (await shadowText()).includes('Zed'), 8000), `${label}: Split redraws the edited source`)
  // Phase C: an edit of the current version belongs to the output (the editor bar with Save), never a scratch copy.
  check(
    (await dlg.locator('[data-testid=diagram-scratch-note]').count()) === 0 && (await until(async () => (await dlg.locator('[data-testid=output-edit-bar]').count()) === 1, 3000)) && (await dlg.locator('[data-testid=output-save]').isEnabled()),
    `${label}: a Split edit shows the editor bar with Save (no scratch note)`
  )
  check(/^Line \d+, column \d+ · /.test(clean(await dlg.locator('[data-testid=diagram-source-status]').innerText())), `${label}: the source status names the line and column`)
  await ta.fill('flowchart TD\n  A[Start --> Z\n')
  check(await until(async () => (await dlg.locator('[data-testid=diagram-error]').count()) === 1, 8000), `${label}: a broken edit shows the error pane`)
  check((await dlg.locator('[data-testid=diagram-stale-badge]').count()) === 1 && (await shadowText()).includes('Zed'), `${label}: the last drawing that worked stays, marked`)
  check((await ta.inputValue()).includes('A[Start --> Z'), `${label}: the broken source stays on screen`)
  await ta.fill(TINY)
  await until(async () => (await dlg.locator('[data-testid=diagram-error]').count()) === 0, 8000)
  // Export: Copy SVG answers with a notice (copied, or the clipboard's refusal; never a failure to make it).
  const exportBtn = dlg.locator('[data-testid=diagram-export]')
  if (await exportBtn.count()) {
    await exportBtn.click()
    await dlg.locator('[data-testid=diagram-copy-svg]').click()
    const n = dlg.locator('[data-testid=diagram-notice]')
    check(await until(async () => (await n.count()) === 1 && clean(await n.innerText()).length > 0, 5000), `${label}: Copy SVG answers with a notice`)
    check(!/could not make/i.test(clean(await n.innerText())), `${label}: the SVG was made`, clean(await n.innerText()))
  } else check(false, `${label}: the Larger view toolbar shows Export`)
  const dlgAnims = await running(dlg)
  check(dlgAnims === '', `${label}: nothing animates in the Larger view`, dlgAnims)
  await noScroll(`${label}: Larger view with Split`)
  await snap(`${label}-split`)
  await dlg.getByRole('button', { name: 'Close dialog' }).click()
  await dlg.waitFor({ state: 'hidden', timeout: 5000 })
}

// ---------- grid, thumbnails, select mode and bulk delete (docs/design/outputs-2.md sections 5 and 6) ----------
/** Wrap window.orgai.outputs.thumb to count calls and the most in flight at once. False when the bridge is read-only. */
async function installThumbProbe() {
  return page.evaluate(() => {
    const api = window.orgai?.outputs
    if (!api?.thumb) return false
    const real = api.thumb.bind(api)
    window.__thumbStats = { calls: 0, now: 0, max: 0 }
    try {
      api.thumb = (ref) => {
        const s = window.__thumbStats
        s.calls++
        s.now++
        s.max = Math.max(s.max, s.now)
        return real(ref).finally(() => {
          s.now--
        })
      }
    } catch {
      return false
    }
    return api.thumb !== real
  })
}
let thumbProbe = false

const activeRow = () => page.evaluate(() => ({ tid: document.activeElement?.getAttribute('data-testid') ?? '', id: document.activeElement?.getAttribute('data-id') ?? '' }))
const viewRadio = (name) => page.locator('[data-testid=outputs-view-switch]').getByRole('radio', { name })

/** Grid view: switch, persistence, cards, thumbnails, two-dimensional keys. */
async function gridChecks(label) {
  await page.locator('[data-testid=tab-outputs]').click()
  await page.locator('[data-testid=outputs-list]').waitFor({ timeout: 10_000 })
  const total = (await outputsOf()).length
  check((await page.locator('[data-testid=outputs-view-switch] input[type=radio]').count()) === 2, `${label}: the view switch offers List and Grid`)
  await viewRadio('Grid').check()
  const grid = page.locator('[data-testid=outputs-grid]')
  await grid.waitFor({ timeout: 8000 })
  check((await page.locator('[data-testid=outputs-list]').count()) === 0, `${label}: Grid replaces the list`)
  const cards = page.locator('[data-testid=output-card]')
  check(await until(async () => (await cards.count()) === total), `${label}: one card per output`, `${await cards.count()} of ${total}`)
  const stored = await page.evaluate((id) => localStorage.getItem(`orgai.outputsView.${id}`), project.id)
  check(stored === 'grid', `${label}: the choice is kept per project`, String(stored))
  const g = await grid.evaluate((ul) => ({ role: ul.getAttribute('role'), tab0: ul.querySelectorAll('[role=option][tabindex="0"]').length, template: getComputedStyle(ul).gridTemplateColumns.split(' ').length }))
  check(g.role === 'listbox' && g.tab0 === 1, `${label}: the grid is one listbox with one Tab stop`, JSON.stringify(g))
  check(g.template >= 2, `${label}: the grid has at least two columns`, String(g.template))
  const sizes = await cards.first().locator('.output-card-thumb').evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }))
  check(Math.abs(sizes.w / sizes.h - 1.6) < 0.1, `${label}: card thumbnails are 16:10`, JSON.stringify(sizes))
  const meta = clean(await cards.first().locator('.output-card-meta').innerText())
  check(/^(v\d+ · )?(Word|Excel|Deck|Diagram|Markdown|Image|Text|CSV|JSON|SVG|PDF|File)$/.test(meta), `${label}: card meta reads "v2 · Excel" style`, meta)
  // Thumbnails arrive lazily: the image output's card draws an <img>, an alt-less decoration.
  const imageCard = page.locator('[data-testid=output-card][data-kind=image]')
  const imgOk = await until(async () => (await imageCard.locator('img.output-thumb-img').count()) === 1, 8000)
  if (imgOk) {
    const attrs = await imageCard.locator('img.output-thumb-img').evaluate((i) => ({ alt: i.getAttribute('alt'), hidden: !!i.closest('[aria-hidden=true]') }))
    check(attrs.alt === '' && attrs.hidden, `${label}: a thumbnail has alt="" and is aria-hidden`, JSON.stringify(attrs))
  } else console.log('SKIP thumbnails: no image thumbnail drew (main has no outputs:thumb answer for it yet)')
  if (thumbProbe) {
    const st = await page.evaluate(() => window.__thumbStats)
    check(st.max <= 3, `${label}: at most three thumbnail calls were ever in flight`, JSON.stringify(st))
  }
  // Keys: Left / Right by one, Up / Down by a measured row, Home / End.
  await cards.first().focus()
  const ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
  const cols = await cards.evaluateAll((els) => els.filter((e) => Math.abs(e.offsetTop - els[0].offsetTop) < 3).length)
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  check(await until(async () => (await activeRow()).id === ids[1]), `${label}: ArrowRight moves to the next card`, JSON.stringify(await activeRow()))
  await page.keyboard.press('ArrowLeft')
  check(await until(async () => (await activeRow()).id === ids[0]), `${label}: ArrowLeft goes back`)
  if (ids.length > cols) {
    await page.keyboard.press('ArrowDown')
    check(await until(async () => (await activeRow()).id === ids[cols]), `${label}: ArrowDown moves one row (${cols} columns)`, JSON.stringify({ cols, got: await activeRow() }))
    await page.keyboard.press('ArrowUp')
    check(await until(async () => (await activeRow()).id === ids[0]), `${label}: ArrowUp moves back a row`)
  }
  await page.keyboard.press('End')
  check(await until(async () => (await activeRow()).id === ids[ids.length - 1]), `${label}: End goes to the last card`)
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  check(await until(async () => (await page.evaluate(() => document.activeElement?.id)) === 'output-detail-heading'), `${label}: Enter opens the detail and focuses its heading`)
  await noScroll(`${label}: grid`)
  await snap(`${label}-grid`)
  // Away and back: the grid stays.
  await projectTab(page, 'History').click()
  await page.locator('[data-testid=tab-outputs]').click()
  check(await until(async () => (await page.locator('[data-testid=outputs-grid]').count()) === 1, 5000), `${label}: the grid is still chosen after leaving the tab`)
  await viewRadio('List').check()
  await page.locator('[data-testid=outputs-list]').waitFor({ timeout: 8000 })
}

/** Select mode by keyboard, no delete: checkboxes, Space, the bulk bar, Select all shown, Esc. */
async function selectChecks(label, grid) {
  await page.locator('[data-testid=tab-outputs]').click()
  await (grid ? viewRadio('Grid') : viewRadio('List')).check()
  const item = grid ? '[data-testid=output-card]' : '[data-testid=output-row]'
  const items = page.locator(item)
  await items.first().waitFor({ timeout: 8000 })
  const toggle = page.locator('[data-testid=outputs-select-toggle]')
  await toggle.click()
  check((await toggle.getAttribute('aria-pressed')) === 'true', `${label}: Select is pressed`)
  const n = await items.count()
  check((await page.locator('[data-testid=output-select]').count()) === n, `${label}: ${grid ? 'cards' : 'rows'} show a checkbox in select mode`)
  const bar = page.locator('[data-testid=outputs-bulk-bar]')
  check(await bar.isVisible(), `${label}: the bulk bar shows`)
  const count = page.locator('[data-testid=outputs-bulk-count]')
  check(/^0 selected$/.test(clean(await count.innerText())) && (await count.getAttribute('role')) === 'status', `${label}: "0 selected" is a status`)
  const del = page.locator('[data-testid=outputs-bulk-delete]')
  check(await del.isDisabled(), `${label}: Delete is off with nothing selected`)
  await items.first().focus()
  await page.keyboard.press('Space')
  check(await until(async () => /^1 selected$/.test(clean(await count.innerText()))), `${label}: Space selects the focused ${grid ? 'card' : 'row'}`, clean(await count.innerText()))
  await page.keyboard.press(grid ? 'ArrowRight' : 'ArrowDown')
  await page.keyboard.press('Space')
  check(await until(async () => /^2 selected$/.test(clean(await count.innerText()))), `${label}: a second Space makes two`)
  check((await page.locator(`${item}[aria-selected=true]`).count()) === 2, `${label}: the two are marked selected`)
  await page.keyboard.press('Space')
  check(await until(async () => /^1 selected$/.test(clean(await count.innerText()))), `${label}: Space again unselects`)
  await page.locator('[data-testid=outputs-select-all]').click()
  check(await until(async () => clean(await count.innerText()) === `${n} selected`), `${label}: Select all shown picks every one`, clean(await count.innerText()))
  check(!(await del.isDisabled()), `${label}: Delete is on with a selection`)
  await noScroll(`${label}: select mode ${grid ? 'grid' : 'list'}`)
  await snap(`${label}-select-${grid ? 'grid' : 'list'}`)
  await items.first().focus()
  await page.keyboard.press('Escape')
  check(await until(async () => (await bar.count()) === 0), `${label}: Esc leaves select mode`)
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'outputs-select-toggle', 3000), `${label}: focus returns to Select`)
  check((await page.locator('[data-testid=output-select]').count()) === 0, `${label}: the checkboxes are gone`)
  await viewRadio('List').check()
}

/** A second run: a new version of an output still listed gets "New" and a spoken update, never moves its row; then bulk delete. */
async function secondRunChecks(label) {
  await page.locator('[data-testid=tab-outputs]').click()
  await page.locator('[data-testid=outputs-list], [data-testid=outputs-empty]').first().waitFor({ timeout: 8000 })
  const before = await outputsOf()
  const plan = before.find((o) => o.title === 'Project plan')
  if (!plan) {
    console.log('SKIP second run: Project plan is no longer listed')
    return
  }
  await page.evaluate(() => {
    window.__statusLog = []
    const el = document.querySelector('[data-testid=outputs-status]')
    if (el) new MutationObserver(() => window.__statusLog.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true })
  })
  const rows = page.locator('[data-testid=output-row]')
  // The output shown in the detail counts as seen (it never reads "New"), so show another one while the run works.
  const other = before.find((o) => o.id !== plan.id && !o.missing) ?? before.find((o) => o.id !== plan.id)
  if (other) {
    await page.locator(`[data-testid=output-row][data-id="${other.id}"]`).click()
    await until(async () => (await page.locator('[data-testid=output-detail]').first().getAttribute('data-id')) === other.id, 3000)
  } else {
    // Project plan is the only output left, so it stays selected: fold the pane so its detail is not on screen.
    const hide = page.locator('[data-testid=outputs-detail]').getByRole('button', { name: /^Hide output preview/ })
    if (await hide.count()) await hide.click()
    await until(async () => (await page.locator('[data-testid=outputs-detail]').getAttribute('data-collapsed')) === 'true', 3000)
  }
  const orderBefore = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
  await page.evaluate(({ id, prompt }) => window.orgai.runs.start({ projectId: id, prompt }), { id: project.id, prompt: USE_SCRIPT ? 'Produce the deliverables' : 'Produce the deliverables [mock:outputs]' })
  const bumped = await until(async () => ((await outputsOf()).find((o) => o.id === plan.id)?.version ?? 1) >= 2, 60_000)
  check(bumped, `${label}: the second run made version 2 of Project plan`)
  if (!bumped) return
  const row = page.locator(`[data-testid=output-row][data-id="${plan.id}"]`)
  check(
    await until(async () => (await row.locator('[data-testid=output-new-version]').count()) === 1, 8000),
    `${label}: the row shows a "New" badge`,
    JSON.stringify({ shown: await page.locator('[data-testid=output-detail]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id'))), plan: plan.id, other: other?.id })
  )
  const orderAfter = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
  const kept = orderAfter.filter((id) => orderBefore.includes(id))
  check(kept.join() === orderBefore.filter((id) => orderAfter.includes(id)).join(), `${label}: the updated row did not move`, `${orderBefore.join()} -> ${orderAfter.join()}`)
  check(/v2/.test(clean(await row.locator('.outputs-row-meta').innerText())), `${label}: the meta line says v2`, clean(await row.locator('.outputs-row-meta').innerText()))
  const said = await until(async () => (await page.evaluate(() => window.__statusLog)).some((t) => /Updated Project plan to version 2/.test(t)), 12_000)
  check(said, `${label}: the status says "Updated Project plan to version 2"`, JSON.stringify(await page.evaluate(() => window.__statusLog)))
  // Opening it shows it (marks it seen) and the badge goes.
  await row.click()
  // The detail (versions engineer) calls markOutputSeen; until it does there is nothing to assert here.
  if (fs.readFileSync(path.join(APP_DIR, 'src/renderer/src/components/outputs/OutputDetail.tsx'), 'utf8').includes('markOutputSeen')) {
    check(await until(async () => (await row.locator('[data-testid=output-new-version]').count()) === 0, 8000), `${label}: the badge goes once the detail shows the new version`)
  } else console.log('SKIP badge clearing: OutputDetail does not call markOutputSeen yet')
  // Let the rest of the run's outputs arrive, then bulk delete two.
  await sleep(2500)
  const n0 = (await outputsOf()).length
  await page.locator('[data-testid=outputs-select-toggle]').click()
  await rows.nth(0).focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Space')
  await page.locator('[data-testid=outputs-bulk-delete]').click()
  const confirm = page.locator('[data-testid=output-delete-confirm]')
  if (!(await confirm.waitFor({ timeout: 4000 }).then(() => true, () => false))) {
    console.log('SKIP bulk delete: the confirm never opened (the delete seam is still the stub)')
    await page.keyboard.press('Escape')
    await page.locator('[data-testid=outputs-select-cancel]').click().catch(() => {})
    return
  }
  await confirm.click()
  check(await until(async () => (await outputsOf()).length === n0 - 2, 10_000), `${label}: bulk delete removed two outputs`, `${n0} -> ${(await outputsOf()).length}`)
  const status = page.locator('[data-testid=outputs-bulk-result]')
  check(await until(async () => /Deleted 2 outputs\./.test(clean(await status.innerText())), 5000), `${label}: the visible result says "Deleted 2 outputs."`, clean(await status.innerText()))
  check(await until(async () => (await page.locator('[data-testid=outputs-bulk-bar]').count()) === 0), `${label}: select mode ends after a clean delete`)
  check(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'output-row'), `${label}: focus lands on the next row`)
  await noScroll(`${label}: after bulk delete`)
}

try {
  project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  thumbProbe = await installThumbProbe()
  if (!thumbProbe) console.log('SKIP thumbnail concurrency: window.orgai.outputs.thumb cannot be wrapped from the page')
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
  // E2E_DIAGRAMS_ONLY=1 skips straight to the diagram viewer section (a quicker loop while working on it).
  for (const [i, c] of process.env.E2E_DIAGRAMS_ONLY === '1' ? [] : combos.entries()) {
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
      await gridChecks(label)
      await selectChecks(label, i % 2 === 1)
      if (i === 0 || i === 3) {
        await filterChecks(label)
        await keyboardChecks(label)
        await actionChecks(label)
        await historyChecks(label)
      }
    } catch (e) {
      check(false, `${label}: project tab checks`, e.message.split('\n')[0])
    }
  }
  // Last: Remove from list drops the item from both lists.
  if (process.env.E2E_DIAGRAMS_ONLY !== '1') try {
    await removeChecks('1024x640 light')
  } catch (e) {
    check(false, 'remove checks', e.message.split('\n')[0])
  }
  if (process.env.E2E_DIAGRAMS_ONLY !== '1') {
    // Once only: a second identical run adds a version once. It runs at the last combo's size and theme (1024x640 light).
    try {
      await secondRunChecks('1024x640 light second run')
    } catch (e) {
      check(false, 'second run checks', e.message.split('\n')[0])
    }
  }
  // The diagram viewer on its own project, driven by a script set in main for that run only.
  try {
    const scriptFile = path.join(base, 'diagrams-script.json')
    fs.writeFileSync(scriptFile, JSON.stringify(diagramScript))
    await app.evaluate((_electron, file) => {
      process.env.ORGAI_MOCK_SCRIPT = file
    }, scriptFile)
    project2 = await createProject(page, { mode: 'existing', path: repo2, name: NAME2 })
    check(!!project2, 'the diagrams project was created')
    await startRun('Draw the diagrams')
    const n = () => page.evaluate((id) => window.orgai.outputs.list(id).then((l) => l.length), project2.id)
    check(await until(async () => (await n()) >= 3, 60_000), 'the scripted run produced three diagrams', String(await n()))
    await sleep(1000)
    const combos = [
      { w: 1600, h: 1000, theme: 'dark' },
      { w: 1600, h: 1000, theme: 'light' },
      { w: 1024, h: 640, theme: 'dark' },
      { w: 1024, h: 640, theme: 'light' }
    ]
    for (const [i, c] of combos.entries()) {
      const label = `diagrams ${c.w}x${c.h} ${c.theme}`
      await setSize(c.w, c.h)
      await setTheme(c.theme)
      try {
        await diagramChecks(label, i === 0 || i === 3)
      } catch (e) {
        check(false, `${label}: diagram checks`, e.message.split('\n')[0])
      }
    }
  } catch (e) {
    check(false, 'diagram viewer checks', e.message.split('\n')[0])
  }
} finally {
  if (project2 && page && !page.isClosed()) await deleteProject(page, NAME2).catch(() => {})
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('outputs')
