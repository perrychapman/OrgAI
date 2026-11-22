// QA stress pass for the Dashboard and Usage redesign (docs/design/qa-dashboard-usage-redesign.md). Token-free: mock adapter,
// throwaway data dir, synthetic run summaries written into the script's own runs.json. Not part of e2e:free: it prints
// measurements (overflow, animation counts, texts) and takes screenshots rather than asserting a fixed UI.
//   node e2e/qa-dash-usage-stress.mjs
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DATA_DIR, TMP, check, createProject, finish, gotoProjects, launch, log, makeFixtureRepo, relaunch, screenshot, setReduceMotion, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const spawns = Array.from({ length: 15 }, (_, i) => ({ type: 'spawn', id: `w${i}`, name: `Engineer-with-an-extremely-long-agent-handle-${i}-${'x'.repeat(60)}`, description: `Long agent task ${i} ${'description '.repeat(30)}` }))
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-qa-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 60, work: [...spawns, { type: 'tool', name: 'Edit', input: { file_path: 'src/example.ts', old_string: 'a', new_string: 'b' }, ask: true, result: 'ok' }] }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const LONG = (n, s = 'Quarterly-Reconciliation') => (s + '-').repeat(Math.ceil(n / (s.length + 1))).slice(0, n)
const NAMES = [LONG(110), 'プロジェクト名前がとても長いです（日本語）テスト \u{1F680}\u{1F680}', 'مشروع اختبار طويل جدا للواجهة', 'A', 'Zalgo t̶̐͡e̵st', 'Plain project six']
const repos = NAMES.map((_, i) => makeFixtureRepo(`qa-${i}`))
const SIZES = [[1024, 640], [1600, 1000]]
const THEMES = ['dark', 'light']
let { app, page } = await launch({ shotPrefix: 'qa' })
const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
const setTheme = (t) => page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), t)
const metrics = () =>
  page.evaluate(() => {
    const de = document.documentElement
    const wide = [...document.querySelectorAll('[data-testid=dashboard] *, [data-testid=usage-view] *, main *')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.right > de.clientWidth + 1
    })
    const running = document.getAnimations().filter((a) => a.playState === 'running')
    const inf = running.filter((a) => a.effect?.getComputedTiming?.().iterations === Infinity)
    return { sw: de.scrollWidth, cw: de.clientWidth, offscreen: wide.slice(0, 4).map((e) => (e.getAttribute('data-testid') || e.className || e.tagName).toString().slice(0, 50)), running: running.length, infinite: inf.map((a) => a.animationName ?? a.constructor.name), breathe: document.querySelectorAll('[data-breathe]').length }
  })
const report = async (tag) => {
  const m = await metrics()
  log(tag, JSON.stringify(m))
  return m
}
const matrix = async (tag, shotName) => {
  for (const th of THEMES) {
    await setTheme(th)
    for (const [w, h] of SIZES) {
      await setSize(w, h)
      await sleep(900)
      const m = await report(`${tag} ${th} ${w}x${h}`)
      check(m.sw <= m.cw + 1, `${tag} ${th} ${w}x${h}: no horizontal overflow`, `${m.sw} > ${m.cw}`)
      await screenshot(page, `qa-${shotName}-${th}-${w}`)
    }
  }
}
const nav = async (id) => {
  await page.locator(`[data-testid=${id}]`).click()
  await sleep(1200)
}

// ---- 0. empty first launch
await matrix('first-launch', 'first')

// ---- 1. projects with extreme names
const ids = []
for (let i = 0; i < NAMES.length; i++) {
  const p = await createProject(page, { mode: 'existing', path: repos[i], name: NAMES[i], skipSetup: true })
  ids.push(p?.id)
  log('project', i, p?.id, (p?.name ?? '').length)
}
await gotoProjects(page)
await sleep(800)
await matrix('projects-long-no-runs-no-name', 'projects')
check(ids.every(Boolean), 'six projects created', JSON.stringify(ids))

