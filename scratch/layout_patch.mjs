import fs from 'node:fs'
const p = 'e2e/layout.mjs'
let s = fs.readFileSync(p, 'utf8').split(String.fromCharCode(13, 10)).join('\n')
function rep(a, b) {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70))
  s = s.replace(a, () => b)
}
rep("page.locator('.empty h2')", "page.locator('.new-run h2')")
rep(
  `  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  await sleep(500)
  check((await page.locator('.run-row').count()) >= 1, 'run appears in history after reload')`,
  `  check((await page.locator('.new-run').count()) === 0 && (await page.locator('.run-tab[aria-selected="true"]').count()) === 1, 'a project with history opens on its newest run, not the empty state')
  await page.locator('.topbar .tabs').getByRole('button', { name: 'History', exact: true }).click()
  await sleep(500)
  check((await page.locator('.run-row').count()) >= 1, 'run appears in the History tab after reload')`
)
const a = s.indexOf('  // Run strip, composer mode row and Runs tab in the viewport x theme matrix')
const b = s.indexOf("  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))\n\n  // New-idea mode")
if (a < 0 || b < 0) throw new Error('matrix block not found')
s =
  s.slice(0, a) +
  `  // Run tabs keyboard model: Ctrl+T opens the New run page as a second tab, Ctrl+W closes it again.
  await page.locator('.topbar .tabs').getByRole('button', { name: 'Live', exact: true }).click()
  await sleep(500)
  check((await page.locator('.run-tabs [role="tablist"] [role="tab"]').count()) === 1, 'one run tab for the reopened run')
  check((await page.locator('.canvas-toolbar').count()) === 0, 'no toolbar floats over the canvas')
  await page.keyboard.press('Control+t')
  await sleep(400)
  check((await page.locator('.new-run').count()) === 1, 'Ctrl+T opens the New run page')
  check((await page.locator('.run-tabs [role="tab"]').count()) === 2, 'the New run page is a second tab')
  check((await page.locator('.run-header').count()) === 0 && (await page.locator('.react-flow').count()) === 0, 'no other run is on screen on the New run page')
  await shot('new-run-page')
  await page.keyboard.press('Control+w')
  await sleep(400)
  check((await page.locator('.new-run').count()) === 0 && (await page.locator('.run-header').count()) === 1, 'Ctrl+W closes the New run page and returns to the run')
  await page.locator('.run-tab-new').click()
  await sleep(300)
  check((await page.locator('.new-run').count()) === 1, 'the + button opens the New run page')
  await page.locator('.run-tab[aria-selected="false"]').first().focus()
  await page.keyboard.press('ArrowRight')
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'), 'ArrowRight moves focus to the next tab')
  await page.keyboard.press('ArrowLeft')
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'false'), 'ArrowLeft moves focus back')
  await page.keyboard.press('Enter')
  await sleep(400)
  check((await page.locator('.run-header').count()) === 1, 'Enter activates the focused tab')

  // Run tabs, run header, composer and the History tab in the viewport x theme matrix.
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(400)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(300)
      await page.locator('.topbar .tabs').getByRole('button', { name: 'Live', exact: true }).click()
      await sleep(300)
      const m = await page.evaluate(() => {
        const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && { l: b.left, r: b.right, t: b.top, b: b.bottom } }
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth, ih: window.innerHeight, tabs: r('.run-tabs'), header: r('.run-header'), composer: r('.composer') }
      })
      const inside = (b) => !!b && b.l >= -0.5 && b.r <= m.iw + 0.5 && b.t >= -0.5 && b.b <= m.ih + 0.5
      check(m.sw <= m.cw, \`no horizontal scroll with runs at \${w}x\${h} \${theme}\`, JSON.stringify(m))
      check(inside(m.tabs), \`run tabs inside viewport at \${w}x\${h} \${theme}\`, JSON.stringify(m.tabs))
      check(inside(m.header), \`run header inside viewport at \${w}x\${h} \${theme}\`, JSON.stringify(m.header))
      check(inside(m.composer), \`composer with mode row inside viewport at \${w}x\${h} \${theme}\`, JSON.stringify(m.composer))
      check(!!m.tabs && !!m.header && m.header.t >= m.tabs.b - 0.5, \`run header sits under the tabs in normal flow at \${w}x\${h} \${theme}\`, JSON.stringify([m.tabs, m.header]))
      const tab = page.locator('.run-tab[aria-selected="true"]')
      await tab.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab') // keyboard modality so :focus-visible matches
      const ring = await tab.evaluate((el) => { const s = getComputedStyle(el); return { o: s.outlineStyle, ow: s.outlineWidth, bs: s.boxShadow } })
      check((ring.o !== 'none' && parseFloat(ring.ow) > 0) || ring.bs !== 'none', \`run tab shows a focus ring at \${w}x\${h} \${theme}\`, JSON.stringify(ring))
      await shot(\`live-run-\${w}x\${h}-\${theme}\`)
      await page.locator('.topbar .tabs').getByRole('button', { name: 'History', exact: true }).click()
      await sleep(300)
      const hm = await page.evaluate(() => {
        const b = document.querySelector('.run-row')?.getBoundingClientRect()
        return { iw: window.innerWidth, ih: window.innerHeight, row: b && { l: b.left, r: b.right, t: b.top, b: b.bottom } }
      })
      check(!!hm.row && hm.row.l >= -0.5 && hm.row.r <= hm.iw + 0.5 && hm.row.b <= hm.ih + 0.5, \`History row inside viewport at \${w}x\${h} \${theme}\`, JSON.stringify(hm))
      await shot(\`history-\${w}x\${h}-\${theme}\`)
    }
  }
` +
  s.slice(b)
fs.writeFileSync(p, s)
console.log('ok')
