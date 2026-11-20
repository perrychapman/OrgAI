// Factory Floor, slice 1 (docs/design/factory-floor.md sections 6.6, 7.1, 8, 10.4, 10.5, 12). Token-free: mock adapter, temp data dir.
// Checks: the presentation choice in App settings, the scene mounting in Live (Team keeps the Graph: Factory Floor is
// Live only by owner decision 2026-11-19), the renderer it picked (the script
// passes on either path: 'webgl2' or 'floor-plan'), the developer key that forces the floor plan or the section 8 notices,
// "Use Graph", both themes, both window sizes with no page scroll, zero CSP violations, the mirror group and the hidden
// canvas, and that Pocket Office is still selectable. Slice 2+ checks (layout, stations, cues) are not here.
//
// Software WebGL: this launch (and only this one) adds Chromium's SwiftShader switches so a runner without a GPU still
// takes the 3D path. Measured on Electron here: without them the GPU is used; with them the context reports
// "SwiftShader" and stays webgl2 even with failIfMajorPerformanceCaveat. They are on by default so the 3D path is the same
// everywhere; E2E_FACTORY_SWGL=0 keeps the machine's own GPU. Never added to the product.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { APP_DIR, DATA_DIR, SHOTS_DIR, TMP, check, cleanup, createProject, electronBinary, endSession, finish, log, makeFixtureRepo, openAppSettings, openProject, openTeam, projectTab, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-factory-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E factory floor (orgai test)'
const repo = makeFixtureRepo('factory')
const SWGL = process.env.E2E_FACTORY_SWGL !== '0'
// E2E_FACTORY_PLAN=1 forces the floor plan for the whole run (the developer key below is set before the first mount), so
// every slice 2 case also runs on the path a runner without WebGL2 (GitHub's macOS) takes. Default: the machine's own path.
const PLAN = process.env.E2E_FACTORY_PLAN === '1'
const KEY = 'orgai.factory.renderer'

fs.mkdirSync(SHOTS_DIR, { recursive: true })
const app = await electron.launch({
  executablePath: electronBinary(),
  args: ['--use-mock-keychain', ...(SWGL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []), APP_DIR],
  cwd: APP_DIR,
  timeout: 60_000,
  env: { ...process.env, ORGAI_DATA_DIR: DATA_DIR }
})
const page = await app.firstWindow()
page.on('dialog', (d) => void d.accept())
page.on('console', (m) => {
  if (m.type() === 'error') log('console.error:', m.text().slice(0, 200))
})
page.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 200)))
// Counts CSP violations from the first script of every document (survives reloads in this page).
await page.addInitScript(() => {
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`))
})
await page.waitForSelector('.sidebar', { timeout: 60_000 })
await page.evaluate(() => {
  for (const k of Object.keys(localStorage).filter((x) => x.startsWith('orgai.'))) localStorage.removeItem(k)
  window.__cspViolations = []
  document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`))
})
if (PLAN) await page.evaluate((k) => localStorage.setItem(k, 'floor-plan'), KEY)
await page.reload()
await page.waitForSelector('[data-testid=dashboard], .editor', { timeout: 60_000 })
let shots = 0
const shot = (name) => page.screenshot({ path: path.join(SHOTS_DIR, `factory-floor-${String(++shots).padStart(2, '0')}-${name}.png`) }).catch(() => {})

const resizeTo = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}
const setAppearance = async (patch, canvas = {}) => {
  await page.evaluate(
    async ([p, c]) => {
      const info = await window.orgai.settings.get()
      const { dataDir: _d, appVersion: _v, ...s } = info
      const a = s.appearance
      await window.orgai.settings.set({ ...s, appearance: { ...a, ...p, canvas: { ...a.canvas, ...c } } })
    },
    [patch, canvas]
  )
  await sleep(450)
}
const setCanvas = (c) => setAppearance({}, c)
const html = (n) => page.evaluate((a) => document.documentElement.getAttribute(a), n)
const noPageScroll = () =>
  page.evaluate(() => {
    const s = document.scrollingElement
    return s.scrollHeight <= s.clientHeight + 1 && s.scrollWidth <= s.clientWidth + 1
  })
