import * as fs from 'node:fs'
import { launch, size, shot, theme, sleep, setScript, plain, three, OUT } from './p2-common.mjs'
const { app, page } = await launch()
const log = (...a) => console.log(...a)
const measure = (tag) => page.evaluate((tag) => {
  const sels = { topbar: '.project-topbar', strip: '[data-testid=run-strip]', toolbar: '.frame-toolbar', stage: '.frame-stage', tray: '.frame-tray', composer: '.composer', side: '.side-panel', sidebar: '.sidebar', sbfoot: '.sidebar-footer', brand: '.sidebar-brand, .brand, .sidebar > :first-child', main: '.main, main' }
  const out = { tag, vw: innerWidth, vh: innerHeight }
  for (const [k, s] of Object.entries(sels)) { const e = document.querySelector(s); if (e) { const r = e.getBoundingClientRect(); out[k] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',') } }
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const pills = [...document.querySelectorAll('.badge, .chip, .pill, [class*=badge], [class*=chip], [class*=pill]')].filter(vis).map((e) => (e.className + '|' + e.innerText.trim().slice(0, 24)))
  out.pills = pills
  const st = document.querySelector('.frame-stage .react-flow, .frame-stage')
  if (st) { const r = st.getBoundingClientRect(); out.canvas = Math.round(r.width) + 'x' + Math.round(r.height) }
  const fs = [...document.querySelectorAll('.frame-stage *, .frame-toolbar *, .frame-tray *')].filter((e) => e.children.length === 0 && e.innerText?.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize)); out.minFont = Math.min(...fs)
  return out
}, tag)
const start = async (t) => { const ta = page.locator('.composer textarea'); await ta.fill(t); await page.locator('.composer .btn.primary').click() }
await theme(page, 'dark')
await size(app, page, 1424, 881)
await page.locator('.sidebar [data-testid=nav-project]', { hasText: 'Notes API' }).click()
await page.getByRole('tab', { name: 'Live', exact: true }).click()
setScript(plain); await start('Add a /health endpoint'); await sleep(4500)
setScript(three); await page.keyboard.press('Control+t'); await sleep(500); await start('Add rate limiting to the API'); await sleep(6000)
const res = []
for (const [w, h] of [[1024, 640], [1424, 881], [1600, 1000]]) {
  await size(app, page, w, h); await sleep(500)
  res.push(await measure(`${w}x${h} dark decisions`))
}
fs.writeFileSync(OUT + '/measure.json', JSON.stringify(res, null, 1))
log(JSON.stringify(res, null, 1))
await app.close()
