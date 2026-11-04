// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The knowledge graph in run views, Settings and Maintenance
// (docs/design/knowledge.md sections 7, 8, 9): a [mock:knowledge] work run on an engagement writes eight harness rows
// (4 Recorded, 2 Linked, 1 Saved note, 1 Retired fact); the root transcript shows one plain sentence per knowledge call
// and one row per write with an "Open" link; RunMeta reads "Recorded 8 items" and opens the Knowledge tab; Settings >
// General > Context notes is the summary line with "Open Knowledge"; Maintenance "Clear everything…" names the counts
// and empties the graph; the forget confirm counts recorded items. Both sizes and themes, with screenshots.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, deleteProject, findProject, finish, launch, openProject, openProjectForm, gotoProjects, projectTab, sleep, windowShift } from './lib.mjs'

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

const { app, page, shot } = await launch({ shotPrefix: 'knowledge-run' })
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
  if (liveNotes > 0) parts.push(`${liveNotes} ${liveNotes === 1 ? 'note' : 'notes'}`)
  if (facts > 0) parts.push(`${facts} ${facts === 1 ? 'fact' : 'facts'}`)
  const counts = new Map()
  for (const n of liveNodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
  const order = [...COMMON.filter((k) => counts.has(k)), ...[...counts.keys()].filter((k) => !COMMON.includes(k)).sort()]
  const top = order.map((kind) => ({ kind, count: counts.get(kind) })).sort((a, b) => b.count - a.count)[0]
  if (top) parts.push(`${top.count} ${(top.count === 1 ? sentence(words(top.kind)) : PLURAL[top.kind] ?? sentence(words(top.kind))).toLowerCase()}`)
  else if (liveNodes.length > 0) parts.push(`${liveNodes.length} ${liveNodes.length === 1 ? 'item' : 'items'}`)
  return parts.length ? parts.join(', ') : 'Nothing recorded yet'
}
const clearCounts = (graph) => {
  const n = graph.nodes.length
  const facts = graph.nodes.reduce((s, node) => s + node.facts.length, 0)
  const e = graph.edges.length
  return `${n} ${n === 1 ? 'item' : 'items'}, ${facts} ${facts === 1 ? 'fact' : 'facts'}, ${e} ${e === 1 ? 'relation' : 'relations'}`
}

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
  const kRows = page.locator('[data-testid=knowledge-row]')
  check((await kRows.count()) === RECORDING_ROWS.length, `${RECORDING_ROWS.length} harness write rows carry data-testid=knowledge-row`, String(await kRows.count()))
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
  await meta.waitFor({ state: 'visible', timeout: 8000 })
  check(clean(await meta.innerText()) === 'Recorded 8 items', 'RunMeta reads "Recorded 8 items"', clean(await meta.innerText()))
  check((await meta.evaluate((el) => el.tagName)) === 'BUTTON' && /Opens Knowledge/.test((await meta.getAttribute('title')) ?? ''), 'the count is a button with the Knowledge title')
  await meta.click()
  await page.locator('[data-testid=knowledge-view]').waitFor({ state: 'visible', timeout: 8000 })
  check(true, 'clicking "Recorded 8 items" shows the Knowledge tab')

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

  // ======== 5. Maintenance: forget confirm counts, then Clear everything (section 9) ========
  await openSettingsPane('Maintenance')
  check(/what the team recorded/.test(clean(await page.locator('[data-testid=danger-zone-text]').innerText())), 'the danger-zone text names what the team recorded')
  await page.locator('[data-testid=forget-engagement]').click()
  const forgetBody = page.locator('[data-testid=forget-confirm]')
  await forgetBody.waitFor({ state: 'visible' })
  const forgetText = clean(await forgetBody.innerText())
  check(/4 recorded items/.test(forgetText), 'the forget confirm lists "4 recorded items"', forgetText)
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
  check(body.startsWith(`Deletes ${wantCounts}.`) && /Context notes stay\./.test(body) && /Retire items on the Knowledge tab/.test(body), `the confirm names "${wantCounts}" and that notes stay`, body)
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
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'knowledge-clear' || document.activeElement === document.body) , 'focus returns to the button (or the body when it is disabled)')
  await shot('cleared-1600-dark')
  // The summary line follows the clear.
  await openSettingsPane('General')
  check(await until(async () => clean(await summary.innerText()) === summaryLine(after, notesAfter)), 'the summary line refetches after the clear', clean(await summary.innerText()))
  // The RunMeta count still counts what the run did, not what is left.
  await projectTab(page, 'Live').click()
  check(clean(await meta.innerText().catch(() => '')) === 'Recorded 8 items', 'RunMeta still reads "Recorded 8 items" after the clear (it counts the run, not the graph)')

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
    check(metaVisible && clean(await meta.innerText()) === 'Recorded 8 items', `${tag}: RunMeta reads "Recorded 8 items"`)
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
} finally {
  try {
    if (!page.isClosed()) {
      await projectTab(page, 'Live').click().catch(() => {})
      const end = page.getByRole('button', { name: 'End session' })
      if (await end.count()) await end.first().click().catch(() => {})
      await sleep(800)
      for (const name of [A, B]) {
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