const scene = (mode) => page.locator(`[data-testid=factory-scene]${mode ? `[data-mode=${mode}]` : ''}`).first()
const state = async () => JSON.parse((await page.locator('[data-testid=factory-state]').first().evaluate((el) => el.textContent || el.value || '{}')) || '{}')
/** Remount the scene (graph, then back) so the developer key is read again. */
const remount = async () => {
  await setCanvas({ presentation: 'graph' })
  await page.locator('[data-testid=factory-scene]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  await setCanvas({ presentation: 'factory-floor' })
}
const setKey = (v) => page.evaluate(([k, val]) => (val === null ? localStorage.removeItem(k) : localStorage.setItem(k, val)), [KEY, v])

/** What every mounted scene must satisfy, whichever renderer it picked. Returns the renderer. */
const checkMounted = async (mode, label) => {
  await scene(mode).waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => !!document.querySelector('[data-testid=factory-scene]')?.getAttribute('data-renderer'), null, { timeout: 20_000 })
  const renderer = await scene(mode).getAttribute('data-renderer')
  check(renderer === 'webgl2' || renderer === 'floor-plan', `${label}: scene mounts with a renderer`, String(renderer))
  const st = await state().catch(() => null)
  check(!!st && st.renderer === renderer && st.mode === mode, `${label}: factory-state agrees with the scene`, JSON.stringify(st)?.slice(0, 200))
  const group = page.locator('[data-testid=factory-floor]').first()
  check((await group.count()) === 1 && (await group.getAttribute('role')) === 'group', `${label}: the mirror group exists`)
  check(/^Factory floor,/.test((await group.getAttribute('aria-label')) ?? ''), `${label}: the mirror's name starts "Factory floor,"`, String(await group.getAttribute('aria-label')))
  const canvases = page.locator('[data-testid=factory-canvas]')
  // The 3D path mounts its canvas once the lazy chunk has loaded, after data-renderer is set.
  if (renderer === 'webgl2') await canvases.first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {})
  if (await canvases.count()) {
    check((await canvases.first().getAttribute('aria-hidden')) === 'true', `${label}: the canvas is aria-hidden`)
    check(renderer === 'webgl2', `${label}: a canvas appears only on the 3D path`)
  } else check(renderer === 'floor-plan', `${label}: no canvas means the floor plan`)
  return renderer
}

// ---------- Slice 2 helpers: live floors of 1, 5, 15 and 40 agents ----------
const workerBtn = (id) => page.locator(`[data-testid=factory-worker][data-factory-worker-id="${id}"]`)
const activeWorkerId = async () => {
  const r = await page.evaluate(() => {
    const a = document.activeElement
    const id = a?.getAttribute?.('data-factory-worker-id') ?? null
    return { id, what: id ? '' : `${a?.tagName}.${a?.className}[${a?.getAttribute?.('data-testid') ?? ''}] scenes=${document.querySelectorAll('[data-testid=factory-scene]').length}` }
  })
  if (!r.id && process.env.E2E_FACTORY_DEBUG) log('focus is not on a worker:', r.what)
  return r.id
}
/** Poll the test state until `pred(state)` holds (the state is written at most twice a second). Returns the state, or null on timeout. */
const untilState = async (pred, timeout = 8000) => {
  const end = Date.now() + timeout
  let st = null
  while (Date.now() < end) {
    st = await state().catch(() => null)
    if (st && pred(st)) return st
    await sleep(150)
  }
  return null
}
/** The camera after a tween: wait until the view stops changing across two reads. */
const settledView = async () => {
  let prev = null
  for (let i = 0; i < 20; i++) {
    const v = (await state()).view
    if (prev && Math.abs(v.ppm - prev.ppm) < 0.005 && Math.abs(v.targetX - prev.targetX) < 0.005 && Math.abs(v.targetZ - prev.targetZ) < 0.005) return v
    prev = v
    await sleep(650)
  }
  return (await state()).view
}

/** The section 3.2 algorithm, written out again here as the test oracle. `agents`: spawn order [{ id, parent }] (parent null = root's reports). */
const FLOOR_LINE = { stationX: (slot) => 6 + 4 * (slot % 8), stationZ: (row) => 1.5 + 7 * row }
function referenceLayout(agents) {
  const lines = new Map([['root', { number: 1, rows: [0], count: 0 }]])
  let nextLine = 2
  let nextRow = 1
  const out = new Map()
  for (const a of agents) {
    const lead = a.parent ?? 'root'
    if (!lines.has(lead)) lines.set(lead, { number: nextLine++, rows: [nextRow++], count: 0 })
    const line = lines.get(lead)
    const slot = line.count++
    const ri = Math.floor(slot / 8)
    if (ri === line.rows.length) line.rows.push(nextRow++)
    const row = line.rows[ri]
    out.set(a.id, { line: line.number, row, slot, x: FLOOR_LINE.stationX(slot), z: FLOOR_LINE.stationZ(row) })
  }
  return out
}
/** The sections 3.3 worked examples, as the spec states them (the oracle above is also checked against these). */
const SPEC_5 = { fa: [1, 0, 0, 6, 1.5], fb: [1, 0, 1, 10, 1.5], fa1: [2, 1, 0, 6, 8.5], fb1: [3, 2, 0, 6, 15.5] }
const SPEC_15 = (() => {
  const t = { fa: [1, 0, 0, 6, 1.5], fb: [1, 0, 1, 10, 1.5], fc: [1, 0, 2, 14, 1.5] }
  for (const [lead, line, row, n] of [['fa', 2, 1, 4], ['fb', 3, 2, 4], ['fc', 4, 3, 3]]) for (let i = 1; i <= n; i++) t[`${lead}${i}`] = [line, row, i - 1, 6 + 4 * (i - 1), 1.5 + 7 * row]
  return t
})()
/** Spawn order of the section 3.3 trees (leads first, then each lead's reports in lead order). */
const TREE_5 = [['fa', null], ['fb', null], ['fa1', 'fa'], ['fb1', 'fb']]
const TREE_15 = [['fa', null], ['fb', null], ['fc', null], ...[['fa', 4], ['fb', 4], ['fc', 3]].flatMap(([lead, n]) => Array.from({ length: n }, (_, i) => [`${lead}${i + 1}`, lead]))]

