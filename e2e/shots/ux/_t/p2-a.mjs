import { launch, size, shot, DATA, setScript, plain } from './p2-common.mjs'
setScript(plain)
const { app, page } = await launch()
console.log('DATA', DATA)
await size(app, page, 1600, 1000); await shot(page, '01-first-dark-1600')
await size(app, page, 1024, 640); await shot(page, '01-first-dark-1024')
console.log(await page.evaluate(() => [...document.querySelectorAll('form.card input, form.card textarea, form.card button, form.card label')].map(e => e.tagName + ':' + (e.placeholder || e.innerText || e.type).slice(0, 40)).join('\n')))
await app.close()
