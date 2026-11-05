// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The Knowledge tab's Graph view, the neural canvas
// (docs/design/knowledge-graph-2.md section 1; testable state in 1.9). An engagement gets a seeded graph of about 65 items
// through the knowledge API (facts name other items, so inferred links exist), then the Graph view is checked: it is a
// canvas and not React Flow, hover card, click, size by appearances, colour and mark per kind, kind chips and search dim in
// place, retired only with the switch, the inferred-links switch, a recall firing nodes (`[mock:knowledge-recall]`),
// reduced motion and List view stopping the loop, the one Tab stop and the keyboard table, no page scroll, and the colour
// contrast of the resolved theme. Screenshots go to e2e/shots/neural/ (gitignored).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SHOTS_DIR, TMP, check, findProject, finish, gotoProjects, launch, log, openProject, openProjectForm, projectTab, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-neural-'))
const wf = path.join(base, 'acme-kickoff')
fs.mkdirSync(wf, { recursive: true })
const SHOT_DIR = path.join(SHOTS_DIR, 'neural')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const NAME = 'E2E Neural graph (orgai test)'
const RECALL_PROMPT = 'Summarise the kickoff [mock:knowledge-recall]'

const { app, page } = await launch({ shotPrefix: 'knowledge-neural' })
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
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, ...p } })
  }, patch)
  await sleep(500)
}
const setTheme = (theme) => setAppearance({ theme })
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
const shot = async (name) => {
  const file = path.join(SHOT_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  log('shot', path.relative(path.join(SHOTS_DIR, '..'), file))
  return file
}
const noPageScroll = async (what) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
  check(o.sw <= o.cw && o.sh <= o.ch + 1, `${what}: the page does not scroll`, JSON.stringify(o))
}
const activeTestId = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? `${document.activeElement?.tagName.toLowerCase() ?? 'none'}#${document.activeElement?.id ?? ''}`)

// ---------------------------------------------------------------- setup
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

/** About 65 items in 11 kinds. Facts name other items (inferred links); relations tie people to organisations and systems. */
function seedPlan() {
  const items = []
  const add = (kind, name, facts = [], summary) => items.push({ kind, name, facts, summary })
  const orgs = ['Acme Corp', 'Globex Industries', 'Initech', 'Umbrella Holdings']
  orgs.forEach((o) => add('organisation', o, [`${o} is a client of the engagement`]))
  const people = ['Jane Doe', 'Tom Okafor', 'Mara Lindqvist', 'Priya Nair', 'Luis Ortega', 'Hanna Berg', 'Sam Whitfield', 'Chen Wei', 'Olu Adeyemi', 'Rosa Marin', 'Ivan Petrov', 'Keiko Tanaka', 'Noah Fischer', 'Aisha Khan', 'Dmitri Volkov', 'Elena Rossi', 'Felix Braun', 'Grace Lee', 'Hugo Martin', 'Ines Costa', 'Jonas Weber', 'Kara Singh', 'Leo Novak', 'Maya Patel']
  people.forEach((p, i) => add('person', p, i % 3 === 0 ? [`Works closely with ${people[(i + 1) % people.length]} on the billing rollout`] : []))
  const systems = ['Billing platform', 'Data warehouse', 'Customer portal', 'Identity provider', 'Ticketing system', 'Legacy export', 'Reporting stack', 'Payment gateway', 'Mail relay', 'Audit log']
  systems.forEach((s, i) => add('system', s, i % 2 === 0 ? [`Owned by ${orgs[i % orgs.length]}`] : []))
  ;['Kickoff call summary', 'Statement of work', 'Data protection addendum', 'Architecture overview', 'Interview notes', 'Rollout checklist'].forEach((d) => add('document', d))
  ;['Migrate billing to Stripe', 'Keep the legacy export for a year', 'Move reporting to the warehouse', 'Adopt single sign-on', 'Freeze changes in December', 'Retire the mail relay'].forEach((d) => add('decision', d))
  ;['Legacy export format undocumented', 'Single admin account', 'Vendor lock-in on the gateway', 'Staff turnover in finance'].forEach((r) => add('risk', r))
  ;['Invoices must be exportable as CSV', 'Audit trail for every change', 'Portal available in French', 'Single sign-on for staff'].forEach((r) => add('requirement', r))
  ;['Go-live date', 'Contract renewal'].forEach((d) => add('deadline', d))
  ;['Weekly steering committee', 'Architecture review'].forEach((m) => add('meeting', m))
  ;['Who signs off the migration?', 'Is the French portal in scope?'].forEach((q) => add('open-question', q))
  ;['Stripe', 'Okta', 'Snowflake'].forEach((v) => add('vendor', v))
  return { items, orgs, people, systems }
}

