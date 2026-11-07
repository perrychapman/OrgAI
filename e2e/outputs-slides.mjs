// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The slide viewer (docs/design/outputs-2.md 13): a scripted run produces a
// five-slide pptx through produce_output (ORGAI_MOCK_SCRIPT set in main), then the strip, stage, keys, speaker notes,
// paper colour, table, fidelity caption and the Larger view are checked at 1024x640 and 1600x1000 in both themes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { TMP, check, cleanup, createProject, deleteProject, finish, launch, makeFixtureRepo, projectTab, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E slides (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-slides-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('outputs-slides', { at: repo })

function crc32(buf) {
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function redPng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(8 * (1 + 8 * 3))
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) raw[y * 25 + 1 + x * 3] = 255
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
fs.writeFileSync(path.join(repo, 'deck-image.png'), redPng())

const deck = {
  size: '16:9',
  slides: [
    { layout: 'title', title: 'Client deck', subtitle: 'Quarterly review', notes: 'Welcome everyone.' },
    { layout: 'content', title: 'Agenda', bullets: [{ text: 'Results' }, { text: 'Plan', level: 0 }, { text: 'Risks', level: 1 }] },
    { layout: 'two-content', title: 'Two columns', left: [{ type: 'bullets', bullets: [{ text: 'Left one' }] }], right: [{ type: 'body', text: 'Right body text' }], notes: 'Compare the two sides.' },
    { layout: 'image', title: 'Picture', image: { path: 'deck-image.png', alt: 'A red square' } },
    { layout: 'content', title: 'Numbers', table: { rows: [['Item', 'Cost'], ['Design', '1200'], ['Build', '3400']], header: true } }
  ]
}
const script = {
  delayMs: 100,
  work: [
    { type: 'text', text: 'Making the deck.' },
    { type: 'harness', name: 'produce_output', args: { kind: 'pptx', title: 'Client deck', fileName: 'client-deck', deck } },
    { type: 'text', text: 'The deck is ready.' }
  ]
}
const scriptFile = path.join(base, 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify(script))

let { app, page } = await launch({ shotPrefix: 'outputs-slides' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(600)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(500)
}
const until = async (fn, ms = 8000) => {
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
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const noScroll = async (what) => {
  const o = await page.evaluate(() => {
    const el = document.scrollingElement
    const main = document.querySelector('main.main')
    return { sh: el?.scrollHeight ?? 0, ch: el?.clientHeight ?? 0, sw: el?.scrollWidth ?? 0, cw: el?.clientWidth ?? 0, mh: main?.scrollHeight ?? 0, mch: main?.clientHeight ?? 0 }
  })
  check(o.sh <= o.ch + 1 && o.sw <= o.cw + 1 && o.mh <= o.mch + 1, `${what}: the page and the main region do not scroll`, JSON.stringify(o))
}
const running = (loc) =>
  loc.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === 'running' && a.constructor.name !== 'CSSTransition')
      .map((a) => a.animationName ?? a.constructor.name)
      .join(' | ')
  )

