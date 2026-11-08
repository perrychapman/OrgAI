// Called by canvas.mjs so Pocket Office stays on the existing token-free CI path.
import { check, endSession, openAppSettings, openProject, openTeam, projectTab, sleep } from './lib.mjs'
import * as fs from 'node:fs'

export async function checkPocketOffice({ page, name, resizeTo, setAppearance, setCanvas, noPageScroll, shot, scriptFile }) {
  const scene = () => page.locator('[data-testid=office-scene]').first()
  const openDirectory = async () => {
    const directory = scene().locator('details.office-directory')
    if (await directory.count() && await directory.getAttribute('open') === null) await directory.locator('summary').click()
  }
  const graph = { pattern: 'blueprint', layout: 'left-right', nodeStyle: 'compact', edges: 'orthogonal', minimap: true, tint: false }
  await setCanvas({ ...graph, presentation: 'graph', scenePalette: 'color' })
  await openAppSettings(page)
  const section = page.locator('[data-testid=canvas-section]')
  const office = section.locator('[data-testid=canvas-presentation] input[value="pocket-office"]')
  await office.check()
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'pocket-office')
  check(await section.locator('[data-testid=canvas-preview] [data-testid=office-scene]').count() === 1, 'Pocket Office settings shows the shared scene sample')
  check(await scene().getAttribute('data-mode') === 'sample', 'settings office is explicitly static sample data')
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
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      for (const palette of ['color', 'neutral', 'green']) {
        await setAppearance({ theme }, { presentation: 'pocket-office', scenePalette: palette })
        await scene().waitFor()
        check(await scene().getAttribute('data-mode') === 'team', `Team is static at ${w}x${h} ${theme}/${palette}`)
        check(await scene().getAttribute('data-palette') === palette, `office follows palette at ${w}x${h} ${theme}/${palette}`)
        check(await noPageScroll(), `office fits the window at ${w}x${h} ${theme}/${palette}`)
        check(await scene().locator('[data-office-agent-id]').count() > 1, `Team exposes named agent buttons at ${w}x${h} ${theme}/${palette}`)
        const targets = await scene().locator('button[data-office-worker-id]').evaluateAll(buttons => buttons.map(button => {
          const rect = button.getBoundingClientRect()
          const sprite = [...document.querySelectorAll('[data-office-sprite-id]')].find(el => el.getAttribute('data-office-sprite-id') === button.getAttribute('data-office-worker-id'))
          const art = sprite?.getBoundingClientRect()
          return { size: rect.width >= 24 && rect.height >= 24, aligned: !!art && rect.left <= art.left && rect.right >= art.right && rect.top <= art.top && rect.bottom >= art.bottom, named: !!button.getAttribute('aria-label') || !!button.textContent?.trim() }
        }))
        check(targets.length > 0 && targets.every(target => target.size && target.aligned && target.named), `native person targets cover their visible sprites with accessible names at ${w}x${h} ${theme}/${palette}`)
        const directory = scene().locator('details.office-directory')
        check(await directory.count() === 1 && await directory.getAttribute('open') === null, `agent directory stays optional at ${w}x${h} ${theme}/${palette}`)
        const identityFrames = await scene().locator('[data-office-sprite-id]').evaluateAll(sprites => sprites.map(sprite => sprite.style.backgroundPosition))
        check(identityFrames.length <= 12 && new Set(identityFrames).size === identityFrames.length, `small team people have distinct silhouettes at ${w}x${h} ${theme}/${palette}`)
        const fills = await scene().evaluate(el => {
          const stage = el.querySelector('.office-stage')
          const floor = el.querySelector('[data-testid=office-floor]')?.getBoundingClientRect()
          return !!stage && !!floor && floor.width >= stage.clientWidth - 1 && floor.height >= stage.clientHeight - 1
        })
        check(fills, `office floor fills the resized stage at ${w}x${h} ${theme}/${palette}`)
        check(await scene().locator('[data-office-department-id]').count() > 0, `real reporting branches label departments at ${w}x${h} ${theme}/${palette}`)
        await shot(`office-team-${w}x${h}-${theme}-${palette}`)
      }
    }
  }
  // A real project role tree with four departments overflows floors while retaining every role in the roster.
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
  await page.reload()
  await page.locator('.sidebar').waitFor()
  await openProject(page, name)
  await openTeam(page)
  await scene().waitFor()
  const firstPeople = new Map()
  for (let floor = 0; floor < 33 && firstPeople.size < 12; floor++) {
    const people = await scene().locator('[data-office-sprite-id]').evaluateAll(sprites => sprites.map(sprite => [sprite.getAttribute('data-office-sprite-id'), sprite.style.backgroundPosition]))
    for (const [id, appearance] of people) if (firstPeople.size < 12) firstPeople.set(id, appearance)
    const next = scene().getByRole('button', { name: 'Next floor', exact: true })
    if (await next.isDisabled()) break
    await next.click()
  }
  check(firstPeople.size === 12 && new Set(firstPeople.values()).size === 12, 'first twelve people retain visibly distinct atlas identities across floors')
  await page.evaluate(async project => { await window.orgai.projects.save(project) }, largeProject)
  await page.reload()
  await page.locator('.sidebar').waitFor()
  await openProject(page, name)
  await openTeam(page)
  await scene().waitFor()
  check(await scene().locator('button[data-office-agent-id]').count() === 33, 'large team keeps all 33 real roles in the optional directory')
  await openDirectory()
  check(await scene().getAttribute('data-palette') === 'green', 'saved office presentation and palette survive a renderer reload')
  await scene().locator('button[data-office-agent-id="office-worker-3-6"]').click()
  check(Number(await scene().getAttribute('data-floor')) > 1, 'roster selection jumps to the correct explicit floor')
  const selectedFloor = Number(await scene().getAttribute('data-floor'))
  await scene().getByRole('button', { name: 'Previous floor', exact: true }).click()
  await page.waitForFunction(expected => Number(document.querySelector('[data-testid=office-scene]')?.getAttribute('data-floor')) === expected, selectedFloor - 1)
  check(Number(await scene().getAttribute('data-floor')) === selectedFloor - 1, 'manual floor navigation stays on the chosen floor even with an agent selected')
  await page.evaluate(async project => { await window.orgai.projects.save(project) }, original)
  await page.reload()
  await page.locator('.sidebar').waitFor()
  await openProject(page, name)
  await openTeam(page)
  await scene().waitFor()
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
  await projectTab(page, 'Live').click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await page.locator('.composer textarea').fill('Office deep tree [mock:deep-tree]')
  await page.locator('.composer textarea').press('Enter')
  await scene().waitFor()
  await openDirectory()
  await scene().locator('button[data-office-agent-id="mock-lead-report-1"]').first().waitFor({ timeout: 20_000 })
  await page.getByText('The lead finished: both halves are done. Anything else?', { exact: true }).first().waitFor({ timeout: 30_000 })
  check(await scene().getAttribute('data-mode') === 'live', 'Live uses the live scene')
  check(await scene().locator('button[data-office-agent-id]').count() >= 4, 'finished deep-tree agents remain available in the office list')
  await setAppearance({ reduceMotion: 'on' })
  check(await scene().locator('[data-testid=office-deliveries]').getAttribute('data-active') === '0', 'reduced motion has no active office walks')
  await setAppearance({ theme: 'dark' })
  await setAppearance({ theme: 'light' })
  check(await scene().locator('[data-testid=office-deliveries]').getAttribute('data-active') === '0', 'theme changes do not replay retained messages')
  await setCanvas({ presentation: 'graph' })
  await page.locator('.run-body .frame-stage .react-flow').waitFor()
  await setCanvas({ presentation: 'pocket-office' })
  await scene().waitFor()
  check(await scene().locator('[data-testid=office-deliveries]').getAttribute('data-active') === '0', 'reopening office establishes a message baseline without replay')
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
  // Exercise genuine normalized messages through the mock runtime while the office is mounted.
  await endSession(page)
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400, work: [
    { type: 'spawn', id: 'office-a', name: 'office-a', description: 'Receive the findings' },
    ...Array.from({ length: 24 }, (_, i) => ({ type: 'message', to: 'office-a', text: `Actual office message ${i}: <script>plain text</script>` })),
    { type: 'text', text: 'Office delivery fixture complete.' }
  ] }))
  await resizeTo(1024, 640)
  await setAppearance({ reduceMotion: 'system' })
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor()
  await page.locator('.composer textarea').fill('Office messages')
  await page.locator('.composer textarea').press('Enter')
  await scene().waitFor()
  while (Number(await scene().locator('[data-testid=office-zoom]').getAttribute('data-zoom')) < 3) await scene().getByRole('button', { name: 'Zoom in', exact: true }).click()
  await scene().locator('[data-testid=office-caption]').first().waitFor({ timeout: 20_000 })
  const delivery = scene().locator('[data-testid=office-deliveries]')
  const floorMapping = await scene().locator('button[data-office-agent-id]').evaluateAll(buttons => buttons.filter(button => ['root', 'office-a'].includes(button.getAttribute('data-office-agent-id'))).map(button => button.getAttribute('data-office-floor')))
  check(floorMapping.length === 2 && floorMapping[0] !== floorMapping[1] && floorMapping.every(Boolean), 'runtime message endpoints are explicitly on different floors')
  check(/Floor \d+ to floor \d+:/.test(await scene().locator('[data-testid=office-caption]').first().innerText()), 'cross-floor delivery presents an immediate truthful floor cue')
  check(await delivery.getAttribute('data-active') === '0' && await delivery.getAttribute('data-queued') === '0', 'cross-floor events never enter the walking queue')
  check(await scene().locator('[data-testid=office-caption]').count() <= 3, 'cross-floor captions share the three-caption limit')
  await scene().getByRole('button', { name: 'Zoom out', exact: true }).click()
  await resizeTo(1600, 1000)
  const reflowedFloors = await scene().locator('button[data-office-agent-id]').evaluateAll(buttons => buttons.filter(button => ['root', 'office-a'].includes(button.getAttribute('data-office-agent-id'))).map(button => button.getAttribute('data-office-floor')))
  check(reflowedFloors.length === 2 && reflowedFloors[0] === reflowedFloors[1], 'responsive reflow places both actual message endpoints on the shared floor')
  const observedDelivery = await (await page.waitForFunction(() => {
    const delivery = document.querySelector('[data-testid=office-deliveries]')
    if (!delivery) return false
    const active = Number(delivery.getAttribute('data-active'))
    const queued = Number(delivery.getAttribute('data-queued'))
    return active > 0 && { active, queued }
  }, undefined, { timeout: 15_000 })).jsonValue()
  check(observedDelivery.active > 0, 'genuinely new messages after responsive reflow animate on the shared floor')
  const movingTargetsMatch = await scene().evaluate(async el => {
    const matches = () => [...el.querySelectorAll('button[data-office-worker-id]')].every(button => {
      const sprite = [...el.querySelectorAll('[data-office-sprite-id]')].find(art => art.getAttribute('data-office-sprite-id') === button.getAttribute('data-office-worker-id'))
      if (!sprite) return false
      const target = button.getBoundingClientRect(); const art = sprite.getBoundingClientRect()
      return Math.abs((target.left + target.right) - (art.left + art.right)) < 2 && Math.abs((target.top + target.bottom) - (art.top + art.bottom)) < 2 && target.left <= art.left + 1 && target.top <= art.top + 1 && target.right >= art.right - 1 && target.bottom >= art.bottom - 1
    })
    for (let i = 0; i < 12; i++) { if (!matches()) return false; await new Promise(resolve => requestAnimationFrame(resolve)) }
    return true
  })
  check(movingTargetsMatch, 'person hit targets track rendered sprite coordinates throughout live delivery frames')
  check(observedDelivery.active <= 3 && observedDelivery.queued <= 12, 'real message burst respects active and queued visual limits')
  check(await scene().locator('[data-testid=office-caption] script').count() === 0, 'agent-authored message markup renders as text')
  await shot('office-real-message')
  await setAppearance({ reduceMotion: 'on' })
  check(await delivery.getAttribute('data-active') === '0', 'turning on reduced motion stops traversal during a real burst')
  await page.getByText('Office delivery fixture complete.', { exact: true }).first().waitFor({ timeout: 20_000 })
  await setCanvas({ presentation: 'graph' })
  await setCanvas({ presentation: 'pocket-office' })
  check(await scene().locator('[data-testid=office-caption]').count() === 0, 'reopening after real messages does not replay captions')
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))
  await setCanvas({ presentation: 'graph' })
  await sleep(200)
  const restored = await page.evaluate(async () => (await window.orgai.settings.get()).appearance.canvas)
  check(Object.entries(graph).every(([key, value]) => restored[key] === value), 'returning to graph restores its saved style', JSON.stringify(restored))
  await setAppearance({ reduceMotion: 'system', theme: 'dark' }, { pattern: 'dots', layout: 'top-down', nodeStyle: 'card', edges: 'curved', minimap: false, tint: true })
}
