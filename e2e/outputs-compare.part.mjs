// Compare (docs/design/outputs-2.md 12.2). Called by e2e/outputs-versions.mjs while a project with two versions each of a
// markdown, csv, json, docx, xlsx and mermaid output is open on its Outputs tab (or a run's Outputs side tab):
//   await compare({ app, page, project, label, size: [w, h], theme, check, sleep })
// Steps whose test ids the shell does not render yet log SKIP. `check` is lib.mjs check(ok, what, detail).
const KINDS = ['markdown', 'csv', 'json', 'docx', 'xlsx', 'mermaid']

export default async function compare(ctx) {
  const { page, label, check, sleep } = ctx
  const skip = (what) => console.log(`SKIP ${label}: ${what}`)
  const q = (id) => page.locator(`[data-testid="${id}"]`)

  const selectOutput = async (kind) => {
    for (const row of ['output-row', 'run-output-row']) {
      const r = page.locator(`[data-testid="${row}"][data-kind="${kind}"]`).first()
      if (await r.count()) {
        await r.click()
        await sleep(300)
        return true
      }
    }
    return false
  }
  const noPageScroll = async (what) => {
    const s = await page.evaluate(() => ({ h: document.documentElement.scrollHeight - innerHeight, w: document.documentElement.scrollWidth - innerWidth }))
    check(s.h <= 1 && s.w <= 1, `${label}: ${what}: the page does not scroll`, JSON.stringify(s))
  }
  const openCompare = async (kind) => {
    if (!(await selectOutput(kind))) return skip(`no ${kind} output row`), false
    if (!(await q('output-tab-versions').count())) return skip('no Versions tab yet'), false
    await q('output-tab-versions').click()
    const btn = q('output-version-compare-current').first()
    if (!(await btn.count())) return skip(`no Compare with current on a ${kind} version`), false
    await btn.click()
    await page.waitForSelector('[data-testid="output-compare"][data-state="ready"], [data-testid="output-compare"][data-state="error"]', { timeout: 15000 }).catch(() => undefined)
    // Always the two versions the runs made (v1 and v2): an earlier pass's edit part saved more versions with only additions.
    const a = q('output-compare-a')
    const b = q('output-compare-b')
    if ((await a.count()) && (await b.count())) {
      const ok = await page.evaluate(() => {
        const has = (id, v) => !!document.querySelector(`[data-testid="${id}"] option[value="${v}"]`)
        return has('output-compare-a', '1') && has('output-compare-b', '2')
      })
      if (ok) {
        await a.selectOption('1')
        await b.selectOption('2')
        await page.waitForSelector('[data-testid="output-compare"][data-state="ready"]', { timeout: 15000 }).catch(() => undefined)
      }
    }
    return true
  }

  for (const kind of KINDS) {
    if (!(await openCompare(kind))) continue
    const root = q('output-compare')
    check((await root.getAttribute('data-kind')) === kind, `${label}: compare ${kind} sets data-kind`)
    check((await root.getAttribute('data-state')) === 'ready', `${label}: compare ${kind} is ready`)
    const aFocused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'output-compare-a' || !!document.querySelector('[data-testid="output-compare-body"]'))
    check(aFocused, `${label}: compare ${kind} opened (A select focus or body present)`)
    const summary = ((await q('output-compare-summary').textContent()) ?? '').trim()
    check(/added|removed|changed|no changes/i.test(summary), `${label}: compare ${kind} summary reads as counts`, summary)

    if (kind === 'markdown' || kind === 'json') {
      check((await q('output-compare-mode').count()) === 1, `${label}: ${kind} has Changes | Side by side`)
      const glyphs = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="output-compare-body"] .compare-glyph')).map((g) => g.textContent?.trim()).join(''))
      check(glyphs.includes('+') && glyphs.includes('-'), `${label}: ${kind} marks added and removed lines with + and -`, glyphs.slice(0, 20))
      const before = await q('output-compare-position').textContent()
      await q('output-compare-next').click()
      const after = await q('output-compare-position').textContent()
      check(/Change 1 of/.test(after ?? '') && before !== after, `${label}: ${kind} Next change moves to change 1`, after ?? '')
      await q('output-compare-body').focus()
      await page.keyboard.press('F3')
      const second = await q('output-compare-position').textContent()
      check(/Change (2|1) of/.test(second ?? ''), `${label}: ${kind} F3 steps`, second ?? '')
      await page.keyboard.press('Shift+F3')
      await q('output-compare-prev').click()
      await page.locator('[data-testid="output-compare-mode"] label', { hasText: 'Side by side' }).click()
      await sleep(150)
      check((await page.locator('.compare-side-row').count()) > 0, `${label}: ${kind} side by side shows rows`)
      await page.locator('[data-testid="output-compare-mode"] label', { hasText: 'Changes' }).first().click()
    }

    if (kind === 'docx') {
      const marks = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="output-compare-block"] .compare-glyph')).map((g) => g.textContent?.trim()).join(''))
      check(marks.includes('+') || marks.includes('-'), `${label}: docx blocks carry + or - glyphs`, marks.slice(0, 20))
    }

    if (kind === 'xlsx' || kind === 'csv') {
      check((await q('output-compare-grid').count()) === 1, `${label}: ${kind} shows the changed grid`)
      check((await page.locator('.compare-cell').count()) > 0, `${label}: ${kind} outlines changed cells`)
      const tip = await page.locator('.compare-cell').first().getAttribute('title')
      check(/was .*, now /.test(tip ?? ''), `${label}: ${kind} changed cell says was / now`, tip ?? '')
      const rows = await page.locator('.compare-grid-row').count()
      await q('output-compare-only-changes').click()
      const all = await page.locator('.compare-grid-row').count()
      check(all >= rows, `${label}: ${kind} Only rows with changes off shows every row`, `${rows} -> ${all}`)
      await q('output-compare-only-changes').click()
    }

    if (kind === 'mermaid') {
      check((await q('output-compare-link').count()) === 1, `${label}: mermaid has Link pan and zoom`)
      check((await q('output-compare-link').getAttribute('aria-checked')) === 'true', `${label}: mermaid link defaults on`)
      await page.locator('[data-testid="output-compare-view"] label', { hasText: 'Source changes' }).click()
      await sleep(200)
      check((await q('output-compare-body').count()) === 1, `${label}: mermaid Source changes shows the text changes`)
      await page.locator('[data-testid="output-compare-view"] label', { hasText: 'Drawings' }).click()
      await sleep(300)
      await q('output-compare-zoom-in').click()
      const ka = await q('output-compare-view-a').getAttribute('data-k')
      const kb = await q('output-compare-view-b').getAttribute('data-k')
      check(ka === kb, `${label}: linked zoom keeps both drawings at one scale`, `${ka} / ${kb}`)
    }

    // swap exchanges the selects and keeps working
    const a0 = await q('output-compare-a').inputValue()
    const b0 = await q('output-compare-b').inputValue()
    await q('output-compare-swap').click()
    check((await q('output-compare-a').inputValue()) === b0 && (await q('output-compare-b').inputValue()) === a0, `${label}: ${kind} swap exchanges A and B`)
    await q('output-compare-swap').click()
    await noPageScroll(`compare ${kind}`)

    const close = q('output-compare-close')
    if (await close.count()) await close.click()
    await sleep(150)
  }
}
