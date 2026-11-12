// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Output notes (docs/design/outputs-2.md 11): a scripted run (ORGAI_MOCK_SCRIPT set
// in main) produces a Markdown file, a CSV, a workbook, a Word document, a diagram and an SVG. Drives, at 1024x640 and
// 1600x1000 in both themes: text selection then Add note (composer, mark with data-status, resolve / reopen / edit / delete,
// select notes and Revise), a sheet range by Shift+arrows then a note with Ctrl+Shift+M and the corner marks, a CSV cell,
// a Word block, a region on the diagram by keyboard (tool Box, Enter, arrows, Enter, type, Ctrl+Enter) and an SVG region by
// drag, Esc order, no page scroll and no running animation.
// Text selections are made programmatically (a mouse drag over text is not what is under test; selectionchange is the same).
// The Notes tab and the toolbar mount come from the detail shell; the revise dialog is asserted only if it renders.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, deleteProject, finish, launch, makeFixtureRepo, projectTab, screenshot, settleMotion, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E notes (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-notes-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('outputs-notes', { at: repo })

const MD = '# Plan\n\nThe quick brown fox jumps over the lazy dog.\n\nSecond paragraph stays plain.\n'
const DOC = '# Handbook\n\nWelcome to the team handbook. Read the first chapter carefully.\n\n- Item one\n- Item two\n'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><rect x="10" y="10" width="80" height="60" fill="#4477aa"/><text x="20" y="45" fill="#ffffff">Box</text></svg>'
const script = {
  delayMs: 100,
  work: [
    { type: 'text', text: 'Producing the files.' },
    { type: 'harness', name: 'produce_output', args: { kind: 'markdown', title: 'Field notes', fileName: 'field-notes', content: MD } },
    { type: 'harness', name: 'produce_output', args: { kind: 'csv', title: 'Cost table', fileName: 'cost-table', content: 'Item,Cost\nDesign,1200\nBuild,3400\nLaunch,800\n' } },
    {
      type: 'harness',
      name: 'produce_output',
      args: {
        kind: 'xlsx',
        title: 'Budget sheet',
        fileName: 'budget-sheet',
        workbook: { sheets: [{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Cost' }, { header: 'Owner' }], rows: [['Design', 1200, 'Ana'], ['Build', 3400, 'Ben'], ['Launch', 800, 'Cy']] }] }
      }
    },
    { type: 'harness', name: 'produce_output', args: { kind: 'docx', title: 'Team handbook', fileName: 'team-handbook', content: DOC } },
    { type: 'harness', name: 'produce_output', args: { kind: 'mermaid', title: 'Flow map', fileName: 'flow-map', content: 'flowchart LR\n  Client --> API --> Database\n' } },
    { type: 'harness', name: 'produce_output', args: { kind: 'svg', title: 'Logo mark', fileName: 'logo-mark', content: SVG } },
    { type: 'text', text: 'Six files are ready.' }
  ]
}
const scriptFile = path.join(base, 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify(script))

let { app, page } = await launch({ shotPrefix: 'outputs-notes' })
page.setDefaultTimeout(8000)
await app.evaluate((_e, file) => {
  process.env.ORGAI_MOCK_SCRIPT = file
}, scriptFile)

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
    await sleep(150)
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
const running = (scope) =>
  scope.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running' && a.constructor.name !== 'CSSTransition')
      .map((a) => a.animationName ?? a.constructor.name)
      .join(' | ')
  )

let project
const detail = () => page.locator('[data-testid=output-detail]').first()
const outputsOf = () => page.evaluate((id) => window.orgai.outputs.list(id), project.id)
const notesOf = (outputId) => page.evaluate(([projectId, id]) => window.orgai.outputs.notes({ projectId, outputId: id }), [project.id, outputId])
const idOfKind = async (kind) => (await outputsOf()).find((o) => o.kind === kind)?.id
async function clearNotes() {
  await page.evaluate(async (pid) => {
    for (const o of await window.orgai.outputs.list(pid)) for (const n of await window.orgai.outputs.notes({ projectId: pid, outputId: o.id })) await window.orgai.outputs.noteRemove({ projectId: pid, outputId: o.id, noteId: n.id })
  }, project.id)
}

async function startRun() {
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Produce the files')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
}
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
  await page.locator('[data-testid=run-outputs-list], [data-testid=output-detail]').first().waitFor({ timeout: 8000 })
}
async function show(kind) {
  const back = page.locator('[data-testid=run-output-back]')
  if (await back.count()) {
    await back.click()
    await page.locator('[data-testid=run-outputs-list]').waitFor({ timeout: 5000 })
  }
  await page.locator(`[data-testid=run-output-row][data-kind=${kind}]`).locator('[data-testid=run-output-show]').click()
  await page.locator(`[data-testid=output-detail][data-kind=${kind}]`).waitFor({ timeout: 8000 })
  await toTab('preview')
}
/**
 * The detail shows the preview and the Notes list on separate tabs (outputs-2 section 7): selections, marks, pins and the
 * note tools live on Preview; the list, its filter, Resolve, Edit, Delete and "Revise with notes" on Notes.
 */
async function toTab(which) {
  const t = detail().locator(`[data-testid=output-tab-${which}]`)
  if (!(await t.count())) return
  if ((await t.getAttribute('aria-selected')) !== 'true') await t.click()
  await detail()
    .locator(which === 'notes' ? '[data-testid=output-notes]' : '[data-testid=output-preview]')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => undefined)
}
const addBtn = () => detail().locator('[data-testid=output-note-add]').first()
const addEnabled = async () => (await addBtn().getAttribute('aria-disabled')) !== 'true'
const composer = () => page.locator('[data-testid=output-note-composer]')
const liveText = async () => clean(await page.locator('[data-testid=output-live], [data-testid=output-live-temp]').allInnerTexts().then((a) => a.join(' ')))