let project
try {
  await app.evaluate((_electron, file) => {
    process.env.ORGAI_MOCK_SCRIPT = file
  }, scriptFile)
  project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'the slides project was created')
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Make the deck')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  const made = await until(() => page.evaluate((id) => window.orgai.outputs.list(id).then((l) => l.some((o) => o.kind === 'pptx')), project.id), 60_000)
  check(made, 'the scripted run produced a pptx')
  await sleep(800)

  async function openDeck() {
    await projectTab(page, 'Live').click()
    await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
    const railed = page.locator('aside.side-panel[data-collapsed=true]')
    if (await railed.count()) {
      await railed.getByRole('button', { name: /^Show run panel/ }).click()
      await sleep(400)
    }
    const tab = page.locator('[data-testid=side-tab-outputs]')
    await tab.waitFor({ state: 'visible', timeout: 8000 })
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
    await page.locator('[data-testid=run-outputs-list], [data-testid=output-detail]').first().waitFor({ timeout: 8000 })
    const back = page.locator('[data-testid=run-output-back]')
    if (await back.count()) {
      await back.click()
      await page.locator('[data-testid=run-outputs-list]').waitFor({ timeout: 5000 })
    }
    await page.locator('[data-testid=run-output-row]').filter({ hasText: 'Client deck' }).first().locator('[data-testid=run-output-show]').click()
    await page.locator('[data-testid=output-detail-heading]', { hasText: 'Client deck' }).first().waitFor({ timeout: 8000 })
  }

  async function slideChecks(label, scope, wideExpected) {
    const root = scope.locator('[data-testid=output-slides]').first()
    await root.waitFor({ timeout: 15_000 })
    check((await root.getAttribute('data-state')) === 'ready', `${label}: the viewer is ready`)
    const strip = root.locator('[data-testid=slide-strip]')
    const orient = await strip.getAttribute('aria-orientation')
    check(orient === (wideExpected ? 'vertical' : 'horizontal'), `${label}: the strip is ${wideExpected ? 'vertical' : 'horizontal'}`, String(orient))
    check((await strip.locator('[data-testid=slide-thumb]').count()) === 5, `${label}: five thumbnails`)
    {
      const sb = await strip.boundingBox()
      const st = await root.locator('[data-testid=slide-stage]').boundingBox()
      if (wideExpected) check(!!sb && !!st && Math.abs(sb.width - 168) <= 12 && st.x >= sb.x + sb.width - 1, `${label}: the strip is 168 px wide at the left of the stage`, JSON.stringify({ sb, st }))
      else check(!!sb && !!st && sb.y >= st.y + st.height - 1 && sb.height <= 110, `${label}: the strip is a row under the stage`, JSON.stringify({ sb, st }))
    }
    check((await strip.locator('[tabindex="0"]').count()) === 1, `${label}: the strip is one Tab stop`)
    const names = await strip.locator('[data-testid=slide-thumb]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    check(names[0] === 'Slide 1: Client deck' && names[2] === 'Slide 3: Two columns', `${label}: thumbnails are named with number and title`, names.join(' | '))
    const counter = root.locator('[data-testid=slide-counter]')
    check(clean(await counter.innerText()) === 'Slide 1 of 5', `${label}: the counter starts at slide 1`)
    // Title drawn from runs, paper stays light.
    const stage = root.locator('[data-testid=slide-stage]')
    check(/Client deck/.test(await stage.innerText()), `${label}: the title is drawn from its runs`)
    const paper = await stage.locator('.slide-paper').evaluate((el) => getComputedStyle(el).backgroundColor)
    check(paper === 'rgb(255, 255, 255)', `${label}: the slide paper is white`, paper)
    check((await stage.getAttribute('aria-label')).startsWith('Slide 1 of 5'), `${label}: the stage is named`, await stage.getAttribute('aria-label'))
    // Strip keys: focus the selected thumb, arrows and PageDown move the selection.
    await strip.locator('[data-n="1"]').focus()
    await page.keyboard.press(wideExpected ? 'ArrowDown' : 'ArrowRight')
    check(clean(await counter.innerText()) === 'Slide 2 of 5', `${label}: an arrow key on the strip moves to slide 2`)
    check((await strip.locator('[data-n="2"]').getAttribute('aria-selected')) === 'true', `${label}: thumb 2 is selected`)
    check(await page.evaluate(() => document.activeElement?.getAttribute('data-n') === '2'), `${label}: focus followed the selection`)
    await page.keyboard.press('PageDown')
    check(clean(await counter.innerText()) === 'Slide 3 of 5', `${label}: PageDown moves to slide 3`)
    await page.keyboard.press('End')
    check(clean(await counter.innerText()) === 'Slide 5 of 5', `${label}: End goes to the last slide`)
    check(/Design/.test(await stage.innerText()) && (await stage.locator('td').count()) === 6, `${label}: the table slide has its six cells`, String(await stage.locator('td').count()))
    // Stage keys.
    await stage.focus()
    await page.keyboard.press('Home')
    check(clean(await counter.innerText()) === 'Slide 1 of 5', `${label}: Home on the stage goes to slide 1`)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    check(clean(await counter.innerText()) === 'Slide 3 of 5', `${label}: Right on the stage moves on`)
    await page.keyboard.press('PageUp')
    check(clean(await counter.innerText()) === 'Slide 2 of 5', `${label}: PageUp on the stage moves back`)
    // Image slide.
    await root.locator('[data-testid=slide-next]').click()
    await root.locator('[data-testid=slide-next]').click()
    const imgs = await stage.locator('img').count()
    const placeholders = await stage.locator('.slide-placeholder').count()
    check(imgs + placeholders >= 1, `${label}: the picture slide draws an image or a placeholder`, `img ${imgs}, placeholder ${placeholders}`)
    if (imgs === 0) console.log('NOTE the image slide showed a placeholder, not the png')
    // Speaker notes: closed, then open on slide 3 (index 2).
    await root.locator('[data-testid=slide-prev]').click()
    await root.locator('[data-testid=slide-prev]').click()
    await root.locator('[data-testid=slide-next]').click()
    const notesBtn = root.locator('[data-testid=slide-notes] button')
    check((await notesBtn.getAttribute('aria-expanded')) === 'false', `${label}: speaker notes start closed`)
    await notesBtn.click()
    check(/Compare the two sides/.test(await root.locator('[data-testid=slide-notes-body]').innerText()), `${label}: speaker notes open with the slide's notes`)
    await notesBtn.click()
    check(clean(await root.locator('[data-testid=slide-fidelity]').innerText()) === 'Preview. Open in PowerPoint for the exact look.', `${label}: the fidelity caption is shown`)
    check((await running(root)) === '', `${label}: nothing animates`, await running(root))
  }

  const combos = [
    { w: 1600, h: 1000, theme: 'dark' },
    { w: 1600, h: 1000, theme: 'light' },
    { w: 1024, h: 640, theme: 'dark' },
    { w: 1024, h: 640, theme: 'light' }
  ]
  for (const c of combos) {
    const label = `slides ${c.w}x${c.h} ${c.theme}`
    await setSize(c.w, c.h)
    await setTheme(c.theme)
    try {
      await openDeck()
      const detail = page.locator('[data-testid=output-detail]').first()
      await slideChecks(`${label} panel`, detail, false)
      await noScroll(`${label} panel`)
      await screenshot(page, `outputs-slides-${c.w}-${c.theme}-panel`)
      // The Larger view: vertical strip, fidelity caption, focus on the selected thumb.
      await detail.locator('[data-testid=output-detail-expand]').click()
      const dlg = page.locator('[data-testid=output-dialog]')
      await dlg.waitFor({ state: 'visible', timeout: 5000 })
      await sleep(400)
      check(await until(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'slide-thumb')), `${label}: the Larger view focuses the selected thumb`, await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)))
      await slideChecks(`${label} larger`, dlg, true)
      await noScroll(`${label} larger`)
      const box = await dlg.locator('[data-testid=slide-stage]').boundingBox()
      const paperBox = await dlg.locator('[data-testid=slide-stage] .slide-paper').boundingBox()
      check(!!box && !!paperBox && paperBox.height <= box.height + 1 && paperBox.width <= box.width + 1, `${label}: the slide fits its stage in the Larger view`, JSON.stringify({ box, paperBox }))
      await screenshot(page, `outputs-slides-${c.w}-${c.theme}-larger`)
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'hidden', timeout: 5000 })
    } catch (e) {
      check(false, `${label}: slide checks`, e.message.split('\n')[0])
      await page.keyboard.press('Escape').catch(() => {})
    }
  }
} finally {
  if (project && page && !page.isClosed()) await deleteProject(page, NAME).catch(() => {})
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('outputs-slides')