/** The first role the root may spawn (the mock's own choice), used for every spawn so the roster accepts the script. */
const spawnSlug = async () => {
  const p = await page.evaluate((n) => window.orgai.projects.list().then((l) => l.find((x) => x.name === n)), NAME)
  const root = p.roles.find((r) => r.reportsTo === null)
  const first = p.roles.find((r) => root.spawnable.includes(r.id)) ?? p.roles.find((r) => r.reportsTo !== null)
  return first.slug
}
const writeScript = (work) => fs.writeFileSync(scriptFile, JSON.stringify(work ? { delayMs: 300, work } : { delayMs: 300 }))
const spawnWork = (tree, slug) => [
  ...tree.map(([id, parent]) => ({ type: 'spawn', id, name: id, role: slug, description: `Floor ${id}`, ...(parent ? { parent } : {}) })),
  { type: 'text', text: 'The floor is staffed.' }
]
/** Start a fresh Live run with `prompt` (the previous one is ended first). */
let runsStarted = 0
const startLiveRun = async (prompt) => {
  if (runsStarted++ > 0 || (await page.getByRole('button', { name: 'End session' }).count())) await endSession(page)
  await projectTab(page, 'Live').click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 8000 }).catch(() => {})
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(prompt)
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
}
/** Wait until the mirror has `n` workers and the scene has a readable state of that size. */
const waitForFloor = async (n, extra = () => true, timeout = Number(process.env.E2E_FACTORY_WAIT_MS) || 90_000) => {
  const st = await untilState((s) => s.mode === 'live' && s.workers.length === n && extra(s), timeout)
  const mirrored = await page.waitForFunction((k) => document.querySelectorAll('[data-testid=factory-worker]').length === k, n, { timeout: 10_000 }).then(() => true).catch(() => false)
  if (!st || !mirrored) {
    const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid=factory-worker]')].map((b) => b.getAttribute('data-factory-worker-id')))
    log(`waitForFloor(${n}) gave up: state workers ${st ? st.workers.length : 'unreadable'}, mirror ${ids.length}: ${ids.join(',')}`)
  }
  return st
}

/** Section 3.3: state coordinates and the mirror's data hooks against `expected` (id -> [line, row, slot, x, z]). */
async function checkPlacement(label, st, expected) {
  const booth = await page.locator('[data-testid=factory-worker][data-kind=booth]').getAttribute('data-factory-worker-id')
  check(!!booth, `${label}: the root is the booth`)
  const ids = Object.keys(expected)
  const got = Object.fromEntries(st.workers.map((w) => [w.id, w]))
  const rest = st.workers.filter((w) => w.id !== booth)
  check(rest.length === ids.length && ids.every((id) => got[id]), `${label}: the floor holds exactly the expected stations`, rest.map((w) => w.id).join(','))
  const bad = ids.filter((id) => {
    const w = got[id]
    const e = expected[id]
    return !w || w.line !== e[0] || w.row !== e[1] || w.slot !== e[2] || Math.abs(w.x - e[3]) > 0.01 || Math.abs(w.z - e[4]) > 0.01
  })
  check(bad.length === 0, `${label}: line, row, slot, x and z equal the section 3.3 table`, bad.map((id) => `${id} want ${expected[id]} got ${JSON.stringify(got[id] && [got[id].line, got[id].row, got[id].slot, got[id].x, got[id].z])}`).join('; '))
  await checkMirrorHooks(label, st, booth)
}
/** The mirror buttons' data-line, data-slot and data-kind agree with the state. */
async function checkMirrorHooks(label, st, booth) {
  const leads = new Set(st.lines.map((l) => l.leadId))
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=factory-worker]')].map((b) => ({ id: b.getAttribute('data-factory-worker-id'), line: b.getAttribute('data-line'), slot: b.getAttribute('data-slot'), kind: b.getAttribute('data-kind') }))
  )
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  const wrong = []
  for (const w of st.workers) {
    const r = byId[w.id]
    if (!r) wrong.push(`${w.id}: no button`)
    else if (w.id === booth) {
      if (r.kind !== 'booth') wrong.push(`${w.id}: kind ${r.kind}`)
    } else if (r.line !== String(w.line) || r.slot !== String(w.slot) || r.kind !== (leads.has(w.id) ? 'lead' : 'bench')) wrong.push(`${w.id}: ${JSON.stringify(r)} vs line ${w.line} slot ${w.slot}`)
  }
  check(rows.length === st.workers.length && wrong.length === 0, `${label}: the mirror's data-line, data-slot and data-kind agree with the state`, wrong.slice(0, 3).join('; '))
}

