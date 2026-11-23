// Temporary probe (not committed): widths of the run header row at each supported size.
import { cleanup, launch, makeFixtureRepo, openProject, projectTab, removeFixture, setReduceMotion, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E meta probe (orgai test)'
const repo = makeFixtureRepo('meta-probe')
const { app, page } = await launch({ shotPrefix: 'meta-probe' })
const measure = (p) =>
  p.evaluate(() => {
    const m = document.querySelector('[data-testid=run-meta]')
    if (!m) return { err: 'no run-meta', w: innerWidth }
    const r = m.getBoundingClientRect()
    const kids = [...m.children].map((k) => {
      const b = k.getBoundingClientRect()
      return `${k.getAttribute('data-testid') || k.className.split(' ').pop()}${k.hasAttribute('data-folded') ? '(F)' : ''}${k.hasAttribute('data-compact') ? '(C)' : ''}:${Math.round(b.width)}`
    })
    const perm = document.querySelector('[data-testid=run-meta-permission]')
    const pb = perm?.getBoundingClientRect()
    const vis = !!perm && perm.getClientRects().length > 0 && !perm.hasAttribute('data-folded') && pb.width > 0 && pb.right <= r.right + 1
    return { win: `${innerWidth}x${innerHeight}`, meta: Math.round(r.width), clientW: m.clientWidth, scrollW: m.scrollWidth, dock: document.querySelector('.run-body')?.getAttribute('data-dock'), permVisible: vis, permW: pb && Math.round(pb.width), compact: perm?.getAttribute('data-compact'), kids: kids.join(' ') }
  })
try {
  await setReduceMotion(page, 'on')
  const project = await page.evaluate(async (repo) => {
    const created = await window.orgai.projects.create({ path: repo, name: 'E2E meta probe (orgai test)', mock: true })
    return window.orgai.projects.save({ ...created, autoContinue: false })
  }, repo)
  const start = async (prompt, extra = {}) => {
    const run = await page.evaluate((a) => window.orgai.runs.start(a), { projectId: project.id, prompt, ...extra })
    await page.waitForFunction(async (id) => ['idle'].includes((await window.orgai.runs.get(id))?.summary.status), run.id, { timeout: 25000, polling: 200 })
    return run
  }
  const runs = {
    default: await start('[mock:model-switch] pdefault'),
    bypass: await start('[mock:model-switch] pbypass', { permissionMode: 'bypassPermissions' }),
    ended: await start('[mock:model-switch] pended', { permissionMode: 'plan' })
  }
  await page.evaluate((id) => window.orgai.runs.stop(id), runs.ended.id)
  await sleep(1500)
  const sizes = [
    ['main 1024x640 rail sidebar', 1024, 640, 'collapsed'],
    ['main 1024x640 expanded sidebar', 1024, 640, 'expanded'],
    ['main 1600x1000', 1600, 1000, null]
  ]
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 60000 })
  await openProject(page, NAME)
  await projectTab(page, 'Live').click()
  for (const dock of ['open', 'closed']) {
    for (const [label, w, h, sb] of sizes) {
      await page.evaluate(([d, s]) => { localStorage.setItem('orgai.sidePanel.run', d); s ? localStorage.setItem('orgai.sidebar', s) : localStorage.removeItem('orgai.sidebar') }, [dock, sb])
      await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('#/run/')).setContentSize(cw, ch), [w, h])
      await page.reload()
      await page.waitForSelector('.sidebar', { timeout: 60000 })
      await openProject(page, NAME)
      await projectTab(page, 'Live').click()
      for (const key of ['default', 'bypass', 'ended']) {
        await page.locator('.run-tablist [role="tab"]', { hasText: new RegExp(`Mockmodel-switch p${key}`, 'i') }).click()
        await page.waitForSelector('[data-testid=run-meta-permission]', { timeout: 10000 }).catch(() => {})
        await sleep(400)
        console.log('PROBE', label, 'dock', dock, key, JSON.stringify(await measure(page)))
      }
    }
  }
  // run windows
  for (const dock of ['open', 'closed']) {
    for (const [w, h] of [[1024, 640], [1600, 1000]]) {
      for (const key of ['default', 'bypass', 'ended']) {
        await page.evaluate((d) => { localStorage.setItem('orgai.sidePanel.run', d); localStorage.removeItem('orgai.sidebar') }, dock)
        for (const x of app.windows()) if (x !== page) await x.close().catch(() => {})
        await page.evaluate((r) => window.orgai.window.openRun({ projectId: r.projectId, runId: r.id }), runs[key])
        let v
        for (let i = 0; i < 60 && !v; i++) { v = app.windows().find((x) => x !== page); if (!v) await sleep(100) }
        await v.waitForSelector('.composer textarea', { timeout: 20000 }).catch(() => {})
        await app.evaluate(({ BrowserWindow }, { id, w, h }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(id))?.setContentSize(w, h), { id: runs[key].id, w, h })
        await sleep(700)
        console.log('PROBE', `run window ${w}x${h}`, 'dock', dock, key, JSON.stringify(await measure(v)))
      }
    }
  }
} finally {
  for (const w of app.windows()) if (w !== page) await w.close().catch(() => {})
  await cleanup(app, page, NAME)
  removeFixture(repo)
}
process.exit(0)
