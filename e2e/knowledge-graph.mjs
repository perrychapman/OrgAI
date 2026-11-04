// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The Knowledge tab's Graph view (docs/design/knowledge.md section 5):
// an engagement runs "[mock:knowledge]" (Acme Corp, Jane Doe, a decision and a risk; Jane works at Acme, the decision
// is decided by Jane), then the tab's Graph view is checked: the neighbourhood at Depth 1 and 2, each node's spoken
// name, Tab order in list order, Enter opening the detail pane, edge labels at zoom 1, the legend, Show all, the skip
// links, the retired fold (Acme retired through the knowledge API and restored), reduced motion, the four node styles,
// and both sizes and themes without page scroll. The list view, the detail pane and the view switch are the list
// engineer's (e2e/knowledge.mjs); this script only drives them to reach the graph.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, findProject, finish, gotoProjects, launch, openProject, openProjectForm, projectTab, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-kg-'))
const wf = path.join(base, 'acme-kickoff')
fs.mkdirSync(wf, { recursive: true })

const NAME = 'E2E Knowledge graph (orgai test)'
const PROMPT = 'Summarise the kickoff [mock:knowledge]'
const JANE = 'Jane Doe'
const ACME = 'Acme Corp'
const DECISION = 'Migrate billing to Stripe'
const RISK = 'Legacy export format undocumented'

const { app, page, shot } = await launch({ shotPrefix: 'knowledge-graph' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(600)
}
const setAppearance = async (patch) => {
  await page.evaluate(async (p) => {
    const s = await window.orgai.settings.get()
    const canvas = { ...s.appearance.canvas, ...(p.canvas ?? {}) }
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, ...p, canvas } })
  }, patch)
  await sleep(500)
}
const setTheme = (theme) => setAppearance({ theme })
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
const activeTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? `${document.activeElement?.tagName.toLowerCase() ?? 'none'}#${document.activeElement?.id ?? ''}`)

/** Create an engagement through the form (first launch inline form or the dialog). Setup interview is switched off (token-free). */
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
const runTabText = async () => {
  const tab = page.locator('[data-testid=run-strip] .run-tab[aria-selected=true]').first()
  if (!(await tab.count())) return ''
  return `${await tab.getAttribute('aria-label')} ${clean(await tab.innerText().catch(() => ''))}`
}