/** Section 6.3 keyboard walk on the mirror. `booth` is the root's id. */
async function keyboardWalk(label, booth) {
  const st0 = await state()
  const stations = st0.workers.filter((w) => w.id !== booth).sort((a, b) => a.row - b.row || a.slot - b.slot)
  const tabStops = await page.locator('[data-testid=factory-worker][tabindex="0"]').count()
  check(tabStops === 1, `${label}: exactly one factory-worker is a Tab stop`, String(tabStops))
  const total = await page.locator('[data-testid=factory-worker]').count()
  check((await page.locator('[data-testid=factory-worker][tabindex="-1"]').count()) === total - 1, `${label}: every other worker has tabindex -1`)
  const press = async (key) => {
    await page.keyboard.press(key)
    await sleep(150)
    return activeWorkerId()
  }
  const first = stations[0]
  await page.locator('[data-testid=factory-worker][tabindex="0"]').focus()
  check(await page.evaluate(() => document.activeElement?.matches('[data-testid=factory-worker]')), `${label}: the Tab stop takes focus`)
  check((await press('Home')) === booth, `${label}: Home goes to the booth`)
  check((await press('ArrowDown')) === first.id, `${label}: Down from the booth goes to row 0 slot 0`, String(await activeWorkerId()))
  check((await press('ArrowUp')) === booth, `${label}: Up from row 0 goes to the booth`)
  await press('ArrowDown')
  const row0 = stations.filter((w) => w.row === 0)
  if (row0.length > 1) {
    check((await press('ArrowRight')) === row0[1].id, `${label}: Right moves to the next slot`)
    check((await press('ArrowLeft')) === row0[0].id, `${label}: Left moves to the previous slot`)
  }
  // Down and Up between rows: a station and the one below it at the same x.
  const below = stations.find((w) => stations.some((o) => o.row === w.row + 1 && Math.abs(o.x - w.x) < 0.01))
  if (below) {
    const target = stations.find((o) => o.row === below.row + 1 && Math.abs(o.x - below.x) < 0.01)
    await workerBtn(below.id).focus()
    check((await press('ArrowDown')) === target.id, `${label}: Down goes to the station below at the same x`, `${below.id} -> ${await activeWorkerId()}, want ${target.id}`)
    const up = await press('ArrowUp')
    check(up === below.id, `${label}: Up returns to the station above`, `${target.id} (row ${target.row}, x ${target.x}) -> ${up}, want ${below.id} (row ${below.row}, x ${below.x}); row above: ${stations.filter((o) => o.row === target.row - 1).map((o) => `${o.id}@${o.x}`).join(' ')}`)
  }
  // Reading order across a row end: last of one row, first of the next.
  const wrapFrom = stations.find((w, i) => stations[i + 1] && stations[i + 1].row > w.row)
  if (wrapFrom) {
    const next = stations[stations.indexOf(wrapFrom) + 1]
    await workerBtn(wrapFrom.id).focus()
    check((await press('ArrowRight')) === next.id, `${label}: Right past the end of a row goes to the next row's first slot`)
    check((await press('ArrowLeft')) === wrapFrom.id, `${label}: Left from a row start goes to the previous row's last slot`)
  }
  const last = stations[stations.length - 1]
  check((await press('End')) === last.id, `${label}: End goes to the last placed station`, `${await activeWorkerId()} want ${last.id}`)
  check((await press('Home')) === booth, `${label}: Home returns to the booth`)

  // Camera keys. The fit value is the reference for "0".
  await page.keyboard.press('0')
  const fit = await settledView()
  check(fit.ppm > 0, `${label}: the view has a scale`, JSON.stringify(fit))
  await page.keyboard.press('+')
  const zin = await untilState((s) => s.view.ppm > fit.ppm + 0.01, 5000)
  check(!!zin, `${label}: + zooms in`, String((await state()).view.ppm))
  const zoomed = await settledView()
  await page.keyboard.press('-')
  const zout = await untilState((s) => s.view.ppm < zoomed.ppm - 0.01, 5000)
  check(!!zout, `${label}: - zooms out`, String((await state()).view.ppm))
  await page.keyboard.press('0')
  const back = await untilState((s) => Math.abs(s.view.ppm - fit.ppm) < 0.05, 5000)
  check(!!back, `${label}: 0 fits again (ppm returns to ${fit.ppm})`, String((await state()).view.ppm))
  for (const [axis, keys] of [['targetX', ['Shift+ArrowRight', 'Shift+ArrowLeft']], ['targetZ', ['Shift+ArrowDown', 'Shift+ArrowUp']]]) {
    const before = (await settledView())[axis]
    let moved = false
    for (const k of keys) {
      await page.keyboard.press(k)
      moved = !!(await untilState((s) => Math.abs(s.view[axis] - before) > 0.01, 3000))
      if (moved) break
    }
    check(moved, `${label}: Shift+Arrow pans (view.${axis} changes)`)
    await settledView()
  }
  await page.keyboard.press('0')
  await settledView()

  // Enter selects: the live inspector opens with the back button, and the worker is the selected Tab stop.
  await workerBtn(last.id).focus()
  await page.keyboard.press('Enter')
  const back2 = page.locator('[data-testid=factory-agent-back]')
  await back2.waitFor({ timeout: 8000 }).catch(() => {})
  check((await back2.count()) === 1, `${label}: Enter selects and opens the live inspector (Back to floor exists)`)
  check((await workerBtn(last.id).getAttribute('aria-current')) === 'true', `${label}: the selected worker has aria-current`)
  check((await page.locator('[data-testid=factory-worker][tabindex="0"]').getAttribute('data-factory-worker-id')) === last.id, `${label}: the selected worker is the Tab stop`)
  await back2.click()
  await sleep(300)
  check((await activeWorkerId()) === last.id, `${label}: Back to floor returns focus to that worker`, String(await activeWorkerId()))
}

