// Pocket Office checks (docs/design/pocket-office.md "Living office rework", sections 8 and 9 S6).
// Called by office.mjs (focused runner) and canvas.mjs (CI) so Pocket Office stays on the token-free path: mock adapter only.
// One building per team, no floors: people are looked up by id and building coordinates, never by floor.
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
  check(await section.locator('[data-testid=canvas-presentation-choice]').count() === 2, 'presentation offers two visual choices')
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
  await openTeam(page)
  const styleTrigger = page.getByRole('button', { name: 'Canvas style', exact: true })
  await styleTrigger.click()
  const stylePanel = page.locator('[data-testid=canvas-style-popover]')
  await stylePanel.waitFor()
  await page.waitForFunction(() => document.activeElement?.matches('[data-testid="canvas-presentation"] input[value="pocket-office"]'))
  check(await stylePanel.locator('[data-testid=canvas-preset]').count() === 0, 'Office toolbar does not offer accidental Graph preset switches')
  check(await stylePanel.locator('[data-testid=canvas-palette-choice]').count() === 3, 'toolbar offers the same visual Office palette choices')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Canvas style' || document.activeElement?.textContent?.trim() === 'Canvas style')
  check(await styleTrigger.evaluate(el => el === document.activeElement), 'Office style Escape returns focus to Canvas style')

  // ---------- Team: one static building at both window sizes, both themes, three palettes ----------
  const placed = new Set()
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      for (const palette of ['color', 'neutral', 'green']) {
        const tag = `at ${w}x${h} ${theme}/${palette}`
        await setAppearance({ theme }, { presentation: 'pocket-office', scenePalette: palette })
        await scene().waitFor()
        check(await scene().getAttribute('data-mode') === 'team', `Team is static ${tag}`)
        check(await scene().getAttribute('data-palette') === palette, `office follows palette ${tag}`)
        check(await noPageScroll(), `office fits the window ${tag}`)
        check(await scene().locator('[data-office-agent-id]').count() > 1, `Team exposes named agent buttons ${tag}`)
        const targets = await targetsOk()
        check(targets.count > 0 && targets.size && targets.aligned && targets.named && !targets.overlap, `native person targets cover their visible sprites with accessible names ${tag}`, JSON.stringify(targets))
        const directory = scene().locator('details.office-directory')
        check(await directory.count() === 1 && await directory.getAttribute('open') === null, `agent directory stays optional ${tag}`)
        const identityFrames = await scene().locator('[data-office-sprite-id]').evaluateAll(sprites => sprites.map(sprite => sprite.style.backgroundPosition))
        check(identityFrames.length <= 12 && new Set(identityFrames).size === identityFrames.length, `small team people have distinct silhouettes ${tag}`)
        const fills = await scene().evaluate(el => {
          const s = el.querySelector('.office-stage')
          const map = el.querySelector('[data-testid=office-floor]')?.getBoundingClientRect()
          return !!s && !!map && map.width >= s.clientWidth - 1 && map.height >= s.clientHeight - 1
        })
        check(fills, `office map fills the resized stage ${tag}`)
        check(await scene().locator('[data-office-department-id]').count() > 0, `real reporting branches label departments ${tag}`)
        const team = await scene().evaluate(el => ({
          clock: el.dataset.officeClock, animated: el.dataset.officeAnimated, pause: !!el.querySelector('[data-testid=office-pause]'),
          bubbles: el.querySelectorAll('[data-testid=office-bubble]').length, marks: el.querySelectorAll('[data-testid=office-mark]').length,
          cues: [...el.querySelectorAll('[data-office-sprite-id]')].map(s => s.dataset.officeCue), states: [...el.querySelectorAll('[data-office-sprite-id]')].map(s => s.dataset.officeState),
          floorText: /\bfloors?\b/i.test(el.textContent), floorAttr: el.hasAttribute('data-floor') || !!el.querySelector('[data-floor], [data-office-floor]'),
          floorButtons: [...el.querySelectorAll('button')].some(b => /floor/i.test(`${b.textContent} ${b.getAttribute('aria-label')}`)),
          stageLabel: el.querySelector('[data-testid=office-stage]').getAttribute('aria-label'), stageRole: el.querySelector('[data-testid=office-stage]').getAttribute('role'),
          people: [...el.querySelectorAll('button[data-office-worker-id]')].map(b => ({ name: b.querySelector('.office-person-name')?.textContent, line: b.querySelector('.office-person-line')?.textContent, label: b.getAttribute('aria-label') }))
        }))
        check(team.clock === 'stopped' && team.animated === '0' && team.cues.every(cue => cue === 'none') && team.states.every(state => state === 'idle'), `Team has no clock, no cues and every person idle ${tag}`, JSON.stringify(team))
        check(!team.pause && team.bubbles === 0 && team.marks === 0, `Team has no Pause motion, bubbles or marks ${tag}`)
        check(!team.floorText && !team.floorAttr && !team.floorButtons, `Team has no floor text, attribute or button ${tag}`)
        check(/^Office scene\. Arrow keys pan, plus and minus zoom, 0 fits the building/.test(team.stageLabel ?? ''), `the stage names its keys ${tag}`, team.stageLabel)
        check(team.stageRole === 'group' && /arrow keys/i.test(team.stageLabel ?? '') && /plus and minus/i.test(team.stageLabel ?? '') && /\b0 fits\b/.test(team.stageLabel ?? '') && /home/i.test(team.stageLabel ?? ''), `the stage is a role=group whose label mentions the keys ${tag}`, `${team.stageRole} ${team.stageLabel}`)
        check(team.people.length > 1 && team.people.every(p => p.line && p.label === `${p.name}, ${p.line}`) && team.people[0].line === 'Orchestrators', `Team plate line 2 is the department name (Orchestrators in the lobby) ${tag}`, JSON.stringify(team.people))
        placed.add(JSON.stringify(await positionsOf()))
        await shot(`office-team-${w}x${h}-${theme}-${palette}`)
      }
    }
  }
  check(placed.size === 1, 'data-office-x/y are identical at 1600x1000 and 1024x640 in every theme and palette', [...placed].join(' / '))
  await keyShot('team-1600-light-green')

  // Zoom set 0.5, 1, 2, 3, 4: coordinates never move, targets stay usable, plates follow the zoom, instant steps.
  await stage().focus()
  await page.keyboard.press('Home')
  await settle()
  const home = await positionsOf()
  for (const target of [0.5, 1, 2, 3, 4, 2]) {
    const reached = await zoomTo(target)
    const info = await stageInfo()
    check(reached && info.zoom === target && (info.readout.includes(target === 0.5 ? '½×' : `${target}×`) || info.readout.includes(`Zoom ${target * 100}%`)), `zoom reads ${target === 0.5 ? '½×' : `${target}×`} with data-zoom ${target}`, JSON.stringify(info))
    check(info.aria === `Zoom ${target * 100}%`, `the zoom readout is labelled "Zoom ${target * 100}%" at zoom ${target}`, String(info.aria))
    check(JSON.stringify(await positionsOf()) === JSON.stringify(home), `data-office-x/y do not change at zoom ${target}`)
    const t = await targetsOk()
    check(t.size && t.aligned && t.named && !t.overlap, `person targets are at least 24 px, aligned and apart at zoom ${target}`, JSON.stringify(t))
    const plates = await scene().locator('.office-person-label').evaluateAll(labels => labels.map(label => getComputedStyle(label).display))
    check(info.plates === (target >= 2 ? 'always' : 'hover') && plates.every(display => (target >= 2) === (display !== 'none')), `nameplates are ${target >= 2 ? 'always shown' : 'hover-only'} at zoom ${target}`, `${info.plates} ${plates.join(',')}`)
  }
  await stage().focus()
  await page.keyboard.press('Home')
  await settle()
  await keyShot('team-default-view')

  // ---------- A real 33-role team: Fit, 1x overview, Tab order, keys, drag, Find ----------
  // The first twelve roles keep distinct atlas identities (checked on a 12-role team), then the 33-role tree is saved.
  const original = await page.evaluate(async projectName => (await window.orgai.projects.list()).find(project => project.name === projectName), name)
  const largeProject = await page.evaluate(async project => {
    const root = project.roles.find(role => role.reportsTo === null)
    const template = project.roles.find(role => role.reportsTo !== null) ?? root
    const roles = [root]
    for (let branch = 0; branch < 4; branch++) {
      const leadId = `office-lead-${branch}`
      roles.push({ ...template, id: leadId, slug: `office-lead-${branch}`, name: `Department lead ${branch + 1}`, reportsTo: root.id })
      for (let worker = 0; worker < 7; worker++) roles.push({ ...template, id: `office-worker-${branch}-${worker}`, slug: `office-worker-${branch}-${worker}`, name: `Worker ${branch + 1}.${worker + 1}`, reportsTo: leadId })
    }
    await window.orgai.projects.save({ ...project, roles: roles.slice(0, 12) })
    return { ...project, roles }
  }, original)
  const reopenTeam = async () => {
    await page.reload()
    await page.locator('.sidebar').waitFor()
    await openProject(page, name)
    await openTeam(page)
    await scene().waitFor()
    await sleep(300)
  }
  await reopenTeam()
  const firstTwelve = await scene().locator('[data-office-sprite-id]').evaluateAll(sprites => sprites.slice(0, 12).map(sprite => sprite.style.backgroundPosition))
  check(firstTwelve.length === 12 && new Set(firstTwelve).size === 12, 'first twelve people retain visibly distinct atlas identities')
  await page.evaluate(async project => { await window.orgai.projects.save(project) }, largeProject)
  await resizeTo(1600, 1000)
  await reopenTeam()
  check(await scene().locator('button[data-office-agent-id]').count() === 33, 'large team keeps all 33 real roles in the optional directory')
  check(await scene().locator('button[data-office-worker-id]').count() === 33, 'the 33-role building shows every person as a native button')
  check(await scene().getAttribute('data-palette') === 'green', 'saved office presentation and palette survive a renderer reload')
  const big = await stageInfo()
  check(big.w === 58 && big.h === 33, 'the 33-role building is 58 x 33 tiles (4 departments of 8 plus the lobby)', JSON.stringify(big))
  check(big.zoom === 2, 'the 33-role default view is 2x on the lobby', JSON.stringify(big))
  await zoomButton('Fit').click()
  await settle()
  const fit = await stageInfo()
  check(fit.zoom === 0.5 && fit.sw <= fit.cw && fit.sh <= fit.ch && fit.sl === 0 && fit.st === 0, 'Fit shows the whole 33-role building with no scrollbars', JSON.stringify(fit))
  check(await scene().locator('[data-office-sprite-id]').evaluateAll(sprites => sprites.length === 33), 'the fitted building still draws all 33 people')
  const fitPositions = await positionsOf()
  await keyShot('team-33-fit')
  await shot('office-team-33-fit')
  // Overview at 1x: room labels, no nameplates, people targets stay usable.
  check(await zoomTo(1), 'Zoom in from Fit reaches the 1x overview')
  const overview = await scene().evaluate(el => {
    const s = el.querySelector('[data-testid=office-stage]').getBoundingClientRect()
    const labels = [...el.querySelectorAll('.office-room-label')]
    return {
      plates: el.dataset.plates, labels: labels.map(l => l.textContent), visible: labels.map(l => { const r = l.getBoundingClientRect(); return r.width > 0 && r.height > 0 }),
      shown: labels.filter(l => { const r = l.getBoundingClientRect(); return r.right > s.left && r.left < s.right && r.bottom > s.top && r.top < s.bottom }).length,
      platesShown: [...el.querySelectorAll('.office-person-label')].filter(p => getComputedStyle(p).display !== 'none').length
    }
  })
  check(overview.plates === 'hover' && overview.platesShown === 0, 'the 1x overview shows no nameplates by default', JSON.stringify(overview))
  check(overview.labels.length === 5 && overview.labels.every(text => /^.+ · \d+$/.test(text)) && overview.visible.every(Boolean) && overview.shown >= 3, 'the 1x overview shows room labels `{Department} · {n}`', JSON.stringify(overview))
  check(overview.labels.includes('Orchestrators · 1') && overview.labels.filter(text => text.endsWith('· 8')).length === 4, 'the room labels count the lobby and four full departments', overview.labels.join(' | '))
  check(JSON.stringify(await positionsOf()) === JSON.stringify(fitPositions), 'the 33-role coordinates do not move between Fit and 1x')
  await keyShot('team-33-overview-1x')
  // The room roster: every person has a room label, the lobby first.
  await openDirectory()
  const roster = await scene().locator('button[data-office-agent-id]').evaluateAll(buttons => buttons.map(b => ({ id: b.dataset.officeAgentId, room: b.dataset.officeRoom })))
  check(roster.length === 33 && roster.every(entry => !!entry.room) && new Set(roster.map(entry => entry.room)).size === 5, 'every roster button names its room (data-office-room), five rooms for 33 people', JSON.stringify([...new Set(roster.map(entry => entry.room))]))
  check(!(await scene().locator('[data-office-floor]').count()), 'roster rows carry no data-office-floor')
  await scene().locator('details.office-directory summary').click()

  // Keyboard on the stage: arrows pan 48 px (Shift 192), +/- step the zoom, 0 fits, Home is the default view.
  await stage().focus()
  await page.keyboard.press('Home')
  await settle()
  let before = await stageInfo()
  check(before.zoom === 2 && before.sw > before.cw, 'Home returns to the 2x default view of the 33-role building', JSON.stringify(before))
  const pan = async (key, axis, expected, what) => {
    const start = (await stageInfo())[axis]
    await page.keyboard.press(key)
    try { await page.waitForFunction(([a, value]) => { const s = document.querySelector('[data-testid=office-stage]'); return (a === 'sl' ? s.scrollLeft : s.scrollTop) === value }, [axis, start + expected], { timeout: 2000 }) } catch { /* reported below */ }
    const end = (await stageInfo())[axis]
    check(end - start === expected, what, `${start} -> ${end}`)
  }
  await pan('ArrowRight', 'sl', 48, 'ArrowRight pans the stage 48 px right')
  await pan('ArrowLeft', 'sl', -48, 'ArrowLeft pans the stage 48 px left')
  await pan('ArrowDown', 'st', 48, 'ArrowDown pans the stage 48 px down')
  await pan('ArrowUp', 'st', -48, 'ArrowUp pans the stage 48 px up')
  await pan('Shift+ArrowRight', 'sl', 192, 'Shift+ArrowRight pans the stage 192 px')
  await stage().focus()
  await page.keyboard.press('+')
  await settle()
  check((await stageInfo()).zoom === 3, 'plus zooms in one step (data-zoom 3)')
  await page.keyboard.press('-')
  await page.keyboard.press('-')
  await settle()
  check((await stageInfo()).zoom === 1, 'minus zooms out one step per press (data-zoom 1)')
  await page.keyboard.press('0')
  await settle()
  const keyFit = await stageInfo()
  check(keyFit.zoom === 0.5 && keyFit.sw <= keyFit.cw && keyFit.sh <= keyFit.ch, 'zero fits the whole building', JSON.stringify(keyFit))
  await page.keyboard.press('Home')
  await settle()
  check((await stageInfo()).zoom === 2, 'Home restores the default view')
  // Drag on an empty part of the stage pans it (grab cursor, pointer capture; people buttons are excluded).
  const spot = await stage().evaluate(el => {
    const r = el.getBoundingClientRect()
    for (let y = r.top + 30; y < r.bottom - 30; y += 17) for (let x = r.left + 30; x < r.right - 30; x += 19) {
      const hit = document.elementFromPoint(x, y)
      if (hit && !hit.closest('button, summary, a') && el.contains(hit)) return { x, y }
    }
    return null
  })
  if (spot) {
    const start = await stageInfo()
    await page.mouse.move(spot.x, spot.y)
    await page.mouse.down()
    await page.mouse.move(spot.x - 90, spot.y - 50, { steps: 6 })
    const dragging = await stage().getAttribute('data-dragging')
    await page.mouse.up()
    const end = await stageInfo()
    check(dragging === 'true' && end.sl - start.sl >= 60 && end.st - start.st >= 30, 'dragging an empty part of the stage pans it', `${start.sl},${start.st} -> ${end.sl},${end.st} dragging=${dragging}`)
    check(await stage().getAttribute('data-dragging') === null, 'the drag ends cleanly on pointer up')
  } else check(false, 'found an empty spot on the stage to drag')
  await stage().focus()
  await page.keyboard.press('Home')
  await settle()

  // Tab order: lobby first, then rooms in sequence; every focused person is scrolled into view.
  const order = await scene().locator('button[data-office-worker-id]').evaluateAll(buttons => buttons.map(b => ({ id: b.dataset.officeWorkerId, label: b.getAttribute('aria-label') })))
  const rooms = new Map(roster.map(entry => [entry.id, entry.room]))
  check(/^Orchestrators/.test(rooms.get(order[0].id) ?? ''), 'the first person in building order is in the lobby', `${order[0].id} ${rooms.get(order[0].id)}`)
  const seq = order.map(person => rooms.get(person.id))
  const firstSeen = [...new Set(seq)]
  check(seq.every((room, i) => i === 0 || room === seq[i - 1] || !seq.slice(0, i).includes(room)) && firstSeen[0].startsWith('Orchestrators') && firstSeen.length === 5, 'building order keeps each room together, lobby first', firstSeen.join(' | '))
  await stage().focus()
  const tabbed = []
  let visible = true
  for (let i = 0; i < order.length; i++) {
    await page.keyboard.press('Tab')
    await settle()
    const id = await page.evaluate(() => document.activeElement?.dataset?.officeWorkerId ?? null)
    tabbed.push(id)
    if (id && !(await inStage(id))) { visible = false; log('not in view after Tab:', id) }
  }
  check(JSON.stringify(tabbed) === JSON.stringify(order.map(person => person.id)), 'Tab walks all 33 people in building order, lobby first', tabbed.slice(0, 6).join(','))
  check(visible, 'Tab scrolls every focused person into view')
  await page.keyboard.press('Tab')
  check(await page.evaluate(() => !document.activeElement?.dataset?.officeWorkerId), 'Tab leaves the people after the last one')
  await stage().focus()
  await page.keyboard.press('Home')
  await settle()

  // Keyboard zoom with a person focused: they stay inside the stage, each change is announced once, the readout is labelled.
  await page.keyboard.press('Tab')
  const zoomWho = await page.evaluate(() => document.activeElement?.dataset?.officeWorkerId ?? null)
  check(!!zoomWho, 'Tab from the stage focuses a person for the keyboard zoom pass', String(zoomWho))
  await sleep(1100)
  await page.evaluate(() => {
    window.__said?.stop()
    const region = document.querySelector('[data-testid=tray-announce]')
    const list = []
    let last = ''
    const observer = new MutationObserver(() => { const text = region.textContent ?? ''; if (text && text !== last) list.push(text); last = text })
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    window.__said = { list, stop: () => observer.disconnect() }
  })
  await page.keyboard.press('+')
  await waits('plus announces `Zoom 300%`', () => window.__said.list.includes('Zoom 300%'), undefined, 4000)
  await settle()
  check((await stageInfo()).zoom === 3 && await inStage(zoomWho) && await page.evaluate(id => document.activeElement?.dataset?.officeWorkerId === id, zoomWho), 'plus keeps the focused person inside the stage and focused', JSON.stringify(await stageInfo()))
  check((await stageInfo()).aria === 'Zoom 300%', 'the zoom readout is labelled `Zoom 300%` after plus')
  await sleep(1100) // the frame announcer joins lines said within one second of each other (JOIN_WINDOW_MS)
  await page.keyboard.press('-')
  await waits('minus announces `Zoom 200%`', () => window.__said.list.includes('Zoom 200%'), undefined, 4000)
  await settle()
  check((await stageInfo()).zoom === 2 && await inStage(zoomWho), 'minus keeps the focused person inside the stage')
  await settle()
  const said = await page.evaluate(() => window.__said.list.slice())
  check(JSON.stringify(said) === JSON.stringify(['Zoom 300%', 'Zoom 200%']), 'each keyboard zoom change is announced exactly once through the frame live region', JSON.stringify(said))
  await page.evaluate(() => window.__said.stop())
  await sleep(1100) // later announcement checks read the whole region text, so let this one age out of the join window
  await stage().focus()
  await page.keyboard.press('Home')
  await settle()

  // Find a person (roster): selects, pans so the person is inside, rings them, then the ring goes away.
  await openDirectory()
  await scene().locator('button[data-office-agent-id="office-worker-3-6"]').click()
  await waits('Find a person rings the person (data-office-found)', () => document.querySelector('button[data-office-worker-id="office-worker-3-6"]')?.getAttribute('data-office-found') === 'true')
  await waits('Find a person brings the person inside the stage', () => {
    const el = document.querySelector('button[data-office-worker-id="office-worker-3-6"]')
    const s = document.querySelector('[data-testid=office-stage]')?.getBoundingClientRect()
    if (!el || !s) return false
    const r = el.getBoundingClientRect()
    return r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom
  }, undefined, 8000)
  check(await scene().locator('button[data-office-worker-id="office-worker-3-6"]').getAttribute('aria-pressed') === 'true', 'Find a person selects the person')
  check(await scene().locator('[data-office-found]').count() === 1, 'only one person is ringed at a time')
  // The frame announcer joins lines said within a second of each other (JOIN_WINDOW_MS), so earlier keyboard-zoom lines may precede it:
  // the Showing line must be the latest and appear exactly once.
  const findSaid = (await page.locator('[data-testid=tray-announce]').first().textContent()) ?? ''
  check(/(^|\. )Showing Worker 4\.7, Department lead 4$/.test(findSaid) && findSaid.split('Showing ').length === 2, 'Find a person announces `Showing {name}, {room}` once, as the latest line', findSaid)
  await keyShot('team-33-find')
  await waits('the Find ring goes away after three seconds', () => !document.querySelector('[data-office-found]'), undefined, 6000)
  await page.locator('[data-testid=office-role-back]').click()
  check(await page.evaluate(() => document.activeElement?.dataset?.officeWorkerId === 'office-worker-3-6'), 'Back to office returns focus to the found person')

  // Back to the small team for the person keyboard path.
  await page.evaluate(async project => { await window.orgai.projects.save(project) }, original)
  await resizeTo(1024, 640)
  await reopenTeam()
  const worker = scene().locator('button[data-office-worker-id]').first()
  await worker.focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-testid=role-capabilities]').waitFor()
  check(await page.locator('[data-testid=role-capabilities]').count() === 1, 'office keyboard selection opens the existing editable role inspector')
  await page.locator('[data-testid=office-role-back]').click()
  check(await page.evaluate(() => !!document.activeElement?.hasAttribute('data-office-worker-id') || !!document.activeElement?.hasAttribute('data-office-agent-id')), 'Back to office returns Team focus to its person')
  await worker.focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-testid=role-capabilities]').waitFor()
  await page.keyboard.press('Escape')
  check(await page.evaluate(() => !!document.activeElement?.hasAttribute('data-office-worker-id') || !!document.activeElement?.hasAttribute('data-office-agent-id')), 'Escape returns Team focus to an office agent')

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
    const region = el.querySelector('.office-message-strip').getBoundingClientRect()
    return {
      height: region.height, rows: [...el.querySelectorAll('[data-testid=office-caption]')].map(r => ({ text: r.querySelector('.office-strip-text').textContent, show: r.querySelector('[data-testid=office-show]')?.textContent ?? null, full: r.querySelector('.office-full-message')?.textContent ?? '' })),
      script: el.querySelectorAll('[data-testid=office-caption] script').length
    }
  })
  check(Math.abs(strip.height - 48) <= 1, 'the message strip is 48 px tall', String(strip.height))
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
  check(await page.evaluate(() => document.activeElement?.dataset?.officeWorkerId === 'root'), 'Back to office returns focus to the shown person')
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
  await page.emulateMedia({ reducedMotion: null })

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
  const small = await scene().evaluate(el => {
    const strip = el.querySelector('.office-message-strip').getBoundingClientRect()
    const stageBox = el.querySelector('[data-testid=office-stage]').getBoundingClientRect()
    return { strip: strip.height, stage: [stageBox.width, stageBox.height], sceneBottom: el.getBoundingClientRect().bottom, inner: innerHeight }
  })
  check(await noPageScroll(), 'the office with a permission card open has no page scroll at 1024x640', JSON.stringify(small))
  check(Math.abs(small.strip - 48) <= 1, 'the message strip is still 48 px with a permission card open', String(small.strip))
  check(small.sceneBottom <= small.inner + 1, 'the office stays inside the window with a permission card open', JSON.stringify(small))
  await keyShot('permission-card-1024')
  await shot('office-permission-card')
  // Needs you: the person who is waiting on the card waves (hand pose) and shows the question mark, drawn from the one clock.
  await waits('the person waiting on the card is in the waiting state with the wait mark (Needs you)', () => {
    const waiting = document.querySelector('[data-testid=office-scene] [data-office-sprite-id][data-office-state=waiting]')
    return !!waiting && document.querySelector(`[data-testid=office-mark][data-mark=wait][data-agent-id="${waiting.dataset.officeSpriteId}"]`) !== null
  }, undefined, 6000)
  await waits('Needs you people wave once any message walk is over (cue waving)', () => !!document.querySelector('[data-testid=office-scene] [data-office-state=waiting][data-office-cue=waving]'), undefined, 15_000)
  const waitingNow = await snapshot()
  check(waitingNow.clock === 'running' && marksAgree(waitingNow) && waitingNow.animated >= 1, 'the clock runs for Needs you, and marks agree', JSON.stringify(waitingNow.sprites.map(s => `${s.state}/${s.cue}`)))
  // Off-screen chips: the person who needs you is scrolled out of the stage, a chip names them in the controls row,
  // pressing it brings them back and hands them keyboard focus, and the stage never changes height.
  const waitingWho = await page.evaluate(() => document.querySelector('[data-testid=office-scene] [data-office-state=waiting]')?.dataset.officeSpriteId ?? null)
  check(!!waitingWho, 'a person is waiting on the card', String(waitingWho))
  // A roomy window: at 1024x640 with the card open the stage is only ~116 px tall, too short to reveal a 4x person with a plate and bubble room.
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
