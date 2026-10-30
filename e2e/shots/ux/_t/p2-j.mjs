import { launch, size, sleep, setScript, three, theme } from './p2-common.mjs'
const { app, page } = await launch()
const start = async (t) => { const ta = page.locator('.composer textarea'); await ta.fill(t); await page.locator('.composer .btn.primary').click() }
await theme(page, 'dark')
await size(app, page, 1024, 640)
await page.locator('.sidebar [data-testid=nav-project][data-name="Notes API"]').click()
await page.getByRole('tab', { name: 'Live', exact: true }).click()
setScript(three); await start('Add rate limiting to the API'); await sleep(6000)
for (const [w, h] of [[1024, 640], [1424, 881], [1600, 1000]]) {
  await size(app, page, w, h); await sleep(500)
  console.log(w, h, await page.evaluate(() => {
    const vp = document.querySelector('.react-flow__viewport'); const m = /scale\(([\d.]+)\)/.exec(vp?.style.transform || '') || /matrix\(([\d.]+)/.exec(getComputedStyle(vp).transform)
    const n = document.querySelector('.react-flow__node'); const t = n?.querySelector('div, span'); const status = [...document.querySelectorAll('.react-flow__node *')].find((e) => /Asking|Needs approval/.test(e.textContent) && e.children.length === 0)
    const fs = status ? parseFloat(getComputedStyle(status).fontSize) : null
    return { scale: m && m[1], statusFont: fs, effective: fs && m ? +(fs * parseFloat(m[1])).toFixed(1) : null, nodeW: n && Math.round(n.getBoundingClientRect().width) }
  }))
}
await app.close()
