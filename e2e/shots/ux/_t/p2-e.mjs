import { launch, size, shot, theme, sleep, setScript, plain, three } from './p2-common.mjs'
const { app, page } = await launch()
const log = (...a) => console.log(...a)
const start = async (t) => { const ta = page.locator('.composer textarea'); await ta.fill(t); await page.locator('.composer .btn.primary').click() }
const active = () => page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'body'; const r = e.getBoundingClientRect(); return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className).split(' ')[0]} "${(e.getAttribute('aria-label') || e.innerText || e.title || '').trim().slice(0, 40).replace(/\n/g, ' ')}" @${Math.round(r.x)},${Math.round(r.y)}` })
await theme(page, 'dark')
await size(app, page, 1424, 881)
await page.locator('.sidebar [data-testid=nav-project]', { hasText: 'Notes API' }).click()
await page.getByRole('tab', { name: 'Live', exact: true }).click()
setScript(plain); await start('Add a /health endpoint'); await sleep(4500)
setScript(three); await page.keyboard.press('Control+t'); await sleep(500); await start('Add rate limiting to the API'); await sleep(6000)

// popovers
await page.locator('.sidebar-footer button').first().click(); await sleep(400)
await shot(page, '07-account-pop-dark-1424')
log('account pop:', await page.evaluate(() => document.querySelector('.account-popover')?.innerText))
await page.keyboard.press('Escape'); await sleep(300)
log('after Esc account open?', await page.locator('.account-popover').count(), 'focus', await active())
await page.locator('.sidebar .needs-row, .sidebar [aria-haspopup]').first().click().catch(async () => { await page.getByText('Needs you · 3').click() }); await sleep(400)
await shot(page, '07-needs-pop-dark-1424')
log('needs pop:', await page.evaluate(() => document.querySelector('.needs-popover')?.innerText))
await page.keyboard.press('Escape'); await sleep(300)
log('after Esc needs open?', await page.locator('.needs-popover').count(), 'focus', await active())
await page.locator('[data-testid=canvas-legend-trigger]').click(); await sleep(400)
await shot(page, '08-legend-dark-1424')
log('legend:', await page.evaluate(() => document.querySelector('[data-testid=canvas-legend]')?.innerText))
await page.keyboard.press('Escape'); await sleep(300)
log('after Esc legend open?', await page.locator('[data-testid=canvas-legend]').count(), 'focus', await active())

// rail toggle
await page.keyboard.press('Control+b'); await sleep(500)
await shot(page, '09-rail-dark-1424')
await page.keyboard.press('Control+b'); await sleep(500)
// side panel collapse at 1424
await page.locator('.side-panel button').first().click(); await sleep(500)
await shot(page, '10-sidepanel-collapsed-dark-1424')
log('1424 collapsed side: stage', await page.evaluate(() => { const r = document.querySelector('.frame-stage').getBoundingClientRect(); const t = document.querySelector('.frame-tray').getBoundingClientRect(); return [r.width, r.height, t.x, t.y, t.width, t.height].map(Math.round).join(',') }))
await page.locator('.side-panel button').first().click(); await sleep(400)

// 1024
await size(app, page, 1024, 640); await sleep(600)
await page.locator('.side-panel button').first().click(); await sleep(600)
await shot(page, '10-sidepanel-expanded-dark-1024')
log('1024 expanded side: stage', await page.evaluate(() => { const r = document.querySelector('.frame-stage').getBoundingClientRect(); const s = document.querySelector('.side-panel').getBoundingClientRect(); return [r.width, r.height, s.width].map(Math.round).join(',') }))
await page.locator('.side-panel button').first().click(); await sleep(400)
await page.keyboard.press('Control+b'); await sleep(500)
await shot(page, '09-expanded-sidebar-dark-1024')
log('1024 sidebar expanded: stage', await page.evaluate(() => { const r = document.querySelector('.frame-stage').getBoundingClientRect(); return [r.width, r.height].map(Math.round).join(',') }))
await page.keyboard.press('Control+b'); await sleep(400)
// hover rail brand
log('rail brand html:', await page.evaluate(() => document.querySelector('.sidebar').firstElementChild.outerHTML.slice(0, 500)))
await page.locator('[aria-label="Expand sidebar"]').first().hover().catch(() => log('no expand btn'))
await sleep(900); await shot(page, '09-rail-hover-dark-1024')

// Needs row/rail popover at 1024
await page.locator('.sidebar [aria-haspopup]').first().click().catch(() => {}); await sleep(400)
await shot(page, '07-needs-pop-rail-dark-1024')
await page.keyboard.press('Escape')

// decision card actions at 1024: open Details
await page.getByRole('button', { name: /Details/ }).first().click().catch(() => {}); await sleep(400)
await shot(page, '11-card-details-dark-1024')
log('tray at 1024 after Details:', await page.evaluate(() => { const t = document.querySelector('.frame-tray'); const s = document.querySelector('.frame-stage').getBoundingClientRect(); return `stage ${Math.round(s.height)} tray scrollH ${t.scrollHeight} clientH ${t.clientHeight}` }))
// compose: click question chip
await page.locator('.decision-chip').first().click(); await sleep(400)
await shot(page, '11-card-question-dark-1024')
log('question card:', await page.evaluate(() => document.querySelector('.frame-tray').innerText))
await app.close()