/** Section 6.4: Find a worker. `stations` are state workers (not the booth); handles equal ids in these scripts. */
async function findWalk(label, st) {
  const find = page.locator('[data-testid=factory-find]').first()
  const findBtn = (await find.evaluate((el) => el.tagName)) === 'BUTTON' ? find : find.locator('button').first()
  const input = page.locator('[data-testid=factory-find-input]')
  const results = page.locator('[data-testid=factory-find-result]')
  await findBtn.click()
  await input.waitFor({ timeout: 5000 })
  check(true, `${label}: Find opens a search field`)
  const target = st.workers.find((w) => w.row >= 1) ?? st.workers[st.workers.length - 1]
  await input.fill(target.id.toUpperCase())
  await sleep(250)
  check((await results.count()) >= 1 && (await results.first().innerText()).toLowerCase().includes(target.id.toLowerCase()), `${label}: Find filters by handle, case-insensitively`, String(await results.count()))
  const names = await page.evaluate(() => [...document.querySelectorAll('[data-testid=factory-worker] .factory-worker-name')].map((n) => n.textContent ?? ''))
  const nm = names[names.length - 1]
  if (nm) {
    await input.fill(nm.toUpperCase())
    await sleep(250)
    const want = names.filter((n) => n.toLowerCase().includes(nm.toLowerCase())).length
    check((await results.count()) === want, `${label}: Find filters by name, case-insensitively`, `${await results.count()} results, want ${want}`)
  }
  await input.fill('zz-nobody-zz')
  await sleep(250)
  check((await results.count()) === 0 && (await page.getByText('No worker matches “zz-nobody-zz”.').count()) >= 1, `${label}: Find says No worker matches “{query}”.`)
  await input.fill(target.id)
  await sleep(250)
  await results.first().click()
  await sleep(400)
  check((await input.count()) === 0, `${label}: choosing a result closes Find`)
  check((await activeWorkerId()) === target.id, `${label}: the chosen worker's button has focus`, String(await activeWorkerId()))
  check((await workerBtn(target.id).getAttribute('aria-current')) === 'true', `${label}: the chosen worker is selected`)
  check((await page.locator('[data-testid=factory-agent-back]').count()) === 1, `${label}: the chosen worker's inspector opens`)
  await findBtn.click()
  await input.waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await sleep(300)
  check((await input.count()) === 0, `${label}: Escape closes Find`)
  check(await page.evaluate(() => document.activeElement?.closest('[data-testid=factory-find]') !== null || document.activeElement?.matches('[data-testid=factory-find]')), `${label}: Escape returns focus to Find`)
}

/** Section 6.7: the control row, at both sizes. */
async function controlsWalk(label) {
  const bar = page.locator('[data-testid=factory-controls]').first()
  check((await bar.count()) === 1 && (await bar.getAttribute('role')) === 'toolbar', `${label}: factory-controls is a toolbar`)
  check((await bar.getAttribute('aria-label')) === 'Factory floor controls', `${label}: the toolbar is named "Factory floor controls"`, String(await bar.getAttribute('aria-label')))
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    check(await noPageScroll(), `${label}: no page scroll at ${w}x${h}`)
    const box = await bar.boundingBox()
    check(!!box && box.height <= 48.5, `${label}: the control row is at most 48 px tall at ${w}x${h}`, String(box?.height))
  }
  await resizeTo(1024, 640)
  await page.locator('[data-testid=factory-fit]').click()
  const fit = await settledView()
  await page.locator('[data-testid=factory-zoom-in]').click()
  check(!!(await untilState((s) => s.view.ppm > fit.ppm + 0.01, 5000)), `${label}: Zoom in raises view.ppm`)
  const zoomed = await settledView()
  await page.locator('[data-testid=factory-zoom-out]').click()
  check(!!(await untilState((s) => s.view.ppm < zoomed.ppm - 0.01, 5000)), `${label}: Zoom out lowers view.ppm`)
  await settledView()
  await page.locator('[data-testid=factory-zoom-in]').click()
  await settledView()
  await page.locator('[data-testid=factory-fit]').click()
  check(!!(await untilState((s) => Math.abs(s.view.ppm - fit.ppm) < 0.05, 5000)), `${label}: Fit returns view.ppm to ${fit.ppm}`, String((await state()).view.ppm))
}