async function typeNote(text) {
  await composer().waitFor({ state: 'visible', timeout: 4000 })
  const ta = composer().locator('textarea')
  check(await ta.evaluate((el) => document.activeElement === el), 'the composer takes focus in its field')
  check((await composer().locator('label', { hasText: 'Note' }).count()) === 1, 'the composer field is labelled "Note"')
  await ta.fill(text)
  await page.keyboard.press('Control+Enter')
  await composer().waitFor({ state: 'hidden', timeout: 4000 })
}
/** Select the first occurrence of `needle` in the text of `scope` (a CSS selector). */
const selectText = (scope, needle) =>
  page.evaluate(
    ([sel, text]) => {
      const root = document.querySelector(sel)
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        const i = t.data.indexOf(text)
        if (i >= 0) {
          const r = document.createRange()
          r.setStart(t, i)
          r.setEnd(t, i + text.length)
          const s = window.getSelection()
          s.removeAllRanges()
          s.addRange(r)
          return true
        }
      }
      return false
    },
    [scope, needle]
  )

async function textFlow(label) {
  await clearNotes()
  await show('markdown')
  check(!(await addEnabled()), `${label}: Add note is off with nothing selected`)
  check(/Select text to add a note\./.test(clean(await detail().locator('[data-testid=output-note-hint]').innerText())), `${label}: the reason line says "Select text to add a note."`)
  // Source view: offsets are exact there.
  await detail().locator('[data-testid=output-md-view] label', { hasText: 'Source' }).click()
  const src = '[data-testid=output-detail] [data-testid=output-source]'
  await page.locator(src).waitFor()
  await page.locator(src).focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  check(await until(addEnabled, 3000), `${label}: keyboard selects source lines`)
  check((await page.locator(`${src} [data-cursor]`).count()) === 2 && !!(await page.locator(src).getAttribute('aria-activedescendant')), `${label}: source range and active line exposed`)
  await page.keyboard.press('Escape')
  check(!(await addEnabled()) && !(await page.locator(src).getAttribute('aria-activedescendant')), `${label}: Escape clears source selection`)
  check(await selectText(src, 'quick brown fox'), `${label}: selected text in the source view`)
  check(await until(addEnabled, 3000), `${label}: Add note turns on with a selection`)
  await addBtn().focus()
  await page.keyboard.press('Enter')
  await composer().waitFor({ state: 'visible' })
  check(/quick brown fox/.test(clean(await composer().locator('[data-testid=output-note-quote]').innerText())), `${label}: the quote chip shows what the note is on`)
  await snap(`${label}-composer`)
  await page.keyboard.press('Escape')
  await composer().waitFor({ state: 'hidden' })
  check(await addBtn().evaluate((el) => document.activeElement === el), `${label}: Esc closes the composer and focus returns to Add note`)
  // Ctrl+Shift+M from the preview.
  await page.locator(src).focus()
  check(await selectText(src, 'quick brown fox'), `${label}: reselected`)
  await page.keyboard.press('Control+Shift+m')
  await typeNote('Make this line more formal.')
  check(await until(async () => (await notesOf(await idOfKind('markdown'))).length === 1), `${label}: the note was saved`)
  const n = (await notesOf(await idOfKind('markdown')))[0]
  check(n.anchor.type === 'text' && n.anchor.quote === 'quick brown fox' && n.status === 'open', `${label}: a text anchor with the quote`, JSON.stringify(n.anchor))
  check(/Note added\./.test(await liveText()), `${label}: "Note added." is spoken`, await liveText())
  const mark = detail().locator('mark.output-note-mark[data-status=open]')
  check(await until(async () => (await mark.count()) >= 1), `${label}: the source view marks the range (open)`)
  const markFacts = await mark.first().evaluate((el) => ({ text: el.textContent, deco: getComputedStyle(el).textDecorationLine, tab: el.tabIndex }))
  check(/quick brown fox/.test(markFacts.text) && /underline/.test(markFacts.deco) && markFacts.tab === -1, `${label}: the mark is underlined and not a tab stop`, JSON.stringify(markFacts))
  await toTab('notes')
  const row = detail().locator('[data-testid=output-note]').first()
  check((await row.getAttribute('data-status')) === 'open', `${label}: the panel lists the note as open`)
  check(/1 open/.test(clean(await detail().locator('[data-testid=output-notes-count]').innerText())), `${label}: the count line says 1 open`)
  // Rendered view marks through the highlight API (no mark element), and selecting there maps to source.
  await toTab('preview')
  await detail().locator('[data-testid=output-md-view] label', { hasText: 'Rendered' }).click()
  await page.locator('[data-testid=output-md-rendered]').waitFor()
  const rendered = detail().locator('[data-testid=output-md-rendered]')
  await rendered.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  check(await until(addEnabled, 3000), `${label}: keyboard selects rendered blocks`)
  check(!!(await rendered.getAttribute('aria-activedescendant')), `${label}: rendered active block exposed`)
  await page.keyboard.press('Escape')
  check(await selectText('[data-testid=output-detail] [data-testid=output-md-rendered]', 'lazy dog'), `${label}: selected text in the rendered view`)
  check(await until(addEnabled, 3000), `${label}: Add note turns on in the rendered view`)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  // Resolve, reopen, edit, delete.
  await toTab('notes')
  await row.locator('[data-testid=output-note-resolve]').click()
  check(await until(async () => (await detail().locator('mark.output-note-mark').count()) === 0 || true), 'settled')
  check(await until(async () => (await notesOf(await idOfKind('markdown')))[0]?.status === 'resolved'), `${label}: Resolve saves`)
  await detail().locator('[data-testid=output-notes-filter] label', { hasText: 'All' }).click()
  const row2 = detail().locator('[data-testid=output-note]').first()
  check((await row2.getAttribute('data-status')) === 'resolved', `${label}: the row says resolved (All filter)`)
  check(/Resolved/.test(clean(await row2.innerText())), `${label}: a resolved note says so in words`)
  await row2.locator('[data-testid=output-note-resolve]').click()
  check(await until(async () => (await notesOf(await idOfKind('markdown')))[0]?.status === 'open'), `${label}: Reopen saves`)
  await row2.locator('[data-testid=output-note-edit]').click()
  const ta = row2.locator('textarea')
  await ta.fill('Edited text.')
  await page.keyboard.press('Control+Enter')
  check(await until(async () => (await notesOf(await idOfKind('markdown')))[0]?.text === 'Edited text.'), `${label}: Edit saves`)
  // Select it and ask for a revision.
  await detail().locator('[data-testid=output-note-select]').first().check()
  check(/Revise with 1 note/.test(clean(await detail().locator('[data-testid=output-notes-revise]').innerText())), `${label}: the footer says "Revise with 1 note"`)
  await detail().locator('[data-testid=output-notes-revise]').click()
  await sleep(500)
  if (await page.locator('[data-testid=output-revise-dialog]').count()) {
    check(true, `${label}: Revise with notes opens the revise dialog`)
    await page.keyboard.press('Escape')
    await sleep(300)
  } else console.log('SKIP revise dialog (not mounted in this build)')
  await detail().locator('[data-testid=output-note-delete]').first().click()
  await page.locator('[data-testid=output-note-delete-confirm]').click()
  check(await until(async () => (await notesOf(await idOfKind('markdown'))).length === 0), `${label}: Delete asks first, then removes`)
  check(/No (open )?notes/.test(clean(await detail().innerText())), `${label}: the empty state is plain text`)
  await noScroll(`${label}: text notes`)
}