// ---- 2. seed synthetic runs: priced / unpriced / mixed / partial, with and without decisions, over 30 days
const base = { tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, models: [], roles: [], wallMs: 600000, turns: 3, toolCalls: 4, retries: 0, agents: 2, agentsWithoutResult: 0, noResultTokens: 0, nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, updatedAt: Date.now() }
const DAY = 86400000
const mk = (i, over, usageOver) => {
  const started = Date.now() - (over.daysAgo ?? 0) * DAY - (over.hoursAgo ?? 1) * 3600000
  return {
    id: `qa-run-${i}`, projectId: ids[over.p ?? 0], kind: 'work', prompt: over.prompt ?? `Seeded run ${i} ${'very long prompt text '.repeat(15)}`, status: over.status ?? 'finished', startedAt: started, endedAt: started + 600000,
    totalCostUsd: over.cost ?? 0, usage: { ...base, costUsd: over.cost ?? 0, costSource: 'computed', ...usageOver }
  }
}
const runs = []
let n = 0
for (let d = 0; d < 28; d++) {
  runs.push(mk(n++, { daysAgo: d, p: d % 6, cost: 0.4 + (d % 5) * 0.37 }, { decisions: d % 4 })) // priced, decisions 0..3
  if (d % 2 === 0) runs.push(mk(n++, { daysAgo: d, p: (d + 1) % 6, cost: 0 }, { costUsd: null, costSource: 'unknown' })) // unpriced, no decisions field
  if (d % 3 === 0) runs.push(mk(n++, { daysAgo: d, p: (d + 2) % 6, cost: 0.42 }, { costUsd: 0.42, costPartial: true })) // lower bound
}
// a day with very many runs and a huge cost
for (let k = 0; k < 40; k++) runs.push(mk(n++, { daysAgo: 1, p: k % 6, cost: 12345.678 }, { decisions: 250 }))
await app.close().catch(() => {})
const indexFile = path.join(DATA_DIR, 'data', 'runs.json')
const rf = indexFile
fs.mkdirSync(path.dirname(rf), { recursive: true })
const index = fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : { version: 1, runs: [] }
index.runs.push(...runs)
fs.writeFileSync(rf, JSON.stringify(index))
log('seeded', runs.length, 'runs into', rf)
;({ app, page } = await relaunch(app, { shotPrefix: 'qa2' }))
await gotoProjects(page)
await sleep(1500)
await matrix('dash-seeded-history', 'seeded')
const wk = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dash-stat]')].map((b) => b.textContent.replace(/\s+/g, ' ').trim().slice(0, 90)))
log('week cards', JSON.stringify(wk))
const money = await page.evaluate(() => (document.querySelector('[data-testid=dashboard]')?.innerText.match(/\$[\d,.]+\+?/g) ?? []).slice(0, 20))
log('dashboard money strings', JSON.stringify(money))

