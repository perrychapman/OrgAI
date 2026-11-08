// Called by canvas.mjs so Pocket Office stays on the existing token-free CI path.
import { check, endSession, openAppSettings, openProject, openTeam, projectTab, sleep } from './lib.mjs'
import * as fs from 'node:fs'

export async function checkPocketOffice({ page, name, resizeTo, setAppearance, setCanvas, noPageScroll, shot, scriptFile }) {
  const scene = () => page.locator('[data-testid=office-scene]').first()
  const graph = { pattern: 'blueprint', layout: 'left-right', nodeStyle: 'compact', edges: 'orthogonal', minimap: true, tint: false }
  await setCanvas({ ...graph, presentation: 'graph', scenePalette: 'neutral' })
  await openAppSettings(page)
  const section = page.locator('[data-testid=canvas-section]')
  const office = section.locator('[data-testid=canvas-presentation] input[value="pocket-office"]')
  await office.check()
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'pocket-office')
  check(await section.locator('[data-testid=canvas-preview] [data-testid=office-scene]').count() === 1, 'Pocket Office settings shows the shared scene sample')
  check(await scene().getAttribute('data-mode') === 'sample', 'settings office is explicitly static sample data')
  await section.locator('[data-testid=canvas-scene-palette] input[value="green"]').check()
  await page.waitForFunction(() => document.documentElement.dataset.canvasScenePalette === 'green')
  const saved = await page.evaluate(async () => (await window.orgai.settings.get()).appearance.canvas)
  check(Object.entries(graph).every(([key, value]) => saved[key] === value), 'switching presentation and palette preserves every graph preference', JSON.stringify(saved))
  // Native radio arrows provide the keyboard path back to Graph and back to Office.
  await office.focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'graph')
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.documentElement.dataset.canvasPresentation === 'pocket-office')
  await openProject(page, name)
  await openTeam(page)
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await resizeTo(w, h)
    for (const theme of ['dark', 'light']) {
      for (const palette of ['neutral', 'green']) {
        await setAppearance({ theme }, { presentation: 'pocket-office', scenePalette: palette })
        await scene().waitFor()
        check(await scene().getAttribute('data-mode') === 'team', `Team is static at ${w}x${h} ${theme}/${palette}`)
        check(await scene().getAttribute('data-palette') === palette, `office follows palette at ${w}x${h} ${theme}/${palette}`)
        check(await noPageScroll(), `office fits the window at ${w}x${h} ${theme}/${palette}`)
        check(await scene().locator('[data-office-agent-id]').count() > 1, `Team exposes named agent buttons at ${w}x${h} ${theme}/${palette}`)
        await shot(`office-team-${w}x${h}-${theme}-${palette}`)
      }
    }
  }
  const worker = scene().locator('button[data-office-agent-id]').first()
  await worker.focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-testid=role-capabilities]').waitFor()
  check(await page.locator('[data-testid=role-capabilities]').count() === 1, 'office keyboard selection opens the existing editable role inspector')
  await page.keyboard.press('Escape')
  check(await page.evaluate(() => !!document.activeElement?.hasAttribute('data-office-agent-id')), 'Escape returns Team focus to an office agent')
  await projectTab(page, 'Live').click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await page.locator('.composer textarea').fill('Office deep tree [mock:deep-tree]')
  await page.locator('.composer textarea').press('Enter')
  await scene().waitFor()
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
  const prior = scene().locator('button[data-office-agent-id$="/mock-lead"]').first()
  await prior.waitFor({ timeout: 30_000 })
  check(/Earlier|Session/i.test(await prior.innerText()), 'the prior report retains visible session context')
  await prior.click()
  await page.getByText('Splitting the work in two.', { exact: true }).first().waitFor({ timeout: 10_000 })
  check(await page.getByText('Splitting the work in two.', { exact: true }).count() > 0, 'selecting an earlier lead opens its original transcript')
  // Exercise genuine normalized messages through the mock runtime while the office is mounted.
  await endSession(page)
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 180, work: [
    { type: 'spawn', id: 'office-a', name: 'office-a', description: 'Send the findings' },
    { type: 'spawn', id: 'office-b', name: 'office-b', description: 'Receive the findings' },
    ...Array.from({ length: 24 }, (_, i) => ({ type: 'message', from: 'office-a', to: 'office-b', text: `Actual office message ${i}: <script>plain text</script>` })),
    { type: 'text', text: 'Office delivery fixture complete.' }
  ] }))
  await setAppearance({ reduceMotion: 'system' })
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor()
  await page.locator('.composer textarea').fill('Office messages')
  await page.locator('.composer textarea').press('Enter')
  await scene().locator('[data-testid=office-caption]').first().waitFor({ timeout: 20_000 })
  const delivery = scene().locator('[data-testid=office-deliveries]')
  check(Number(await delivery.getAttribute('data-active')) <= 3 && Number(await delivery.getAttribute('data-queued')) <= 12, 'real message burst respects active and queued visual limits')
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