let projectOpen = false
try {
  await resizeTo(1024, 640)
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')

  // ---------- Settings: choose Factory Floor ----------
  await openAppSettings(page)
  const section = page.locator('[data-testid=canvas-section]')
  await section.waitFor({ timeout: 10_000 })
  const radio = section.locator('[data-testid=canvas-presentation-factory-floor]')
  check((await radio.count()) === 1, 'settings offer the Factory Floor presentation')
  await radio.check({ force: true })
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'factory-floor', null, { timeout: 10_000 }).catch(() => {})
  check((await html('data-canvas-presentation')) === 'factory-floor', 'choosing Factory Floor sets the presentation')
  const saved = await page.evaluate(async () => (await window.orgai.settings.get()).appearance.canvas.presentation)
  check(saved === 'factory-floor', 'the presentation is saved in settings', String(saved))

  // ---------- Factory Floor is Live only (owner decision 2026-11-19): Team keeps the Graph ----------
  await openProject(page, NAME)
  projectOpen = true
  await openTeam(page)
  await page.locator('.react-flow').first().waitFor({ timeout: 15_000 }).catch(() => {})
  check((await page.locator('.react-flow').count()) > 0, 'Team shows the Graph while Factory Floor is chosen')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'Team never mounts the factory scene')
  await shot('team-graph')

  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Factory floor check build')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  const liveRenderer = await checkMounted('live', 'Live')
  const liveName = await page.locator('[data-testid=factory-floor]').first().getAttribute('aria-label')
  check(/^Factory floor, \d+ workers?$/.test(liveName ?? ''), 'Live: the mirror says workers', String(liveName))
  await shot('live')
  log('live renderer:', liveRenderer, 'gpu:', (await state().catch(() => ({}))).perf?.gpu)

  // ---------- Both themes and both sizes (Live) ----------
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setAppearance({ theme })
      for (const mode of ['live']) {
        await scene(mode).waitFor({ timeout: 15_000 })
        const st = await state().catch(() => null)
        check(!!st && ['webgl2', 'floor-plan'].includes(st.renderer), `${mode} scene state readable at ${w}x${h} ${theme}`)
        if (st?.renderer === 'webgl2') check(st.engines === 1, `theme switch keeps one engine at ${w}x${h} ${theme} (${mode})`, String(st.engines))
        check(await noPageScroll(), `${mode} has no page scroll at ${w}x${h} ${theme}`)
        await shot(`${mode}-${w}x${h}-${theme}`)
      }
    }
  }
  await resizeTo(1024, 640)
  await setAppearance({ theme: 'dark' })

  // ---------- Slice 2: live floors of 1, 5, 15 and 40 agents (section 3.3), mock adapter ----------
  // The oracle itself must reproduce the spec's own tables before it judges the app.
  const o5 = referenceLayout(TREE_5.map(([id, parent]) => ({ id, parent })))
  const o15 = referenceLayout(TREE_15.map(([id, parent]) => ({ id, parent })))
  const same = (o, spec) => Object.entries(spec).every(([id, e]) => { const r = o.get(id); return r && [r.line, r.row, r.slot, r.x, r.z].every((v, i) => v === e[i]) })
  check(same(o5, SPEC_5) && same(o15, SPEC_15), 'the test oracle reproduces the section 3.3 tables for 5 and 15 agents')

  const slug = await spawnSlug()
  const boothOf = () => page.locator('[data-testid=factory-worker][data-kind=booth]').getAttribute('data-factory-worker-id')

  // 1 agent: the booth only.
  writeScript([{ type: 'text', text: 'Only the root is on the floor.' }])
  await startLiveRun('Factory floor one agent')
  const s1 = await waitForFloor(1)
  check(!!s1, '1 agent: the floor has one worker', JSON.stringify(s1?.workers.map((w) => w.id)))
  if (s1) {
    check((await page.locator('[data-testid=factory-worker]').count()) === 1 && (await page.locator('[data-testid=factory-worker]').first().getAttribute('data-kind')) === 'booth', '1 agent: the only station is the booth')
    check(s1.vacant === 0 && s1.lines.length <= 1, '1 agent: no vacancies, at most the root line', JSON.stringify(s1.lines))
    check(/^Factory floor, 1 worker$/.test((await page.locator('[data-testid=factory-floor]').getAttribute('aria-label')) ?? ''), '1 agent: the mirror says "1 worker"')
  }
  await shot('floor-1')

  // 5 agents.
  writeScript(spawnWork(TREE_5, slug))
  await startLiveRun('Factory floor five agents')
  const s5 = await waitForFloor(5)
  check(!!s5, '5 agents: the floor holds root plus four stations')
  if (s5) await checkPlacement('5 agents', s5, SPEC_5)
  await shot('floor-5')

  // 15 agents: placement, keyboard walk, Find, controls.
  writeScript(spawnWork(TREE_15, slug))
  await startLiveRun('Factory floor fifteen agents')
  const s15 = await waitForFloor(15)
  check(!!s15, '15 agents: the floor holds root plus fourteen stations')
  if (s15) {
    await checkPlacement('15 agents', s15, SPEC_15)
    const booth = await boothOf()
    await keyboardWalk('15 agents', booth)
    await findWalk('15 agents', await state())
    await controlsWalk('15 agents')
  }
  await shot('floor-15')

  // 40 agents: the mock's [mock:factory-floor] tour (root, 3 leads, 9 sub-leads, 27 workers; ff-w333 removed). Invariants, not a table.
  writeScript(null)
  await startLiveRun('Factory floor forty agents [mock:factory-floor]')
  const s40 = await waitForFloor(39, (s) => s.vacant === 1)
  check(!!s40, '40 agents: 39 stations stand and the removed ff-w333 is one vacant slot', JSON.stringify(s40 && { n: s40.workers.length, vacant: s40.vacant }))
  if (s40) {
    const booth = await boothOf()
    const ids = s40.workers.map((w) => w.id)
    check(!ids.includes('ff-w333'), '40 agents: the removed ff-w333 is not on the floor')
    check(s40.workers.filter((w) => w.id !== booth).every((w) => w.x === 6 + 4 * (w.slot % 8) && w.z === 1.5 + 7 * w.row), '40 agents: every station x = 6 + 4 * (slot % 8) and z = 1.5 + 7 * row')
    const seen = new Set()
    const dup = s40.workers.filter((w) => w.id !== booth).filter((w) => seen.size === seen.add(`${w.x},${w.z}`).size)
    check(dup.length === 0, '40 agents: no two stations share a position', dup.map((w) => w.id).join(','))
    check(s40.workers.filter((w) => w.id !== booth).every((w) => w.slot >= 0 && Math.floor(w.slot / 8) <= w.row), '40 agents: slots are non-negative and rows are real')
    // The oracle in spawn order (ff-w333 spawned, then vacant: its slot is held, so later slots are unaffected).
    const F = ['ff-l1', 'ff-l2', 'ff-l3']
    const order = []
    F.forEach((l, a) => {
      order.push({ id: l, parent: null })
      for (let b = 1; b <= 3; b++) {
        const sub = `ff-s${a + 1}${b}`
        order.push({ id: sub, parent: l })
        for (let c = 1; c <= 3; c++) order.push({ id: `ff-w${a + 1}${b}${c}`, parent: sub })
      }
    })
    const ref = referenceLayout(order)
    // The scene mounted before the first spawn, so placement was incremental: no compaction, ff-w333's slot stays held.
    const refBad = s40.workers.filter((w) => w.id !== booth).filter((w) => { const r = ref.get(w.id); return !r || r.line !== w.line || r.row !== w.row || r.slot !== w.slot }).map((w) => w.id)
    check(refBad.length === 0, '40 agents: stations sit where the append-only algorithm puts them (spawn order, depth first)', refBad.slice(0, 5).join(','))
    const leadsWithReports = F.concat(F.flatMap((l, a) => [1, 2, 3].map((b) => `ff-s${a + 1}${b}`)))
    const lineLeads = new Set(s40.lines.map((l) => l.leadId))
    check(leadsWithReports.every((id) => lineLeads.has(id)) && lineLeads.has(booth), '40 agents: the root and each lead with reports own a line', [...lineLeads].join(','))
    check(s40.lines.length === 13 && s40.lines.some((l) => l.number === 1), '40 agents: 13 lines (root, 3 leads, 9 sub-leads)', JSON.stringify(s40.lines.map((l) => l.number)))
    await checkMirrorHooks('40 agents', s40, booth)
    // The tour's background permission ask (ff-w211) arrives after the removal; a new decision card takes focus on mount
    // (DecisionCard's existing auto-focus), so the keyboard walk starts only once the card is there.
    const card = await page.locator('.decision-card').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
    check(card, '40 agents: the tour\'s permission card is in the tray before the keyboard walk')
    await sleep(400)
    await keyboardWalk('40 agents', booth)
    for (const [w, h] of [[1024, 640], [1600, 1000]]) {
      await resizeTo(w, h)
      check(await noPageScroll(), `40 agents: no page scroll at ${w}x${h}`)
    }
    await resizeTo(1024, 640)
  }
  await shot('floor-40')
  writeScript(null)

  // ---------- Forced floor plan, notices, Use Graph (Live scene, reads the key at mount) ----------
  await setKey('floor-plan')
  await remount()
  await scene('live').waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => document.querySelector('[data-testid=factory-scene]')?.getAttribute('data-renderer') === 'floor-plan', null, { timeout: 10_000 }).catch(() => {})
  check((await scene('live').getAttribute('data-renderer')) === 'floor-plan', 'the developer key forces the floor plan')
  check((await scene('live').getAttribute('data-reason')) === 'forced', 'the forced floor plan reports reason forced')
  const forced = await state()
  check(forced.renderer === 'floor-plan' && forced.reason === 'forced', 'factory-state reports floor-plan / forced', JSON.stringify(forced).slice(0, 160))
  check((await page.locator('[data-testid=factory-canvas]').count()) === 0, 'the forced floor plan has no canvas')
  check((await page.locator('[data-testid=factory-notice]').count()) === 0, 'the forced floor plan shows no notice')
  check((await page.locator('[data-testid=factory-floor]').count()) === 1, 'the floor plan keeps the mirror group')
  check(await noPageScroll(), 'forced floor plan has no page scroll at 1024x640')
  await shot('forced-floor-plan')

  // FactoryScene decides the reason in this order: forced floor-plan, no WebGL2, too many agents, context lost, chunk failed.
  // A machine whose probe finds no WebGL2 (the macOS CI runner: its Live scene is already the floor plan above) therefore
  // can never reach 'chunk-failed': the forced chunk failure is moot and the no-webgl2 notice (no Try 3D again) is correct.
  // With E2E_FACTORY_PLAN the live renderer says nothing about WebGL2, so ask the browser.
  const noWebgl2Here = PLAN ? !(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))) : liveRenderer !== 'webgl2'
  for (const [value, notice, retry] of [['no-webgl2', 'no-webgl2', false], ['chunk-failed', noWebgl2Here ? 'no-webgl2' : 'chunk-failed', !noWebgl2Here]]) {
    await setKey(value)
    await remount()
    await scene('live').waitFor({ timeout: 15_000 })
    await page.locator('[data-testid=factory-notice]').first().waitFor({ timeout: 15_000 }).catch(() => {})
    const n = page.locator('[data-testid=factory-notice]').first()
    check((await n.count()) === 1 && (await n.getAttribute('data-notice')) === notice, `${value}: the ${notice} notice shows`, String(await n.getAttribute('data-notice').catch(() => null)))
    check((await scene('live').getAttribute('data-renderer')) === 'floor-plan' && (await scene('live').getAttribute('data-reason')) === notice, `${value}: the floor plan shows with reason ${notice}`)
    check((await page.locator('[data-testid=factory-use-graph]').count()) === 1, `${value}: Use Graph is offered`)
    if (retry) {
      check((await page.locator('[data-testid=factory-retry-3d]').count()) === 1, 'chunk-failed: Try 3D again is offered')
      await page.locator('[data-testid=factory-retry-3d]').click()
      await sleep(600)
      check((await page.locator('[data-testid=factory-notice]').count()) === 1, 'chunk-failed: Try 3D again fails again while the key is set')
    } else if (value === 'chunk-failed') {
      check((await page.locator('[data-testid=factory-retry-3d]').count()) === 0, 'chunk-failed on a machine without WebGL2: the no-webgl2 notice has no Try 3D again')
    }
    await shot(`notice-${value}`)
  }

  // Use Graph returns to the graph canvas.
  await page.locator('[data-testid=factory-use-graph]').click()
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'graph', null, { timeout: 10_000 }).catch(() => {})
  check((await html('data-canvas-presentation')) === 'graph', 'Use Graph sets the presentation back to Graph')
  await page.locator('.react-flow').first().waitFor({ timeout: 10_000 }).catch(() => {})
  check((await page.locator('.react-flow').count()) > 0, 'the graph canvas shows after Use Graph')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'the scene is gone after Use Graph')

  // Without the key the real path comes back.
  await setKey(PLAN ? 'floor-plan' : null)
  await setCanvas({ presentation: 'factory-floor' })
  const again = await checkMounted('live', 'Live after clearing the key')
  check(again === liveRenderer, 'the same renderer returns once the key is removed', `${liveRenderer} -> ${again}`)

  // ---------- Pocket Office is still selectable ----------
  await setCanvas({ presentation: 'pocket-office' })
  await page.locator('[data-testid=office-scene]').first().waitFor({ timeout: 15_000 }).catch(() => {})
  check((await page.locator('[data-testid=office-scene]').count()) > 0, 'Pocket Office still mounts afterwards')
  check((await page.locator('[data-testid=factory-scene]').count()) === 0, 'no factory scene beside Pocket Office')
  await setCanvas({ presentation: 'graph' })

  // ---------- CSP ----------
  const violations = await page.evaluate(() => window.__cspViolations ?? [])
  check(violations.length === 0, 'zero securitypolicyviolation events', violations.slice(0, 3).join(' | '))
} catch (e) {
  check(false, 'factory-floor script ran to the end', e.stack ?? String(e))
  await shot('failure')
} finally {
  await page.evaluate((k) => localStorage.removeItem(k), KEY).catch(() => {})
  if (projectOpen) await endSession(page).catch(() => {})
  await cleanup(app, page, NAME)
}
finish('factory-floor')