// ---- 3. Usage page, seeded
await nav('nav-usage')
await matrix('usage-seeded', 'usage')
const usageText = await page.evaluate(() => document.querySelector('[data-testid=usage-view]')?.innerText.replace(/\s+/g, ' ').slice(0, 3500))
log('usage text', usageText)
const bad = await page.evaluate(() => (document.body.innerText.match(/\$0(?![.\d])|\bNaN\b|undefined|\[object/g) ?? []))
log('suspicious strings on usage', JSON.stringify(bad))

// ---- 4. live: many runs, 15 agents each, one decision each
await gotoProjects(page)
for (let i = 0; i < ids.length; i++) await page.evaluate((id) => window.orgai.runs.start({ projectId: id, prompt: 'Stress run' }), ids[i])
await sleep(6000)
await matrix('live-6-runs-15-agents-6-decisions', 'live')
const breathe = await page.evaluate(() => ({ band: document.querySelectorAll('[data-testid=dashboard] [data-breathe]').length, pulseNodes: document.querySelectorAll('[data-testid=dash-pulse-node]').length, signals: document.querySelectorAll('[data-testid=dash-pulse-signal]').length, caption: document.querySelector('[data-testid=dash-pulse-caption]')?.textContent }))
log('breathing', JSON.stringify(breathe))
check(breathe.band <= 12, 'at most 12 breathing marks on the page', String(breathe.band))
check(breathe.pulseNodes <= 12, 'Team pulse draws at most 12 nodes', String(breathe.pulseNodes))
const infinite = await page.evaluate(() => [...new Set(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations === Infinity && document.querySelector('[data-testid=dashboard]')?.contains(a.effect.target)).map((a) => a.animationName))])
log('looping animation names on dashboard', JSON.stringify(infinite))
check(infinite.length <= 2, 'at most two looping animations on the dashboard', JSON.stringify(infinite))
// keyboard: Tab through needs-you inline buttons
const needs = await page.evaluate(() => [...document.querySelectorAll('[data-testid=dash-needs-you] button')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 40)))
log('needs-you buttons', JSON.stringify(needs.slice(0, 14)))
await setSize(1024, 640)
await setTheme('dark')
await sleep(600)
for (const id of ['dash-now', 'dash-needs-you']) {
  const el = page.locator(`[data-testid=${id}]`).first()
  if (await el.count()) {
    await el.scrollIntoViewIfNeeded()
    await el.screenshot({ path: path.join(path.dirname(scriptFile), `${id}.png`) }).catch(() => {})
    await screenshot(page, `qa-live-${id}-1024`)
  }
}
const rowClip = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid=dash-now] .dash-agent-row')].slice(0, 3).map((r) => ({ w: r.clientWidth, sw: r.scrollWidth, kids: [...r.children].map((c) => `${c.className}:${Math.round(c.getBoundingClientRect().width)}`).join(' ') }))
)
log('agent rows', JSON.stringify(rowClip))
const nowRows = await page.evaluate(() => document.querySelectorAll('[data-testid=dash-now] .dash-agent-row').length)
log('agent rows rendered in Right now', nowRows)
// Keyboard: Tab from the top of the page; count stops before reaching the first project tile, and ensure Needs you buttons are reachable
await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : 0))
const stops = []
for (let i = 0; i < 60; i++) {
  await page.keyboard.press('Tab')
  stops.push(await page.evaluate(() => { const e = document.activeElement; return e ? (e.getAttribute('data-testid') || e.getAttribute('aria-label') || e.textContent || e.tagName).toString().replace(/\s+/g, ' ').slice(0, 30) : 'none' }))
}
log('tab stops', JSON.stringify(stops))
// Answer one card inline by keyboard: Allow once must exist and the run must move on
const firstAllow = page.locator('[data-testid=dash-needs-you] button', { hasText: 'Allow once' }).first()
const cards = () => page.evaluate(() => ({ allow: document.querySelectorAll('[data-testid=dash-needs-allow]').length, deny: document.querySelectorAll('[data-testid=dash-needs-deny]').length, head: document.querySelector('[data-testid=dash-needs-you]')?.querySelector('h2,h3')?.textContent, focus: (document.activeElement?.getAttribute('data-testid') || document.activeElement?.tagName) }))
const before1 = await cards()
await firstAllow.focus()
await page.keyboard.press('Enter')
await sleep(1500)
log('needs-you before/after one keyboard Allow once', JSON.stringify([before1, await cards()]))
// Pause motion
const pause = page.locator('[data-testid=dash-pause-motion]')
if (await pause.count()) {
  await pause.click()
  await sleep(600)
  const after = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations === Infinity && document.querySelector('[data-testid=dashboard]')?.contains(a.effect.target)).length)
  check(after === 0, 'Pause motion: no looping animation runs on the dashboard', String(after))
  await pause.click()
}
// reduced motion
await setReduceMotion(page, 'on')
await sleep(600)
const reduced = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations === Infinity && document.querySelector('[data-testid=dashboard]')?.contains(a.effect.target)).length)
check(reduced === 0, 'Appearance reduce motion: no looping animation on the dashboard', String(reduced))
await nav('nav-usage')
const reducedU = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && document.querySelector('[data-testid=usage-view]')?.contains(a.effect.target)).map((a) => a.animationName ?? a.transitionProperty))
log('usage running animations under reduced motion', JSON.stringify(reducedU))
await setReduceMotion(page, 'off')

