import { launch, size, shot, theme, sleep, setScript, three } from './p2-common.mjs'
const { app, page } = await launch()
const log = (...a) => console.log(...a)
const start = async (t) => { const ta = page.locator('.composer textarea'); await ta.fill(t); await page.locator('.composer .btn.primary').click() }
const active = () => page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'body'; const r = e.getBoundingClientRect(); const vis = r.width > 0 && r.bottom > 0 && r.top < innerHeight; return `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} "${(e.getAttribute('aria-label') || e.innerText || e.title || '').trim().slice(0, 36).replace(/\n/g, ' ')}" @${Math.round(r.x)},${Math.round(r.y)} ${vis ? '' : 'OFFSCREEN'}` })
await theme(page, 'dark')
await size(app, page, 1024, 640)
const setSidebar = async (want) => { const cur = await page.evaluate(() => document.querySelector('.sidebar').dataset.collapsed); if ((cur === 'true') !== (want === 'rail')) { await page.keyboard.press('Control+b'); await sleep(500) } }
await page.locator('.sidebar [data-testid=nav-project][data-name="Notes API"]').click()
await page.getByRole('tab', { name: 'Live', exact: true }).click()
setScript(three); await start('Add rate limiting to the API'); await sleep(6000)
await setSidebar('rail')
const sidecol = await page.evaluate(() => document.querySelector('.side-panel').dataset.collapsed)
log('side collapsed?', sidecol)
// rail: DOM
log('rail controls:', await page.evaluate(() => [...document.querySelectorAll('.sidebar button, .sidebar a, .sidebar [tabindex]')].map((b) => `${b.className.split(' ')[0]}:${b.getAttribute('aria-label') || b.innerText.trim().slice(0, 20)}`).join(' | ')))
log('brand lockup in rail:', await page.evaluate(() => { const b = document.querySelector('.brand-lockup'); return b.outerHTML.replace(/src="[^"]+"/, 'src=…').slice(0, 300) + ' title=' + (b.closest('[title]')?.title ?? '') }))
// keyboard pass
await page.evaluate(() => { document.activeElement?.blur(); document.body.setAttribute('tabindex', '-1'); document.body.focus() })
const stops = []
for (let i = 0; i < 45; i++) { await page.keyboard.press('Tab'); stops.push(`${i + 1}. ` + (await active())) }
log(stops.join('\n'))
// Ctrl+B from keyboard, side tabs arrows
await page.keyboard.press('Control+b'); await sleep(500); await shot(page, '15-kbd-ctrlb-1024')
await page.keyboard.press('Control+b'); await sleep(400)
// side panel tabs: open side panel then ArrowRight
await page.locator('.side-panel .side-rail button, .side-panel button').first().click({ timeout: 5000 }).catch(() => log('no side btn')); await sleep(500)
await page.getByRole('tab', { name: 'Transcript' }).focus().catch(() => log('no transcript tab'))
const seq = []
seq.push(await active())
for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await sleep(150); seq.push(await active()) }
log('arrow across side tabs:\n' + seq.join('\n'))
await shot(page, '15-kbd-sidetabs-1024')
await app.close()