// ---- graph helpers (the spec's selectors) ----
const GRAPH = '[data-testid=knowledge-graph]'
const NODE = `${GRAPH} .react-flow__node`
const nodeNames = async () =>
  page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-testid=knowledge-node]`)].map((n) => n.querySelector('.knowledge-name-text, .hex-name')?.textContent?.trim() ?? ''), GRAPH)
const nodeCount = () => page.locator(`${GRAPH} [data-testid=knowledge-node]`).count()
const waitNodes = (n, ms = 15_000) => until(async () => (await nodeCount()) === n, ms)
const zoomOf = () =>
  page.evaluate((sel) => {
    const vp = document.querySelector(`${sel} .react-flow__viewport`)
    const m = /scale\(([\d.]+)\)/.exec(vp?.style.transform ?? '')
    return m ? Number(m[1]) : 0
  }, GRAPH)
const edgeLabels = () => page.evaluate((sel) => [...document.querySelectorAll(`${sel} .react-flow__edge-text`)].map((t) => t.textContent?.trim() ?? ''), GRAPH)
const edgeTitles = () => page.evaluate((sel) => [...document.querySelectorAll(`${sel} .knowledge-edge > title`)].map((t) => t.textContent?.trim() ?? ''), GRAPH)
const openGraph = async () => {
  await page.locator('[data-testid=knowledge-view-switch]').getByRole('radio', { name: 'Graph', exact: true }).check({ force: true })
  await page.locator(GRAPH).waitFor({ timeout: 10_000 })
}
const openList = async () => {
  await page.locator('[data-testid=knowledge-view-switch]').getByRole('radio', { name: 'List', exact: true }).check({ force: true })
  await page.locator('[data-testid=knowledge-list]').waitFor({ timeout: 10_000 })
}
const selectRow = async (name) => {
  const row = page.locator('[data-testid=knowledge-row][data-id]', { hasText: name }).first()
  await row.waitFor({ timeout: 10_000 })
  await row.click()
  await sleep(300)
  return row.getAttribute('data-id')
}
const openKnowledgeTab = async () => {
  await page.locator('[data-testid=tab-knowledge]').click()
  await page.locator('[data-testid=knowledge-view]').waitFor({ timeout: 10_000 })
  await sleep(400)
}

try {
  // ======== Setup: an engagement with the mock knowledge run ========
  await setSize(1600, 1000)
  await setTheme('dark')
  const project = await createEngagement({ name: NAME, dir: wf })
  check(!!project && project.kind === 'engagement', 'engagement created')
  const pid = project.id
  await openProject(page, NAME)
  await startRun(PROMPT)
  const recorded = await until(async () => {
    const g = await page.evaluate((id) => window.orgai.knowledge.get(id), pid)
    return g.nodes.length >= 4 && g.edges.length >= 2
  }, 120_000)
  check(recorded, 'the mock run recorded 4 items and 2 relations', await page.evaluate((id) => window.orgai.knowledge.get(id).then((g) => `${g.nodes.length} nodes, ${g.edges.length} edges`), pid))
  // The default script then asks for one Edit: allow it so the run reaches Idle (the graph does not depend on it).
  const card = page.locator('section.frame-tray article.decision-card[data-kind="permission"]')
  if (await until(() => card.count().then((n) => n > 0), 30_000)) await card.first().getByRole('button', { name: 'Allow once', exact: true }).click().catch(() => {})
  const idle = await until(async () => /Idle/.test(await runTabText()), 90_000)
  check(idle, 'the run reaches Idle', await runTabText())

  // ======== 1. The neighbourhood of Jane Doe ========
  await openKnowledgeTab()
  const janeId = await selectRow(JANE)
  check(!!janeId, 'Jane Doe is selected in the list', String(janeId))
  await openGraph()
  check(await waitNodes(3), 'Depth 1 draws 3 nodes', String(await nodeCount()))
  const names1 = await nodeNames()
  check(names1.length === 3 && [JANE, ACME, DECISION].every((n) => names1.includes(n)), 'Depth 1 draws Jane Doe, Acme Corp and the decision', names1.join(' | '))
  check(names1.join('|') === [ACME, JANE, DECISION].join('|'), 'the nodes come in list order (creation order: Acme, Jane, the decision)', names1.join(' | '))
  check((await page.locator(`${GRAPH} [data-testid=knowledge-retired-group]`).count()) === 0, 'no retired group: nothing is retired', '')
  check((await page.locator(`${GRAPH} .react-flow[aria-label="Knowledge graph"]`).count()) === 1, 'the flow is labelled "Knowledge graph"')
  const selectedNode = page.locator(`${NODE}.selected [data-testid=knowledge-node]`)
  check((await selectedNode.count()) === 1 && clean(await selectedNode.innerText()).startsWith(JANE), 'the selected node is Jane Doe (the canvas selection cue)', String(await selectedNode.count()))
  // Spoken names.
  const labels = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .react-flow__node`)].map((n) => n.getAttribute('aria-label') ?? ''), GRAPH)
  const jane = labels.find((l) => l.startsWith('Jane Doe, person.')) ?? ''
  check(/^Jane Doe, person\. 2 facts, 2 relations: works at Acme Corp, Migrate billing to Stripe decided by\. Press Enter to open\.$/.test(jane), 'Jane Doe speaks her kind, counts, relations and the Enter hint', jane)
  check(labels.some((l) => /^Acme Corp, organisation\. 1 fact, 1 relation: Jane Doe works at\. Press Enter to open\.$/.test(l)), 'Acme Corp speaks one live fact (the retired one is left out) and its relation', labels.join(' || '))
  check(labels.some((l) => /^Migrate billing to Stripe, decision\. 1 fact, 1 relation: decided by Jane Doe\. Press Enter to open\.$/.test(l)), 'the decision speaks its relation', labels.join(' || '))
  // Depth 2: the same three for this data.
  const depth = page.locator('[data-testid=knowledge-graph-depth]')
  await depth.getByRole('radio', { name: '2', exact: true }).check({ force: true })
  await sleep(500)
  check(await waitNodes(3), 'Depth 2 draws the same 3 nodes for this data', String(await nodeCount()))
  check((await page.locator(GRAPH).getAttribute('data-depth')) === '2', 'the graph records depth 2')
  await depth.getByRole('radio', { name: '1', exact: true }).check({ force: true })
  await sleep(300)
  await shot('graph-depth1-1600-dark')

  // ======== 2. Edge labels at zoom 1 and the titles ========
  for (let i = 0; i < 6 && (await zoomOf()) < 1; i++) {
    await page.locator('[data-testid=knowledge-graph-zoom-in]').click()
    await sleep(250)
  }
  const z = await zoomOf()
  check(z >= 1, 'the canvas zooms to 1 or more', String(z))
  const labelsAt1 = await edgeLabels()
  check(labelsAt1.includes('works at') && labelsAt1.includes('decided by'), 'the edge labels read "works at" and "decided by" at zoom 1', labelsAt1.join(' | '))
  const titles = await edgeTitles()
  check(titles.includes('Jane Doe works at Acme Corp') && titles.some((t) => t.startsWith('Migrate billing to Stripe decided by Jane Doe')), 'every edge carries its sentence as the SVG title', titles.join(' | '))
  for (let i = 0; i < 8 && (await zoomOf()) >= 1; i++) {
    await page.locator('[data-testid=knowledge-graph-zoom-out]').click()
    await sleep(250)
  }
  check((await zoomOf()) < 1 && (await edgeLabels()).length === 0, 'under zoom 1 the labels are hidden and only the titles remain', `${await zoomOf()} ${(await edgeLabels()).join('|')}`)
  await page.locator('[data-testid=knowledge-graph-fit]').click()
  await sleep(400)

  // ======== 3. The legend ========
  await page.locator('[data-testid=knowledge-graph-legend-trigger]').click()
  const legend = page.locator('[data-testid=knowledge-graph-legend]')
  await legend.waitFor({ state: 'visible', timeout: 5000 })
  const kinds = await legend.locator('[data-testid=knowledge-legend-kind]').allInnerTexts()
  check(kinds.map(clean).join('|') === 'Person|Organisation|Decision', 'the legend lists Person, Organisation and Decision in kind order', kinds.join(' | '))
  const rels = await legend.locator('[data-testid=knowledge-legend-relation]').allInnerTexts()
  check(rels.map(clean).join('|') === 'decided by|works at', 'the legend lists the two relations as words', rels.join(' | '))
  check((await legend.locator('[data-testid=knowledge-legend-retired]').count()) === 1 && (await legend.locator('[data-testid=knowledge-legend-group]').count()) === 1, 'the legend has the Retired and the folded group entries')
  const swatchColors = await legend.locator('.knowledge-legend-swatch').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
  check(new Set(swatchColors).size === 3, 'the three kinds have three different colours', swatchColors.join(' | '))
  await shot('graph-legend-1600-dark')
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await activeTestId()) === 'knowledge-graph-legend-trigger', 'Esc closes the legend and focus returns to its button', await activeTestId())

  // ======== 4. Show all ========
  const all = page.locator('[data-testid=knowledge-graph-all]')
  await all.click()
  check(await waitNodes(4), 'Show all draws 4 nodes (the risk too)', String(await nodeCount()))
  check((await nodeNames()).includes(RISK), 'the risk is drawn with Show all', (await nodeNames()).join(' | '))
  check((await page.locator('[data-testid=knowledge-graph-warn]').count()) === 0, 'no warning under 150 items')
  await shot('graph-all-1600-dark')
  await all.click()
  check(await waitNodes(3), 'Show all off returns to the neighbourhood', String(await nodeCount()))

  // ======== 5. Keyboard: skip links, Tab order, Enter, Space, Ctrl+Arrow ========
  await page.locator('[data-testid=knowledge-show-retired]').focus()
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-skip-list', 'Tab after Show retired lands on Skip to list', await activeTestId())
  const skipBox = await page.locator('[data-testid=knowledge-skip-list]').boundingBox()
  check(!!skipBox && skipBox.y >= 0 && skipBox.y < 1000 && skipBox.width > 0, 'the focused skip link is visible', JSON.stringify(skipBox))
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-skip-detail', 'then Skip to detail', await activeTestId())
  await page.keyboard.press('Tab')
  const onDepth = await page.evaluate(() => document.activeElement?.closest('[data-testid=knowledge-graph-depth]') !== null)
  check(onDepth, 'then the Depth control', await activeTestId())
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-graph-all', 'then Show all', await activeTestId())
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-graph-zoom-out', 'then Zoom out', await activeTestId())
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-graph-fit', 'then Zoom in and Fit to view', await activeTestId())
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-graph-legend-trigger', 'then the legend', await activeTestId())
  const focusedNodeName = () => page.evaluate(() => (document.activeElement?.classList.contains('react-flow__node') ? document.activeElement.querySelector('.knowledge-name-text, .hex-name')?.textContent?.trim() : null) ?? null)
  await page.keyboard.press('Tab')
  check((await focusedNodeName()) === ACME, 'Tab reaches the first node in list order (Acme Corp)', String(await focusedNodeName()))
  const ring = await page.evaluate(() => {
    const el = document.activeElement?.querySelector('[data-testid=knowledge-node]')
    if (!el) return ''
    const s = getComputedStyle(el)
    return `${s.outlineStyle} ${s.outlineWidth}`
  })
  check(/solid 2px/.test(ring), 'a focused node shows the 2 px focus ring on the node', ring)
  await page.keyboard.press('Tab')
  check((await focusedNodeName()) === JANE, 'then Jane Doe', String(await focusedNodeName()))
  await page.keyboard.press('Tab')
  check((await focusedNodeName()) === DECISION, 'then the decision', String(await focusedNodeName()))
  // Space selects the focused node; the list shares it.
  await page.keyboard.press('Space')
  await sleep(300)
  const sel = page.locator(`${NODE}.selected [data-testid=knowledge-node]`)
  check((await sel.count()) === 1 && clean(await sel.innerText()).startsWith(DECISION), 'Space selects the decision', String(await sel.count()))
  // Ctrl+Arrow follows a relation (optional in the spec; built): from the decision towards Jane.
  const before = await focusedNodeName()
  for (const key of ['Control+ArrowUp', 'Control+ArrowLeft', 'Control+ArrowRight', 'Control+ArrowDown']) {
    await page.keyboard.press(key)
    await sleep(100)
    if ((await focusedNodeName()) !== before) break
  }
  check((await focusedNodeName()) === JANE, 'Ctrl+Arrow moves focus along a relation to Jane Doe', String(await focusedNodeName()))
  // Enter opens the detail pane with its heading focused.
  await page.keyboard.press('Enter')
  const opened = await until(() => page.evaluate(() => document.activeElement?.id === 'knowledge-detail-heading'), 5000)
  check(opened, 'Enter on a node opens the detail pane and focuses its heading', await activeTestId())
  const detailName = clean(await page.locator('#knowledge-detail-heading').innerText().catch(() => ''))
  check(detailName.includes(JANE), 'the detail pane shows Jane Doe', detailName)
  const sel2 = page.locator(`${NODE}.selected [data-testid=knowledge-node]`)
  check((await sel2.count()) === 1 && clean(await sel2.innerText()).startsWith(JANE), 'the graph selection follows: Jane Doe is selected', String(await sel2.count()))
  // The Skip to list link focuses the list.
  await page.locator('[data-testid=knowledge-skip-list]').focus()
  await page.keyboard.press('Enter')
  await sleep(200)
  const listTarget = await page.evaluate(() => {
    const href = document.querySelector('[data-testid=knowledge-skip-list]')?.getAttribute('href') ?? ''
    const id = href.startsWith('#') ? href.slice(1) : ''
    return { id, hit: !!id && (document.activeElement?.id === id || !!document.activeElement?.closest(`#${CSS.escape(id)}`)) }
  })
  check(listTarget.hit, 'Skip to list moves focus into the list', JSON.stringify(listTarget))
  await page.locator('[data-testid=knowledge-skip-detail]').focus()
  await page.keyboard.press('Enter')
  await sleep(200)
  const detailTarget = await page.evaluate(() => {
    const href = document.querySelector('[data-testid=knowledge-skip-detail]')?.getAttribute('href') ?? ''
    const id = href.startsWith('#') ? href.slice(1) : ''
    return { id, hit: !!id && (document.activeElement?.id === id || !!document.activeElement?.closest(`#${CSS.escape(id)}`)) }
  })
  check(detailTarget.hit, 'Skip to detail moves focus into the detail pane', JSON.stringify(detailTarget))

  // ======== 6. The retired fold: retire Acme Corp through the knowledge API, expand, restore ========
  const acme = await page.evaluate((id) => window.orgai.knowledge.get(id).then((g) => g.nodes.find((n) => n.name === 'Acme Corp')), pid)
  check(!!acme, 'Acme Corp is in the graph', '')
  if (acme) {
    await page.evaluate(({ id, n }) => window.orgai.knowledge.saveNode({ projectId: id, nodeId: n.id, kind: n.kind, name: n.name, retired: true }), { id: pid, n: acme })
    const group = page.locator(`${GRAPH} [data-testid=knowledge-retired-group]`)
    const folded = await until(async () => (await group.count()) === 1 && (await group.first().getAttribute('data-count')) === '1', 15_000)
    check(folded, 'a retired Acme folds into a "1 retired" group under Jane Doe', `${await group.count()}`)
    check(await waitNodes(2), 'the retired node is not drawn one by one (2 nodes left)', String(await nodeCount()))
    check(clean(await group.first().innerText().catch(() => '')).includes('1 retired'), 'the group reads "1 retired"', clean(await group.first().innerText().catch(() => '')))
    const groupLabel = await page.locator(`${NODE}[data-id^="retired:"]`).first().getAttribute('aria-label').catch(() => '')
    check(groupLabel === '1 retired item under Jane Doe. Press Enter to show them.', 'the group speaks its count and parent', String(groupLabel))
    await shot('graph-retired-fold-1600-dark')
    await group.first().locator('[data-testid=knowledge-retired-expand]').click()
    check(await waitNodes(3), 'expanding the group draws Acme Corp again', String(await nodeCount()))
    const retiredNode = page.locator(`${GRAPH} [data-testid=knowledge-node][data-retired=true]`)
    check((await retiredNode.count()) === 1 && clean(await retiredNode.innerText()).includes('Retired'), 'the retired node carries the word Retired', clean(await retiredNode.innerText().catch(() => '')))
    const dashed = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .react-flow__edge.knowledge-edge-retired .react-flow__edge-path`)].map((p) => getComputedStyle(p).strokeDasharray), GRAPH)
    check(dashed.length >= 1 && dashed.every((d) => d && d !== 'none'), 'the retired relation is dashed', dashed.join(' | '))
    await shot('graph-retired-expanded-1600-dark')
    // Show retired draws it as a node without a group too.
    await openList()
    await page.locator('[data-testid=knowledge-show-retired]').click()
    await sleep(300)
    await openGraph()
    check(await waitNodes(3), 'with Show retired on, the retired node draws as a node', String(await nodeCount()))
    check((await page.locator(`${GRAPH} [data-testid=knowledge-retired-group]`).count()) === 0, 'and no group is drawn')
    await openList()
    await page.locator('[data-testid=knowledge-show-retired]').click()
    await sleep(300)
    await page.evaluate(({ id, n }) => window.orgai.knowledge.saveNode({ projectId: id, nodeId: n.id, kind: n.kind, name: n.name, retired: false }), { id: pid, n: acme })
    await sleep(500)
    await openGraph()
    check(await waitNodes(3), 'restoring Acme draws the three nodes again', String(await nodeCount()))
  }

  // ======== 7. A note selected shows the empty message ========
  await openList()
  await selectRow('Kickoff call summary')
  await openGraph()
  const emptyMsg = page.locator('[data-testid=knowledge-graph-empty]')
  check(await until(() => emptyMsg.count().then((n) => n === 1), 5000), 'a selected note shows the empty message', '')
  check(clean(await emptyMsg.innerText().catch(() => '')).startsWith('Select an item in the list to see its relations.'), 'the empty message copy', clean(await emptyMsg.innerText().catch(() => '')))
  await emptyMsg.locator('[data-testid=knowledge-graph-empty-all]').click()
  check(await waitNodes(4), 'its Show all button draws everything', String(await nodeCount()))
  await page.locator('[data-testid=knowledge-graph-all]').click()
  await openList()
  await selectRow(JANE)
  await openGraph()
  check(await waitNodes(3), 'back to the neighbourhood of Jane Doe', String(await nodeCount()))

  // ======== 8. Reduced motion ========
  await setAppearance({ reduceMotion: 'on' })
  check((await page.evaluate(() => document.documentElement.getAttribute('data-reduce-motion'))) === 'on', 'reduced motion is on')
  await depth.getByRole('radio', { name: '2', exact: true }).check({ force: true })
  await sleep(400)
  check(await waitNodes(3), 'the graph re-lays out under reduced motion (no animated fit)', String(await nodeCount()))
  const transitions = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-testid=knowledge-node]`)].map((n) => getComputedStyle(n).transitionProperty), GRAPH)
  check(transitions.every((t) => t === 'none' || t === ''), 'nodes have no transition under reduced motion', transitions.join(' | '))
  await depth.getByRole('radio', { name: '1', exact: true }).check({ force: true })
  await setAppearance({ reduceMotion: 'system' })

  // ======== 9. The four node styles ========
  for (const style of ['compact', 'station', 'hex', 'card']) {
    await setAppearance({ canvas: { nodeStyle: style } })
    const styled = await until(() => page.locator(`${GRAPH} [data-testid=knowledge-node][data-style=${style}]`).count().then((n) => n === 3), 8000)
    check(styled, `node style ${style} draws 3 nodes`, String(await page.locator(`${GRAPH} [data-testid=knowledge-node][data-style=${style}]`).count()))
    const box = await page.locator(`${GRAPH} [data-testid=knowledge-node][data-style=${style}]`).first().boundingBox()
    if (style === 'compact') check(!!box && Math.abs(box.width - 160) <= 1 && Math.abs(box.height - 40) <= 1, 'name tags are 160 x 40', JSON.stringify(box))
    if (style === 'hex') check(!!box && Math.abs(box.width - 120) <= 1 && Math.abs(box.height - 104) <= 1, 'hex tiles are 120 x 104', JSON.stringify(box))
    if (style === 'card') check(!!box && Math.abs(box.width - 220) <= 1 && box.height >= 80, 'cards are 220 wide', JSON.stringify(box))
    await shot(`graph-style-${style}-1600-dark`)
  }

  // ======== 10. Both sizes and themes: no page scroll, the window did not shift ========
  for (const [w, h] of [[1600, 1000], [1024, 640]]) {
    for (const theme of ['dark', 'light']) {
      await setSize(w, h)
      await setTheme(theme)
      await sleep(400)
      const tag = `${w}x${h} ${theme}`
      check(await waitNodes(3), `graph drawn at ${tag}`, String(await nodeCount()))
      await fitsWindow(`graph ${tag}`)
      const ws = await windowShift(page)
      check(ws.ok, `the window did not shift at ${tag}`, JSON.stringify(ws))
      const stage = await page.locator(`${GRAPH} .knowledge-graph-stage`).boundingBox()
      check(!!stage && stage.width >= 480, `the canvas is at least 480 px wide at ${tag}`, JSON.stringify(stage))
      const toolbar = await page.locator('[data-testid=knowledge-graph-toolbar]').boundingBox()
      check(!!toolbar && toolbar.height <= 72, `the toolbar is at most two rows at ${tag}`, JSON.stringify(toolbar))
      await shot(`graph-${w}x${h}-${theme}`)
    }
  }
  await setSize(1600, 1000)
  await setTheme('dark')
} catch (e) {
  check(false, 'script error', String(e?.stack ?? e))
} finally {
  await shot('graph-final').catch(() => {})
  await app.close().catch(() => {})
  fs.rmSync(base, { recursive: true, force: true })
}
finish('knowledge-graph')