async function seedGraph(projectId) {
  const plan = seedPlan()
  const out = await page.evaluate(
    async ({ pid, items, orgs, people, systems }) => {
      const ids = new Map()
      for (const it of items) {
        const n = await window.orgai.knowledge.saveNode({ projectId: pid, kind: it.kind, name: it.name, summary: it.summary, facts: it.facts.map((text) => ({ text })) })
        ids.set(it.name, n.id)
      }
      let edges = 0
      const link = async (a, b, relation) => {
        if (!ids.get(a) || !ids.get(b)) return
        await window.orgai.knowledge.saveEdge({ projectId: pid, from: ids.get(a), to: ids.get(b), relation })
        edges++
      }
      for (let i = 0; i < people.length; i++) await link(people[i], orgs[i % orgs.length], 'works-at')
      for (let i = 0; i < systems.length; i++) await link(systems[i], orgs[(i + 1) % orgs.length], 'owned-by')
      for (let i = 1; i < systems.length; i++) await link(systems[i], systems[Math.floor(i / 3)], 'depends-on')
      await link('Migrate billing to Stripe', 'Jane Doe', 'decided-by')
      await link('Keep the legacy export for a year', 'Tom Okafor', 'decided-by')
      await link('Move reporting to the warehouse', 'Mara Lindqvist', 'decided-by')
      await link('Legacy export format undocumented', 'Legacy export', 'affects')
      await link('Single admin account', 'Identity provider', 'affects')
      await link('Vendor lock-in on the gateway', 'Payment gateway', 'affects')
      await link('Stripe', 'Payment gateway', 'owns')
      await link('Okta', 'Identity provider', 'owns')
      await link('Snowflake', 'Data warehouse', 'owns')
      await link('Invoices must be exportable as CSV', 'Billing platform', 'affects')
      await link('Go-live date', 'Billing platform', 'affects')
      await link('Weekly steering committee', 'Jane Doe', 'raised-by')
      await link('Architecture review', 'Priya Nair', 'raised-by')
      await link('Who signs off the migration?', 'Acme Corp', 'can-answer')
      return { nodes: ids.size, edges, janeId: ids.get('Jane Doe'), acmeId: ids.get('Acme Corp') }
    },
    { pid: projectId, ...plan }
  )
  return out
}

const NEURAL = '[data-testid=knowledge-neural]'
const attr = (name) => page.locator(NEURAL).getAttribute(name)
const num = async (name) => Number(await attr(name))
const openKnowledgeTab = async () => {
  await page.locator('[data-testid=tab-knowledge]').click()
  await page.locator('[data-testid=knowledge-view]').waitFor({ timeout: 10_000 })
  await sleep(400)
}
const openGraph = async () => {
  await page.locator('[data-testid=knowledge-view-switch]').getByRole('radio', { name: 'Graph', exact: true }).check({ force: true })
  await page.locator(NEURAL).waitFor({ timeout: 10_000 })
}
const openList = async () => {
  await page.locator('[data-testid=knowledge-view-switch]').getByRole('radio', { name: 'List', exact: true }).check({ force: true })
  await page.locator('[data-testid=knowledge-list]').waitFor({ timeout: 10_000 })
}
const settled = () => until(async () => (await attr('data-settled')) === 'true', 30_000)
/** The option data of every drawn node: id, name (from the spoken label), world position, radius, total, colour and mark. */
const nodeData = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid=knowledge-node]')].map((n) => [
        n.getAttribute('data-id'),
        { name: (n.getAttribute('aria-label') ?? '').split(', ')[0], kind: n.getAttribute('data-kind'), x: Number(n.dataset.x), y: Number(n.dataset.y), r: Number(n.dataset.radius), total: Number(n.dataset.total), color: n.dataset.color, mark: n.dataset.mark, dim: n.dataset.dim, retired: n.dataset.retired }
      ])
    )
  )
const byName = (data, name) => Object.entries(data).find(([, v]) => v.name === name)
/** Screen position (page coordinates) of a node's centre, for pointer moves. */
const screenOfNode = (id) =>
  page.evaluate((nid) => {
    const el = document.querySelector(`[data-testid=knowledge-node][data-id="${nid}"]`)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width / 2 }
  }, id)
const stageBox = () => page.locator('.neural-stage').boundingBox()
/** Frame counting for the honest-loop checks. */
const framesOver = async (ms) => {
  const a = await num('data-frames')
  await sleep(ms)
  return (await num('data-frames')) - a
}

