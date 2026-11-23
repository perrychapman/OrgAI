// Pocket Office checks (docs/design/pocket-office.md "Living office rework", sections 8 and 9 S6).
// Called by office.mjs (focused runner) and canvas.mjs (CI) so Pocket Office stays on the token-free path: mock adapter only.
// One building per team, no floors: people are looked up by id and building coordinates, never by floor.
// The Team tab no longer shows the office (Team tab overhaul phase 2, docs/design/team-tab-overhaul.md 0.1): the old Team
// checks (static building, 33-role zoom/Fit/Find/keyboard, Back to office) were dropped with it and the Canvas style
// popover check moved to Live. Settings and Live keep every other step.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SHOTS_DIR, check, endSession, log, openAppSettings, openProject, openTeam, projectTab, sleep } from './lib.mjs'

const MARKS = new Set(['wait', 'done', 'error', 'talk'])
const STATES = new Set(['idle', 'running', 'waiting', 'finished', 'failed'])
const CUES = new Set(['typing', 'waving', 'glance', 'arriving', 'cheering', 'slumping', 'walking', 'none'])
const STATE_MARK = { waiting: 'wait', finished: 'done', failed: 'error' }
/** Key frames for the Slice 6 report (the rest go to e2e/shots through `shot`). */
const KEY_DIR = path.join(SHOTS_DIR, 'ux', 'pocket-office-rework')

