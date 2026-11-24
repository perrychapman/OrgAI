// Token-free. Regression check for "text overlapping on subsequent messages" (polish-run-view finding F1), called from
// e2e/transcript-media.mjs with the app it already runs. It makes a work run in a fixture project and a Chat session, sends
// three messages of different lengths (short, long multi-paragraph with a list, a code block and an unbroken URL, medium) while
// the mock is still streaming, and at 1024x640 and 1600x1000, after a dock resize and with the dock hidden and shown, asserts:
//  - no two feed rows have intersecting bounding boxes,
//  - no row is drawn shorter than its content (a flex item shrunk below its text: rect height < scrollHeight),
//  - at the end of the feed the last row sits fully above the composer and inside its scroller.
// The old rule (`.entry.text.has-avatar { min-height }` as a flex item of the bounded `.transcript` column) fails the first
// two. `E2E_OVERLAP_OLD_CSS=1` re-injects it to prove the check can fail.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, makeFixtureRepo, sleep } from './lib.mjs'

const SIZES = [
  [1024, 640],
  [1600, 1000]
]

const MESSAGES = [
  'short',
  [
    'A long multi-paragraph message to the team.',
    '',
    'The second paragraph has one very long line that wraps several times across the conversation dock when it is narrow, and then goes on a while longer to push the rows below it further down the feed.',
    '',
    '- first item of a list',
    '- second item of a list with a few more words in it',
    '- third item',
    '',
    '```js',
    'const answer = 42;',
    'console.log("a code line that is much wider than the narrowest dock so it must scroll sideways and never spill over the next row")',
    '```',
    '',
    'https://example.com/a/very/long/path/without/any/break/opportunity/that/keeps/going/and/going/and/going/until/it/must/wrap/somewhere?x=1'
  ].join('\n'),
  'A medium message with two sentences. It is neither short nor long, so it wraps once or twice in the dock.'
]

async function resize(app, page, w, h) {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await sleep(500)
}

/** Rows of every visible feed (the dock's tab panel, a Chat list) with their geometry, measured in the page. */
function measure(page) {
  return page.evaluate(() => {
    const feeds = [...document.querySelectorAll('.run-body > .side-panel [role=tabpanel].transcript, .conversation-newest')].filter((el) => el.offsetParent !== null)
    const composer = [...document.querySelectorAll('.composer')].find((el) => el.offsetParent !== null)?.getBoundingClientRect()
    return feeds.map((feed) => {
      const scroller = feed.classList.contains('conversation-newest') ? feed.closest('.conversation-list') : feed
      const rows = [...feed.children].filter((el) => el.getBoundingClientRect().height > 0 && /\bentry\b|chain-divider|chain-omitted/.test(el.className))
      const rects = rows.map((el) => el.getBoundingClientRect())
      const overlaps = []
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const ox = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left)
          const oy = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top)
          if (ox > 1 && oy > 1) overlaps.push(`${rows[i].className.split(' ').slice(0, 2).join('.')}~${rows[j].className.split(' ').slice(0, 2).join('.')} ${Math.round(oy)}px`)
        }
      }
      const shrunk = rows.flatMap((el, i) => (el.scrollHeight > Math.ceil(rects[i].height) + 2 ? [`${el.className.split(' ').slice(0, 2).join('.')} ${Math.round(rects[i].height)}<${el.scrollHeight}`] : []))
      // End of the feed: the last row must be reachable above the composer.
      scroller.scrollTop = scroller.scrollHeight
      const last = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null
      const box = scroller.getBoundingClientRect()
      return {
        kind: feed.classList.contains('conversation-newest') ? 'chat' : 'dock',
        rows: rows.length,
        overlaps,
        shrunk,
        lastOk: !last || (last.bottom <= box.bottom + 1 && (!composer || last.bottom <= composer.top + 1)),
        last: last && { bottom: Math.round(last.bottom), scroller: Math.round(box.bottom), composer: composer ? Math.round(composer.top) : null }
      }
    })
  })
}

