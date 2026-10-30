import { launch, size, shot, theme, sleep, setScript, three } from './p2-common.mjs'
const { app, page } = await launch()
const log = (...a) => console.log(...a)
const start = async (t) => { const ta = page.locator('.composer textarea'); await ta.fill(t); await page.locator('.composer .btn.primary').click() }
await theme(page, 'dark')
await size(app, page, 1024, 640)
await page.locator('.sidebar [data-testid=nav-project]', { hasText: 'Notes API' }).click()
await page.getByRole('tab', { name: 'Live', exact: true }).click()
setScript(three); await start('Add rate limiting to the API'); await sleep(6000)
const setSidebar = async (want) => { const cur = await page.evaluate(() => document.querySelector('.sidebar').dataset.collapsed); if ((cur === 'true') !== (want === 'rail')) { await page.keyboard.press('Control+b'); await sleep(500) } }
const setSide = async (want) => { const cur = await page.evaluate(() => document.querySelector('.side-panel').dataset.collapsed); if ((cur === 'true') !== (want === 'collapsed')) { await page.locator('.side-panel button').first().click(); await sleep(500) } }
const probe = async (label) => {
  const n = await page.locator('.decision-chip').count()
  const out = []
  for (let i = 0; i < n; i++) {
    await page.locator('.decision-chip').nth(i).click(); await sleep(300)
    out.push(await page.evaluate(() => {
      const t = document.querySelector('.frame-tray'); const tr = t.getBoundingClientRect()
      const bs = [...t.querySelectorAll('button')].filter((b) => /^(Allow once|Deny|Submit)/.test(b.innerText.trim()))
      return { kind: t.querySelector('[data-kind]')?.dataset.kind, trayH: Math.round(tr.height), scrollH: t.scrollHeight, clientH: t.clientHeight, btn: bs.map((b) => { const r = b.getBoundingClientRect(); return `${b.innerText.trim()} ${Math.round(r.top)}-${Math.round(r.bottom)} vis=${r.bottom <= tr.bottom + 0.5}` }) }
    }))
  }
  log(label, JSON.stringify(out))
}
const sc = [['rail', 'collapsed'], ['rail', 'open'], ['open', 'collapsed'], ['open', 'open']]
for (const [sb, sp] of sc) {
  await size(app, page, 1024, 640)
  await setSidebar(sb); await setSide(sp)
  const m = await page.evaluate(() => { const st = document.querySelector('.frame-stage').getBoundingClientRect(); return `${Math.round(st.width)}x${Math.round(st.height)}` })
  await probe(`1024 sidebar=${sb} side=${sp} stage=${m}`)
  await page.locator('.decision-chip').nth(0).click(); await sleep(300)
  await shot(page, `13-1024-sb-${sb}-side-${sp}-q`)
}
await setSidebar('rail'); await setSide('collapsed')
await size(app, page, 1024, 640)
await page.locator('.decision-chip').nth(0).click(); await sleep(300)
// try to answer question: pick option and see Submit
await page.getByRole('button', { name: /Details/ }).first().click().catch(() => log('no details'))
await sleep(400); await shot(page, '14-question-details-1024')
log(await page.evaluate(() => { const t = document.querySelector('.frame-tray'); return `tray scroll ${t.scrollHeight}/${t.clientHeight} overflowY=${getComputedStyle(t).overflowY}` }))
await app.close()