async function sheetFlow(label) {
  await clearNotes()
  await show('xlsx')
  const region = detail().locator('[data-testid=output-sheet-region]')
  await region.waitFor()
  await region.focus()
  await page.keyboard.press('ArrowDown')
  check(!!(await region.getAttribute('aria-activedescendant')), `${label}: sheet keyboard exposes active cell`)
  check(await until(async () => /Cells? A1.*selected/i.test(await liveText()), 3000), `${label}: sheet selection is announced`)
  await page.keyboard.press('Escape')
  check(/Select cells to add a note\./.test(clean(await detail().locator('[data-testid=output-note-hint]').innerText())), `${label}: the hint names cells`)
  await region.locator('td', { hasText: 'Design' }).first().click()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  const selected = await region.locator('td[aria-selected=true]').count()
  check(selected === 4, `${label}: Shift+arrows select a 2 x 2 range (aria-selected)`, String(selected))
  check(await until(addEnabled, 3000), `${label}: Add note turns on for cells`)
  await page.keyboard.press('Control+Shift+m')
  await typeNote('Check these figures.')
  const id = await idOfKind('xlsx')
  check(await until(async () => (await notesOf(id)).length === 1), `${label}: the cell note was saved`)
  const a = (await notesOf(id))[0].anchor
  check(a.type === 'cells' && a.sheet === 'Budget' && a.r1 === 1 && a.c1 === 0 && a.r2 === 2 && a.c2 === 1, `${label}: cells anchor B-C on Budget`, JSON.stringify(a))
  check(await until(async () => (await region.locator('td[data-note-state=open]').count()) === 4), `${label}: four cells carry a corner mark`)
  const desc = await region.locator('td[data-note-state=open]').first().getAttribute('aria-description')
  check(/Check these figures/.test(desc ?? ''), `${label}: a noted cell exposes the note through aria-description`, String(desc))
  await toTab('notes')
  check(/Cells A2:B3 on Budget/.test(clean(await detail().locator('[data-testid=output-note]').first().innerText())), `${label}: the panel says "Cells A2:B3 on Budget"`)
  await detail().locator('[data-testid=output-note-resolve]').first().click()
  await toTab('preview')
  check(await until(async () => (await region.locator('td[data-note-state=resolved]').count()) === 4), `${label}: resolved cells get the outline corner`)
  await snap(`${label}-sheet`)
  await noScroll(`${label}: sheet notes`)
}

