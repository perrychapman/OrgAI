// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The knowledge graph in run views, Settings and Maintenance
// (docs/design/knowledge.md sections 7, 8, 9): a [mock:knowledge] work run on an engagement writes eight harness rows
// (4 Recorded, 2 Linked, 1 Saved note, 1 Retired fact); the root transcript shows one plain sentence per knowledge call
// and one row per write with an "Open" link; RunMeta reads "Recorded 8 changes" (title: the breakdown) and opens the Knowledge tab; Settings >
// General > Context notes is the summary line with "Open Knowledge"; Maintenance "Clear everything…" names the counts
// and empties the graph; the forget confirm counts recorded items. Both sizes and themes, with screenshots.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SHOTS_DIR, TMP, check, deleteProject, endSession, findProject, finish, launch, openProject, openProjectForm, gotoProjects, projectTab, relaunch, screenshot, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-knrun-'))
const mk = (name) => {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const wfA = mk('acme-kickoff')
const wfB = mk('birch-kickoff')
const A = 'E2EK Acme kickoff (orgai test)'
const B = 'E2EK Birch kickoff (orgai test)'
const PROMPT = 'Summarise the kickoff [mock:knowledge]'

let { app, page, shot } = await launch({ shotPrefix: 'knowledge-run' })
page.setDefaultTimeout(8000)

const snap = (name) => screenshot(page, name)
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
const noPageScroll = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
const fitsWindow = async (what) => {
  const o = await noPageScroll()
  check(o.sw <= o.cw && o.sh <= o.ch + 1, `${what}: the page does not scroll`, JSON.stringify(o))
}

/** Create an engagement through the form with the setup interview off (copied from e2e/engagement2.mjs). */
async function createEngagement({ name, dir }) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Working folder', { exact: true }).fill(dir)
  const arch = form.locator('[data-testid=architect-setup]')
  if (await arch.isChecked()) await form.locator('label.checkbox', { hasText: 'Start with the setup interview' }).click()
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  return findProject(page, name)
}
/** Start a work run from the Live tab (copied from e2e/engagement.mjs). */
const startRun = async (text) => {
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}
const openSettingsPane = async (pane) => {
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: pane, exact: true }).click()
  await sleep(300)
}
/** The run side panel open (it is a rail at 1024x640) with the root agent selected, so the panel shows the root transcript. */
const showRootTranscript = async () => {
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
  if ((await tTab.count()) && (await tTab.getAttribute('aria-selected')) !== 'true') await tTab.click()
  await page.locator('.side-run .transcript .entry').first().waitFor({ state: 'visible', timeout: 10_000 })
}
/** The visible headline of every transcript row, in order (tool rows, result rows, harness rows). */
const rowTexts = () =>
  page.locator('.side-run .transcript .entry').evaluateAll((els) =>
    els.map((el) => {
      const head = el.querySelector('.tool-label, .entry-plain, .md')
      return (head ? head.textContent : el.textContent).replace(/\s+/g, ' ').trim()
    })
  )