/** Resolved colours from the live tokens (probe element + canvas pixel), as the engine reads them. */
const measureContrast = () =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid=knowledge-neural]')
    const cv = document.createElement('canvas')
    cv.width = cv.height = 1
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    const rgb = (css) => {
      const probe = document.createElement('span')
      probe.style.color = css
      root.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#808080'
      ctx.fillStyle = c
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2]]
    }
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const field = rgb('var(--neural-field)')
    const slots = {}
    for (const n of document.querySelectorAll('[data-testid=knowledge-node]')) slots[n.dataset.kind] = n.dataset.color
    const nodes = Object.entries(slots).map(([kind, slot]) => ({ kind, slot, ratio: ratio(rgb(`color-mix(in srgb, ${slot} var(--neural-node-mix), var(--neural-node-ink))`), field) }))
    return { name: ratio(rgb('var(--text-primary)'), field), synapse: ratio(rgb('var(--neural-synapse)'), field), nodes }
  })

try {
  // ======== Setup ========
  await setSize(1600, 1000)
  await setTheme('dark')
  const project = await createEngagement({ name: NAME, dir: wf })
  check(!!project && project.kind === 'engagement', 'engagement created')
  const pid = project.id
  const seeded = await seedGraph(pid)
  check(seeded.nodes >= 60 && seeded.edges >= 30, 'seeded about 65 items and 40 relations through the knowledge API', JSON.stringify(seeded))
  await openProject(page, NAME)
  await openKnowledgeTab()
  await openGraph()

  // ======== 1. It is a canvas, not React Flow ========
  check(await settled(), 'the layout settles', String(await attr('data-settled')))
  check((await page.locator('.react-flow').count()) === 0, 'no React Flow in the Graph view')
  check((await page.locator(`${NEURAL} canvas`).count()) === 2, 'two stacked canvases draw the field and the pulses')
  check((await num('data-drawn')) === seeded.nodes, 'data-drawn counts every live item', `${await attr('data-drawn')} of ${seeded.nodes}`)
  check((await num('data-edges')) >= 30, 'data-edges counts the recorded relations', String(await attr('data-edges')))
  check((await attr('data-lod')) === 'full', 'about 65 items are the full tier', String(await attr('data-lod')))
  await shot('01-graph-1600-dark')
  await noPageScroll('1600x1000 dark')

  const data0 = await nodeData()
  const [janeId] = byName(data0, 'Jane Doe') ?? []
  const [acmeId] = byName(data0, 'Acme Corp') ?? []
  check(!!janeId && !!acmeId, 'Jane Doe and Acme Corp are options', String(Object.keys(data0).length))
  check(Object.keys(data0).length === seeded.nodes, 'every item has one DOM option up to 300 nodes', `${Object.keys(data0).length}`)

  // ======== 2. Hover shows the card ========
  const jp = await screenOfNode(janeId)
  await page.mouse.move(jp.x + 60, jp.y + 160)
  await page.mouse.move(jp.x, jp.y, { steps: 4 })
  const card = page.locator('[data-testid=knowledge-neural-card]')
  check(await until(async () => (await card.count()) === 1, 3000), 'hovering Jane Doe shows the card')
  await sleep(150)
  check((await card.getAttribute('data-id')) === janeId, 'the card names the hovered node')
  const cardText = (await card.innerText()).replace(/\s+/g, ' ')
  check(/Jane Doe/.test(cardText) && /Person/.test(cardText), 'the card holds the name and the kind', cardText)
  const countText = ((await page.locator('[data-testid=knowledge-neural-card-count]').innerText()) ?? '').trim()
  check(/^Comes up (once|\d+ times): /.test(countText) && /relation/.test(countText), 'the card says how often it comes up', countText)
  check((await card.getAttribute('aria-hidden')) === 'true' && (await card.evaluate((el) => getComputedStyle(el).pointerEvents)) === 'none', 'the card is aria-hidden and takes no pointer events')
  const sb = await stageBox()
  const cb = await card.boundingBox()
  const disc = await screenOfNode(janeId)
  const nearest = (b, p) => Math.hypot(p.x - Math.max(b.x, Math.min(p.x, b.x + b.width)), p.y - Math.max(b.y, Math.min(p.y, b.y + b.height)))
  check(cb.x >= sb.x + 7 && cb.y >= sb.y + 7 && cb.x + cb.width <= sb.x + sb.width - 7 && cb.y + cb.height <= sb.y + sb.height - 7, 'the card sits inside the stage', JSON.stringify({ cb, sb }))
  check(nearest(cb, disc) >= disc.r - 0.5, 'the card never covers the node disc', `${nearest(cb, disc)} vs r ${disc.r}`)
  await shot('02-hover-jane-1600-dark')
  await page.mouse.move(sb.x + 8, sb.y + 8, { steps: 6 })
  check(await until(async () => (await card.count()) === 0, 3000), 'leaving the node hides the card')

  // ======== 3. Click opens the detail; nothing moves ========
  const before = await nodeData()
  const zoomBefore = await attr('data-zoom')
  const screenBefore = await screenOfNode(janeId)
  await page.mouse.click(screenBefore.x, screenBefore.y)
  check(await until(async () => (await page.locator('[data-testid=knowledge-detail-name]').count()) === 1, 4000), 'a click opens the detail panel')
  check(((await page.locator('[data-testid=knowledge-detail-name]').innerText()) ?? '').trim() === 'Jane Doe', 'the detail shows Jane Doe')
  await sleep(500)
  const after = await nodeData()
  check(Object.keys(before).every((id) => before[id].x === after[id]?.x && before[id].y === after[id]?.y), 'no node moved (data-x / data-y) after a click')
  check((await attr('data-zoom')) === zoomBefore, 'data-zoom is unchanged after a click', `${zoomBefore} -> ${await attr('data-zoom')}`)
  const screenAfter = await screenOfNode(janeId)
  check(Math.abs(screenAfter.x - screenBefore.x) <= 1 && Math.abs(screenAfter.y - screenBefore.y) <= 1, 'the clicked node keeps its screen position', `${JSON.stringify(screenBefore)} -> ${JSON.stringify(screenAfter)}`)
  check((await page.locator(`[data-testid=knowledge-node][data-id="${janeId}"]`).getAttribute('aria-selected')) === 'true', 'the clicked node is the selected option')
  check((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'knowledge-node', 'focus stays on the node after a click', await activeTestId())
  await shot('03-selected-jane-1600-dark')
  await page.mouse.click(sb.x + 12, sb.y + 12)
  check(await until(async () => (await page.locator('[data-testid=knowledge-detail-empty]').count()) === 1, 3000), 'a click on empty space clears the selection (knowledge-detail-empty)')

  // ======== 4. Size follows appearances ========
  const rows = Object.values(await nodeData()).sort((a, b) => a.total - b.total)
  const maxTotal = Math.max(...rows.map((r) => r.total))
  const expected = (t) => Math.min(34, 6 + (28 * Math.log2(1 + t)) / Math.log2(1 + Math.max(maxTotal, 16)))
  check(rows.every((r) => Math.abs(r.r - expected(r.total)) <= 0.11), 'every data-radius follows 6 + 28 log2(1 + total) / log2(1 + max(top, 16))', rows.slice(-3).map((r) => `${r.name} ${r.total} -> ${r.r}`).join('; '))
  check(rows.every((r, i) => i === 0 || r.r >= rows[i - 1].r - 0.001), 'radius never decreases as data-total grows')
  check(rows[rows.length - 1].total > rows[0].total && rows[rows.length - 1].r > rows[0].r, 'the largest total has the largest node', `${rows[0].total} -> ${rows[rows.length - 1].total}`)

  // ======== 5. Colour and mark per kind ========
  const byKind = {}
  for (const r of rows) (byKind[r.kind] ??= new Set()).add(`${r.color}|${r.mark}`)
  check(Object.values(byKind).every((set) => set.size === 1), 'one data-color and data-mark per kind', JSON.stringify(Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, [...v]]))))
  const markOf = (k) => [...byKind[k]][0].split('|')[1]
  check(markOf('person') === 'solid' && markOf('deadline') === 'ring' && markOf('vendor') === 'ring-dot', 'person is solid, deadline a ring, a free-form kind ring-dot', `${markOf('person')} ${markOf('deadline')} ${markOf('vendor')}`)
  check(new Set(['person', 'organisation', 'system', 'document', 'decision'].map((k) => [...byKind[k]][0].split('|')[0])).size === 5, 'five common kinds, five slot colours')
  const colorsBefore = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, [...v][0]]))
  await page.evaluate(async (id) => {
    await window.orgai.knowledge.saveNode({ projectId: id, kind: 'regulator', name: 'Financial Conduct Authority' })
  }, pid)
  check(await until(async () => (await num('data-drawn')) === seeded.nodes + 1, 8000), 'a new node arrives after a refetch', String(await attr('data-drawn')))
  await sleep(700)
  const data1 = await nodeData()
  const colorsAfter = {}
  for (const r of Object.values(data1)) colorsAfter[r.kind] = `${r.color}|${r.mark}`
  check(Object.entries(colorsBefore).every(([k, v]) => colorsAfter[k] === v), 'a new kind recolours no other kind')
  check(Object.keys(before).every((id) => before[id].x === data1[id]?.x && before[id].y === data1[id]?.y), 'a new node moves no other node (pinned placement)')
  check(Object.values(data1).some((r) => r.name === 'Financial Conduct Authority'), 'the new node is drawn')
  check((await num('data-fired')) >= 1, 'a new node fires', String(await attr('data-fired')))
  await page.reload()
  await page.waitForSelector('.sidebar')
  await openProject(page, NAME)
  await openKnowledgeTab()
  await openGraph()
  check(await settled(), 'the layout is settled again after a reload')
  const data2 = await nodeData()
  check(Object.keys(data1).every((id) => data1[id].x === data2[id]?.x && data1[id].y === data2[id]?.y), 'the stored layout gives the same positions after a reload (localStorage)')

  // ======== 6. Kind chip and search dim in place ========
  const litAll = await num('data-lit')
  const posBefore = await nodeData()
  await page.locator('[data-testid=knowledge-kind][data-kind=person]').click()
  check(await until(async () => (await num('data-lit')) === 24, 4000), 'the People chip lights 24 nodes (data-lit)', String(await attr('data-lit')))
  const dimmed = await page.locator('[data-testid=knowledge-node][data-dim=true]').count()
  check(dimmed === litAll - 24, 'every other node is dimmed (data-dim)', `${dimmed} of ${litAll}`)
  const posChip = await nodeData()
  check(Object.keys(posBefore).every((id) => posBefore[id].x === posChip[id].x && posBefore[id].y === posChip[id].y), 'a kind filter moves no node')
  await shot('04-kind-people-1600-dark')
  await page.locator('[data-testid=knowledge-kind][data-kind=person]').click()
  check(await until(async () => (await num('data-lit')) === litAll, 4000), 'clearing the chip lights everything again')
  await page.locator('[data-testid=knowledge-search]').fill('acme')
  check(await until(async () => (await num('data-lit')) >= 1 && (await num('data-lit')) < 10, 4000), 'search lights the matches only', String(await attr('data-lit')))
  const litNames = await page.evaluate(() => [...document.querySelectorAll('[data-testid=knowledge-node][data-dim=false]')].map((n) => (n.getAttribute('aria-label') ?? '').split(', ')[0]))
  check(litNames.includes('Acme Corp'), 'Acme Corp is among the lit matches', litNames.join(' | '))
  await shot('05-search-acme-1600-dark')
  await page.locator('[data-testid=knowledge-search]').fill('zzzzz-nothing')
  check(await until(async () => (await page.locator('[data-testid=knowledge-neural-none]').count()) === 1, 4000), 'nothing matching shows knowledge-neural-none')
  check(/No items match zzzzz-nothing\./.test((await page.locator('[data-testid=knowledge-neural-none]').innerText()) ?? ''), 'it names the query')
  await shot('06-none-1600-dark')
  await page.locator('[data-testid=knowledge-clear-filters]').click()
  check(await until(async () => (await num('data-lit')) === litAll && (await page.locator('[data-testid=knowledge-neural-none]').count()) === 0, 4000), 'Clear filters brings everything back', `lit ${await attr('data-lit')} of ${litAll}, none ${await page.locator('[data-testid=knowledge-neural-none]').count()}`)

  // ======== 7. Retired only with the switch ========
  await page.evaluate(async (id) => {
    const g = await window.orgai.knowledge.get(id)
    const n = g.nodes.find((x) => x.name === 'Mail relay')
    await window.orgai.knowledge.saveNode({ projectId: id, nodeId: n.id, kind: n.kind, name: n.name, retired: true })
  }, pid)
  check(await until(async () => (await num('data-drawn')) === seeded.nodes, 8000), 'a retired item leaves the drawn count', String(await attr('data-drawn')))
  const sw = page.locator('[data-testid=knowledge-show-retired]')
  await sw.click()
  check(await until(async () => (await num('data-drawn')) === seeded.nodes + 1, 4000), 'Show retired draws it again', String(await attr('data-drawn')))
  const dataRet = await nodeData()
  check(Object.values(dataRet).some((r) => r.name === 'Mail relay' && r.retired === 'true'), 'the retired option carries data-retired')
  check(Object.keys(data2).every((id) => !dataRet[id] || (data2[id].x === dataRet[id].x && data2[id].y === dataRet[id].y)), 'showing retired moves nothing')
  await shot('07-retired-shown-1600-dark')
  await sw.click()
  check(await until(async () => (await num('data-drawn')) === seeded.nodes, 4000), 'switching it off hides it again')

  // ======== 8. Inferred links ========
  check((await num('data-inferred')) === 0, 'no inferred line is drawn at rest', String(await attr('data-inferred')))
  const sw2 = page.locator('[data-testid=knowledge-inferred-links]')
  const hasSwitch = (await sw2.count()) > 0
  if (hasSwitch) await sw2.click()
  else {
    await page.evaluate((id) => localStorage.setItem(`orgai.knowledgeInferred.${id}`, 'on'), pid)
    await projectTab(page, 'Live').click()
    await openKnowledgeTab()
    await openGraph()
  }
  check(await until(async () => (await num('data-inferred')) > 0, 8000), 'the inferred-links switch draws the suggestions (data-inferred)', String(await attr('data-inferred')))
  await shot('08-inferred-on-1600-dark')
  if (hasSwitch) await sw2.click()
  else {
    await page.evaluate((id) => localStorage.removeItem(`orgai.knowledgeInferred.${id}`), pid)
    await projectTab(page, 'Live').click()
    await openKnowledgeTab()
    await openGraph()
  }
  check(await until(async () => (await num('data-inferred')) === 0, 6000), 'and off again clears them', String(await attr('data-inferred')))
  await settled()

  // ======== 9. A recall fires nodes ========
  const firedBefore = await num('data-fired')
  const run = await page.evaluate(({ id, prompt }) => window.orgai.runs.start({ projectId: id, prompt }), { id: pid, prompt: RECALL_PROMPT })
  const rose = await until(async () => (await num('data-fired')) > firedBefore, 60_000)
  check(rose, 'a recall during a run raises data-fired', `${firedBefore} -> ${await attr('data-fired')}`)
  const firedIds = ((await attr('data-fired-ids')) ?? '').split(',').filter(Boolean)
  const allIds = new Set(Object.keys(await nodeData()))
  check(firedIds.length >= 1 && firedIds.length <= 12 && firedIds.every((id) => allIds.has(id)), 'data-fired-ids holds real node ids (at most 12)', firedIds.join(','))
  await shot('09-recall-fired-1600-dark')
  await page.evaluate((rid) => window.orgai.runs.stop(rid), run.id).catch(() => {})

  // ======== 10. The loop is honest ========
  const rising = await framesOver(1200)
  const animating = await attr('data-animating')
  log('frames in 1.2 s with motion:', rising, 'animating', animating)
  check(animating === 'false' || rising > 5, 'while animating, data-frames rises', `${rising} frames, animating ${animating}`)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await sleep(300)
  check((await attr('data-animating')) === 'false', 'a hidden tab stops the loop (data-animating=false)', String(await attr('data-animating')))
  check((await framesOver(500)) === 0, 'and no frame is drawn while hidden')
  await page.evaluate(() => {
    delete document.visibilityState
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await sleep(300)
  await setAppearance({ reduceMotion: 'on' })
  await sleep(500)
  check((await page.locator('html').getAttribute('data-reduce-motion')) === 'on', 'reduce motion is on')
  check((await attr('data-animating')) === 'false', 'reduced motion: data-animating=false', String(await attr('data-animating')))
  check((await framesOver(500)) === 0, 'reduced motion: data-frames is constant over 500 ms')
  await page.locator('[data-testid=knowledge-neural-zoom-in]').click()
  await sleep(300)
  check((await attr('data-animating')) === 'false' && (await num('data-frames')) > 0, 'a zoom in reduced motion draws once and stops', String(await attr('data-animating')))
  await shot('10-reduced-1600-dark')
  await page.locator('[data-testid=knowledge-neural-fit]').click()
  await sleep(300)
  await setAppearance({ reduceMotion: 'system' })
  await sleep(500)
  await openList()
  await sleep(300)
  check((await page.locator(NEURAL).count()) === 0, 'List view: no canvas is mounted')
  const rafs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0
        const orig = window.requestAnimationFrame
        window.requestAnimationFrame = (cb) => {
          n++
          return orig(cb)
        }
        setTimeout(() => {
          window.requestAnimationFrame = orig
          resolve(n)
        }, 600)
      })
  )
  check(rafs <= 2, 'List view: no animation frame loop runs (frames requested in 600 ms)', String(rafs))
  await openGraph()
  check(await settled(), 'the Graph view comes back settled')

  // ======== 11. Keyboard ========
  await page.locator('[data-testid=knowledge-show-retired]').focus()
  await page.keyboard.press('Tab')
  const tabs = []
  for (let i = 0; i < 3; i++) {
    tabs.push(await activeTestId())
    if (i < 2) await page.keyboard.press('Tab')
  }
  check(tabs[0] === 'knowledge-skip-list' && tabs[1] === 'knowledge-skip-detail' && tabs[2] === 'knowledge-node', 'Tab: skip to list, skip to detail, then one graph option', tabs.join(' > '))
  const firstNode = await page.evaluate(() => document.activeElement?.getAttribute('data-id'))
  const tabStopCount = await page.locator('[data-testid=knowledge-node][tabindex="0"]').count()
  check(tabStopCount === 1, 'exactly one option is a Tab stop (roving tabindex)', String(tabStopCount))
  check((await page.locator('[data-testid=knowledge-neural-nodes]').getAttribute('aria-label')) === 'Knowledge graph', 'the listbox is named "Knowledge graph"')
  const ring = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement)
    return `${s.outlineStyle} ${s.outlineWidth}`
  })
  check(/solid/.test(ring), 'the focused option shows a focus outline', ring)
  check(await until(async () => (await card.count()) === 1, 2000), 'keyboard focus shows the card')
  const rowsNow = Object.values(await nodeData()).sort((a, b) => a.total - b.total)
  const largest = rowsNow[rowsNow.length - 1]
  const data3 = await nodeData()
  check(data3[firstNode]?.total === largest.total, 'focus lands on the largest node when nothing was focused', `${data3[firstNode]?.name}`)
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-neural-zoom-out', 'the next Tab leaves the graph for Zoom out', await activeTestId())
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-neural-fit', 'Zoom in, then Fit to view', await activeTestId())
  await page.keyboard.press('Tab')
  check((await activeTestId()) === 'knowledge-neural-legend-trigger', 'then the Legend button', await activeTestId())
  await page.keyboard.press('Enter')
  const legend = page.locator('[data-testid=knowledge-neural-legend]')
  await legend.waitFor({ state: 'visible', timeout: 4000 })
  const kindsLegend = await legend.locator('[data-testid=knowledge-neural-legend-kind]').count()
  check(kindsLegend === 12, 'the legend lists the kinds in use (12 with the new one)', String(kindsLegend))
  check(/Dotted line: an inferred link, found by matching names in text; it may be wrong/.test((await legend.innerText()) ?? ''), 'the legend explains inferred links')
  await shot('11-legend-1600-dark')
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await activeTestId()) === 'knowledge-neural-legend-trigger', 'Esc closes the legend and focus returns to its button')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Tab')
  const idOf = () => page.evaluate(() => document.activeElement?.getAttribute('data-id'))
  check((await idOf()) === firstNode, 'Shift+Tab returns to the same option', await activeTestId())
  let moved = 0
  for (const [key, test] of [
    ['ArrowRight', (a, b) => b.x > a.x],
    ['ArrowLeft', (a, b) => b.x < a.x],
    ['ArrowDown', (a, b) => b.y > a.y],
    ['ArrowUp', (a, b) => b.y < a.y]
  ]) {
    const from = await idOf()
    await page.keyboard.press(key)
    await sleep(120)
    const to = await idOf()
    if (to !== from) {
      moved++
      const d = await nodeData()
      check(test(d[from], d[to]), `${key} moves to a node in that direction`, `${d[from].name} -> ${d[to].name}`)
    }
  }
  check(moved >= 2, 'arrows move between nodes', String(moved))
  await page.keyboard.press('Control+ArrowRight')
  await page.keyboard.press('Control+ArrowLeft')
  check((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'knowledge-node', 'Ctrl+Arrow keeps focus on an option')
  await page.keyboard.press('Home')
  check((await nodeData())[await idOf()].total === largest.total, 'Home goes to the largest node')
  await page.keyboard.press('End')
  check((await nodeData())[await idOf()].total === rowsNow[0].total, 'End goes to the smallest node')
  for (const ch of 'jane') await page.keyboard.press(ch)
  await sleep(100)
  check((await idOf()) === janeId, 'typing "jane" goes to Jane Doe (type-ahead)', String((await nodeData())[await idOf()]?.name))
  await page.keyboard.press('Space')
  const sel = () => page.locator(`[data-testid=knowledge-node][data-id="${janeId}"]`).getAttribute('aria-selected')
  check(await until(async () => (await sel()) === 'true', 2000), 'Space selects the node')
  await page.keyboard.press('Escape')
  check(await until(async () => (await card.count()) === 0, 2000), 'Esc first hides the card')
  check((await sel()) === 'true', 'the selection is still there after the first Esc')
  await page.keyboard.press('Escape')
  check(await until(async () => (await sel()) === 'false', 2000), 'the second Esc clears the selection')
  check((await idOf()) === janeId, 'focus stays on the node after Esc')
  const z0 = await attr('data-zoom')
  await page.keyboard.press('+')
  await sleep(500)
  const z1 = await attr('data-zoom')
  check(Number(z1) > Number(z0), '+ zooms in', `${z0} -> ${z1}`)
  await page.keyboard.press('-')
  await sleep(500)
  check(Number(await attr('data-zoom')) < Number(z1), '- zooms out', `${z1} -> ${await attr('data-zoom')}`)
  await page.keyboard.press('0')
  await sleep(500)
  await page.keyboard.press('Enter')
  check(await until(async () => (await page.evaluate(() => document.activeElement?.id)) === 'knowledge-detail-heading', 3000), 'Enter opens the detail and focuses its heading', await activeTestId())
  await page.keyboard.press('Escape')
  check(await until(async () => (await idOf()) === janeId, 3000), 'Esc on the heading returns to the node', await activeTestId())
  await shot('12-keyboard-1600-dark')

  // ======== 12. Skip to list ========
  await page.locator('[data-testid=knowledge-skip-list]').focus()
  await page.keyboard.press('Enter')
  check(await until(async () => (await page.locator('[data-testid=knowledge-list]').count()) === 1, 4000), 'Show as list switches to the list')
  await openGraph()
  check(await settled(), 'the graph is back')

  // ======== 13. Sizes and themes: look, no scroll, no shift, contrast ========
  const contrastRows = []
  for (const [w, h] of [
    [1600, 1000],
    [1024, 640]
  ]) {
    await setSize(w, h)
    for (const theme of ['dark', 'light']) {
      await setTheme(theme)
      await sleep(600)
      await settled()
      await noPageScroll(`${w}x${h} ${theme}`)
      const shift = await windowShift(page)
      check(shift.html === 0 && shift.body === 0 && shift.appTop === 0, `${w}x${h} ${theme}: the window does not shift`, JSON.stringify(shift))
      const nb = await stageBox()
      check(nb.width > 400 && nb.height > 300, `${w}x${h} ${theme}: the stage has room`, JSON.stringify(nb))
      await shot(`20-graph-${w}-${theme}`)
      const jp2 = await screenOfNode(janeId)
      if (jp2 && jp2.x > nb.x + 20 && jp2.x < nb.x + nb.width - 20 && jp2.y > nb.y + 20 && jp2.y < nb.y + nb.height - 20) {
        await page.mouse.move(jp2.x + 30, jp2.y + 120)
        await page.mouse.move(jp2.x, jp2.y, { steps: 3 })
        await sleep(350)
        const c2 = await card.boundingBox()
        check(!!c2 && c2.x >= nb.x + 7 && c2.x + c2.width <= nb.x + nb.width - 7 && c2.y >= nb.y + 7 && c2.y + c2.height <= nb.y + nb.height - 7, `${w}x${h} ${theme}: the card stays inside the stage`, JSON.stringify({ c2, nb }))
        await shot(`21-hover-${w}-${theme}`)
        await page.mouse.move(nb.x + 6, nb.y + 6, { steps: 3 })
        await sleep(300)
      }
      contrastRows.push({ w, theme, ...(await measureContrast()) })
    }
  }
  for (const c of contrastRows.filter((c) => c.w === 1600)) {
    log(`contrast ${c.theme}: name on field ${c.name.toFixed(2)}:1; synapse ${c.synapse.toFixed(2)}; nodes ${c.nodes.map((n) => `${n.kind} ${n.ratio.toFixed(2)}`).join(', ')}`)
    check(c.name >= 4.5, `${c.theme}: the name colour on the field is at least 4.5:1`, c.name.toFixed(2))
    check(c.nodes.every((n) => n.ratio >= 3), `${c.theme}: every node colour is at least 3:1 to the field`, c.nodes.filter((n) => n.ratio < 3).map((n) => `${n.kind} ${n.ratio.toFixed(2)}`).join(', '))
  }
  await setSize(1024, 640)
  await setTheme('dark')
  await settled()
  const j3 = await screenOfNode(janeId)
  await page.mouse.click(j3.x, j3.y)
  await sleep(800)
  const j4 = await screenOfNode(janeId)
  const nb2 = await stageBox()
  check(j3.x > nb2.x + nb2.width - 60 || (Math.abs(j4.x - j3.x) <= 1 && Math.abs(j4.y - j3.y) <= 1), 'opening the panel keeps every node where it was (no refit)', `${JSON.stringify(j3)} -> ${JSON.stringify(j4)}`)
  await shot('22-panel-open-1024-dark')
  await noPageScroll('1024x640 panel open')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  await app.close().catch(() => {})
}
finish('knowledge-graph')