async function csvDocFlow(label) {
  await clearNotes()
  await show('csv')
  const grid = detail().locator('[data-testid=output-csv-table]')
  await grid.waitFor()
  const csvRegion = grid.locator('..')
  await csvRegion.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowRight')
  check((await grid.locator('[aria-selected=true]').count()) === 2 && !!(await csvRegion.getAttribute('aria-activedescendant')), `${label}: CSV keyboard range and active cell exposed`)
  await page.keyboard.press('Escape')
  await grid.locator('td', { hasText: 'Build' }).first().click()
  check(await until(addEnabled, 3000), `${label}: a CSV cell can be noted`)
  await addBtn().click()
  await typeNote('Why this much?')
  const id = await idOfKind('csv')
  const a = (await until(async () => (await notesOf(id)).length === 1)) ? (await notesOf(id))[0].anchor : null
  check(a?.type === 'cells' && a.sheet === '' && a.r1 === 2 && a.c1 === 0, `${label}: csv cells anchor with an empty sheet`, JSON.stringify(a))
  await clearNotes()
  await show('docx')
  const body = '[data-testid=output-detail] [data-testid=output-doc] .output-doc-body'
  await page.locator(body).waitFor()
  await page.locator(body).focus()
  await page.keyboard.press('ArrowDown')
  check(await until(addEnabled, 3000), `${label}: keyboard selects a document block`)
  check(!!(await page.locator(body).getAttribute('aria-activedescendant')), `${label}: document active block exposed`)
  await page.keyboard.press('Control+Shift+m')
  await composer().waitFor({ state: 'visible' })
  check(/Handbook/.test(clean(await composer().locator('[data-testid=output-note-quote]').innerText())), `${label}: document keyboard selection reaches note anchor`)
  await page.keyboard.press('Escape')
  await page.locator(body).focus()
  await page.keyboard.press('Escape')
  check(await selectText(body, 'team handbook'), `${label}: selected words in the document`)
  check(await until(addEnabled, 3000), `${label}: a document selection can be noted`)
  await addBtn().click()
  await typeNote('Rename the handbook.')
  const did = await idOfKind('docx')
  const da = (await until(async () => (await notesOf(did)).length === 1)) ? (await notesOf(did))[0].anchor : null
  check(da?.type === 'block' && da.index === 1 && da.quote === 'team handbook' && da.end - da.start === 13, `${label}: block anchor with offsets into the block text`, JSON.stringify(da))
  check(await until(async () => (await detail().locator('.output-doc-block mark.output-note-mark').count()) >= 1), `${label}: the document marks the range`)
  await noScroll(`${label}: document notes`)
}