/** Measure a few times over `ms`, so rows that are still streaming in are caught mid-growth. */
async function sample(page, ms) {
  const out = []
  const end = Date.now() + ms
  do {
    out.push(...(await measure(page)))
    await sleep(150)
  } while (Date.now() < end)
  return out
}

function verdict(samples, what, kind) {
  const mine = samples.filter((s) => s.kind === kind)
  check(mine.length > 0, `${what}: a ${kind} feed is on screen`)
  const bad = mine.filter((s) => s.overlaps.length || s.shrunk.length || !s.lastOk)
  check(bad.length === 0, `${what}: no two rows intersect, no row is shorter than its text, the last row is above the composer`, JSON.stringify(bad[0] ?? null))
}

async function sendAll(app, page, label, kind) {
  const ta = page.locator('.composer textarea').first()
  for (const [i, text] of MESSAGES.entries()) {
    await ta.fill(text)
    await ta.press('Enter')
    // While the reply streams in.
    verdict(await sample(page, 900), `${label} message ${i + 1} sent (streaming)`, kind)
  }
}

export async function checkTranscriptOverlap({ app, page, shot }) {
  if (process.env.E2E_OVERLAP_OLD_CSS === '1') {
    await page.addStyleTag({ content: '.transcript > .entry { flex-shrink: 1 !important }' })
  }
  // ---- A work run: the dock's feed.
  const repo = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-overlap-')), 'repo')
  makeFixtureRepo('overlap', { at: repo })
  await resize(app, page, 1600, 1000)
  await createProject(page, { mode: 'existing', path: repo, name: 'E2E overlap (orgai test)' })
  await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Live', exact: true }).click()
  const start = page.locator('.new-run .composer textarea')
  await start.waitFor({ timeout: 10_000 })
  await start.fill('Overlap check: start the work')
  await page.locator('.new-run .composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  await page.locator('.run-body > .side-panel [role=tabpanel].transcript .entry').first().waitFor({ timeout: 15_000 })
  await sendAll(app, page, 'dock 1600x1000', 'dock')
  await shot('overlap-dock-1600')
  for (const [w, h] of [...SIZES].reverse()) {
    await resize(app, page, w, h)
    verdict(await sample(page, 400), `dock after resizing the window to ${w}x${h}`, 'dock')
    await shot(`overlap-dock-${w}`)
  }
  // The dock's own width, narrowest and widest (the handle's keys: Home / End).
  const handle = page.locator('[data-testid=side-panel-resize]')
  if ((await handle.count()) > 0) {
    await handle.focus()
    for (const key of ['Home', 'End', 'Home']) {
      await page.keyboard.press(key)
      await sleep(300)
      verdict(await sample(page, 300), `dock after resizing the dock (${key})`, 'dock')
    }
  }
  // Hidden, then shown: the feed stays mounted, so its rows are re-measured by the layout, not remembered.
  const hide = page.locator('.run-body > .side-panel').getByRole('button', { name: /^Hide / })
  if ((await hide.count()) > 0) {
    await hide.first().click()
    await sleep(300)
    await page.locator('[data-testid=dock-show]').click()
    await sleep(500)
    verdict(await sample(page, 300), 'dock hidden then shown', 'dock')
  }
  // One more message with the dock at its narrowest.
  await sendAll(app, page, 'dock narrow', 'dock')

  // ---- A Chat session: the conversation list.
  await resize(app, page, 1024, 640)
  // The earlier part of the script left an ended Chat session: Send continues it (the chain's merged feed).
  await page.locator('[data-testid=nav-assistant][data-id=quick]').click()
  await page.locator('[data-testid=conversation-transcript] .entry').first().waitFor({ timeout: 15_000 })
  await sendAll(app, page, 'chat 1024x640', 'chat')
  await resize(app, page, 1600, 1000)
  verdict(await sample(page, 400), 'chat after resizing the window to 1600x1000', 'chat')
  await shot('overlap-chat-1600')
}