/** The Context notes summary line as lib/knowledge.ts knowledgeSummaryLine words it (mirrored, not imported). */
const COMMON = ['person', 'organisation', 'system', 'document', 'decision', 'risk', 'requirement', 'deadline', 'meeting', 'open-question']
const PLURAL = { person: 'People', organisation: 'Organisations', system: 'Systems', document: 'Documents', decision: 'Decisions', risk: 'Risks', requirement: 'Requirements', deadline: 'Deadlines', meeting: 'Meetings', 'open-question': 'Open questions' }
const words = (k) => k.replace(/-+/g, ' ').trim()
const sentence = (w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : '')
function summaryLine(graph, notes) {
  const liveNotes = notes.filter((n) => !n.retired).length
  const liveNodes = graph.nodes.filter((n) => !n.retired)
  const facts = liveNodes.reduce((n, node) => n + node.facts.filter((f) => !f.retired).length, 0)
  const parts = []
  if (liveNodes.length > 0) {
    const counts = new Map()
    for (const n of liveNodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
    const order = [...COMMON.filter((k) => counts.has(k)), ...[...counts.keys()].filter((k) => !COMMON.includes(k)).sort()]
    const kinds = order.map((kind) => `${counts.get(kind)} ${(counts.get(kind) === 1 ? sentence(words(kind)) : PLURAL[kind] ?? sentence(words(kind))).toLowerCase()}`)
    const shown = kinds.slice(0, 5)
    const more = kinds.length - shown.length
    parts.push(`${liveNodes.length} ${liveNodes.length === 1 ? 'item' : 'items'} (${shown.join(', ')}${more > 0 ? `, ${more} more` : ''})`)
  }
  if (liveNotes > 0) parts.push(`${liveNotes} ${liveNotes === 1 ? 'note' : 'notes'}`)
  if (facts > 0) parts.push(`${facts} ${facts === 1 ? 'fact' : 'facts'}`)
  return parts.length ? parts.join(', ') : 'Nothing recorded yet'
}
const clearCounts = (graph) => {
  const one = (n, s, p, retired) => `${n} ${n === 1 ? s : p}${retired > 0 ? ` (${retired} retired)` : ''}`
  const facts = graph.nodes.flatMap((n) => n.facts)
  return [
    one(graph.nodes.length, 'item', 'items', graph.nodes.filter((n) => n.retired).length),
    one(facts.length, 'fact', 'facts', facts.filter((f) => f.retired).length),
    one(graph.edges.length, 'relation', 'relations', graph.edges.filter((e) => e.retired).length)
  ].join(', ')
}
/** A write row's visible geometry: icon and headline on one line, "Open" not wrapped under the headline. */
const writeRowGeometry = (row) =>
  row.evaluate((el) => {
    const icon = el.querySelector(':scope > svg')?.getBoundingClientRect()
    const head = el.querySelector('.entry-plain')?.getBoundingClientRect()
    const open = el.querySelector('[data-testid=knowledge-row-open]')?.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const lineH = parseFloat(getComputedStyle(el.querySelector('.entry-plain')).lineHeight) || 18
    const single = !!head && head.height < lineH * 1.5
    // A long headline may wrap onto a second line; "Open" follows its last line then. A one-line headline keeps "Open" on that line.
    return { sameLine: !!icon && !!head && Math.abs(icon.top - head.top) < 12, openOnLine: !open || !head || !single || Math.abs(open.top - head.top) < lineH, single, h: box.height, headH: head?.height ?? 0 }
  })

const EXPECTED_ROWS = [
  'Looked up the kinds and relations in use',
  'Recorded organisation Acme Corp',
  'Recorded person Jane Doe',
  'Linked Jane Doe works at Acme Corp',
  'Recorded decision Migrate billing to Stripe',
  'Linked Migrate billing to Stripe decided by Jane Doe',
  'Recorded risk Legacy export format undocumented',
  'Saved note Kickoff call summary',
  'Searched the knowledge for Acme',
  'Read Acme Corp',
  'Retired fact Fiscal year ends in March (Corrected: fiscal year ends in April)'
]
const RECORDING_ROWS = EXPECTED_ROWS.filter((t) => /^(Recorded|Linked|Saved note|Retired) /.test(t))

try {
  const a = await createEngagement({ name: A, dir: wfA })
  check(!!a && a.kind === 'engagement', 'engagement A created')
  const b = await createEngagement({ name: B, dir: wfB })
  check(!!b, 'engagement B created')
  await setSize(1600, 1000)
  await setTheme('dark')

  // ======== 1. The [mock:knowledge] run ========
  await openProject(page, A)
  await startRun(PROMPT)
  // The root writes the graph first, then the default script's report asks for an edit; allow it so the run goes idle.
  const tabStatus = () => page.locator('.run-tab[aria-selected=true]').first().innerText().catch(() => '')
  const settled = await until(async () => {
    const card = page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first()
    if (await card.count()) await card.getByRole('button', { name: 'Allow once', exact: true }).click().catch(() => {})
    return /Idle/.test(await tabStatus())
  }, 60_000)
  check(settled, 'the [mock:knowledge] run reaches Idle', clean(await tabStatus()))
  const graph = await page.evaluate((id) => window.orgai.knowledge.get(id), a.id)
  const notes = await page.evaluate((id) => window.orgai.engagement.listNotes(id), a.id)
  check(graph.nodes.length === 4 && graph.edges.length === 2 && notes.length === 1, 'the mock recorded 4 items, 2 relations and 1 note', `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${notes.length} notes`)
  const acme = graph.nodes.find((n) => n.name === 'Acme Corp')
  check(!!acme && acme.facts.some((f) => f.text === 'Fiscal year ends in March' && f.retired), 'the March fact of Acme Corp is retired')

  // ======== 2. The root transcript (section 7) ========
  await showRootTranscript()
  const rows = await rowTexts()
  const seen = rows.filter((t) => EXPECTED_ROWS.includes(t))
  check(JSON.stringify(seen) === JSON.stringify(EXPECTED_ROWS), 'the root transcript shows the eleven knowledge sentences in order', JSON.stringify(rows))
  const noisy = rows.filter((t) => /not instructions|engagement_knowledge|engagement_context|Used engagement/.test(t))
  check(noisy.length === 0, 'no visible row text names the tool or says "not instructions"', JSON.stringify(noisy))
  check(!rows.some((t) => /^(Created|Merged into existing) /.test(t)), 'the write results are folded into their harness rows (no "Created ..." row)', JSON.stringify(rows))
  const kRows = page.locator('[data-testid=knowledge-write-row]')
  check((await kRows.count()) === RECORDING_ROWS.length, `${RECORDING_ROWS.length} harness write rows carry data-testid=knowledge-write-row`, String(await kRows.count()))
  check((await page.locator('.side-run [data-testid=knowledge-row]').count()) === 0, 'no transcript row uses the Knowledge list row testid')
  const opens = page.locator('[data-testid=knowledge-row-open]')
  check((await opens.count()) === RECORDING_ROWS.length, 'every recording row has an "Open" link', String(await opens.count()))
  const openNames = await opens.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  check(openNames.every((n) => /^Open .+ in Knowledge$/.test(n ?? '')), 'each Open link is named "Open <name> in Knowledge"', JSON.stringify(openNames))
  check(openNames[0] === 'Open Acme Corp in Knowledge' && openNames.at(-1) === 'Open Acme Corp in Knowledge', 'the first and the retired-fact rows open Acme Corp', JSON.stringify(openNames))
  const outputs = await kRows.evaluateAll((els) => els.map((e) => e.querySelector('details summary')?.textContent?.trim() ?? ''))
  check(outputs.every((s) => s === 'Show output'), 'each write row keeps the tool result under "Show output"', JSON.stringify(outputs))
  const firstRow = kRows.first()
  await firstRow.locator('summary').click()
  check(/Created organisation Acme Corp \(kn_/.test(await firstRow.locator('pre').innerText()), 'Show output holds the raw "Created ..." result')
  // The expanded output stays inside its row and never overlaps the next row.
  const overlap = await kRows.evaluateAll((els) => {
    const pre = els[0].querySelector('pre')?.getBoundingClientRect()
    const next = els[1]?.getBoundingClientRect()
    return pre && next ? { preBottom: pre.bottom, nextTop: next.top } : null
  })
  check(!!overlap && overlap.preBottom <= overlap.nextTop + 1, 'an expanded output does not overlap the next row', JSON.stringify(overlap))
  await firstRow.locator('summary').click()
  const resultLabels = rows.filter((t) => /^(Looked up \d+ kinds?|No kinds in use yet|\d+ items? found|Item returned)$/.test(t))
  check(resultLabels.length === 3, 'the read results read "Looked up N kinds" / "N items found" / "Item returned"', JSON.stringify(resultLabels))
  await shot('transcript-1600-dark')

  // The Open link opens the Knowledge tab on the item (the view resolves the focus; here the tab must at least show).
  await opens.first().focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-testid=knowledge-view]').waitFor({ state: 'visible', timeout: 8000 })
  check(true, 'Enter on an "Open" link shows the Knowledge tab')
  check((await page.locator('[data-testid=tab-knowledge]').getAttribute('aria-selected')) === 'true', 'the Knowledge topbar tab is selected')

  // ======== 3. RunMeta (section 8) ========
  await projectTab(page, 'Live').click()
  const meta = page.locator('[data-testid=run-meta-recorded]')
  // The button carries an sr-only " (opens Knowledge)" suffix in its accessible name; the visible text is checked.
  const metaText = async () => clean((await meta.innerText().catch(() => '')).replace(/\([^)]*opens Knowledge\)/, ''))
  await meta.waitFor({ state: 'visible', timeout: 8000 })
  check((await metaText()) === 'Recorded 8 changes', 'RunMeta reads "Recorded 8 changes"', await metaText())
  const WANT_TITLE = 'What the team recorded this run: 4 items, 2 relations, 1 note, 1 retired. Opens Knowledge.'
  check((await meta.evaluate((el) => el.tagName)) === 'BUTTON' && (await meta.getAttribute('title')) === WANT_TITLE, 'the count is a button whose title gives the breakdown', (await meta.getAttribute('title')) ?? '')
  const srText = clean(await meta.locator('.sr-only').innerText())
  check(srText === '(4 items, 2 relations, 1 note, 1 retired; opens Knowledge)', 'the screen-reader text carries the breakdown and "opens Knowledge"', srText)
  await meta.click()
  await page.locator('[data-testid=knowledge-view]').waitFor({ state: 'visible', timeout: 8000 })
  check(true, 'clicking "Recorded 8 changes" shows the Knowledge tab')
  // Needs the Knowledge view change from the parallel branch (focus lands on a row when the request has no target).
  check(
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'knowledge-row'), 4000),
    'RunMeta trigger: focus lands on a knowledge row',
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)
  )

  // ======== 4. Settings > General (section 9) ========
  await openSettingsPane('General')
  const summary = page.locator('[data-testid=knowledge-summary]')
  await summary.waitFor({ state: 'visible' })
  const wantSummary = summaryLine(graph, notes)
  check(await until(async () => clean(await summary.innerText()) === wantSummary), `Context notes summary reads "${wantSummary}"`, clean(await summary.innerText()))
  check((await page.locator('[data-testid=context-note-row]').count()) === 0 && (await page.locator('[data-testid=context-note-add]').count()) === 0, 'the inline notes list and "Add a note" are gone from Settings')
  const lead = clean(await page.locator('[data-testid=context-notes-section] .settings-section-lead').innerText())
  check(/Agents read and write these notes/.test(lead), 'the description says agents read and write these notes', lead)
  // A note saved elsewhere refreshes the line through the push event.
  await page.evaluate((id) => window.orgai.engagement.saveNote({ projectId: id, title: 'Glossary', text: 'SAP = the ERP.' }), a.id)
  const notes2 = await page.evaluate((id) => window.orgai.engagement.listNotes(id), a.id)
  const wantSummary2 = summaryLine(graph, notes2)
  check(await until(async () => clean(await summary.innerText()) === wantSummary2), `the summary refetches on a note save ("${wantSummary2}")`, clean(await summary.innerText()))
  await shot('settings-general-1600-dark')
  await page.locator('[data-testid=knowledge-open]').click()
  await page.locator('[data-testid=knowledge-view]').waitFor({ state: 'visible', timeout: 8000 })
  check(true, '"Open Knowledge" shows the Knowledge tab')
  // Needs the Knowledge view change from the parallel branch (focus lands on a row when the request has no target).
  check(
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'knowledge-row'), 4000),
    'Settings trigger: focus lands on a knowledge row',
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)
  )
  // The tab's total (items and notes) is what the forget confirm counts as recorded items plus context notes.
  const tabTotal = await (async () => {
    const t = clean(await page.locator('[data-testid=knowledge-count]').innerText())
    const nums = (t.match(/\d+/g) ?? []).map(Number)
    return nums.length ? nums[nums.length - 1] : -1
  })()

  // ======== 5. Maintenance: forget confirm counts, then Clear everything (section 9) ========
  await openSettingsPane('Maintenance')
  check(/what the team recorded/.test(clean(await page.locator('[data-testid=danger-zone-text]').innerText())), 'the danger-zone text names what the team recorded')
  await page.locator('[data-testid=forget-engagement]').click()
  const forgetBody = page.locator('[data-testid=forget-confirm]')
  await forgetBody.waitFor({ state: 'visible' })
  const forgetText = clean(await forgetBody.innerText())
  check(/4 recorded items/.test(forgetText), 'the forget confirm lists "4 recorded items"', forgetText)
  const forgetNotes = Number(/(\d+) context notes?/.exec(forgetText)?.[1] ?? 0)
  const forgetItems = Number(/(\d+) recorded items?/.exec(forgetText)?.[1] ?? 0)
  check(tabTotal > 0 && tabTotal === forgetItems + forgetNotes, "the Knowledge tab's total equals the forget confirm's recorded items plus its notes", `tab ${tabTotal}, forget ${forgetItems} + ${forgetNotes}`)
  await shot('forget-confirm-1600-dark')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.locator('[data-testid=forget-confirm]').waitFor({ state: 'hidden' })
  const clearBtn = page.locator('[data-testid=knowledge-clear]')
  await clearBtn.waitFor({ state: 'visible' })
  check(await until(async () => !(await clearBtn.isDisabled())), '"Clear everything…" is enabled while items exist')
  await clearBtn.focus()
  await page.keyboard.press('Enter')
  // The shared useConfirm dialog (no dialog testId): found by its confirm button.
  const dlg = page.locator('.dialog, [role=dialog]', { has: page.locator('[data-testid=knowledge-clear-confirm]') }).first()
  await dlg.waitFor({ state: 'visible' })
  check(clean(await dlg.getByRole('heading').first().innerText()) === 'Clear everything the team recorded?', 'the confirm title', clean(await dlg.getByRole('heading').first().innerText()))
  const body = clean(await dlg.locator('[data-testid=knowledge-clear-body]').innerText())
  const wantCounts = clearCounts(graph)
  check(body.startsWith(`Deletes ${wantCounts}.`) && /Agents and you can no longer see these\. Context notes stay\./.test(body) && /Retire items on the Knowledge tab/.test(body), `the confirm names "${wantCounts}" and that notes stay`, body)
  check(await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Cancel'), 'focus starts on Cancel')
  await shot('clear-confirm-1600-dark')
  await dlg.locator('[data-testid=knowledge-clear-confirm]').click()
  await dlg.waitFor({ state: 'hidden' })
  const after = await page.evaluate((id) => window.orgai.knowledge.get(id), a.id)
  check(after.nodes.length === 0 && after.edges.length === 0, 'knowledge.get is empty after Clear everything')
  const noticeText = await until(async () => /Cleared everything the team recorded\./.test(await page.locator('[data-testid=settings-section-maintenance], #settings-section-maintenance').innerText()))
  check(noticeText, 'the Maintenance notice reads "Cleared everything the team recorded."')
  check(await until(async () => (await clearBtn.isDisabled()) && (await page.locator('[data-testid=knowledge-clear-empty]').count()) === 1), 'after clearing, the button greys with "Nothing recorded yet."')
  const notesAfter = await page.evaluate((id) => window.orgai.engagement.listNotes(id), a.id)
  check(notesAfter.length === 2, 'context notes survive Clear everything', String(notesAfter.length))
  check(await until(async () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'maintenance-notice')), 'focus moves to the "Cleared everything" notice (the button is disabled once the graph is empty)')
  await shot('cleared-1600-dark')
  // The summary line follows the clear.
  await openSettingsPane('General')
  check(await until(async () => clean(await summary.innerText()) === summaryLine(after, notesAfter)), 'the summary line refetches after the clear', clean(await summary.innerText()))
  // The RunMeta count still counts what the run did, not what is left.
  await projectTab(page, 'Live').click()
  check((await metaText()) === 'Recorded 8 changes', 'RunMeta still reads "Recorded 8 changes" after the clear (it counts the run, not the graph)')

  // ======== 6. Both sizes and themes: transcript, Settings and Maintenance, no page scroll ========
  for (const [w, h, theme] of [[1600, 1000, 'light'], [1024, 640, 'dark'], [1024, 640, 'light']]) {
    const tag = `${w}x${h} ${theme}`
    await setSize(w, h)
    await setTheme(theme)
    await openProject(page, A)
    await showRootTranscript()
    const r = await rowTexts()
    check(JSON.stringify(r.filter((t) => EXPECTED_ROWS.includes(t))) === JSON.stringify(EXPECTED_ROWS), `${tag}: the eleven knowledge sentences show`, JSON.stringify(r).slice(0, 400))
    check((await page.locator('[data-testid=knowledge-row-open]').count()) === RECORDING_ROWS.length, `${tag}: every recording row has an Open link`)
    const metaVisible = await meta.isVisible().catch(() => false)
    check(metaVisible && (await metaText()) === 'Recorded 8 changes', `${tag}: RunMeta reads "Recorded 8 changes"`)
    const geo = []
    const writeRows = page.locator('[data-testid=knowledge-write-row]')
    for (let i = 0; i < (await writeRows.count()); i++) geo.push(await writeRowGeometry(writeRows.nth(i)))
    check(geo.length === RECORDING_ROWS.length && geo.every((g) => g.sameLine && g.openOnLine), `${tag}: each write row keeps its icon and headline on one line, Open beside the headline`, JSON.stringify(geo.filter((g) => !g.sameLine || !g.openOnLine)))
    check(geo.every((g) => g.h <= g.headH + 40), `${tag}: write rows are as tall as their text, not the list row height`, JSON.stringify(geo.map((g) => [Math.round(g.h), Math.round(g.headH)])))
    await fitsWindow(`${tag} Live`)
    await shot(`transcript-${w}-${theme}`)
    await openSettingsPane('General')
    await summary.waitFor({ state: 'visible' })
    check(/Open Knowledge/.test(clean(await page.locator('[data-testid=context-notes-section]').innerText())), `${tag}: Context notes shows "Open Knowledge"`)
    const shiftG = await windowShift(page)
    check(shiftG.ok, `${tag}: Settings > General did not shift the window`, JSON.stringify(shiftG))
    await fitsWindow(`${tag} Settings General`)
    await shot(`settings-${w}-${theme}`)
    await openSettingsPane('Maintenance')
    await clearBtn.waitFor({ state: 'visible' })
    check(await clearBtn.isDisabled(), `${tag}: "Clear everything…" is disabled with nothing recorded`)
    await fitsWindow(`${tag} Settings Maintenance`)
    await shot(`maintenance-${w}-${theme}`)
  }

  // ======== 7. The forget notice counts recorded items (engagement B records again, then is forgotten) ========
  await setSize(1600, 1000)
  await setTheme('dark')
  await openProject(page, B)
  await startRun(PROMPT)
  const settledB = await until(async () => {
    const card = page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first()
    if (await card.count()) await card.getByRole('button', { name: 'Allow once', exact: true }).click().catch(() => {})
    return /Idle/.test(await tabStatus())
  }, 60_000)
  check(settledB, 'the second engagement run reaches Idle')
  const end = page.getByRole('button', { name: 'End session' })
  if (await end.count()) {
    await end.first().click().catch(() => {})
    await sleep(1200)
  }
  await openSettingsPane('Maintenance')
  await page.locator('[data-testid=forget-engagement]').click()
  await forgetBody.waitFor({ state: 'visible' })
  check(/4 recorded items/.test(clean(await forgetBody.innerText())), 'B: the forget confirm lists "4 recorded items"', clean(await forgetBody.innerText()))
  await page.getByRole('button', { name: 'Forget engagement', exact: true }).click()
  const notice = page.locator('[data-testid=forget-notice]')
  await notice.waitFor({ state: 'visible', timeout: 15_000 })
  const noticeB = clean(await notice.innerText())
  check(/4 recorded items/.test(noticeB), 'the Dashboard forget-notice counts "4 recorded items"', noticeB)
  await shot('forget-notice')

  // ======== 8. Knowledge during a run (docs/design/knowledge-graph-2.md section 3) ========
  fs.mkdirSync(path.join(SHOTS_DIR, 'run'), { recursive: true })
  const wfC = mk('cedar-recall')
  const C = 'E2EK Cedar recall (orgai test)'
  const c = await createEngagement({ name: C, dir: wfC })
  check(!!c, 'engagement C created')
  await setSize(1600, 1000)
  await setTheme('dark')
  await openProject(page, C)
  await startRun('Check the billing wording [mock:knowledge-recall]')
  const settledC = await until(async () => {
    const card = page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first()
    if (await card.count()) await card.getByRole('button', { name: 'Allow once', exact: true }).click().catch(() => {})
    return /Idle/.test(await tabStatus())
  }, 60_000)
  check(settledC, 'the [mock:knowledge-recall] run reaches Idle', clean(await tabStatus()))
  const graphC = await page.evaluate((id) => window.orgai.knowledge.get(id), c.id)
  const acmeC = graphC.nodes.find((n) => n.name === 'Acme Corp')
  const janeC = graphC.nodes.find((n) => n.name === 'Jane Doe')
  check(!!acmeC && !!janeC, 'the recall run recorded Acme Corp and Jane Doe')

  const active = () =>
    page.evaluate(() => {
      const a = document.activeElement
      return { tid: a?.getAttribute('data-testid') ?? '', id: a?.getAttribute('data-id') ?? '', rid: a?.getAttribute('data-return-id') ?? '', tag: a?.tagName ?? '' }
    })
  const kTab = page.locator('[data-testid=side-tab-knowledge]')
  const openKnowledgeTab = async () => {
    await showRootTranscript()
    await page.locator('[data-testid=side-tab-knowledge]').click()
    await page.locator('[data-testid=run-knowledge]').waitFor({ state: 'visible', timeout: 8000 })
  }
  const search = page.locator('[data-testid=run-knowledge-search]')
  const liveSelected = async () => (await projectTab(page, 'Live').getAttribute('aria-selected')) === 'true'

  await openKnowledgeTab()
  const tabOrder = await page.locator('.side-header [role=tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  check(tabOrder.indexOf('side-tab-knowledge') > tabOrder.indexOf('side-tab-usage') && tabOrder.indexOf('side-tab-knowledge') === tabOrder.indexOf('side-tab-logs') - 1, 'the Knowledge tab sits before Logs', JSON.stringify(tabOrder))
  check((await kTab.innerText()).trim() === 'Knowledge', 'the tab reads "Knowledge"')

  // Recalled in this run: de-duplicated, with counts.
  const rrows = page.locator('[data-testid=run-knowledge-recalled-row]')
  check(await until(async () => (await rrows.count()) >= 2), 'Recalled lists at least two items', String(await rrows.count()))
  const rids = await rrows.evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))
  check(new Set(rids).size === rids.length, 'Recalled has one row per item', JSON.stringify(rids))
  const givens = await page.locator('[data-testid=run-knowledge-recalled-row-given]').allInnerTexts()
  check(givens.every((g) => /^Given (once|\d+ times)$/.test(g.trim())), 'each row says how often it was given', JSON.stringify(givens))
  check(givens.some((g) => /^Given [2-9]\d* times$/.test(g.trim())), 'the repeated recall counts twice, not two rows', JSON.stringify(givens))
  check(rids.includes(janeC.id), 'Jane Doe (named in a report brief) is among the recalled items')
  check((await page.locator('[data-testid=run-knowledge-recalled] h3').innerText()) === 'Recalled in this run', 'the section is headed "Recalled in this run"')
  check(/^Searching here does not call a model\.$/.test(clean(await page.locator('[data-testid=run-knowledge-free]').innerText())), 'the quiet line says searching does not call a model')
  check((await page.locator('[data-testid=run-knowledge-recalled-row] [data-testid=knowledge-kind-mark]').count()) === rids.length, 'every row carries a kind mark')

  // Search: ranked, kind mark, keyboard.
  const before = JSON.stringify(await page.evaluate((id) => window.orgai.knowledge.get(id), c.id))
  await search.fill('Acme')
  const results = page.locator('[data-testid=run-knowledge-result]')
  check(await until(async () => (await results.count()) >= 1), 'searching "Acme" shows results')
  check(clean(await results.first().locator('.run-knowledge-row-name').innerText()) === 'Acme Corp', 'Acme Corp ranks first')
  check((await results.first().locator('[data-testid=knowledge-kind-mark]').count()) === 1 && /Organisation/.test(await results.first().innerText()), 'a result shows its kind mark and kind')
  check(await until(async () => /^\d+ items? found\.$/.test(clean(await page.locator('[data-testid=run-knowledge-status]').innerText()))), 'the status region says "N items found."', clean(await page.locator('[data-testid=run-knowledge-status]').innerText()))
  check((await page.locator('[data-testid=run-knowledge-recalled]').count()) === 0, 'results replace the Recalled list while there is a query')
  await search.focus()
  await page.keyboard.press('ArrowDown')
  const a1 = await active()
  check(a1.tid === 'run-knowledge-result', 'Down from the search box enters the results', JSON.stringify(a1))
  await page.keyboard.press('Enter')
  const detail = page.locator('[data-testid=run-knowledge-detail]')
  await detail.waitFor({ state: 'visible' })
  check((await detail.getAttribute('data-id')) === acmeC.id, 'Enter opens the compact detail of Acme Corp')
  check(await until(async () => (await active()).tag === 'H3'), 'focus moves to the detail heading', JSON.stringify(await active()))
  check(await liveSelected(), 'the Live tab is still selected (no navigation away)')
  check((await page.locator('[data-testid=knowledge-view]').count()) === 0, 'the project Knowledge tab did not open')
  const dtext = clean(await detail.innerText())
  check(/Headquartered in Leeds/.test(dtext) && /Facts/.test(dtext) && /Related/.test(dtext), 'the detail lists facts and related items', dtext.slice(0, 200))
  check(!/Fiscal year ends in March/.test(dtext), 'a retired fact is not listed')
  check((await page.locator('[data-testid=run-knowledge-open-tab]').count()) === 1, '"Open in Knowledge" is offered in the main window')
  await snap('run/kr-detail-1600-dark')
  // Related link opens the neighbour; Back twice returns to the link, then the row.
  await detail.locator('[data-testid=run-knowledge-related-link]', { hasText: 'Jane Doe' }).first().click()
  check(await until(async () => (await detail.getAttribute('data-id')) === janeC.id), 'a related link opens the neighbour here')
  await page.locator('[data-testid=run-knowledge-back]').click()
  check(await until(async () => (await detail.getAttribute('data-id')) === acmeC.id), 'Back returns to the previous item')
  check(await until(async () => (await active()).rid === janeC.id), 'focus returns to the link it came from', JSON.stringify(await active()))
  await page.locator('[data-testid=run-knowledge-back]').click()
  check(await until(async () => (await results.count()) >= 1), 'Back from the first item returns to the results')
  check(await until(async () => { const a = await active(); return a.tid === 'run-knowledge-result' && a.id === acmeC.id }), 'focus returns to the result row', JSON.stringify(await active()))
  await page.keyboard.press('Enter')
  await detail.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  check(await until(async () => (await results.count()) >= 1 && (await detail.count()) === 0), 'Esc goes back')
  check(await until(async () => (await active()).id === acmeC.id), 'Esc returns focus to the row', JSON.stringify(await active()))
  check(JSON.stringify(await page.evaluate((id) => window.orgai.knowledge.get(id), c.id)) === before, 'browsing the tab wrote nothing')
  // Query and open item survive a tab switch; Esc clears and keeps focus.
  await page.locator('[data-testid=side-tab-usage]').click()
  await page.locator('[data-testid=usage-panel]').waitFor({ state: 'visible' })
  await kTab.click()
  check((await search.inputValue()) === 'Acme' && (await results.count()) >= 1, 'the query survives a tab switch')
  await search.focus()
  await page.keyboard.press('Escape')
  check((await search.inputValue()) === '' && (await active()).tid === 'run-knowledge-search', 'Esc clears the query and keeps focus')
  check(await until(async () => (await page.locator('[data-testid=run-knowledge-recalled]').count()) === 1), 'the Recalled list returns')
  await search.fill('zzzz-nothing')
  check(await until(async () => /Nothing recorded matches zzzz-nothing\./.test(clean(await page.locator('[data-testid=run-knowledge-none]').innerText().catch(() => '')))), 'no match reads "Nothing recorded matches <query>."')
  await search.fill('')
  check(await until(async () => (await page.locator('[data-testid=run-knowledge-recalled]').count()) === 1), 'clearing the box brings the Recalled list back')

  // Transcript rows (3.4).
  await page.locator('[data-testid=side-tab-transcript]').click()
  await page.locator('.side-run .transcript .entry').first().waitFor({ state: 'visible' })
  const reads = page.locator('[data-testid=knowledge-read-row]')
  const readTexts = (await reads.evaluateAll((els) => els.map((e) => e.querySelector('.entry-plain')?.textContent?.trim() ?? ''))).filter(Boolean)
  check(readTexts.filter((t) => /^Recalled \d+ items? about Acme billing$/.test(t)).length === 2, 'the root transcript has two "Recalled N items about Acme billing" rows', JSON.stringify(readTexts))
  check((await reads.first().locator('details summary').innerText()) === 'Show output', 'the recall result sits under "Show output"')
  const crows = await rowTexts()
  check(!crows.some((t) => /knowledge recall|knowledge_recall|Used knowledge/i.test(t)), 'no call or result row for knowledge_recall is left', JSON.stringify(crows.filter((t) => /recall/i.test(t))))
  check(!crows.some((t) => /not instructions/.test(t)), 'no row says "not instructions"')
  // The report that was handed the brief gets the quiet "Added" row.
  const nodes = page.locator('.react-flow__node')
  let addedText = ''
  for (let i = 0; i < (await nodes.count()) && !addedText; i++) {
    await nodes.nth(i).click().catch(() => {})
    await sleep(300)
    const t = (await page.locator('[data-testid=knowledge-read-row] .entry-plain').allInnerTexts()).find((x) => /^Added \d+ known items?: /.test(x.trim()))
    if (t) addedText = t.trim()
  }
  check(/^Added 1 known item: .*Jane Doe/.test(addedText), 'a report has the quiet "Added 1 known item: Jane Doe" row', addedText)
  if (addedText) check((await page.locator('[data-testid=knowledge-read-row]:has-text("Added") details').count()) === 0, 'the Added row has no output')

  // Usage (3.5) and RunMeta (reads are not recorded changes).
  await page.locator('.react-flow__node:has(.agent-node.is-root)').first().click()
  await page.locator('[data-testid=side-tab-usage]').click()
  const uk = page.locator('[data-testid=usage-knowledge]')
  await uk.waitFor({ state: 'visible', timeout: 8000 })
  check(clean(await page.locator('[data-testid=usage-knowledge-recalls]').innerText()).endsWith('2 times'), 'usage: "Looked up by agents" reads 2 times', clean(await page.locator('[data-testid=usage-knowledge-recalls]').innerText()))
  check(/times?$/.test(clean(await page.locator('[data-testid=usage-knowledge-auto]').innerText())), 'usage: "Added automatically" reads N times')
  check(/\d characters?$/.test(clean(await page.locator('[data-testid=usage-knowledge-chars]').innerText())), 'usage: "Text given to agents" reads N characters')
  check((await page.locator('[data-testid=usage-knowledge-items]').count()) === 1, 'usage: items given row')
  check(!/saved/i.test(await page.locator('[data-testid=usage-panel]').innerText()), 'the usage panel never says "saved"')
  await snap('run/kr-usage-1600-dark')
  check((await metaText()) === 'Recorded 8 changes', 'RunMeta still counts only the 8 writes (reads are not changes)', await metaText())

  // Settings (3.6): the switch round-trips through projects:save.
  const savedField = () => page.evaluate(async (id) => { const p = (await window.orgai.projects.list()).find((x) => x.id === id); return p && 'knowledgeAutoContext' in p ? p.knowledgeAutoContext : 'absent' }, c.id)
  await openSettingsPane('General')
  const sw = page.locator('[data-testid=knowledge-auto-context]')
  await sw.waitFor({ state: 'visible' })
  check((await sw.getAttribute('aria-checked')) === 'true' && (await savedField()) === 'absent', 'auto context is on by default and stores nothing')
  check((await sw.getAttribute('aria-label')) === 'Add known items to what agents receive', 'the switch is named "Add known items to what agents receive"')
  await sw.focus()
  await page.keyboard.press('Space')
  check(await until(async () => (await savedField()) === false), 'turning it off saves false', String(await savedField()))
  check((await sw.getAttribute('aria-checked')) === 'false', 'the switch reads off')
  await snap('run/kr-settings-1600-dark')
  await sw.focus()
  await page.keyboard.press('Space')
  check(await until(async () => (await savedField()) === 'absent'), 'turning it on removes the field', String(await savedField()))
  // Off again; the reload check at the end proves it was saved.
  await page.keyboard.press('Space')
  check(await until(async () => (await savedField()) === false), 'off again saves false')

  // A run window (3.3): the tab works, the deep link says so.
  const runC = (await page.evaluate((id) => window.orgai.runs.list(id), c.id))[0]
  await page.evaluate((t) => window.orgai.window.openRun(t), { projectId: c.id, runId: runC.id })
  let win2
  for (let i = 0; i < 30 && !win2; i++) {
    win2 = app.windows().find((w) => w !== page)
    if (!win2) await sleep(500)
  }
  check(!!win2, 'a run-scoped window opens')
  if (win2) {
    await win2.waitForSelector('[data-testid=run-meta]', { timeout: 20_000 })
    await sleep(800)
    const w2meta = win2.locator('[data-testid=run-meta-recorded]')
    await w2meta.waitFor({ state: 'visible', timeout: 10_000 })
    await w2meta.click()
    await win2.locator('[data-testid=run-knowledge]').waitFor({ state: 'visible', timeout: 8000 })
    check(true, 'in a run window "Recorded N changes" opens the Knowledge side tab')
    check((await win2.locator('[data-testid=side-tab-knowledge]').getAttribute('aria-selected')) === 'true', 'the Knowledge side tab is selected there')
    check(await until(async () => (await win2.locator('[data-testid=run-knowledge-recalled-line]').count()) >= 2), 'with no live events the transcript lines stand in', String(await win2.locator('[data-testid=run-knowledge-recalled-line]').count()))
    check(/kept only while OrgAI is open/.test(clean(await win2.locator('[data-testid=run-knowledge-recalled-note]').innerText())), 'the lines carry the "kept only while OrgAI is open" note')
    await win2.locator('[data-testid=run-knowledge-search]').fill('Acme')
    await win2.locator('[data-testid=run-knowledge-result]').first().waitFor({ state: 'visible', timeout: 8000 })
    await win2.locator('[data-testid=run-knowledge-result]').first().click()
    await win2.locator('[data-testid=run-knowledge-detail]').waitFor({ state: 'visible' })
    check(clean(await win2.locator('[data-testid=run-knowledge-window-note]').innerText()) === 'To edit this item, open Knowledge in the main OrgAI window.', 'the window shows the note instead of "Open in Knowledge"')
    check((await win2.locator('[data-testid=run-knowledge-open-tab]').count()) === 0, 'no deep link in the window')
    await win2.locator('[data-testid=side-tab-transcript]').click()
    await win2.locator('[data-testid=knowledge-row-open]').first().click()
    await win2.locator('[data-testid=run-knowledge-detail]').waitFor({ state: 'visible', timeout: 8000 })
    check((await win2.locator('[data-testid=side-tab-knowledge]').getAttribute('aria-selected')) === 'true', 'in a window an Open link opens the item in the side tab')
    await screenshot(win2, 'run/kr-window')
    await win2.close().catch(() => {})
  }
  check((await page.locator('[data-testid=knowledge-view]').count()) === 0, 'the main window stayed where it was')

  // Both sizes and themes: the tab, its states, no page scroll.
  for (const [w, h, theme] of [[1600, 1000, 'dark'], [1600, 1000, 'light'], [1024, 640, 'dark'], [1024, 640, 'light']]) {
    const tag = `${w}x${h} ${theme}`
    await setSize(w, h)
    await setTheme(theme)
    await openProject(page, C)
    await openKnowledgeTab()
    check(await until(async () => (await rrows.count()) >= 2), `${tag}: Recalled shows`)
    await fitsWindow(`${tag} Knowledge tab`)
    const tl = await page.locator('.side-header [role=tablist]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    const kb = await kTab.boundingBox()
    check(tl.sw <= tl.cw + 1 || (!!kb && kb.width > 0), `${tag}: the tab bar fits or scrolls`, JSON.stringify(tl))
    await snap(`run/kr-recalled-${w}-${theme}`)
    await search.fill('Acme')
    await results.first().waitFor({ state: 'visible' })
    const overflow = await page.locator('[data-testid=run-knowledge]').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    check(overflow, `${tag}: results do not overflow the panel sideways`)
    await fitsWindow(`${tag} results`)
    await snap(`run/kr-results-${w}-${theme}`)
    await results.first().click()
    await detail.waitFor({ state: 'visible' })
    await fitsWindow(`${tag} detail`)
    await snap(`run/kr-detail-${w}-${theme}`)
    await page.keyboard.press('Escape')
    await search.fill('')
  }
  // 280 px panel: does "Knowledge" fit or scroll?
  await setSize(1600, 1000)
  const narrow = await page.evaluate(() => {
    const body = document.querySelector('.run-body') ?? document.querySelector('.live')
    const list = document.querySelector('.side-header [role=tablist]')
    if (!body || !list) return null
    const prev = body.style.getPropertyValue('--side-panel-w')
    body.style.setProperty('--side-panel-w', '280px')
    const r = { cw: list.clientWidth, sw: list.scrollWidth, panel: document.querySelector('aside.side-panel')?.getBoundingClientRect().width ?? 0 }
    if (prev) body.style.setProperty('--side-panel-w', prev)
    else body.style.removeProperty('--side-panel-w')
    return r
  })
  check(!!narrow, 'measured the tab bar at a 280 px panel', JSON.stringify(narrow))
  console.log('tab bar at 280 px panel:', JSON.stringify(narrow), narrow && narrow.sw > narrow.cw ? '(scrolls)' : '(fits)')

  // A reload drops the events (the main process keeps the run): the transcript lines stand in, and the switch stayed off.
  await page.reload()
  await page.waitForSelector('.sidebar')
  await openProject(page, C)
  await openSettingsPane('General')
  check((await page.locator('[data-testid=knowledge-auto-context]').getAttribute('aria-checked')) === 'false', 'off survives a reload')
  await page.locator('[data-testid=knowledge-auto-context]').focus()
  await page.keyboard.press('Space')
  check(await until(async () => (await savedField()) === 'absent'), 'on again removes the field')
  await openKnowledgeTab()
  check(await until(async () => (await page.locator('[data-testid=run-knowledge-recalled-line]').count()) >= 2), 'after a reload the Recalled lines come from the transcript', String(await page.locator('[data-testid=run-knowledge-recalled-line]').count()))
  check((await page.locator('[data-testid=run-knowledge-recalled-row]').count()) === 0 && (await page.locator('[data-testid=run-knowledge-recalled-note]').count()) === 1, 'after a reload there are no recalled rows and the note shows')
  await snap('run/kr-reload-lines')

  // Same after a relaunch of the app.
  await endSession(page).catch(() => {})
  await sleep(800)
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'knowledge-run' }))
  page.setDefaultTimeout(8000)
  await setSize(1600, 1000)
  await openProject(page, C)
  await projectTab(page, 'Live').click()
  await page.locator('.react-flow__node').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  await openKnowledgeTab().catch((e) => check(false, 'relaunch: open the Knowledge tab', e.message))
  check(await until(async () => (await page.locator('[data-testid=run-knowledge-recalled-line]').count()) >= 2), 'after a relaunch the Recalled lines come from the transcript', String(await page.locator('[data-testid=run-knowledge-recalled-line]').count()))
  await snap('run/kr-relaunch')
} finally {
  try {
    if (!page.isClosed()) {
      await projectTab(page, 'Live').click().catch(() => {})
      const end = page.getByRole('button', { name: 'End session' })
      if (await end.count()) await end.first().click().catch(() => {})
      await sleep(800)
      for (const name of [A, B, 'E2EK Cedar recall (orgai test)']) {
        const left = await deleteProject(page, name).catch(() => -1)
        check(left === 0, `project "${name}" removed`, String(left))
      }
    }
  } catch (e) {
    check(false, 'cleanup', e.message)
  }
  await app.close().catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
}
finish('knowledge-run')