export async function checkPocketOffice({ page, name, resizeTo, setAppearance, setCanvas, noPageScroll, shot, scriptFile }) {
  // Stress option for slow machines (CI is slower than a dev box): ORGAI_E2E_CPU_THROTTLE=4 slows the renderer four times.
  if (Number(process.env.ORGAI_E2E_CPU_THROTTLE) > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.ORGAI_E2E_CPU_THROTTLE) })
    log('cpu throttle', process.env.ORGAI_E2E_CPU_THROTTLE)
  }
  const scene = () => page.locator('[data-testid=office-scene]').first()
  const stage = () => scene().locator('[data-testid=office-stage]')
  const zoomButton = label => scene().getByRole('button', { name: label, exact: true })
  const keyShot = async label => {
    fs.mkdirSync(KEY_DIR, { recursive: true })
    const file = path.join(KEY_DIR, `s6-${label}.png`)
    await page.screenshot({ path: file })
    log('key frame', file)
  }
  /** A wait that records a failed check instead of aborting the rest of the script. */
  const waits = async (what, fn, arg, timeout = 15_000) => {
    try { await page.waitForFunction(fn, arg, { timeout, polling: 'raf' }); return check(true, what) } catch (error) { return check(false, what, String(error.message).split('\n')[0]) }
  }
  const openDirectory = async () => {
    const directory = scene().locator('details.office-directory')
    if (await directory.count() && await directory.getAttribute('open') === null) await directory.locator('summary').click()
  }
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const stageInfo = () => scene().evaluate(el => {
    const s = el.querySelector('[data-testid=office-stage]')
    return {
      w: Number(s.dataset.width), h: Number(s.dataset.height), cw: s.clientWidth, ch: s.clientHeight, sw: s.scrollWidth, sh: s.scrollHeight, sl: s.scrollLeft, st: s.scrollTop,
      zoom: Number(el.querySelector('[data-testid=office-zoom]').dataset.zoom), aria: el.querySelector('[data-testid=office-zoom]').getAttribute('aria-label'), readout: `${el.querySelector('[data-testid=office-zoom]').textContent} ${el.querySelector('[data-testid=office-zoom]').getAttribute('aria-label') ?? ''}`, plates: el.dataset.plates
    }
  })
  const positionsOf = () => scene().evaluate(el => Object.fromEntries([...el.querySelectorAll('[data-office-sprite-id]')].map(s => [s.dataset.officeSpriteId, `${s.dataset.officeX},${s.dataset.officeY}`])))
  const zoomTo = async target => {
    for (let i = 0; i < 7; i++) {
      const { zoom } = await stageInfo()
      if (zoom === target) return true
      await zoomButton(zoom < target ? 'Zoom in' : 'Zoom out').click()
      await settle()
    }
    return (await stageInfo()).zoom === target
  }
  /** Is the person's native button fully inside the stage's visible rectangle (people buttons stay tabbable even when scrolled away). */
  const inStage = id => scene().evaluate((el, who) => {
    const button = el.querySelector(`button[data-office-worker-id="${who}"]`)
    if (!button) return false
    const s = el.querySelector('[data-testid=office-stage]').getBoundingClientRect()
    const r = button.getBoundingClientRect()
    return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1
  }, id)
  /** Hit targets: at least 24 x 24, covering their sprite, named, and never overlapping each other. */
  const targetsOk = () => scene().evaluate(el => {
    const art = new Map([...el.querySelectorAll('[data-office-sprite-id]')].map(s => [s.getAttribute('data-office-sprite-id'), s.getBoundingClientRect()]))
    const buttons = [...el.querySelectorAll('button[data-office-worker-id]')]
    const rects = buttons.map(b => b.getBoundingClientRect())
    const result = { size: true, aligned: true, named: true, overlap: false, count: buttons.length }
    buttons.forEach((button, i) => {
      const r = rects[i]; const a = art.get(button.getAttribute('data-office-worker-id'))
      if (r.width < 23.5 || r.height < 23.5) result.size = false
      if (!a || r.left > a.left + 0.5 || r.right < a.right - 0.5 || r.top > a.top + 0.5 || r.bottom < a.bottom - 0.5) result.aligned = false
      if (!button.getAttribute('aria-label') && !button.textContent?.trim()) result.named = false
      for (let j = 0; j < i; j++) {
        const o = rects[j]
        if (r.left < o.right - 1 && o.left < r.right - 1 && r.top < o.bottom - 1 && o.top < r.bottom - 1) result.overlap = true
      }
    })
    return result
  })
  /** Everything the rework adds to the scene root and its sprites, for state/cue/mark consistency checks. */
  const snapshot = () => scene().evaluate(el => ({
    clock: el.dataset.officeClock, animated: Number(el.dataset.officeAnimated), paused: el.dataset.paused ?? null,
    sprites: [...el.querySelectorAll('[data-office-sprite-id]')].map(s => ({ id: s.dataset.officeSpriteId, state: s.dataset.officeState, cue: s.dataset.officeCue, phase: s.dataset.officeMotionPhase, frame: s.style.backgroundPosition })),
    marks: [...el.querySelectorAll('[data-testid=office-mark]')].map(m => ({ id: m.dataset.agentId, mark: m.dataset.mark, hidden: m.hidden })),
    bubbles: [...el.querySelectorAll('[data-testid=office-bubble]')].map(b => ({ to: b.dataset.officeBubbleFor, from: b.dataset.officeBubbleFrom, text: b.textContent })),
    active: Number(el.querySelector('[data-testid=office-deliveries]')?.dataset.active ?? 0), queued: Number(el.querySelector('[data-testid=office-deliveries]')?.dataset.queued ?? 0)
  }))
  /** Marks agree with states: waiting, finished and failed carry their shape; running and idle only ever carry a talk mark. */
  const marksAgree = s => {
    const byId = new Map(s.sprites.map(sprite => [sprite.id, sprite]))
    const own = new Map(s.marks.map(m => [m.id, m.mark]))
    return s.sprites.every(sprite => STATES.has(sprite.state) && CUES.has(sprite.cue)) && s.marks.every(m => MARKS.has(m.mark) && byId.has(m.id) && !m.hidden)
      && s.sprites.every(sprite => STATE_MARK[sprite.state] ? own.get(sprite.id) === STATE_MARK[sprite.state] || own.get(sprite.id) === 'talk' : (own.get(sprite.id) ?? 'talk') === 'talk')
  }
  const quiet = s => s.clock === 'stopped' && s.animated === 0 && s.sprites.every(sprite => sprite.cue === 'none')
  /**
   * A requestAnimationFrame recorder in the page: every motion phase and cue seen, the largest active-delivery count, whether the clock ever
   * ran, and the first window in which the first message's bubble (at office-a) and talk mark (at root) were on screen, in ms.
   */
  const startRecorder = () => page.evaluate(() => {
    window.__officeRec?.stop()
    const t0 = performance.now()
    const rec = { phases: new Set(), cues: new Set(), clock: new Set(), maxActive: 0, maxAnimated: 0, bubble: { start: null, end: null, text: null }, talk: { start: null, end: null }, quit: false }
    const window_ = (slot, on, now) => {
      if (on) { if (slot.start === null) slot.start = now; if (slot.end === null) slot.last = now } else if (slot.start !== null && slot.end === null) slot.end = now
    }
    const frame = () => {
      if (rec.quit) return
      const now = performance.now() - t0
      const el = document.querySelector('[data-testid=office-scene]')
      if (el) {
        for (const s of el.querySelectorAll('[data-office-sprite-id]')) { rec.phases.add(s.dataset.officeMotionPhase); rec.cues.add(s.dataset.officeCue) }
        rec.clock.add(el.dataset.officeClock); rec.maxAnimated = Math.max(rec.maxAnimated, Number(el.dataset.officeAnimated))
        rec.maxActive = Math.max(rec.maxActive, Number(el.querySelector('[data-testid=office-deliveries]')?.dataset.active ?? 0))
        const bubble = el.querySelector('[data-testid=office-bubble][data-office-bubble-for=office-a]')
        if (bubble && rec.bubble.text === null) rec.bubble.text = bubble.textContent
        window_(rec.bubble, !!bubble, now)
        window_(rec.talk, !!el.querySelector('[data-testid=office-mark][data-mark=talk][data-agent-id=root]'), now)
      }
      requestAnimationFrame(frame)
    }
    rec.stop = () => { rec.quit = true }
    window.__officeRec = rec
    frame()
  })
  const readRecorder = () => page.evaluate(() => {
    const rec = window.__officeRec
    return { phases: [...rec.phases], cues: [...rec.cues], clock: [...rec.clock], maxActive: rec.maxActive, maxAnimated: rec.maxAnimated, bubble: rec.bubble, talk: rec.talk }
  })

  // ---------- Settings: the inert framed sample and the presentation controls ----------
  const graph = { pattern: 'blueprint', layout: 'left-right', nodeStyle: 'compact', edges: 'orthogonal', minimap: true, tint: false }
  await setCanvas({ ...graph, presentation: 'graph', scenePalette: 'color' })
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  const section = page.locator('[data-testid=canvas-section]')
  const office = section.locator('[data-testid=canvas-presentation] input[value="pocket-office"]')
  await office.check()
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'pocket-office')
  check(await section.locator('[data-testid=canvas-preview] [data-testid=office-scene]').count() === 1, 'Pocket Office settings shows the shared scene sample')
  check(await scene().getAttribute('data-mode') === 'sample', 'settings office is explicitly static sample data')
  const sampleClock = await scene().getAttribute('data-office-clock')
  check((sampleClock === null || sampleClock === 'stopped') && await scene().evaluate(el => !el.querySelector('[data-office-cue]:not([data-office-cue="none"])') && el.getAttribute('data-office-animated') !== '1'), 'the settings sample has no clock and animates nothing', String(sampleClock))
  check(await scene().locator('[data-testid=office-pause], [data-testid=office-bubble], [data-testid=office-mark], [data-testid=office-stage], button, a, input').count() === 0, 'the settings sample is inert: no Pause motion, bubbles, marks, stage or controls')
  check(await scene().locator('.office-sample-frame[aria-hidden="true"] i').count() >= 1, 'the settings sample is one framed, hidden-from-assistive-tech picture')
  check(await section.locator('[data-testid=canvas-preset]').count() === 0 && await section.locator('[data-testid=canvas-customise]').count() === 0, 'Office settings show no unrelated Graph gallery or controls')
  check(await section.locator('[data-testid=canvas-presentation-choice]').count() === 3, 'presentation offers three visual choices (Graph, Pocket Office, Factory Floor)')
  check(await section.locator('[data-testid=canvas-palette-choice]').count() === 3, 'Office offers three visual palette previews')
  check(/across the app/i.test(await section.innerText()), 'settings explains the app-wide scope')
  check(await section.locator('[data-testid=canvas-scene-palette] input[value="color"]').isChecked(), 'Color is exposed and selected as the default office palette')
  await section.locator('[data-testid=canvas-scene-palette] input[value="green"]').check()
  await page.waitForFunction(() => document.documentElement.dataset.canvasScenePalette === 'green')
  const saved = await page.evaluate(async () => (await window.orgai.settings.get()).appearance.canvas)
  check(Object.entries(graph).every(([key, value]) => saved[key] === value), 'switching presentation and palette preserves every graph preference', JSON.stringify(saved))
  // Native radio arrows provide the keyboard path back to Graph and back to Office.
  await office.focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'graph')
  check(await section.locator('[data-testid=canvas-preset]').count() > 0 && await section.locator('[data-testid=canvas-customise]').count() === 1, 'Graph restores its own gallery and controls')
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'pocket-office')
  await openProject(page, name)

  // ---------- Live: the deep-tree run (finished agents stay in the office) ----------
  const startRun = async text => {
    await projectTab(page, 'Live').click()
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 5000 })
    await page.locator('.composer textarea').fill(text)
    await page.locator('.composer textarea').press('Enter')
    await scene().waitFor()
  }
  await resizeTo(1600, 1000)
  await startRun('Office deep tree [mock:deep-tree]')
  await openDirectory()
  await scene().locator('button[data-office-agent-id="mock-lead-report-1"]').first().waitFor({ timeout: 20_000 })
  await page.getByText('The lead finished: both halves are done. Anything else?', { exact: true }).first().waitFor({ timeout: 30_000 })
  check(await scene().getAttribute('data-mode') === 'live', 'Live uses the live scene')
  check(await scene().locator('button[data-office-agent-id]').count() >= 4, 'finished deep-tree agents remain available in the office list')
  check(await scene().locator('[data-testid=office-pause]').count() === 1 && await scene().locator('[data-testid=office-pause]').getAttribute('aria-pressed') === 'false', 'Live offers Pause motion, not pressed')
  check(await scene().locator('[data-testid=office-pause]').getAttribute('aria-disabled') === null, 'Pause motion is not aria-disabled while motion is on')
  const finished = await snapshot()
  check(finished.sprites.length >= 4 && marksAgree(finished), 'every person has a valid state and cue, and marks match states', JSON.stringify(finished.sprites.map(s => `${s.state}/${s.cue}`)))
  check(finished.sprites.some(sprite => sprite.state === 'finished') ? finished.marks.some(mark => mark.mark === 'done') : true, 'finished people carry the done mark')
  check(finished.animated <= 12, 'at most 12 people animate', String(finished.animated))
  await keyShot('live-deep-tree')
  // Room labels name the departments (data-office-room), no floors anywhere.
  const liveRooms = await scene().locator('button[data-office-agent-id]').evaluateAll(buttons => buttons.map(b => b.dataset.officeRoom))
  check(liveRooms.length >= 4 && liveRooms.every(Boolean), 'Live roster rows carry data-office-room', JSON.stringify(liveRooms))
  check(!(await scene().evaluate(el => /\bfloors?\b/i.test(el.textContent) || el.hasAttribute('data-floor') || !!el.querySelector('[data-floor], [data-office-floor]'))), 'Live has no floor text or attribute')
  // The Canvas style popover (moved here from the Team tab, which no longer has one): Office offers palettes, never Graph presets.
  const styleTrigger = page.locator('.run-body').getByRole('button', { name: 'Canvas style', exact: true })
  await styleTrigger.click()
  const stylePanel = page.locator('[data-testid=canvas-style-popover]')
  await stylePanel.waitFor()
  await page.waitForFunction(() => document.activeElement?.matches('[data-testid="canvas-scene-palette"] input:checked'))
  check(await stylePanel.locator('[data-testid=canvas-preset]').count() === 0, 'Office toolbar does not offer accidental Graph preset switches')
  check(await stylePanel.locator('[data-testid=canvas-palette-choice]').count() === 3, 'toolbar offers the same visual Office palette choices')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Canvas style' || document.activeElement?.textContent?.trim() === 'Canvas style')
  check(await styleTrigger.evaluate(el => el === document.activeElement), 'Office style Escape returns focus to Canvas style')
  // Pocket Office is a Live and App settings presentation only: with it on app-wide the Team tab still draws its chart.
  await openTeam(page)
  check((await page.locator('.editor [data-testid=office-scene], .editor [data-testid=canvas-style-button], .editor [data-testid=office-role-back]').count()) === 0, 'with Pocket Office on, the Team tab has no office scene, Canvas style button or Back to office')
  check((await page.locator('.editor .frame-stage .react-flow .react-flow__node').count()) > 0, 'with Pocket Office on, the Team tab still draws its role chart')
  await projectTab(page, 'Live').click()
  await scene().waitFor()
  // Reduced motion: the app setting stops the clock and every cue.
  await setAppearance({ reduceMotion: 'on' })
  await settle()
  const reduced = await snapshot()
  check(quiet(reduced) && reduced.active === 0, 'app reduced motion stops the clock and every cue is none', JSON.stringify(reduced))
  check(await page.evaluate(() => document.documentElement.getAttribute('data-reduce-motion') === 'on'), 'the app setting writes data-reduce-motion on the root')
  const reducedPause = scene().locator('[data-testid=office-pause]')
  check(await reducedPause.getAttribute('aria-disabled') === 'true', 'Pause motion is aria-disabled when the app Reduce motion setting is on')
  await reducedPause.click({ force: true }) // Playwright treats aria-disabled as not actionable
  await settle()
  check(await reducedPause.getAttribute('aria-pressed') === 'false' && quiet(await snapshot()), 'pressing the disabled Pause motion changes nothing')
  await setAppearance({ theme: 'dark' })
  await setAppearance({ theme: 'light' })
  check((await snapshot()).active === 0, 'theme changes do not replay retained messages')
  await setCanvas({ presentation: 'graph' })
  await page.locator('.run-body .frame-stage .react-flow').waitFor()
  await setCanvas({ presentation: 'pocket-office' })
  await scene().waitFor()
  check((await snapshot()).active === 0 && await scene().locator('[data-testid=office-bubble]').count() === 0, 'reopening office establishes a message baseline without replay')
  await setAppearance({ reduceMotion: 'system', theme: 'dark' })
  // A new session reuses report handles; the prior roster must retain session context and original transcript routing.
  await endSession(page)
  await page.locator('.composer textarea').fill('Office continuation [mock:deep-tree]')
  await page.locator('.composer textarea').press('Enter')
  await openDirectory()
  const prior = scene().locator('button[data-office-agent-id$="/mock-lead"]').first()
  await prior.waitFor({ timeout: 30_000 })
  check(/Earlier|Session/i.test(await prior.innerText()), 'the prior report retains visible session context')
  await prior.click()
  await page.getByText('Splitting the work in two.', { exact: true }).first().waitFor({ timeout: 10_000 })
  check(await page.getByText('Splitting the work in two.', { exact: true }).count() > 0, 'selecting an earlier lead opens its original transcript')
  await endSession(page)

  // ---------- Live: real messages through the mock runtime ----------
  const FIRST = 'Please review the notes API before we ship it to the customers.'
  const messageScript = {
    delayMs: 500,
    work: [
      { type: 'spawn', id: 'office-a', name: 'office-a', description: 'Receive the findings' },
      { type: 'spawn', id: 'office-b', name: 'office-b', description: 'Check the tests' },
      { type: 'wait', ms: 1500 },
      { type: 'message', to: 'office-a', text: FIRST },
      { type: 'wait', ms: 3000 },
      { type: 'message', from: 'office-a', to: 'root', text: 'On it.' },
      { type: 'wait', ms: 1500 },
      { type: 'message', to: 'office-b', text: 'Check the tests' },
      { type: 'wait', ms: 1500 },
      { type: 'message', to: 'office-b', text: 'Wrap up now' },
      { type: 'wait', ms: 120_000 }
    ]
  }
  fs.writeFileSync(scriptFile, JSON.stringify(messageScript))
  await resizeTo(1600, 1000)
  await setAppearance({ reduceMotion: 'system', theme: 'dark' }, { presentation: 'pocket-office', scenePalette: 'color' })
  await startRecorder()
  await startRun('Office messages')
  await waits('a new report walks in (data-office-motion-phase="arrive", cue arriving)', () => !!document.querySelector('[data-office-motion-phase="arrive"][data-office-cue="arriving"]'), undefined, 20_000)
  await waits('the running clock reports running with cues on running people', () => {
    const scene = document.querySelector('[data-testid=office-scene]')
    return scene?.dataset.officeClock === 'running' && Number(scene.dataset.officeAnimated) >= 1 && [...scene.querySelectorAll('[data-office-state=running]')].some(s => s.dataset.officeCue === 'typing')
  }, undefined, 20_000)
  // A cross-room message: talk mark at the sender, bubble at the recipient, nameplates inverted for the pair.
  await waits('the sender shows a talk mark (office-mark data-mark=talk)', () => !!document.querySelector('[data-testid=office-mark][data-mark=talk][data-agent-id=root]'), undefined, 40_000)
  const endpoints = await scene().evaluate(el => ['root', 'office-a'].map(id => el.querySelector(`button[data-office-agent-id="${id}"]`)?.dataset.officeRoom ?? null))
  check(!!endpoints[0] && !!endpoints[1] && endpoints[0] !== endpoints[1], 'the message crosses rooms (the lobby and a department)', JSON.stringify(endpoints))
  await waits('the recipient shows a bubble (data-office-bubble-for)', () => !!document.querySelector('[data-testid=office-bubble][data-office-bubble-for=office-a]'), undefined, 20_000)
  const geometry = await page.evaluate(() => {
    const bubble = document.querySelector('[data-testid=office-bubble][data-office-bubble-for=office-a]')
    const person = document.querySelector('button[data-office-worker-id=office-a]')
    if (!bubble || !person) return null
    const b = bubble.getBoundingClientRect(); const p = person.getBoundingClientRect()
    const centre = (p.left + p.right) / 2
    return {
      text: bubble.textContent, aria: bubble.getAttribute('aria-hidden'), events: getComputedStyle(bubble).pointerEvents, placement: bubble.dataset.placement, from: bubble.dataset.officeBubbleFrom,
      width: b.width, above: b.bottom <= p.top + 1, below: b.top >= p.bottom - 1, covers: b.left <= centre + 1 && b.right >= centre - 1,
      exchange: [...document.querySelectorAll('[data-office-exchange=true]')].map(el => el.dataset.officeWorkerId), sameRoom: !!person.closest('.office-world')
    }
  })
  check(!!geometry && geometry.text === `Orchestrator: ${FIRST}` && geometry.from === 'root', 'the bubble reads `{Sender}: {text}`', JSON.stringify(geometry))
  check(!!geometry && geometry.aria === 'true' && geometry.events === 'none' && geometry.width <= 202, 'the bubble is aria-hidden, ignores the pointer and is at most 200 px wide', JSON.stringify(geometry))
  check(!!geometry && geometry.covers && (geometry.placement === 'above' ? geometry.above : geometry.below), 'the bubble sits at the recipient (above, or below when there is no room) and its tail covers the person', JSON.stringify(geometry))
  check(!!geometry && geometry.exchange.includes('root') && geometry.exchange.includes('office-a'), 'both people in the exchange show an inverted nameplate', JSON.stringify(geometry?.exchange))
  await keyShot('live-bubble')
  await shot('office-live-bubble')
  check(!(await page.locator('[data-testid=tray-announce]').first().textContent())?.includes('Please review'), 'bubble text is not announced')
  // The strip is a 48 px log, newest first, last three messages, with Show.
  await waits('the strip logs the newest message first (three rows, oldest dropped)', () => {
    const rows = [...document.querySelectorAll('[data-testid=office-caption] .office-strip-text')].map(r => r.textContent)
    return rows.length === 3 && rows[0].includes('Wrap up now') && !rows.some(r => r.includes('Please review'))
  }, undefined, 40_000)
  const strip = await scene().evaluate(el => {
    const regionEl = el.querySelector('.office-message-strip')
    const region = regionEl.getBoundingClientRect()
    return {
      height: region.height, scrollHeight: regionEl.scrollHeight, clientHeight: regionEl.clientHeight,
      outside: [...el.querySelectorAll('[data-testid=office-caption]')].filter(r => { const b = r.getBoundingClientRect(); return b.top < region.top - 0.5 || b.bottom > region.bottom + 0.5 || b.left < region.left - 0.5 || b.right > region.right + 0.5 }).length,
      rows: [...el.querySelectorAll('[data-testid=office-caption]')].map(r => ({ text: r.querySelector('.office-strip-text').textContent, show: r.querySelector('[data-testid=office-show]')?.textContent ?? null, full: r.querySelector('.office-full-message')?.textContent ?? '' })),
      script: el.querySelectorAll('[data-testid=office-caption] script').length
    }
  })
  // Sized to its three 24 px rows plus the 1 px top border (QA F1); it used to be 48 px and clipped the oldest row.
  check(Math.abs(strip.height - 73) <= 1, 'the message strip is sized to its three rows (73 px: 3 x 24 + border)', String(strip.height))
  check(strip.outside === 0 && strip.scrollHeight === strip.clientHeight, 'all three strip rows lie inside the strip and it does not scroll (scrollHeight equals clientHeight)', JSON.stringify({ outside: strip.outside, scrollHeight: strip.scrollHeight, clientHeight: strip.clientHeight }))
  check(strip.rows.length === 3 && /^Orchestrator to office-b · Wrap up now$/.test(strip.rows[0].text) && /^Orchestrator to office-b · Check the tests$/.test(strip.rows[1].text) && /^office-a to Orchestrator · On it\.$/.test(strip.rows[2].text), 'the strip lists the last three messages newest first as `{From} to {To} · {text}`', JSON.stringify(strip.rows.map(r => r.text)))
  check(strip.rows.map(r => r.show).join('|') === 'Show office-b|Show office-b|Show Orchestrator', 'each row has a `Show {To}` button', JSON.stringify(strip.rows.map(r => r.show)))
  check(strip.rows[2].full.includes('On it.') && strip.script === 0, 'rows keep the full text and render markup as text')
  // Show: select, pan, ring, announce; one person is ringed and the inspector opens.
  await scene().locator('[data-testid=office-caption]').nth(2).getByRole('button', { name: 'Show Orchestrator', exact: true }).click()
  await waits('Show rings and selects the recipient (data-office-found, aria-pressed)', () => {
    const person = document.querySelector('button[data-office-worker-id=root]')
    return person?.getAttribute('data-office-found') === 'true' && person.getAttribute('aria-pressed') === 'true'
  }, undefined, 6000)
  await waits('Show announces `Showing {name}, {room}`', () => /^Showing Orchestrator, Orchestrators$/.test(document.querySelector('[data-testid=tray-announce]')?.textContent ?? ''), undefined, 3000)
  check(await page.locator('[data-testid=office-agent-back]').count() === 1, 'Show opens the inspector with Back to office')
  check(await inStage('root'), 'Show brings the recipient inside the stage')
  await waits('the Show ring goes away', () => !document.querySelector('[data-office-found]'), undefined, 6000)
  await page.locator('[data-testid=office-agent-back]').click()
  // returnToOffice focuses the person in a requestAnimationFrame after clearing the selection, so wait for it, then confirm it holds.
  await waits('Back to office returns focus to the shown person', () => document.activeElement?.dataset?.officeWorkerId === 'root', undefined, 3000)
  await settle()
  check(await page.evaluate(() => document.activeElement?.dataset?.officeWorkerId === 'root'), 'focus on the shown person holds after the stage settles')
  // Find a person in Live.
  await openDirectory()
  await scene().locator('button[data-office-agent-id="office-b"]').click()
  await waits('Find a person rings the person in Live', () => document.querySelector('button[data-office-worker-id="office-b"]')?.getAttribute('data-office-found') === 'true', undefined, 6000)
  await page.locator('[data-testid=office-agent-back]').click()
  await scene().locator('details.office-directory summary').click()
  // Keyboard: Tab reaches people, Enter selects and opens the inspector, Escape returns.
  check(await page.locator('[data-testid=office-agent-back]').count() === 0, 'no inspector is open before the keyboard pass')
  await stage().focus()
  await page.keyboard.press('Tab')
  check(await page.evaluate(() => !!document.activeElement?.dataset?.officeWorkerId), 'Tab from the stage reaches a person')
  const lobbyFirst = await page.evaluate(() => document.activeElement?.dataset?.officeWorkerId)
  check(lobbyFirst === 'root', 'the first person reached by Tab is the lobby orchestrator', String(lobbyFirst))
  await page.keyboard.press('Enter')
  await page.locator('[data-testid=office-agent-back]').waitFor()
  check(await page.locator('[data-testid=office-agent-back]').count() === 1, 'Enter selects the person and opens the inspector')
  await page.keyboard.press('Escape')
  await waits('Escape returns focus to the person', () => document.activeElement?.dataset?.officeWorkerId === 'root', undefined, 3000)

  // The clock draws frames: a running person's frame changes over a few seconds; marks agree with states.
  await waits('the clock runs again with typing cues', () => document.querySelector('[data-testid=office-scene]')?.dataset.officeClock === 'running', undefined, 6000)
  const frames = new Set()
  for (let i = 0; i < 10; i++) { const s = await snapshot(); frames.add(s.sprites.filter(p => p.state === 'running').map(p => p.frame).join('|')); await sleep(300) }
  check(frames.size >= 2, 'running people change frames over three seconds', String(frames.size))
  const live = await snapshot()
  check(marksAgree(live) && live.animated >= 1 && live.animated <= 12, 'states, cues and marks agree and at most 12 animate', JSON.stringify(live.sprites.map(s => `${s.state}/${s.cue}`)))

  // Pause motion: aria-pressed toggles, the clock stops, every cue is none and frames hold still, then it resumes.
  const pause = scene().locator('[data-testid=office-pause]')
  const pauseLook = () => pause.evaluate(el => { const c = getComputedStyle(el); return [c.backgroundColor, c.borderTopColor, c.boxShadow, c.fontWeight, c.color].join(' | ') })
  await page.mouse.move(2, 2) // no hover tint in either reading
  await settle()
  const unpressedLook = await pauseLook()
  await pause.click()
  await page.mouse.move(2, 2)
  await settle()
  check(await pause.getAttribute('aria-pressed') === 'true', 'Pause motion is pressed after a click')
  const pressedLook = await pauseLook()
  check(pressedLook !== unpressedLook, 'Pause motion has a visible pressed state (computed style differs from unpressed)', `${unpressedLook}  =>  ${pressedLook}`)
  await waits('Pause stops the clock and every cue is none', () => {
    const scene = document.querySelector('[data-testid=office-scene]')
    return scene?.dataset.officeClock === 'stopped' && scene.dataset.officeAnimated === '0' && [...scene.querySelectorAll('[data-office-sprite-id]')].every(s => s.dataset.officeCue === 'none')
  }, undefined, 4000)
  const held = JSON.stringify((await snapshot()).sprites.map(s => s.frame))
  await sleep(900)
  check(JSON.stringify((await snapshot()).sprites.map(s => s.frame)) === held, 'paused people hold one static frame')
  await pause.click()
  check(await pause.getAttribute('aria-pressed') === 'false', 'Pause motion toggles back')
  await waits('motion resumes after Pause', () => document.querySelector('[data-testid=office-scene]')?.dataset.officeClock === 'running', undefined, 4000)
  // Hidden and resumed: nothing replays. Wait until every bubble and talk mark has ended first.
  await waits('every bubble and talk mark has ended', () => !document.querySelector('[data-testid=office-bubble], [data-testid=office-mark][data-mark=talk]'), undefined, 20_000)
  await waits('after the round trip every sender is seated again (phase rest, not return or a walk cue)', () => [...document.querySelectorAll('[data-testid=office-scene] [data-office-sprite-id]')].every(s => ['rest', 'pinned'].includes(s.dataset.officeMotionPhase) && s.dataset.officeCue !== 'walking'), undefined, 10_000)
  const walked = await readRecorder()
  const expectedBubble = Math.min(6000, 1500 + 45 * FIRST.length)
  check(['outbound', 'settle', 'return'].every(phase => walked.phases.includes(phase)) && walked.cues.includes('walking'), 'a cross-room message walks the sender out, settles and returns (outbound, settle, return)', JSON.stringify(walked.phases))
  check(walked.maxActive >= 1 && walked.maxActive <= 3, 'at most three deliveries are active at once', String(walked.maxActive))
  check(walked.talk.end !== null && walked.talk.end - walked.talk.start >= 600, 'the talk mark covers the outbound walk', JSON.stringify(walked.talk))
  const bubbleShown = walked.bubble.end === null ? null : walked.bubble.end - walked.bubble.start
  check(bubbleShown !== null && Math.abs(bubbleShown - expectedBubble) <= 900, `the bubble stays for its readable time (${expectedBubble} ms) from the walk's settle`, String(bubbleShown))
  check(walked.bubble.start >= walked.talk.end - 200, 'the bubble starts when the sender arrives (after the talk mark)', JSON.stringify({ talk: walked.talk, bubble: walked.bubble }))
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  await waits('the clock stops while the document is hidden', () => document.querySelector('[data-testid=office-scene]')?.dataset.officeClock === 'stopped', undefined, 3000)
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
  await waits('the clock resumes when the document is visible again', () => document.querySelector('[data-testid=office-scene]')?.dataset.officeClock === 'running', undefined, 4000)
  await sleep(1500)
  const resumed = await snapshot()
  check(resumed.bubbles.length === 0 && !resumed.marks.some(m => m.mark === 'talk') && resumed.active === 0 && resumed.sprites.every(s => !['walking', 'arriving'].includes(s.cue)), 'hiding and showing the window does not replay old messages', JSON.stringify(resumed))
  check(await scene().locator('[data-testid=office-caption]').count() === 3, 'the strip log keeps its three rows after hiding and showing')
  // Light and dark, three palettes in the live building.
  for (const theme of ['dark', 'light']) {
    for (const palette of ['color', 'neutral', 'green']) {
      await setAppearance({ theme }, { scenePalette: palette })
      const tag = `${theme}/${palette}`
      check(await scene().getAttribute('data-palette') === palette && await scene().getAttribute('data-office-clock') === 'running', `live office follows ${tag} and keeps running`)
      check(await noPageScroll(), `live office fits the window at 1600x1000 ${tag}`)
      if (palette !== 'color' || theme === 'dark') await keyShot(`live-1600-${theme}-${palette}`)
    }
  }
  await setAppearance({ theme: 'dark' }, { scenePalette: 'neutral' })
  // Reload: the saved palette survives and the log is not replayed.
  await page.reload()
  await page.locator('.sidebar').waitFor()
  await openProject(page, name)
  await projectTab(page, 'Live').click()
  const reloaded = await scene().waitFor({ timeout: 15_000 }).then(() => true, () => false)
  check(reloaded, 'the live office returns after a renderer reload')
  if (reloaded) {
    check(await scene().getAttribute('data-palette') === 'neutral', 'the saved Neutral palette survives a reload')
    await sleep(1500)
    const afterReload = await snapshot()
    check(afterReload.bubbles.length === 0 && afterReload.active === 0 && !afterReload.marks.some(m => m.mark === 'talk'), 'reloading does not replay old messages', JSON.stringify(afterReload))
  }
  await setCanvas({ scenePalette: 'color' })
  await endSession(page)

  // ---------- Live: the sender returns to its desk while the bubble still shows; the strip log holds still under focus ----------
  const LONG = 'Please review the notes API before we ship it to the customers.'
  fs.writeFileSync(scriptFile, JSON.stringify({
    delayMs: 300,
    work: [
      { type: 'spawn', id: 'office-a', name: 'office-a', description: 'Receive the findings' },
      { type: 'spawn', id: 'office-b', name: 'office-b', description: 'Check the tests' },
      { type: 'wait', ms: 1500 },
      { type: 'message', to: 'office-a', text: LONG },
      { type: 'wait', ms: 9000 },
      { type: 'message', to: 'office-b', text: 'Hold two' },
      { type: 'wait', ms: 1500 },
      { type: 'message', to: 'office-a', text: 'Hold three' },
      { type: 'wait', ms: 10_000 },
      { type: 'message', to: 'office-b', text: 'Hold four' },
      { type: 'wait', ms: 120_000 }
    ]
  }))
  await resizeTo(1600, 1000)
  await setAppearance({ reduceMotion: 'system', theme: 'dark' }, { presentation: 'pocket-office', scenePalette: 'color' })
  await startRun('Office hold')
  // Watch the orchestrator across its first walk: remember its resting place, note the return, then look at it once the walk is over.
  await page.evaluate(() => { window.__desk = { rest: null, out: false, ret: false, done: null } })
  await waits('the sender finishes the return leg of its first walk', () => {
    const d = window.__desk
    const el = document.querySelector('[data-testid=office-scene] [data-office-sprite-id=root]')
    if (!el || d.done) return !!d.done
    const r = el.getBoundingClientRect()
    const phase = el.dataset.officeMotionPhase
    if (phase === 'outbound') d.out = true
    if (!d.out) { if (phase === 'rest') d.rest = { left: r.left, top: r.top }; return false }
    if (phase === 'return') { d.ret = true; return false }
    if (!d.ret) return false
    d.done = {
      phase, cue: el.dataset.officeCue, left: r.left, top: r.top,
      bubble: !!document.querySelector('[data-testid=office-bubble][data-office-bubble-for=office-a]'),
      x: el.dataset.officeX, y: el.dataset.officeY
    }
    return true
  }, undefined, 30_000)
  const desk = await page.evaluate(() => window.__desk)
  check(!!desk.done && !!desk.rest && Math.abs(desk.done.left - desk.rest.left) <= 1 && Math.abs(desk.done.top - desk.rest.top) <= 1, 'once the walk ends the sender sprite is back at its desk (same on-screen position as before the walk)', JSON.stringify(desk))
  check(!!desk.done && desk.done.cue !== 'walking' && desk.done.bubble, 'the sender is not walking while the recipient bubble is still showing', JSON.stringify(desk.done))
  // The strip log: with focus on a Show button, newer messages wait; once focus leaves, the newest three appear.
  await waits('the strip logs three rows with `Hold three` first', () => {
    const rows = [...document.querySelectorAll('[data-testid=office-caption] .office-strip-text')].map(r => r.textContent)
    return rows.length === 3 && rows[0].includes('Hold three')
  }, undefined, 30_000)
  const firstShow = scene().locator('[data-testid=office-caption]').first().getByRole('button', { name: /^Show / })
  const showName = await firstShow.textContent()
  await firstShow.focus()
  check(await page.evaluate(() => !!document.activeElement?.closest('.office-message-strip') && document.activeElement?.textContent?.startsWith('Show ')), 'focus is on a Show button in the strip')
  await waits('a newer message ("Hold four") has reached the office while focus is in the strip', () => /Hold four/.test(document.querySelector('[data-testid=office-bubble][data-office-bubble-for=office-b]')?.textContent ?? ''), undefined, 40_000)
  const heldState = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-testid=office-caption] .office-strip-text')].map(r => r.textContent),
    focus: document.activeElement?.textContent ?? null, inStrip: !!document.activeElement?.closest('.office-message-strip'), held: document.querySelector('.office-message-strip')?.dataset.officeStripHeld ?? null
  }))
  check(heldState.inStrip && heldState.focus === showName && heldState.rows.length === 3 && heldState.rows[0].includes('Hold three') && !heldState.rows.some(r => r.includes('Hold four')), 'with focus on a Show button the log holds: the row stays, focus is not dropped to body, newer messages wait', JSON.stringify(heldState))
  await stage().focus()
  await waits('after focus leaves the strip the log catches up to the newest three', () => {
    const rows = [...document.querySelectorAll('[data-testid=office-caption] .office-strip-text')].map(r => r.textContent)
    return rows.length === 3 && rows[0].includes('Hold four') && rows[1].includes('Hold three') && rows[2].includes('Hold two')
  }, undefined, 4000)
  check(await scene().locator('.office-message-strip').getAttribute('data-office-strip-held') === null, 'the strip is no longer held once focus has left')
  await endSession(page)

  // ---------- Reduced motion: no walks, no cues, bubbles and the talk mark still appear ----------
  const runReduced = async (label, enable, disable) => {
    await enable()
    await startRecorder()
    await startRun(`Office reduced ${label}`)
    await waits(`${label}: the first bubble and talk mark have both come and gone`, () => window.__officeRec.bubble.end !== null && window.__officeRec.talk.end !== null, undefined, 30_000)
    const watched = await readRecorder()
    check(watched.bubble.start !== null && watched.bubble.text === `Orchestrator: ${FIRST}`, `${label}: the recipient still shows the bubble`, JSON.stringify(watched))
    check(watched.talk.start !== null, `${label}: the sender still shows the talk mark`, JSON.stringify(watched))
    check(watched.phases.every(phase => ['rest', 'pinned'].includes(phase)) && watched.cues.every(cue => cue === 'none') && watched.maxActive === 0, `${label}: nobody walks, every cue is none and the strip counters read 0`, JSON.stringify(watched))
    check(watched.clock.length === 1 && watched.clock[0] === 'stopped' && watched.maxAnimated === 0, `${label}: the clock is stopped and nothing animates`, JSON.stringify(watched))
    const expected = Math.min(6000, 1500 + 45 * FIRST.length)
    const shown = watched.bubble.end === null ? null : watched.bubble.end - watched.bubble.start
    check(shown !== null && Math.abs(shown - expected) <= 900, `${label}: the bubble stays for its readable time (${expected} ms)`, `${shown}`)
    const talkShown = watched.talk.end === null ? null : watched.talk.end - watched.talk.start
    check(talkShown !== null && talkShown >= 900 && talkShown <= 1800, `${label}: the talk mark shows for about 1.2 s`, `${talkShown}`)
    check(watched.talk.start !== null && watched.bubble.start !== null && Math.abs(watched.bubble.start - watched.talk.start) <= 400, `${label}: with no walk the bubble and the talk mark appear together`, JSON.stringify({ talk: watched.talk, bubble: watched.bubble }))
    const state = await snapshot()
    check(quiet(state) && marksAgree(state), `${label}: states and marks agree with no clock`, JSON.stringify(state.sprites.map(s => `${s.state}/${s.cue}/${s.phase}`)))
    check(await scene().locator('[data-testid=office-caption]').count() >= 1, `${label}: the strip still logs messages`)
    await keyShot(`reduced-${label}`)
    await endSession(page)
    await disable()
  }
  await runReduced('app-setting', () => setAppearance({ reduceMotion: 'on' }), () => setAppearance({ reduceMotion: 'system' }))
  await runReduced('os-emulation', async () => { await setAppearance({ reduceMotion: 'system' }); await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(300) }, () => page.emulateMedia({ reducedMotion: 'no-preference' }))
  // Hand the OS preference back only to look at it, then pin it. What the machine itself reports is not under test here and differs
  // between machines (a CI VM can report reduce), so everything after this point runs on an explicit `no-preference`.
  await page.emulateMedia({ reducedMotion: null })
  log('the machine reports prefers-reduced-motion: reduce =', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await waits('motion is back on after the reduced-motion checks (OS no-preference, no Settings attribute)', () => !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.documentElement.hasAttribute('data-reduce-motion'), undefined, 5000)

  // ---------- A scene that mounted on a stale reduced-motion reading still starts its clock ----------
  // The OS reading is held in state, so a change that lands between the render that read it and the effect that listens for it
  // is lost. Simulate exactly that: every reduced-motion query reads `reduce` until something starts listening to it, then tells the truth.
  await resizeTo(1600, 1000)
  await setAppearance({ reduceMotion: 'system', theme: 'dark' }, { presentation: 'pocket-office', scenePalette: 'color' })
  await page.evaluate(() => {
    const real = window.matchMedia.bind(window)
    window.__realMatchMedia = real
    window.matchMedia = query => {
      const list = real(query)
      if (!/prefers-reduced-motion/.test(query)) return list
      let listening = false
      return new Proxy(list, {
        get: (target, key) => {
          if (key === 'matches') return listening ? target.matches : true
          if (key === 'addEventListener') return (...args) => { listening = true; return target.addEventListener(...args) }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  })
  await startRun('Office stale motion')
  await waits('a scene whose first reduced-motion reading was stale still runs its clock once its listener is attached', () => document.querySelector('[data-testid=office-scene]')?.dataset.officeClock === 'running', undefined, 8000)
  check(await scene().locator('[data-testid=office-pause]').getAttribute('aria-disabled') === null, 'Pause motion is not inert after a stale first reading')
  await page.evaluate(() => { window.matchMedia = window.__realMatchMedia; delete window.__realMatchMedia })
  await endSession(page)

  // ---------- 1024 x 640 with a permission card open ----------
  fs.writeFileSync(scriptFile, JSON.stringify({
    delayMs: 300,
    work: [
      { type: 'spawn', id: 'office-a', name: 'office-a', description: 'Receive the findings' },
      { type: 'message', to: 'office-a', text: 'A message beside the card.' },
      { type: 'tool', name: 'Bash', input: { command: 'git status --short' }, ask: true, result: '' },
      { type: 'wait', ms: 60_000 }
    ]
  }))
  await resizeTo(1024, 640)
  await setAppearance({ reduceMotion: 'system', theme: 'dark' }, { presentation: 'pocket-office', scenePalette: 'color' })
  await startRun('Office permission')
  const card = page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first()
  await card.waitFor({ timeout: 20_000 })
  await sleep(600)
  // Name the input first: a static scene here is either reduced motion (OS, Settings or Pause) or a stopped clock, and the two need different fixes.
  const motionInputs = () => page.evaluate(() => ({
    osReduce: matchMedia('(prefers-reduced-motion: reduce)').matches, attr: document.documentElement.getAttribute('data-reduce-motion'), hidden: document.hidden,
    paused: document.querySelector('[data-testid=office-scene]')?.dataset.paused ?? null, pauseInert: document.querySelector('[data-testid=office-pause]')?.getAttribute('aria-disabled') ?? null
  }))
  const inputs = await motionInputs()
  check(!inputs.osReduce && inputs.attr === null && !inputs.hidden && inputs.paused === null && inputs.pauseInert === null, 'motion is on for the permission run (not reduced, paused or hidden)', JSON.stringify(inputs))
  const small = await scene().evaluate(el => {
    const stripEl = el.querySelector('.office-message-strip')
    const strip = stripEl.getBoundingClientRect()
    const stageBox = el.querySelector('[data-testid=office-stage]').getBoundingClientRect()
    return { strip: strip.height, stripScroll: stripEl.scrollHeight - stripEl.clientHeight, stage: [stageBox.width, stageBox.height], sceneBottom: el.getBoundingClientRect().bottom, inner: innerHeight }
  })
  check(await noPageScroll(), 'the office with a permission card open has no page scroll at 1024x640', JSON.stringify(small))
  check(Math.abs(small.strip - 73) <= 1 && small.stripScroll === 0, 'the message strip is still 73 px, unscrolled, with a permission card open', JSON.stringify(small))
  check(small.sceneBottom <= small.inner + 1, 'the office stays inside the window with a permission card open', JSON.stringify(small))
  await keyShot('permission-card-1024')
  await shot('office-permission-card')
  // Needs you: the person who is waiting on the card waves (hand pose) and shows the question mark, drawn from the one clock.
  await waits('the person waiting on the card is in the waiting state with the wait mark (Needs you)', () => {
    const waiting = document.querySelector('[data-testid=office-scene] [data-office-sprite-id][data-office-state=waiting]')
    return !!waiting && document.querySelector(`[data-testid=office-mark][data-mark=wait][data-agent-id="${waiting.dataset.officeSpriteId}"]`) !== null
  }, undefined, 6000)
  if (!await waits('Needs you people wave once any message walk is over (cue waving)', () => !!document.querySelector('[data-testid=office-scene] [data-office-state=waiting][data-office-cue=waving]'), undefined, 15_000)) {
    log('clock did not start; inputs', JSON.stringify({ ...await motionInputs(), clock: await scene().getAttribute('data-office-clock') }))
  }
  const waitingNow = await snapshot()
  check(waitingNow.clock === 'running' && marksAgree(waitingNow) && waitingNow.animated >= 1, 'the clock runs for Needs you, and marks agree', JSON.stringify(waitingNow.sprites.map(s => `${s.state}/${s.cue}`)))
  // Off-screen chips: the person who needs you is scrolled out of the stage, a chip names them in the controls row,
  // pressing it brings them back and hands them keyboard focus, and the stage never changes height.
  const waitingWho = await page.evaluate(() => document.querySelector('[data-testid=office-scene] [data-office-state=waiting]')?.dataset.officeSpriteId ?? null)
  check(!!waitingWho, 'a person is waiting on the card', String(waitingWho))
  // A short stage (QA F2): at 1024x640 with the card open, Show/Find and the off-screen chip must still end with the person's button inside the stage.
  const shortStageH = await stage().evaluate(el => el.getBoundingClientRect().height)
  const buttonOutOf = who => scene().evaluate((el, id) => {
    const s = el.querySelector('[data-testid=office-stage]')
    const b = el.querySelector(`button[data-office-worker-id="${id}"]`)
    for (const [left, top] of [[0, 0], [1e6, 1e6], [0, 1e6], [1e6, 0]]) {
      s.scrollTo({ left, top, behavior: 'instant' })
      const sr = s.getBoundingClientRect(); const r = b.getBoundingClientRect()
      if (r.right < sr.left || r.left > sr.right || r.bottom < sr.top || r.top > sr.bottom) return true
    }
    return false
  }, who)
  const buttonInside = ([id]) => {
    const button = document.querySelector(`button[data-office-worker-id="${id}"]`)
    const s = document.querySelector('[data-testid=office-stage]').getBoundingClientRect()
    if (!button) return false
    const r = button.getBoundingClientRect()
    return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1
  }
  check(await zoomTo(4), 'short stage: zoom in to 4x at 1024x640 with the card open', String(shortStageH))
  if (await buttonOutOf(waitingWho)) {
    await waits('short stage: a chip names the person who is out of the stage', () => !!document.querySelector('.office-controls [data-testid=office-offscreen-show]'), undefined, 4000)
    await scene().locator('.office-controls [data-testid=office-offscreen-show]').first().click()
    await waits(`short stage (${Math.round(shortStageH)} px): the off-screen chip's Show ends with the person's button inside the stage`, buttonInside, [waitingWho], 6000)
  } else check(false, 'short stage: the waiting person could be scrolled out at 4x')
  await openDirectory()
  await settle()
  const dirStageH = await stage().evaluate(el => el.getBoundingClientRect().height)
  check(await zoomTo(3), 'short stage: zoom to 3x with the directory open')
  if (await buttonOutOf(waitingWho)) {
    // A DOM click: with the card and the directory both open the Decisions tray covers the roster at this size (F8, outside the Office).
    await scene().locator(`button[data-office-agent-id="${waitingWho}"]`).evaluate(el => el.click())
    await waits(`short stage with the directory open (${Math.round(dirStageH)} px): Find a person ends with the person's button inside the stage`, buttonInside, [waitingWho], 6000)
    await sleep(600) // the inspector may open and resize the stage after the pan: the person must stay inside
    check(await inStage(waitingWho), 'short stage: the person is still inside the stage after the inspector and directory settle', String(dirStageH))
  } else check(false, 'short stage: the waiting person could be scrolled out at 3x with the directory open')
  if (await page.locator('[data-testid=office-agent-back]').count()) await page.locator('[data-testid=office-agent-back]').evaluate(el => el.click())
  await scene().locator('details.office-directory summary').evaluate(el => el.click())
  // A roomy window: the next chip checks need a stage tall enough to keep a plate and bubble room as well.
  await resizeTo(1600, 1000)
  await settle()
  check(await zoomTo(4), 'zoom in to 4x so the building is larger than the stage')
  const chips = scene().locator('.office-controls [data-testid=office-offscreen-show]')
  const stageHeight = () => stage().evaluate(el => el.getBoundingClientRect().height)
  await scene().evaluate((el, who) => el.querySelector(`button[data-office-worker-id="${who}"]`).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), waitingWho)
  await waits('no chip is shown while the waiting person is inside the stage', () => document.querySelectorAll('[data-testid=office-offscreen-show]').length === 0, undefined, 4000)
  const heightWith = await stageHeight()
  const moved = await scene().evaluate((el, who) => {
    const s = el.querySelector('[data-testid=office-stage]')
    const b = el.querySelector(`button[data-office-worker-id="${who}"]`)
    for (const [left, top] of [[0, 0], [1e6, 1e6], [0, 1e6], [1e6, 0]]) {
      s.scrollTo({ left, top, behavior: 'instant' })
      const sr = s.getBoundingClientRect(); const r = b.getBoundingClientRect()
      if (r.right < sr.left || r.left > sr.right || r.bottom < sr.top || r.top > sr.bottom) return true
    }
    return false
  }, waitingWho)
  check(moved, 'the waiting person can be scrolled fully out of the stage at 4x')
  await waits('a chip naming the waiting person appears in the controls row', () => {
    const chip = document.querySelector('.office-controls [data-testid=office-offscreen-show]')
    return !!chip && /needs you/.test(chip.getAttribute('aria-label') ?? '')
  }, undefined, 4000)
  const chipLabel = await chips.first().getAttribute('aria-label')
  const personName = await scene().locator(`button[data-office-worker-id="${waitingWho}"] .office-person-name`).textContent()
  check(!!chipLabel && chipLabel.includes(personName ?? '?') && /off screen/.test(chipLabel), 'the chip names the person, the reason and the direction', `${chipLabel} / ${personName}`)
  check(Math.abs(await stageHeight() - heightWith) <= 0.5, 'a chip appearing does not change the stage height', `${heightWith} -> ${await stageHeight()}`)
  await chips.first().click()
  await waits('the chip goes away once the person is on screen', () => document.querySelectorAll('[data-testid=office-offscreen-show]').length === 0, undefined, 6000)
  await waits('keyboard focus is on the person (not the page body)', id => document.activeElement?.dataset?.officeWorkerId === id, waitingWho, 3000)
  await waits('pressing the chip brings the person fully into view (after the smooth pan)', who => {
    const button = document.querySelector(`button[data-office-worker-id="${who}"]`)
    const s = document.querySelector('[data-testid=office-stage]').getBoundingClientRect()
    const r = button.getBoundingClientRect()
    return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1
  }, waitingWho, 5000)
  check(Math.abs(await stageHeight() - heightWith) <= 0.5, 'a chip disappearing does not change the stage height', `${heightWith} -> ${await stageHeight()}`)
  await stage().focus()
  await page.keyboard.press('Home')
  await settle()
  await card.getByRole('button', { name: 'Allow once', exact: true }).click()
  await sleep(400)
  await endSession(page)

  // ---------- A 90-character unbroken agent name must not break a strip row (QA F3) ----------
  const LONG_NAME = 'W'.repeat(90)
  fs.writeFileSync(scriptFile, JSON.stringify({
    delayMs: 300,
    work: [
      { type: 'spawn', id: LONG_NAME, name: LONG_NAME, description: 'Long name' },
      { type: 'wait', ms: 1500 },
      { type: 'message', to: LONG_NAME, text: 'Please confirm the long name stays contained.' },
      { type: 'wait', ms: 60_000 }
    ]
  }))
  await resizeTo(1280, 800)
  await startRun('Office long name')
  await waits('the strip logs the message to the long-named agent', () => /contained/.test(document.querySelector('[data-testid=office-caption] .office-strip-text')?.textContent ?? ''), undefined, 30_000)
  const longRow = await scene().evaluate((el, full) => {
    const row = el.querySelector('[data-testid=office-caption]')
    const r = row.getBoundingClientRect()
    const btn = row.querySelector('[data-testid=office-show]')
    const text = row.querySelector('.office-strip-text')
    const b = btn?.getBoundingClientRect()
    const t = text.getBoundingClientRect()
    return {
      button: !!btn, btnInside: !!b && b.left >= r.left - 0.5 && b.right <= r.right + 0.5, btnWidth: b?.width ?? 0, textWidth: t.width, rowWidth: r.width,
      label: btn?.getAttribute('aria-label'), title: btn?.getAttribute('title'), fullName: full, shown: btn?.textContent, rowText: text.textContent
    }
  }, LONG_NAME)
  check(longRow.button && longRow.btnInside && longRow.btnWidth <= longRow.rowWidth * 0.45, 'a 90-character unbroken name keeps the Show button inside its row and bounded', JSON.stringify(longRow))
  check(longRow.textWidth >= 150 && longRow.rowText.length < 120, 'the message text keeps a usable width and the names in the row text are bounded', JSON.stringify(longRow))
  // The runtime already bounds a handle (about 64 characters); the strip clips it further for display only.
  check(longRow.label?.startsWith('Show WWWW') && longRow.title === longRow.label && longRow.label.length > longRow.shown.length && longRow.shown.length <= 'Show '.length + 24, 'the Show button keeps the whole name in its accessible name and title while its label is clipped', JSON.stringify(longRow))
  await endSession(page)

  // ---------- A failed turn: failed state, error mark, no loop ----------
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300, work: [{ type: 'spawn', id: 'office-a', name: 'office-a', description: 'Receive the findings' }, { type: 'wait', ms: 1500 }, { type: 'fail' }, { type: 'wait', ms: 60_000 }] }))
  await resizeTo(1600, 1000)
  await startRun('Office failure')
  await waits('a failed person shows the error mark (Failed)', () => !!document.querySelector('[data-testid=office-scene] [data-office-state=failed]') && !!document.querySelector('[data-testid=office-mark][data-mark=error]'), undefined, 20_000)
  await sleep(1500)
  const failed = await snapshot()
  check(failed.sprites.some(s => s.state === 'failed') && marksAgree(failed), 'a failed person keeps the error mark once the slump has played', JSON.stringify(failed.sprites.map(s => `${s.state}/${s.cue}`)))
  check(failed.sprites.filter(s => s.state === 'failed').every(s => s.cue === 'none'), 'the slump is a one-shot: a failed person settles to cue none')
  await keyShot('live-failed')
  await endSession(page)
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))

  // ---------- Graph restores its style ----------
  await setCanvas({ presentation: 'graph' })
  await sleep(200)
  const restored = await page.evaluate(async () => (await window.orgai.settings.get()).appearance.canvas)
  check(Object.entries(graph).every(([key, value]) => restored[key] === value), 'returning to graph restores its saved style', JSON.stringify(restored))
  await setAppearance({ reduceMotion: 'system', theme: 'dark' }, { pattern: 'dots', layout: 'top-down', nodeStyle: 'card', edges: 'curved', minimap: false, tint: true })
}
