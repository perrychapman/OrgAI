// Scratch (not committed): three decisions at several sizes, shots + measurements.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, endSession, finish, launch, log, makeFixtureRepo, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-q-script-')), 'script.json')
fs.writeFileSync(
  scriptFile,
  JSON.stringify({
    delayMs: 250,
    work: [
      { type: 'text', text: 'Starting.' },
      { type: 'spawn', id: 'mock-report-1', description: 'Implement the limiter' },
      { type: 'tool', agent: 'mock-report-1', name: 'Bash', input: { command: 'npm test' }, ask: true, background: true, result: 'ok' },
      { type: 'tool', agent: 'mock-report-1', name: 'Edit', input: { file_path: 'src/limiter.js', old_string: 'a', new_string: 'b' }, ask: true, background: true, result: 'ok' },
      {
        type: 'harness',
        name: 'ask_user',
        args: {
          question: 'Which limiter strategy should the notes API use for write requests?',
          options: [
            { label: 'Token bucket', description: 'Allows short bursts, smooth refill over time.' },
            { label: 'Fixed window', description: 'Simple counter per minute; bursts at the boundary.' },
            { label: 'Sliding window', description: 'Most accurate, more memory per client.' }
          ],
          allowMultiple: false,
          allowFreeText: true
        }
      },
      { type: 'text', text: 'Done.' }
    ]
  })
)
process.env.ORGAI_MOCK_SCRIPT = scriptFile
const NAME = 'E2E q (orgai test)'
const repo = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-q-')), 'repo')
makeFixtureRepo('q', { at: repo })
const { app, page } = await launch({ shotPrefix: 'q' })
const size = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(900)
}
const measure = () =>
  page.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel)
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), t: Math.round(b.top), b: Math.round(b.bottom) }
    }
    const tray = document.querySelector('section.frame-tray')
    const list = document.querySelector('.decision-list')
    return {
      stage: r('.frame-stage'),
      tray: r('section.frame-tray'),
      frame: r('.canvas-frame'),
      composer: r('.composer'),
      card: r('article.decision-card'),
      body: r('article.decision-card .decision-body'),
      footer: r('article.decision-card .decision-footer'),
      trayScrolls: tray ? tray.scrollHeight > tray.clientHeight + 1 : null,
      listOverflow: list ? list.scrollWidth - list.clientWidth : null,
      radios: document.querySelectorAll('article.decision-card input[type=radio]').length,
      zoom: document.querySelector('.react-flow__viewport')?.style.transform,
      beside: tray ? getComputedStyle(document.querySelector('.frame-grid')).gridTemplateAreas.includes('stage tray') : null
    }
  })
try {
  await createProject(page, { mode: 'existing', path: repo, name: NAME })
  await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Live', exact: true }).click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Add rate limiting')
  await page.locator('.composer .btn.primary').click()
  await page.waitForSelector('article.decision-card', { timeout: 20_000 })
  await sleep(2500)
  for (const [w, h] of [
    [1024, 640],
    [1424, 881],
    [1600, 1000]
  ]) {
    await size(w, h)
    log('SIZE', w, h, JSON.stringify(await measure()))
    await screenshot(page, `q-${w}x${h}-sel1`)
    // Select the question chip (first) and others
    const chips = page.locator('.decision-chip')
    const n = await chips.count()
    log('chips', n)
    for (let i = 0; i < n; i++) {
      await chips.nth(i).click()
      await sleep(300)
      log('  chip', i, JSON.stringify(await measure()))
      await screenshot(page, `q-${w}x${h}-chip${i + 1}`)
    }
  }
  // side panel closed at 1024
  await size(1024, 640)
  await page.getByRole('button', { name: /^Hide run panel|^Collapse run panel|run panel/i }).first().click().catch(() => log('no panel toggle'))
  await sleep(700)
  log('1024 panel closed', JSON.stringify(await measure()))
  await screenshot(page, 'q-1024x640-panelclosed')
  await endSession(page)
} catch (e) {
  log('ERR', e.message)
  await screenshot(page, 'q-err').catch(() => {})
  process.exitCode = 1
}
await app.close().catch(() => {})
finish('q')