// ---- 5. layout storage: corrupt, old, hidden everything, stale pin
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)))
const KEY = 'orgai.dashboardLayout'
const variants = {
  junk: 'not json{{', array: '[]', null: 'null', future: '{"v":9,"order":["x"]}', badOrder: '{"v":2,"order":"week","hidden":5,"pinned":{"a":1},"focus":"nope","motionPaused":"yes"}',
  v1: '{"v":1,"order":["resume","today","working","week","engagements","projects"],"hidden":["working"],"pinned":["proj_gone"]}',
  allHidden: JSON.stringify({ v: 2, order: ['week', 'pickup', 'upnext', 'projects', 'engagements', 'commits', 'todos'], hidden: ['week', 'pickup', 'upnext', 'projects', 'engagements', 'commits', 'todos'], pinned: [], focus: 'spend', motionPaused: false }),
  stalePins: JSON.stringify({ v: 2, order: ['week', 'pickup', 'upnext', 'projects', 'engagements', 'commits', 'todos'], hidden: [], pinned: ['proj_deleted_1', ids[0], 'proj_deleted_2'], focus: 'decisions', motionPaused: false }),
  huge: JSON.stringify({ v: 2, order: [], hidden: [], pinned: Array.from({ length: 5000 }, (_, i) => `p${i}`), focus: 'spend', motionPaused: false })
}
await gotoProjects(page)
for (const [name, val] of Object.entries(variants)) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, val])
  await page.reload()
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 20000 }).catch(() => {})
  await sleep(900)
  const st = await page.evaluate(() => ({ ok: !!document.querySelector('[data-testid=dashboard]'), sections: [...document.querySelectorAll('[data-testid=dashboard] section[aria-labelledby], [data-testid=dashboard] section')].map((s) => s.getAttribute('data-testid') || s.id).filter(Boolean), needs: !!document.querySelector('[data-testid=dash-needs-you]'), now: !!document.querySelector('[data-testid=dash-now]'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, stored: (localStorage.getItem('orgai.dashboardLayout') ?? '').slice(0, 60) }))
  log(`layout ${name}`, JSON.stringify(st))
  check(st.ok && st.needs && st.now && st.sw <= st.cw, `layout ${name}: dashboard renders with Needs you and Right now`, JSON.stringify(st))
  if (name === 'allHidden') await screenshot(page, 'qa-all-hidden')
  if (name === 'stalePins') await screenshot(page, 'qa-stale-pins')
}
check(errs.length === 0, 'no page errors from layout variants', errs.join(' | '))
await page.evaluate((k) => localStorage.removeItem(k), KEY)
await page.reload()
await sleep(800)

// ---- 6. Usage: keyboard crosshair, then a period under one fifth elapsed (renderer clock set to 3 Nov)
await nav('nav-usage')
const plot = page.locator('[data-testid=usage-spend-plot]').first()
if (await plot.count()) {
  await plot.focus()
  const v0 = await plot.getAttribute('aria-valuetext')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  const v1 = await plot.getAttribute('aria-valuetext')
  await page.keyboard.press('Home')
  const vh = await plot.getAttribute('aria-valuetext')
  await page.keyboard.press('End')
  const ve = await plot.getAttribute('aria-valuetext')
  log('crosshair', JSON.stringify({ v0, v1, vh, ve, role: await plot.getAttribute('role') }))
  check(v1 !== v0 || vh !== ve, 'chart crosshair moves by arrow keys')
  await page.keyboard.press('Escape')
}
const usageStops = []
await page.evaluate(() => document.activeElement?.blur())
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab')
  usageStops.push(await page.evaluate(() => { const e = document.activeElement; return (e?.getAttribute('data-testid') || e?.getAttribute('aria-label') || e?.textContent || '').replace(/\s+/g, ' ').slice(0, 28) }))
}
log('usage tab stops', JSON.stringify(usageStops))
await page.clock.install({ time: new Date('2026-11-03T12:00:00') })
await page.reload()
await sleep(1500)
await nav('nav-usage')
await page.locator('[data-testid=usage-period]').getByText('This month', { exact: true }).click()
await sleep(1200)
const proj = await page.evaluate(() => [document.querySelector('[data-testid=usage-pacing]')?.getAttribute('data-projection'), document.querySelector('[data-testid=usage-pacing-projection]')?.textContent, document.querySelector('[data-testid=usage-pacing]')?.innerText.replace(/\s+/g, ' ').slice(0, 500)])
log('pacing under a fifth elapsed (clock 3 Nov)', JSON.stringify(proj))
await screenshot(page, 'qa-pacing-early')
await page.clock.setFixedTime(new Date('2026-11-21T12:00:00'))
await page.reload()
await sleep(1500)
await nav('nav-usage')
await page.locator('[data-testid=usage-period]').getByText('This month', { exact: true }).click()
await sleep(1200)
const proj2 = await page.evaluate(() => [document.querySelector('[data-testid=usage-pacing]')?.getAttribute('data-projection'), document.querySelector('[data-testid=usage-pacing-projection]')?.textContent])
log('pacing mid-month with unpriced runs (clock 21 Nov)', JSON.stringify(proj2))
await finish('qa-dash-usage-stress')
await app.close().catch(() => {})