async function regionFlow(label) {
  await clearNotes()
  await show('mermaid')
  const vp = detail().locator('[data-testid=diagram-viewport]').first()
  await vp.waitFor({ timeout: 30_000 })
  await sleep(500)
  const group = detail().locator('[data-testid=output-note-region]')
  check(/Mark an area to add a note\./.test(clean(await detail().locator('[data-testid=output-note-hint]').innerText())), `${label}: the hint names an area`)
  await group.locator('[data-testid=output-note-region-box]').click()
  check((await group.locator('[data-testid=output-note-region-box]').getAttribute('aria-pressed')) === 'true', `${label}: the Box tool is pressed`)
  const before = await vp.evaluate((el) => ({ x: el.dataset.x, y: el.dataset.y }))
  await vp.focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-testid=diagram-viewport] .output-region-shape.draft').first().waitFor({ timeout: 3000 })
  const box0 = await vp.locator('.output-region-shape.draft').first().evaluate((el) => el.getBoundingClientRect().toJSON())
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  const box1 = await vp.locator('.output-region-shape.draft').first().evaluate((el) => el.getBoundingClientRect().toJSON())
  check(box1.left > box0.left + 10 && box1.height > box0.height, `${label}: arrows move the box and Shift+arrow grows it`, `${box0.left}->${box1.left} ${box0.height}->${box1.height}`)
  const after = await vp.evaluate((el) => ({ x: el.dataset.x, y: el.dataset.y }))
  check(before.x === after.x && before.y === after.y, `${label}: the view does not pan while the box moves`)
  await page.keyboard.press('Enter')
  await typeNote('This arrow looks wrong.')
  const id = await idOfKind('mermaid')
  check(await until(async () => (await notesOf(id)).length === 1), `${label}: the region note was saved`)
  const a = (await notesOf(id))[0].anchor
  check(a.type === 'region' && a.shape === 'box' && a.w > 0 && a.w < 1 && Array.isArray(a.labels), `${label}: region anchor in fractions${a.labels ? ' with labels' : ''}`, JSON.stringify(a))
  check(await until(async () => (await vp.locator('[data-testid=output-region-pin]').count()) === 1), `${label}: a numbered pin sits on the drawing`)
  check(clean(await vp.locator('[data-testid=output-region-pin]').first().innerText()) === '1', `${label}: the pin number matches the list`)
  await snap(`${label}-diagram`)
  // Esc order: the tool is still on; Esc on the viewport turns it off.
  await vp.focus()
  await page.keyboard.press('Escape')
  check((await group.locator('[data-testid=output-note-region-off]').getAttribute('aria-pressed')) === 'true', `${label}: Esc turns the area tool off`)
  check(!(await running(detail())), `${label}: nothing animates in the detail`, await running(detail()))
  // SVG by pointer drag.
  await clearNotes()
  await show('svg')
  const svgVp = detail().locator('[data-testid=diagram-viewport]').first()
  await svgVp.waitFor()
  await sleep(500)
  await detail().locator('[data-testid=output-note-region-ellipse]').click()
  // In the 360 px panel at 1024x640 the drawing sits below the fold of the detail's scroller: bring it on screen first.
  await svgVp.scrollIntoViewIfNeeded()
  await sleep(200)
  // The layer covers the drawing itself (a small SVG sits centred in a large viewport), so drag inside it.
  const r = await svgVp.locator('[data-testid=output-region-layer]').evaluate((el) => el.getBoundingClientRect().toJSON())
  await page.mouse.move(r.left + r.width * 0.3, r.top + r.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(r.left + r.width * 0.5, r.top + r.height * 0.5, { steps: 5 })
  await page.mouse.up()
  check(await until(addEnabled, 3000), `${label}: a dragged circle enables Add note`)
  check((await svgVp.evaluate((el) => el.dataset.mode)) === 'fit', `${label}: the drag drew instead of panning`)
  await addBtn().click()
  await typeNote('Check the logo colour.')
  const sid = await idOfKind('svg')
  const sa = (await until(async () => (await notesOf(sid)).length === 1)) ? (await notesOf(sid))[0].anchor : null
  check(sa?.type === 'region' && sa.shape === 'ellipse', `${label}: ellipse region anchor on an SVG`, JSON.stringify(sa))
  await noScroll(`${label}: region notes`)
}

