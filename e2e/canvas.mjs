// Canvas themes, phase A (docs/design/canvas-themes.md section 8). Token-free: mock adapter, temp data dir.
// Checks App settings > General > Canvas (gallery, Customise, preview, announce), the toolbar "Canvas style" popover,
// every backdrop on the Live and Team canvases, the three layouts on a [mock:deep-tree] run, compact nodes, the
// minimap (one shape per node, size at 1024x640, never under a popover), and the Team editor following the settings.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { checkPocketOffice } from './pocket-office.mjs'
import { TMP, check, cleanup, createProject, endSession, finish, launch, log, makeFixtureRepo, openAppSettings, openProject, openTeam, projectTab, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-canvas-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E canvas (orgai test)'
const repo = makeFixtureRepo('canvas')
const PATTERNS = ['dots', 'grid', 'none', 'blueprint', 'paper', 'isometric', 'circuit', 'terminal', 'starfield']

const { app, page, shot } = await launch({ shotPrefix: 'canvas' })

const resizeTo = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}

/** Merge into the saved appearance through settings:set (the broadcast re-applies it on <html>). */
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
const html = (name) => page.evaluate((n) => document.documentElement.getAttribute(n), name)
/** The window itself never scrolls: html and body hold the viewport and nothing scrolled them. */
const pageScroll = () =>
  page.evaluate(() => {
    const s = document.scrollingElement
    // What sticks out of the viewport without a clipping ancestor (diagnostics for a failure).
    const out = []
    if (s.scrollHeight > window.innerHeight + 1) {
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.bottom <= window.innerHeight + 1 || r.height === 0) continue
        let clipped = false
        // Walk containing blocks: an absolutely positioned box escapes clipping by static ancestors.
        const abs = getComputedStyle(el).position === 'absolute'
        for (let p = abs ? el.offsetParent : el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p)
          if (o.overflowY !== 'visible' || o.overflowX !== 'visible') {
            clipped = true
            break
          }
        }
        if (!clipped) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}:${Math.round(r.bottom)}`)
        if (out.length > 5) break
      }
    }
    return { sh: s.scrollHeight, sw: s.scrollWidth, ih: window.innerHeight, iw: window.innerWidth, top: s.scrollTop, body: document.body.scrollTop, out }
  })
const noPageScroll = async () => {
  const s = await pageScroll()
  return s.sh <= s.ih + 1 && s.sw <= s.iw + 1 && s.top === 0 && s.body === 0
}

/** Unscaled boxes (flow units) of the stage's nodes, by data-id. */
const flowBoxes = (scope) =>
  page.evaluate((sc) => {
    const out = {}
    for (const n of document.querySelectorAll(`${sc} .react-flow__node`)) {
      const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(n.style.transform)
      if (!m) continue
      out[n.getAttribute('data-id')] = { x: +m[1], y: +m[2], w: n.offsetWidth, h: n.offsetHeight }
    }
    return out
  }, scope)
const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const dist = (a, b) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y)
const intersects = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
/** A reporting line's drawn stroke, width and marker, with the stroke edgeStroke() gives the source node's role colour. */
const edgeInfo = (scope, source, target) =>
  page.evaluate(
    ([sc, s, t]) => {
      const rgbOf = (c) => {
        const el = document.createElement('span')
        el.style.color = c
        document.body.appendChild(el)
        const v = getComputedStyle(el).color
        el.remove()
        return (/(\d+),\s*(\d+),\s*(\d+)/.exec(v) ?? []).slice(1, 4).map(Number)
      }
      const stage = document.querySelector(sc)
      const cs = getComputedStyle(stage)
      const mix = Number.parseFloat(cs.getPropertyValue('--canvas-edge-role-mix'))
      const ink = rgbOf(cs.getPropertyValue('--canvas-edge-ink').trim())
      const node = stage.querySelector(`.react-flow__node[data-id="${s}"] .agent-node, .react-flow__node[data-id="${s}"] .role-node`)
      const role = rgbOf(node?.style.getPropertyValue('--role') ?? '')
      const t01 = Math.max(0, Math.min(100, mix)) / 100
      const expected = `rgb(${role.map((v, i) => Math.round(v * t01 + ink[i] * (1 - t01))).join(', ')})`
      const p = stage.querySelector(`[data-testid="rf__edge-e-${s}-${t}"] path.react-flow__edge-path`)
      if (!p) return null
      const ps = getComputedStyle(p)
      return { stroke: ps.stroke, width: ps.strokeWidth, marker: p.getAttribute('marker-end'), expected, role: role.join(',') }
    },
    [scope, source, target]
  )
const minimapCounts = (scope) =>
  page.evaluate((sc) => ({
    mini: document.querySelectorAll(`${sc} .react-flow__minimap-node`).length,
    nodes: document.querySelectorAll(`${sc} .react-flow__node`).length
  }), scope)

try {
  await resizeTo(1024, 640)
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')

  // ---------- App settings > General > Canvas ----------
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setAppearance({ theme }, { pattern: 'dots', tint: true, edges: 'curved', layout: 'top-down', nodeStyle: 'card', minimap: false })
      await openAppSettings(page)
      const section = page.locator('[data-testid=canvas-section]')
      await section.waitFor({ timeout: 10_000 })
      const order = await page.evaluate(() => {
        const s = document.querySelector('[data-testid=canvas-section]')
        const adv = document.querySelector('[data-testid=settings-advanced]')
        return !!s && (!adv || !!(s.compareDocumentPosition(adv) & Node.DOCUMENT_POSITION_FOLLOWING))
      })
      check(order, `General shows the Canvas section before Advanced settings at ${w}x${h} ${theme}`)
      check((await section.locator('[data-testid=canvas-preview] .react-flow').count()) === 1, `the preview draws a canvas at ${w}x${h} ${theme}`)
      check(
        (await section.locator('[data-preset=default][aria-checked=true]').count()) === 1 && (await section.locator('[data-preset=custom]').count()) === 0,
        `the default canvas shows Default checked and no Custom at ${w}x${h} ${theme}`
      )
      check((await section.locator('[data-preset=default] svg[data-canvas-thumb=dots]').count()) === 1, `the Default entry draws a dots thumbnail at ${w}x${h} ${theme}`)
      check((await section.locator('[role=radiogroup][aria-label="Graph style"] [role=radio][tabindex="0"]').count()) === 1, `the style gallery is one tab stop at ${w}x${h} ${theme}`)
      // Two columns from 720 px of section width: the preview sits beside the gallery, else above it.
      const geo = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel)?.getBoundingClientRect()
        const p = r('[data-testid=canvas-preview]')
        const g = r('[data-testid=canvas-section] .canvas-presets')
        return p && g ? { previewLeftOfOrAbove: p.left >= g.right - 1 ? 'right' : p.bottom <= g.top + 1 ? 'above' : 'overlap', pw: Math.round(p.width), ph: Math.round(p.height) } : null
      })
      check(!!geo && geo.previewLeftOfOrAbove !== 'overlap', `the preview does not overlap the gallery at ${w}x${h} ${theme}`, JSON.stringify(geo))
      check(await noPageScroll(), `no page scroll on App settings at ${w}x${h} ${theme}`, JSON.stringify(await pageScroll()))
      await page.evaluate(() => {
        const sc = document.querySelector('.settings-scroll')
        const s = document.querySelector('[data-testid=canvas-section]')
        if (sc && s) sc.scrollTop += s.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8
      })
      await shot(`settings-${w}x${h}-${theme}`)
      await openProject(page, NAME)
      await sleep(300)
    }
  }

  // Gallery keyboard: arrows pick Blueprint, announce it and keep one tab stop.
  await resizeTo(1024, 640)
  await setAppearance({ theme: 'dark' }, { pattern: 'dots', tint: true, edges: 'curved', layout: 'top-down', nodeStyle: 'card', minimap: false })
  await openAppSettings(page)
  const section = page.locator('[data-testid=canvas-section]')
  await section.waitFor({ timeout: 10_000 })
  await section.locator('[data-preset=default]').focus()
  await page.keyboard.press('ArrowRight')
  await sleep(500)
  check((await html('data-canvas-pattern')) === 'blueprint', 'ArrowRight in the gallery applies Blueprint on <html>', String(await html('data-canvas-pattern')))
  check((await section.locator('[data-testid=canvas-preview] [data-testid=canvas-backdrop]').getAttribute('data-pattern')) === 'blueprint', 'the preview draws the Blueprint backdrop')
  check((await section.locator('[data-testid=canvas-announce]').innerText()).trim() === 'Canvas style: Blueprint.', 'the pick is announced', await section.locator('[data-testid=canvas-announce]').innerText())
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-preset') === 'blueprint'), 'focus follows the checked option')
  check((await section.locator('[role=radio][tabindex="0"]').count()) === 1 && (await section.locator('[data-preset=custom]').count()) === 0, 'one tab stop and no Custom option once a preset is checked')
  await page.keyboard.press('ArrowRight')
  await sleep(500)
  check((await html('data-canvas-layout')) === 'radial' && (await html('data-canvas-pattern')) === 'starfield', 'the next arrow applies Constellation (starfield, radial)')
  check((await section.locator('[data-testid=canvas-preview] .react-flow[data-layout=radial]').count()) === 1, 'the preview follows the radial layout')
  check((await section.locator('[data-testid=canvas-preview] circle.canvas-ring').count()) >= 1, 'the preview draws ring guides in radial')
  check((await section.locator('[data-testid=canvas-preview] .agent-node[data-style=compact]').count()) >= 1, 'the preview draws name tags for Constellation')
  await shot('settings-constellation')

  // Customise: a Background change leaves every preset, so Custom shows checked.
  const customise = section.locator('[data-testid=canvas-customise]')
  if ((await customise.getAttribute('aria-expanded')) !== 'true') await customise.click()
  await section.locator('[data-testid=canvas-backdrop-select]').selectOption('grid')
  await sleep(500)
  check((await html('data-canvas-pattern')) === 'grid', 'Customise > Background Grid applies on <html>')
  check((await section.locator('[data-preset=custom][aria-checked=true]').count()) === 1, 'Custom appears checked after a Customise change')
  check((await section.locator('[data-testid=canvas-announce]').innerText()).trim() === 'Canvas style: Custom.', 'leaving the presets is announced as Custom')
  await section.locator('[data-testid=canvas-layout]').getByText('Left to right', { exact: true }).click()
  await section.locator('[data-testid=canvas-node-style]').getByText('Cards', { exact: true }).click()
  await sleep(400)
  check((await html('data-canvas-layout')) === 'left-right' && (await html('data-canvas-node-style')) === 'card', 'Layout and Agents as apply on <html>')
  await section.locator('[data-testid=canvas-minimap]').click()
  await sleep(300)
  check((await html('data-canvas-minimap')) === 'on', 'the Minimap switch applies on <html>')
  await shot('settings-customise')

  // Phase B: Subway and Hive are in the gallery and apply by arrow keys.
  for (const [preset, style] of [['subway', 'station'], ['hive', 'hex']]) {
    check((await section.locator(`[data-preset=${preset}]`).count()) === 1, `the gallery lists ${preset}`)
    await section.locator('[role=radio][tabindex="0"]').first().focus()
    let reached = false
    for (let i = 0; i < 16 && !reached; i++) {
      await page.keyboard.press('ArrowRight')
      await sleep(120)
      reached = await page.evaluate((p) => document.activeElement?.getAttribute('data-preset') === p, preset)
    }
    await sleep(400)
    check(reached && (await section.locator(`[data-preset=${preset}]`).getAttribute('aria-checked')) === 'true', `arrow keys reach and check ${preset}`)
    check((await html('data-canvas-node-style')) === style, `${preset} sets data-canvas-node-style=${style}`, String(await html('data-canvas-node-style')))
    check((await section.locator('[role=radio][tabindex="0"]').count()) === 1, `the gallery is still one tab stop on ${preset}`)
    check((await section.locator('[data-testid=canvas-preview] .react-flow').count()) === 1, `the preview still draws on ${preset}`)
    await shot(`settings-${preset}`)
  }

  // Default entry: Blueprint, then arrow back to Default restores the way OrgAI starts.
  await section.locator('[data-preset=blueprint]').click()
  await sleep(500)
  check((await html('data-canvas-pattern')) === 'blueprint', 'picking Blueprint applies it')
  await section.locator('[data-preset=blueprint]').focus()
  await page.keyboard.press('ArrowLeft')
  await sleep(500)
  check((await section.locator('[data-preset=default]').getAttribute('aria-checked')) === 'true', 'ArrowLeft from Blueprint checks Default')
  check((await html('data-canvas-pattern')) === 'dots' && (await html('data-canvas-node-style')) === 'card', 'Default sets dots and cards on <html>')
  check((await section.locator('[data-testid=canvas-announce]').innerText()).trim() === 'Canvas style: Default.', 'Default is announced')

  // The preview stays in view while Customise controls scroll (one column, 1024x640).
  await resizeTo(1024, 640)
  if ((await customise.getAttribute('aria-expanded')) !== 'true') await customise.click()
  const minimapSwitch = section.locator('[data-testid=canvas-minimap]')
  await minimapSwitch.focus()
  await page.evaluate(() => {
    const sc = document.querySelector('.settings-scroll')
    const m = document.querySelector('[data-testid=canvas-minimap]')
    if (sc && m) sc.scrollTop += m.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom + 24
  })
  await sleep(300)
  const stick = await page.evaluate(() => {
    const sc = document.querySelector('.settings-scroll').getBoundingClientRect()
    const p = document.querySelector('[data-testid=canvas-preview]').getBoundingClientRect()
    const m = document.querySelector('[data-testid=canvas-minimap]').getBoundingClientRect()
    return { sc: { top: sc.top, bottom: sc.bottom }, p: { top: p.top, bottom: p.bottom }, m: { top: m.top, bottom: m.bottom }, scrolled: document.querySelector('.settings-scroll').scrollTop }
  })
  check(stick.scrolled > 0 && stick.p.top >= stick.sc.top - 1 && stick.p.bottom <= stick.sc.bottom + 1, 'at 1024x640 the preview stays inside the settings view after scrolling to Minimap', JSON.stringify(stick))
  check(stick.m.top >= stick.p.bottom - 1 && stick.m.bottom <= stick.sc.bottom + 1, 'the focused Minimap switch is not covered by the preview', JSON.stringify(stick))
  await shot('settings-sticky-preview')
  check((await windowShift(page)).ok, 'scrolling the settings does not shift the window')

  // ---------- Live run: a deep tree ----------
  await openProject(page, NAME)
  await setCanvas({ pattern: 'dots', tint: true, edges: 'curved', layout: 'top-down', nodeStyle: 'card', minimap: false })
  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Canvas check [mock:deep-tree] build')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  await page.locator('[data-testid=done-group][data-count="3"]').waitFor({ timeout: 40_000 }).catch(() => {})
  // Show every agent: root -> mock-lead -> two reports.
  const fold = page.getByRole('switch', { name: 'Hide finished agents' })
  if ((await fold.getAttribute('aria-checked')) === 'true') await fold.click()
  await sleep(800)
  const STAGE = '.run-body .frame-stage'
  const ids = Object.keys(await flowBoxes(STAGE))
  check(ids.length === 4, 'the deep-tree run shows four agents with Hide finished off', ids.join(','))
  const rootId = ids.find((id) => id !== 'mock-lead' && !id.startsWith('mock-lead-report')) ?? 'root'
  const reportIds = ids.filter((id) => id.startsWith('mock-lead-report'))

  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setAppearance({ theme })
      for (const pattern of PATTERNS) {
        await setCanvas({ pattern })
        const drawn = await page.locator(`${STAGE} [data-testid=canvas-backdrop]`).getAttribute('data-pattern').catch(() => null)
        const ok = drawn === pattern && (await noPageScroll())
        check(ok, `Live draws the ${pattern} backdrop with no page scroll at ${w}x${h} ${theme}`, String(drawn))
        if (pattern === 'terminal') check((await page.locator(`${STAGE} .canvas-scanlines`).count()) === 1, `Terminal adds scanlines at ${w}x${h} ${theme}`)
        if (w === 1024 || ['blueprint', 'terminal', 'starfield'].includes(pattern)) await shot(`live-${pattern}-${w}x${h}-${theme}`)
      }
    }
  }
  await resizeTo(1024, 640)
  await setAppearance({ theme: 'dark' }, { pattern: 'dots' })

  // Terminal stays a dark console in the light theme; the toolbar keeps its light surface.
  await setAppearance({ theme: 'light' }, { pattern: 'terminal' })
  const term = await page.evaluate(() => {
    const lum = (c) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
      return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : -1
    }
    const name = document.querySelector('.run-body .agent-node .name')
    const bar = document.querySelector('.run-body .frame-toolbar') ?? document.querySelector('.run-body .canvas-frame')
    return { text: name ? getComputedStyle(name).color : '', bar: bar ? lum(getComputedStyle(bar).backgroundColor) : -1, barBg: bar ? getComputedStyle(bar).backgroundColor : '' }
  })
  check(term.text === 'rgb(182, 242, 198)', 'Terminal in light: node text is the phosphor colour', term.text)
  check(term.bar === -1 || term.bar > 0.6 || /rgba\(0, 0, 0, 0\)/.test(term.barBg), 'Terminal in light: the toolbar keeps its light surface', JSON.stringify(term))
  await shot('live-terminal-light-1024')
  await setAppearance({ theme: 'dark' }, { pattern: 'dots' })

  // Layouts.
  await setCanvas({ layout: 'top-down', nodeStyle: 'card' })
  await sleep(500)
  let b = await flowBoxes(STAGE)
  check(!!b[rootId] && !!b['mock-lead'] && b['mock-lead'].y >= b[rootId].y + b[rootId].h - 1, 'top down: the lead sits below the root', JSON.stringify(b))
  await setCanvas({ layout: 'left-right' })
  await sleep(600)
  b = await flowBoxes(STAGE)
  check(
    !!b[rootId] && !!b['mock-lead'] && b['mock-lead'].x >= b[rootId].x + b[rootId].w - 1 && reportIds.every((r) => b[r] && b[r].x >= b['mock-lead'].x + b['mock-lead'].w - 1),
    'left to right: each report sits right of its parent',
    JSON.stringify(b)
  )
  check((await page.locator(`${STAGE} .react-flow[data-layout=left-right]`).count()) === 1, 'the Live canvas carries data-layout=left-right')
  // The reporting line leaves the root from its right side (handles follow the layout).
  const edgeStart = await page.evaluate((root) => {
    const p = document.querySelector(`.run-body .react-flow__edge[data-id^="e-${root}-"] path.react-flow__edge-path`) ?? document.querySelector(`.run-body [data-testid^="rf__edge-e-${root}-"] path`)
    const m = p && /M\s*(-?[\d.]+)[ ,](-?[\d.]+)/.exec(p.getAttribute('d') ?? '')
    return m ? { x: +m[1], y: +m[2] } : null
  }, rootId)
  check(!!edgeStart && Math.abs(edgeStart.x - (b[rootId].x + b[rootId].w)) <= 4, 'left to right: the root\'s reporting line leaves from its right side', JSON.stringify({ edgeStart, root: b[rootId] }))
  await shot('live-left-right')
  await setCanvas({ layout: 'radial' })
  await sleep(700)
  b = await flowBoxes(STAGE)
  const rings = await page.locator(`${STAGE} circle.canvas-ring`).count()
  check((await page.locator(`${STAGE} .react-flow[data-layout=radial]`).count()) === 1, 'the Live canvas carries data-layout=radial')
  check(rings === 2, 'radial: one ring guide per depth (2 for the deep tree)', String(rings))
  const dLead = b['mock-lead'] && b[rootId] ? dist(b['mock-lead'], b[rootId]) : 0
  const dReports = reportIds.map((r) => (b[r] ? dist(b[r], b[rootId]) : 0))
  check(dLead > 100 && dReports.every((d) => d > dLead + 50) && Math.abs(dReports[0] - dReports[1]) < 2, 'radial: the lead is on ring 1 and both reports on ring 2', JSON.stringify({ dLead, dReports }))
  check((await page.locator(`${STAGE} .react-flow__edge-radial`).count()) >= 3, 'radial: reporting lines use the radial edge type')
  await shot('live-radial')

  // Compact nodes: 160 x 40 pills.
  await setCanvas({ layout: 'top-down', nodeStyle: 'compact' })
  await sleep(700)
  const pills = await page.locator(`${STAGE} .agent-node`).evaluateAll((els) => els.map((e) => ({ s: e.getAttribute('data-style'), w: e.offsetWidth, h: e.offsetHeight })))
  check(pills.length === 4 && pills.every((p) => p.s === 'compact' && Math.abs(p.w - 160) <= 1 && Math.abs(p.h - 40) <= 1), 'name tags are data-style=compact and 160 x 40', JSON.stringify(pills))
  check(!!(await page.locator(`${STAGE} .agent-node`).first().getAttribute('title')), 'a name tag carries the card text in its tooltip')
  // H1 (ux-review-canvas-themes-2): the tag shows the handle (the tooltip's first line), so two reports of one role differ.
  const tags = await page.locator(`${STAGE} .react-flow__node`).evaluateAll((els) =>
    els
      .filter((e) => (e.getAttribute('data-id') ?? '').startsWith('mock-lead-report'))
      .map((e) => {
        const n = e.querySelector('.agent-node .name')
        return { text: (n?.textContent ?? '').replace(/\s+/g, ''), first: (e.querySelector('.agent-node')?.getAttribute('title') ?? '').split('\n')[0] }
      })
  )
  check(
    tags.length === 2 && tags[0].text !== tags[1].text && tags.every((t) => t.text.split('…').every((part) => t.first.includes(part))),
    'name tags show each report\'s handle, so two reports of one role read differently',
    JSON.stringify(tags)
  )
  // H1: Enter on a focused node selects it (keyboard users reach the side panel).
  await page.locator(`${STAGE} .react-flow__node[data-id="mock-lead"]`).focus()
  await page.keyboard.press('Enter')
  await sleep(300)
  check((await page.locator(`${STAGE} .react-flow__node[data-id="mock-lead"] .agent-node.selected`).count()) === 1, 'Enter on a focused name tag selects it')
  await page.locator(`${STAGE} .react-flow__node[data-id="${rootId}"]`).focus()
  await page.keyboard.press('Space')
  await sleep(300)
  check((await page.locator(`${STAGE} .react-flow__node[data-id="${rootId}"] .agent-node.selected`).count()) === 1, 'Space on a focused name tag selects it')
  await fold.click()
  await sleep(900)
  const grp = await page.locator(`${STAGE} [data-testid=done-group]`).first().evaluate((e) => ({ s: e.getAttribute('data-style'), w: e.offsetWidth, h: e.offsetHeight })).catch(() => null)
  check(!!grp && grp.s === 'compact' && Math.abs(grp.w - 160) <= 1 && Math.abs(grp.h - 40) <= 1, 'a folded group is a 160 x 40 name tag too', JSON.stringify(grp))
  await shot('live-compact-folded')
  await fold.click()
  await sleep(700)
  await setCanvas({ nodeStyle: 'card' })

  // Minimap: one shape per node, a third of the stage at most at 1024x640, never under a popover.
  await setCanvas({ minimap: true })
  await sleep(800)
  let mm = await minimapCounts(STAGE)
  check(mm.nodes === 4 && mm.mini === mm.nodes, 'Live minimap draws one shape per canvas node', JSON.stringify(mm))
  const sizes = await page.evaluate(() => {
    const m = document.querySelector('.run-body .react-flow__minimap')?.getBoundingClientRect()
    const s = document.querySelector('.run-body .frame-stage')?.getBoundingClientRect()
    return m && s ? { mh: m.height, sh: s.height, mw: m.width, sw: s.width } : null
  })
  check(!!sizes && sizes.mh <= 0.34 * sizes.sh + 1, 'at 1024x640 the minimap is at most about a third of the stage height', JSON.stringify(sizes))
  const miniBox = await page.locator('.run-body .react-flow__minimap').boundingBox()
  await page.locator('[data-testid=canvas-legend-trigger]').click()
  await sleep(300)
  const legendBox = await page.locator('[data-testid=canvas-legend]').boundingBox()
  check(!intersects(miniBox, legendBox), 'the legend popover does not land on the minimap', JSON.stringify({ miniBox, legendBox }))
  await shot('live-minimap-legend')
  await page.keyboard.press('Escape')
  await sleep(200)
  await fold.click()
  await sleep(900)
  mm = await minimapCounts(STAGE)
  check(mm.mini === mm.nodes && mm.nodes === 2, 'with Hide finished on the minimap still matches the canvas (root and group)', JSON.stringify(mm))
  await fold.click()
  await sleep(600)

  // Reduced motion: no animated edges.
  await setAppearance({ reduceMotion: 'on' })
  check((await page.locator(`${STAGE} .react-flow__edge.animated`).count()) === 0, 'reduced motion leaves no animated edge')
  await setAppearance({ reduceMotion: 'system' })

  // ---------- Phase B: Subway (station) and Hive (hex) on the deep-tree run ----------
  await resizeTo(1024, 640)
  await setAppearance({ theme: 'dark' }, { pattern: 'none', edges: 'orthogonal', layout: 'left-right', nodeStyle: 'station', tint: false })
  await sleep(700)
  const styleOf = (sel) => page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-style')))
  let st = await styleOf(`${STAGE} .agent-node`)
  check(st.length === 4 && st.every((s) => s === 'station'), 'Subway: every agent is data-style=station', JSON.stringify(st))
  const leadLines = await Promise.all(reportIds.map((r) => edgeInfo(STAGE, 'mock-lead', r)))
  const rootLine = await edgeInfo(STAGE, rootId, 'mock-lead')
  check(leadLines.length === 2 && leadLines.every((l) => !!l && l.stroke === l.expected), 'Subway: the lines leaving mock-lead are the lead\'s role colour mixed by edgeStroke', JSON.stringify(leadLines))
  check(!!leadLines[0] && !!leadLines[1] && leadLines[0].stroke === leadLines[1].stroke, 'Subway: both lines leaving mock-lead share one stroke')
  check(!!rootLine && rootLine.stroke === rootLine.expected, 'Subway: the root line is the root\'s role colour mixed by edgeStroke', JSON.stringify(rootLine))
  if (rootLine && leadLines[0] && rootLine.role !== leadLines[0].role) check(rootLine.stroke !== leadLines[0].stroke, 'Subway: the line into mock-lead differs from its own lines', JSON.stringify({ rootLine, lead: leadLines[0] }))
  check([rootLine, ...leadLines].every((l) => !!l && l.width === '6px' && (!l.marker || l.marker === 'none')), 'Subway: lines are 6 px with no arrow', JSON.stringify([rootLine, ...leadLines]))
  await fold.click()
  await sleep(900)
  st = await styleOf(`${STAGE} [data-testid=done-group]`)
  check(st.length >= 1 && st.every((s) => s === 'station'), 'Subway: the folded group is data-style=station', JSON.stringify(st))
  check((await page.locator(`${STAGE} [data-testid=done-group] .station-terminus`).count()) >= 1, 'Subway: a folded group draws a terminus bar')
  await fold.click()
  await sleep(700)

  await setCanvas({ pattern: 'isometric', edges: 'straight', layout: 'radial', nodeStyle: 'hex', tint: false })
  await sleep(900)
  st = await styleOf(`${STAGE} .agent-node`)
  check(st.length === 4 && st.every((s) => s === 'hex'), 'Hive: every agent is data-style=hex', JSON.stringify(st))
  check((await page.locator(`${STAGE} .react-flow[data-layout=radial]`).count()) === 1, 'Hive: the canvas is radial')
  check((await page.locator(`${STAGE} circle.canvas-ring`).count()) === 0, 'Hive: no ring guides (the honeycomb replaces them)')
  const hexBoxes = await flowBoxes(STAGE)
  const hexIds = Object.keys(hexBoxes)
  check(hexIds.length === 4 && hexIds.every((id) => Math.abs(hexBoxes[id].w - 120) <= 1 && Math.abs(hexBoxes[id].h - 104) <= 1), 'Hive: tiles are 120 x 104', JSON.stringify(hexBoxes))
  const overlaps = []
  for (let i = 0; i < hexIds.length; i++)
    for (let j = i + 1; j < hexIds.length; j++) {
      const p = hexBoxes[hexIds[i]]
      const q = hexBoxes[hexIds[j]]
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y)
      if (ox >= 1 && oy >= 1) overlaps.push(`${hexIds[i]}/${hexIds[j]}`)
    }
  check(overlaps.length === 0, 'Hive: no two tiles overlap', overlaps.join(',') + ' ' + JSON.stringify(hexBoxes))

  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      await setAppearance({ theme })
      for (const [name, canvas] of [
        ['Subway', { pattern: 'none', edges: 'orthogonal', layout: 'left-right', nodeStyle: 'station' }],
        ['Hive', { pattern: 'isometric', edges: 'straight', layout: 'radial', nodeStyle: 'hex' }]
      ]) {
        await setCanvas(canvas)
        await sleep(500)
        check(await noPageScroll(), `${name} run view has no page scroll at ${w}x${h} ${theme}`, JSON.stringify(await pageScroll()))
        await shot(`live-${name.toLowerCase()}-${w}x${h}-${theme}`)
        if (theme === 'light' || w === 1024) {
          await page.locator('[data-testid=canvas-legend-trigger]').click()
          await page.locator('[data-testid=canvas-legend]').waitFor({ timeout: 5000 })
          await sleep(250)
          check(await noPageScroll(), `${name} legend open: no page scroll at ${w}x${h} ${theme}`)
          await shot(`legend-${name.toLowerCase()}-${w}x${h}-${theme}`)
          await page.keyboard.press('Escape')
          await sleep(200)
        }
      }
    }
  }
  await resizeTo(1024, 640)
  await setAppearance({ theme: 'dark' })

  // ---------- The toolbar "Canvas style" popover ----------
  await setCanvas({ pattern: 'dots', tint: true, edges: 'curved', layout: 'top-down', nodeStyle: 'card' })
  const styleBtn = page.locator('.run-body [data-testid=canvas-style-button]')
  await styleBtn.click()
  const pop = page.locator('[data-testid=canvas-style-popover]')
  await pop.waitFor({ timeout: 5000 })
  await sleep(300)
  check(await page.evaluate(() => document.activeElement?.matches('[data-testid="canvas-presentation"] input[value="graph"]')), 'opening the popover focuses the current presentation (Graph)')
  check((await pop.locator('[data-preset=default]').count()) === 1 && (await pop.locator('[data-preset]').first().getAttribute('data-preset')) === 'default', 'the popover lists Default first')
  const popBox = await pop.boundingBox()
  check(!intersects(miniBox, popBox), 'the style popover does not land on the minimap', JSON.stringify({ miniBox, popBox }))
  await pop.locator('[data-preset=default]').focus()
  await page.keyboard.press('ArrowDown')
  await sleep(600)
  check((await html('data-canvas-pattern')) === 'blueprint', 'an arrow in the popover applies Blueprint')
  check(await pop.isVisible(), 'the popover stays open after a pick')
  const said = await page.locator('.run-body [data-testid=tray-announce]').innerText().catch(() => '')
  check(/Canvas style: Blueprint\./.test(said), 'the pick is announced through the frame', said)
  await shot('live-style-popover')
  await page.keyboard.press('Escape')
  await sleep(300)
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'canvas-style-button'), 'Escape closes the popover and returns focus to the button')
  await styleBtn.click()
  await pop.waitFor({ timeout: 5000 })
  await page.locator('[data-testid=canvas-style-more]').click()
  await page.locator('[data-testid=canvas-section]').waitFor({ timeout: 10_000 })
  await sleep(700)
  const inView = await page.evaluate(() => {
    const sc = document.querySelector('.settings-scroll')?.getBoundingClientRect()
    const first = document.querySelector('[data-testid=canvas-section] [data-testid=canvas-preset]')?.getBoundingClientRect()
    return !!sc && !!first && first.top >= sc.top - 1 && first.bottom <= sc.bottom + 1
  })
  check(inView, 'More canvas settings scrolls the gallery\'s first option into the settings view at 1024x640')
  const shift = await windowShift(page)
  check(shift.ok, 'the deep link does not shift the window', JSON.stringify(shift))
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'canvas-preset'), 'the deep link focuses the checked style option')
  await shot('deep-link-canvas')

  // ---------- A message between two working reports (M4) ----------
  await openProject(page, NAME)
  await setCanvas({ pattern: 'dots', tint: true, edges: 'curved', layout: 'top-down', nodeStyle: 'card', minimap: false })
  fs.writeFileSync(
    scriptFile,
    JSON.stringify({
      delayMs: 300,
      work: [
        { type: 'spawn', id: 'msg-a', description: 'First report', name: 'worker-a' },
        { type: 'spawn', id: 'msg-b', description: 'Second report', name: 'worker-b' },
        // `from` is an agent id, `to` a handle (mock.ts MockStep 'message').
        { type: 'message', from: 'msg-a', to: 'worker-b', text: 'Here is what I found.' },
        { type: 'text', text: 'Both reports are working.' }
      ]
    })
  )
  await projectTab(page, 'Live').click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await page.locator('.composer textarea').fill('Message check')
  await page.locator('.composer .btn.primary').click()
  const msgEdge = page.locator(`${STAGE} .react-flow__edge.msg-edge`)
  await msgEdge.first().waitFor({ timeout: 10_000 }).catch(() => {})
  if (await msgEdge.count()) {
    const m = await page.evaluate(() => {
      const path = (el) => el?.querySelector('path.react-flow__edge-path')
      const msg = path(document.querySelector('.run-body .react-flow__edge.msg-edge'))
      const live = path(document.querySelector('.run-body .react-flow__edge.animated:not(.msg-edge)'))
      const svg = msg?.closest('svg')
      return {
        msgDash: msg ? getComputedStyle(msg).strokeDasharray : null,
        msgCap: msg ? getComputedStyle(msg).strokeLinecap : null,
        msgStroke: msg ? getComputedStyle(msg).stroke : null,
        liveDash: live ? getComputedStyle(live).strokeDasharray : null,
        liveStroke: live ? getComputedStyle(live).stroke : null,
        layerZ: svg ? getComputedStyle(svg).zIndex : null
      }
    })
    check(!!m.msgDash && m.msgDash !== 'none' && m.msgCap === 'round', 'a message edge is a round-capped dotted line', JSON.stringify(m))
    check(!m.liveDash || (m.liveDash !== m.msgDash && m.liveStroke !== m.msgStroke), 'a message edge differs from a working reporting line in dash and colour', JSON.stringify(m))
    check(m.layerZ === null || m.layerZ === 'auto' || Number(m.layerZ) <= 0, 'a message edge is drawn in the edge layer, under the nodes', JSON.stringify(m))
    await shot('live-message-edge')
  } else check(false, 'the mock message shows as a message edge')
  await endSession(page)
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))

  // ---------- Team editor ----------
  await openProject(page, NAME)
  await setCanvas({ pattern: 'dots', tint: true, edges: 'curved', layout: 'top-down', nodeStyle: 'card', minimap: true })
  await openTeam(page)
  const TEAM = '.editor .frame-stage'
  await page.locator(`${TEAM} .react-flow__node`).first().waitFor({ timeout: 10_000 })
  await sleep(600)
  for (const pattern of ['grid', 'circuit', 'none']) {
    await setCanvas({ pattern })
    const drawn = await page.locator(`${TEAM} [data-testid=canvas-backdrop]`).getAttribute('data-pattern').catch(() => null)
    check(drawn === pattern, `the Team editor follows the ${pattern} backdrop`, String(drawn))
  }
  const teamBg = await page.evaluate(() => getComputedStyle(document.querySelector('.editor .frame-stage')).backgroundColor)
  check(!/rgba\(0, 0, 0, 0\)/.test(teamBg), 'the Team stage paints a backdrop colour', teamBg)
  mm = await minimapCounts(TEAM)
  check(mm.nodes > 1 && mm.mini === mm.nodes, 'Team minimap draws one shape per role', JSON.stringify(mm))
  const teamMini = await page.locator('.editor .react-flow__minimap').boundingBox()
  const teamStage = await page.locator(TEAM).boundingBox()
  check(!!teamMini && !!teamStage && teamMini.height <= 0.34 * teamStage.height + 1, 'at 1024x640 the Team minimap is at most about a third of the stage height', JSON.stringify({ teamMini, teamStage }))
  await page.locator('.editor [data-testid=canvas-style-button]').click()
  await page.locator('[data-testid=canvas-style-popover]').waitFor({ timeout: 5000 })
  await sleep(250)
  check(!intersects(teamMini, await page.locator('[data-testid=canvas-style-popover]').boundingBox()), 'the Team style popover does not land on the minimap')
  await shot('team-style-popover')
  await page.keyboard.press('Escape')
  await sleep(200)
  const pathKinds = async () => page.locator(`${TEAM} .react-flow__edge path.react-flow__edge-path`).evaluateAll((ps) => ps.map((p) => (/[CQ]/.test(p.getAttribute('d') ?? '') ? 'curve' : 'line')))
  await setCanvas({ edges: 'curved' })
  const curved = await pathKinds()
  await setCanvas({ edges: 'straight' })
  const straight = await pathKinds()
  check(curved.length > 0 && curved.every((k) => k === 'curve') && straight.every((k) => k === 'line'), 'the Team editor follows Lines (curved then straight)', JSON.stringify({ curved, straight }))
  await setCanvas({ nodeStyle: 'compact' })
  await sleep(500)
  const roles = await page.locator(`${TEAM} .role-node`).evaluateAll((els) => els.map((e) => ({ s: e.getAttribute('data-style'), w: e.offsetWidth, h: e.offsetHeight })))
  check(roles.length > 1 && roles.every((r) => r.s === 'compact' && Math.abs(r.w - 160) <= 1 && Math.abs(r.h - 40) <= 1), 'Team role nodes are 160 x 40 name tags', JSON.stringify(roles))
  for (const style of ['station', 'hex']) {
    await setCanvas({ nodeStyle: style, layout: 'top-down' })
    await sleep(600)
    const rs = await styleOf(`${TEAM} .role-node`)
    check(rs.length > 1 && rs.every((s) => s === style), `Team role nodes are data-style=${style}`, JSON.stringify(rs))
    await shot(`team-${style}`)
  }
  await setCanvas({ nodeStyle: 'compact' })
  const autoLayout = page.locator('.editor').getByRole('button', { name: 'Auto-layout', exact: true })
  const teamRoot = async () => {
    const name = NAME
    const list = await page.evaluate(() => window.orgai.projects.list())
    const p = list.find((x) => x.name === name)
    return p?.roles.find((r) => r.reportsTo === null)?.id
  }
  const rid = await teamRoot()
  await setCanvas({ layout: 'left-right' })
  await autoLayout.click()
  await sleep(800)
  b = await flowBoxes(TEAM)
  const kids = Object.keys(b).filter((k) => k !== rid)
  check(!!b[rid] && kids.every((k) => b[k].x >= b[rid].x + b[rid].w - 1), 'Team auto-layout left to right puts reports right of the root', JSON.stringify(b))
  await shot('team-left-right-compact')
  await setCanvas({ layout: 'radial' })
  await autoLayout.click()
  await sleep(800)
  b = await flowBoxes(TEAM)
  check((await page.locator(`${TEAM} .react-flow[data-layout=radial]`).count()) === 1, 'the Team canvas carries data-layout=radial')
  const ds = kids.map((k) => dist(b[k], b[rid]))
  check(ds.length > 0 && ds.every((d) => d > 100), 'Team auto-layout radial places every role around the root', JSON.stringify(ds))
  await shot('team-radial')
  for (const theme of ['dark', 'light']) {
    await setAppearance({ theme }, { pattern: 'blueprint', layout: 'top-down', nodeStyle: 'card', edges: 'orthogonal' })
    await autoLayout.click()
    await sleep(600)
    check(await noPageScroll(), `Team editor has no page scroll at 1024x640 ${theme}`)
    await shot(`team-blueprint-${theme}`)
  }
  await setAppearance({ theme: 'dark' }, { pattern: 'dots', tint: true, edges: 'curved', layout: 'top-down', nodeStyle: 'card', minimap: false })
  await checkPocketOffice({ page, name: NAME, resizeTo, setAppearance, setCanvas, noPageScroll, shot })
} catch (e) {
  check(false, 'canvas script ran to the end', e.stack ?? e.message)
} finally {
  await cleanup(app, page, NAME)
  finish('canvas.mjs')
}
