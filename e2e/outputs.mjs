// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Run outputs (docs/design/outputs.md sections 3-9): a [mock:outputs]
// work run produces docx, xlsx, mermaid and markdown outputs and registers a PNG; the run side tab "Outputs" lists them,
// the transcript rows and the RunMeta chip name them, Show opens the detail with its preview, the More actions menu lists
// its items, and the project Outputs tab lists, filters and searches the same five with a keyboard path. 1024x640 and
// 1600x1000, dark and light. Open / Show in folder / Save as are native and not driven. The preview checks are skipped
// while the previews are the stub ("is not built yet").
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, finish, launch, makeFixtureRepo, openProject, projectTab, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E outputs (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-outputs-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('outputs', { at: repo })
const PROMPT = 'Produce the deliverables [mock:outputs]'

let { app, page } = await launch({ shotPrefix: 'outputs' })
page.setDefaultTimeout(8000)

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
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
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
const fitsWindow = async (what) => {
  const o = await page.evaluate(() => {
    const e = document.scrollingElement ?? document.documentElement
    return { sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }
  })
  check(o.sw <= o.cw && o.sh <= o.ch + 1, `${what}: the page does not scroll`, JSON.stringify(o))
}
const active = () =>
  page.evaluate(() => {
    const a = document.activeElement
    return { tid: a?.getAttribute('data-testid') ?? '', id: a?.id ?? '', dataId: a?.getAttribute('data-id') ?? '', inList: !!a?.closest('[data-testid=outputs-list]'), tag: a?.tagName ?? '' }
  })
const tabStatus = () => page.locator('.run-tab[aria-selected=true]').first().innerText().catch(() => '')

/** The Live tab with the root agent selected and the run side panel open (a rail at 1024x640). */
const showPanel = async () => {
  await projectTab(page, 'Live').click()
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('.react-flow__node:has(.agent-node.is-root)').first().click()
  await sleep(300)
  const railed = page.locator('aside.side-panel[data-collapsed=true]')
  if (await railed.count()) {
    await railed.getByRole('button', { name: /^Show run panel/ }).click()
    await sleep(400)
  }
}
const openSideTab = async (id) => {
  await showPanel()
  const tab = page.locator(`[data-testid=side-tab-${id}]`)
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
}
const openOutputsTab = async () => {
  await openSideTab('outputs')
  await page.locator('[data-testid=run-outputs]').waitFor({ state: 'visible', timeout: 8000 })
  await page.locator('[data-testid=run-output-row]').first().waitFor({ state: 'visible', timeout: 8000 })
}
const rowOf = (title) => page.locator('[data-testid=run-output-row]').filter({ hasText: title }).first()
const showOutput = async (title) => {
  await rowOf(title).locator('[data-testid=run-output-show]').click()
  await page.locator('[data-testid=output-detail]').waitFor({ state: 'visible', timeout: 8000 })
}
const backToList = async () => {
  const back = page.locator('[data-testid=run-output-back]')
  if (await back.count()) await back.click()
  await sleep(200)
}
const previewState = async (kind) => {
  const p = page.locator(`[data-testid=output-preview]`)
  await p.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
  return p.first().getAttribute('data-state').catch(() => null)
}
const toggle = (wrapperId, label) =>
  page.locator(`[data-testid=${wrapperId}]`).getByText(label, { exact: true }).first()

try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  await setSize(1600, 1000)
  await setTheme('dark')
  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(PROMPT)
  await page.locator('.composer .btn.primary').click()
  const settled = await until(async () => {
    const card = page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first()
    if (await card.count()) await card.getByRole('button', { name: 'Allow once', exact: true }).click().catch(() => {})
    return /Idle/.test(await tabStatus())
  }, 60_000)
  check(settled, 'the [mock:outputs] run reaches Idle', clean(await tabStatus()))
  const stored = await page.evaluate((id) => window.orgai.outputs.list(id), project.id).catch(() => null)
  if (Array.isArray(stored)) check(stored.length === 5, 'main lists five outputs', String(stored.length))

  let previewsBuilt = null // decided once, on the first detail

  const WANT_KINDS = ['docx', 'xlsx', 'mermaid', 'markdown', 'image']
  for (const [w, h, theme] of [[1600, 1000, 'dark'], [1600, 1000, 'light'], [1024, 640, 'dark'], [1024, 640, 'light']]) {
    const tag = `${w}x${h} ${theme}`
    await setSize(w, h)
    await setTheme(theme)
    await openProject(page, NAME)

    // ======== run side tab ========
    await openOutputsTab()
    const kinds = await page.locator('[data-testid=run-output-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
    check(JSON.stringify([...kinds].sort()) === JSON.stringify([...WANT_KINDS].sort()), `${tag}: the Outputs tab lists five rows: docx, xlsx, mermaid, markdown, image`, JSON.stringify(kinds))
    check((await page.locator('[data-testid=run-output-row][data-missing=true]').count()) === 0, `${tag}: no row is marked missing`)
    check((await page.locator('[data-testid=run-outputs]').getAttribute('data-mode')) === 'list', `${tag}: the tab opens in list mode`)
    await fitsWindow(`${tag} Outputs tab`)
    await screenshot(page, `outputs-tab-${w}-${theme}`)

    // RunMeta chip (the label may sit in title / sr-only at narrow widths: textContent).
    const chip = page.locator('[data-testid=run-meta-outputs]')
    const chipText = clean(await chip.evaluate((el) => el.textContent).catch(() => ''))
    check(/5\s*outputs/.test(chipText), `${tag}: the RunMeta chip says "5 outputs"`, chipText)

    // Transcript rows.
    await page.locator('[data-testid=side-tab-transcript]').click()
    await page.locator('.side-run .transcript .entry').first().waitFor({ state: 'visible', timeout: 8000 })
    const wrows = page.locator('[data-testid=output-write-row]')
    check(await until(async () => (await wrows.count()) >= 6), `${tag}: the transcript has six output rows`, String(await wrows.count()))
    const states = await wrows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
    check(states.filter((s) => s === 'produced').length === 4 && states.filter((s) => s === 'registered').length === 1 && states.filter((s) => s === 'refused').length === 1, `${tag}: four produced, one registered, one refused row`, JSON.stringify(states))
    const refused = clean(await page.locator('[data-testid=output-write-row][data-state=refused]').first().innerText())
    check(/Refused/.test(refused), `${tag}: the refused row reads "Refused"`, refused)
    check((await page.locator('[data-testid=output-write-row][data-state=refused] [data-testid=output-write-show]').count()) === 0, `${tag}: the refused row has no Show link`)

    // Show in the transcript opens the Outputs tab on that item.
    const plan = page.locator('[data-testid=output-write-row][data-state=produced]').filter({ hasText: 'Project plan' }).first()
    await plan.locator('[data-testid=output-write-show]').click()
    await page.locator('[data-testid=output-detail]').waitFor({ state: 'visible', timeout: 8000 })
    check((await page.locator('[data-testid=side-tab-outputs]').getAttribute('aria-selected')) === 'true', `${tag}: Show selects the Outputs tab`)
    check(clean(await page.locator('[data-testid=output-detail-heading]').innerText()).includes('Project plan'), `${tag}: Show opens the detail of "Project plan"`)
    check(await until(async () => (await active()).id === 'output-detail-heading'), `${tag}: focus lands on the detail heading`, JSON.stringify(await active()))
    await fitsWindow(`${tag} docx detail`)

    // Preview guard (once).
    if (previewsBuilt === null) {
      await page.locator('[data-testid=output-preview]').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
      const none = await page.locator('[data-testid=output-preview-none]').first().innerText().catch(() => '')
      previewsBuilt = !/is not built yet/.test(none)
      if (!previewsBuilt) console.log('SKIP preview checks (previews not merged)')
    }

    if (previewsBuilt) {
      check(await until(async () => (await previewState('docx')) === 'ready', 15_000), `${tag}: the document preview is ready`, String(await previewState('docx')))
      const doc = page.locator('[data-testid=output-doc]')
      check((await doc.locator('h1, h2, h3').filter({ hasText: 'Project plan' }).count()) >= 1, `${tag}: the document shows its heading`)
      check((await doc.locator('strong, b').count()) >= 1, `${tag}: the document shows a bold run`)
      check((await doc.locator('table').count()) >= 1 && /Phase/.test(await doc.locator('table').first().innerText()), `${tag}: the document shows the table`)
      await screenshot(page, `outputs-doc-${w}-${theme}`)
    }

    // More actions menu.
    await page.locator('[data-testid=output-detail] [data-testid=output-more], [data-testid=run-outputs] [data-testid=output-more]').first().click().catch(() => {})
    if (!(await page.locator('[data-testid=output-actions]').count())) {
      await backToList()
      await rowOf('Project plan').locator('[data-testid=output-more]').click()
    }
    await page.locator('[data-testid=output-actions]').waitFor({ state: 'visible', timeout: 5000 })
    const items = await page.locator('[data-testid=output-actions] [role=menuitem]').allInnerTexts()
    const want = ['Open', 'Show in folder', 'Save as', 'Copy path', 'Remove from list', 'Delete file']
    check(want.every((t) => items.some((i) => clean(i).startsWith(t))), `${tag}: the More actions menu lists ${want.join(', ')}`, JSON.stringify(items))
    await page.keyboard.press('Escape')
    await page.locator('[data-testid=output-actions]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    await backToList()
    if (!(await page.locator('[data-testid=run-output-row]').count())) await openOutputsTab()

    if (previewsBuilt) {
      // Sheets.
      await showOutput('Budget')
      check(await until(async () => (await previewState('xlsx')) === 'ready', 15_000), `${tag}: the sheet preview is ready`)
      const sheets = page.locator('[data-testid=output-sheets]')
      check((await page.locator('[data-testid=output-sheet-tab]').count()) === 2, `${tag}: two sheet tabs`, String(await page.locator('[data-testid=output-sheet-tab]').count()))
      const sheetText = clean(await sheets.innerText())
      check(/1,?200/.test(sheetText) && /3,?400/.test(sheetText) && /\b800/.test(sheetText), `${tag}: the Cost cells show`, sheetText.slice(0, 200))
      check(sheetText.includes('=SUM(B2:B4)'), `${tag}: "=SUM(B2:B4)" is shown as text`)
      await screenshot(page, `outputs-sheet-${w}-${theme}`)
      await fitsWindow(`${tag} sheet`)
      await backToList()

      // Mermaid.
      await showOutput('Architecture diagram')
      check(await until(async () => (await page.locator('[data-testid=output-mermaid]').first().getAttribute('data-state')) === 'ok', 20_000), `${tag}: the diagram reaches data-state=ok`, String(await page.locator('[data-testid=output-mermaid]').first().getAttribute('data-state')))
      const nodes = await page.locator('[data-testid=output-mermaid-svg] g.node').count()
      check(nodes === 4, `${tag}: the diagram has four nodes`, String(nodes))
      await toggle('output-mermaid-view', 'Source').click()
      check(await until(async () => (await page.locator('[data-testid=output-source]').count()) >= 1), `${tag}: the Source toggle shows the source`)
      await toggle('output-mermaid-view', 'Diagram').click()
      await screenshot(page, `outputs-mermaid-${w}-${theme}`)
      await fitsWindow(`${tag} mermaid`)
      await backToList()

      // Markdown.
      await showOutput('Summary')
      check(await until(async () => (await page.locator('[data-testid=output-md-rendered] h1, [data-testid=output-md-rendered] h2').filter({ hasText: 'Summary' }).count()) >= 1, 15_000), `${tag}: markdown renders its heading`)
      await toggle('output-md-view', 'Source').click()
      check(await until(async () => (await page.locator('[data-testid=output-source], [data-testid=output-text]').count()) >= 1), `${tag}: markdown toggles to source`)
      await toggle('output-md-view', 'Rendered').click()
      await backToList()

      // Image.
      await showOutput('Logo')
      const img = page.locator('[data-testid=output-image]').first()
      check(await until(async () => (await img.evaluate((el) => (el.tagName === 'IMG' ? el : el.querySelector('img'))?.naturalWidth ?? 0).catch(() => 0)) > 0, 15_000), `${tag}: the image preview shows the PNG (naturalWidth > 0)`)
      await fitsWindow(`${tag} image`)
      await backToList()
    }

    // ======== project Outputs tab ========
    await projectTab(page, 'Outputs').click()
    await page.locator('[data-testid=outputs-view]').waitFor({ state: 'visible', timeout: 8000 })
    const rows = page.locator('[data-testid=output-row]')
    check(await until(async () => (await rows.count()) === 5), `${tag}: the Outputs tab lists five rows`, String(await rows.count()))
    const pKinds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
    check(JSON.stringify([...pKinds].sort()) === JSON.stringify([...WANT_KINDS].sort()), `${tag}: the same five kinds`, JSON.stringify(pKinds))
    const count = () => page.locator('[data-testid=outputs-count]').innerText().then(clean)
    const count0 = await count()
    check(/5/.test(count0), `${tag}: the count line reads five`, count0)
    await fitsWindow(`${tag} Outputs view`)
    await screenshot(page, `outputs-view-${w}-${theme}`)

    // A kind chip filters.
    const chip1 = page.locator('[data-testid=outputs-kind][data-kind=docx]')
    await chip1.click()
    check((await chip1.getAttribute('aria-pressed')) === 'true', `${tag}: the docx chip is pressed`)
    check(await until(async () => (await rows.count()) === 1), `${tag}: one row with the docx chip`, String(await rows.count()))
    check(await until(async () => (await count()) !== count0), `${tag}: the count line updates`, await count())
    await page.locator('[data-testid=outputs-kind-all]').click()
    check(await until(async () => (await rows.count()) === 5), `${tag}: All brings the five back`)
    // Search filters.
    const search = page.locator('[data-testid=outputs-search]')
    await search.fill('budget')
    check(await until(async () => (await rows.count()) === 1), `${tag}: search "budget" leaves one row`, String(await rows.count()))
    check(await until(async () => (await count()) !== count0), `${tag}: the count line follows the search`)
    await search.fill('')
    check(await until(async () => (await rows.count()) === 5), `${tag}: clearing the search restores five rows`)

    // Keyboard: Tab into the listbox, ArrowDown, Enter, Esc.
    await search.focus()
    let inList = false
    for (let i = 0; i < 20 && !inList; i++) {
      await page.keyboard.press('Tab')
      inList = (await active()).inList
    }
    check(inList, `${tag}: Tab reaches the list`)
    const first = await active()
    await page.keyboard.press('ArrowDown')
    const second = await active()
    check(second.inList && second.dataId !== '' && second.dataId !== first.dataId, `${tag}: ArrowDown moves to the next row`, `${first.dataId} -> ${second.dataId}`)
    await page.keyboard.press('Enter')
    await page.locator('[data-testid=outputs-detail]').waitFor({ state: 'visible', timeout: 8000 })
    check(await until(async () => (await active()).id === 'output-detail-heading'), `${tag}: Enter opens the pane with focus on its heading`, JSON.stringify(await active()))
    await fitsWindow(`${tag} Outputs detail`)
    await screenshot(page, `outputs-detail-${w}-${theme}`)
    await page.keyboard.press('Escape')
    check(await until(async () => { const a = await active(); return a.inList && a.dataId === second.dataId }), `${tag}: Esc returns focus to the row`, JSON.stringify(await active()))
  }
} finally {
  await cleanup(app, page, NAME).catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
}
finish('outputs')