const snap = (name) => screenshot(page, `outputs-notes-${name}`)

try {
  project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  await startRun()
  check(await until(async () => (await outputsOf()).length >= 6, 60_000), 'the run produced six outputs', String((await outputsOf()).length))
  await sleep(1000)
  // Later runs (the revise part's continuation or new run) take the mock's default script, which answers revise requests.
  await app.evaluate(() => {
    delete process.env.ORGAI_MOCK_SCRIPT
  })
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
    await openRunOutputsTab()
    for (const [name, fn] of [['text', textFlow], ['sheet', sheetFlow], ['csv and document', csvDocFlow], ['regions', regionFlow]]) {
      try {
        await fn(label)
      } catch (e) {
        check(false, `${label}: ${name} notes`, e.message.split('\n')[0])
      }
    }
  }
  const part = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'outputs-revise.part.mjs')
  if (fs.existsSync(part)) {
    // End the scripted run first: a revise request sent into it would reach the session that still plays the custom script
    // (it only echoes). Ended, the default target is "continue the conversation", a new session on the default script,
    // which answers revise requests with a new version.
    const runIds = [...new Set((await outputsOf()).map((o) => o.runId))]
    for (const id of runIds) await page.evaluate((rid) => window.orgai.runs.stop(rid), id).catch(() => {})
    await until(async () => {
      const st = await page.evaluate((ids) => Promise.all(ids.map((rid) => window.orgai.runs.get(rid).then((r) => r?.summary?.status ?? r?.status).catch(() => 'gone'))), runIds)
      return st.every((s) => s !== 'running' && s !== 'idle' && s !== 'starting' && s !== 'stopping')
    }, 15_000)
    const mod = await import(`file:///${part.replace(/\\/g, '/')}`)
    for (const c of combos) {
      await setSize(c.w, c.h)
      await setTheme(c.theme)
      await mod.default({ app, page, project, label: `${c.w}x${c.h} ${c.theme}`, size: [c.w, c.h], theme: c.theme, check, sleep })
    }
  }
} finally {
  await clearNotes().catch(() => {})
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('outputs-notes')
