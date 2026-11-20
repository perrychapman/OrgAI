// Offscreen art harness for the Factory Floor carriers (docs/design/factory-floor.md sections 4.3 and 4.6, slice 6).
// RUN BY HAND, never in CI (needs a GPU):
//
//   node scripts/render-factory-carriers.mjs --out docs/design/factory-floor-shots/slice-6/art --tag after
//
// It bundles a tiny scene with Vite (the real builders: hall, station, machine, robot, stack light, tote, capsule, part,
// crate, blob and the real materials, palette and lights; this branch's source, no `npm run build` needed), opens it in
// an Electron window through playwright-core and saves PNGs of a static layout at three zooms (near ppm 30, mid 18, far
// 10) in both themes: a lead station with a tote leaving it, capsules in flight, parts on its belt and a crate on the
// pad, beside two bench stations. It is NOT the app: no shadow map (the engine's shadows are off here), no labels, no
// engine, the camera is the engine's (FOV 28, pitch 55, same pose maths). Use it for before/after colour comparisons;
// the app screenshots are the real thing. To compare against an older state, check the old builders out and run it
// with another --tag. The script also prints the contrast of each carrier colour against the floor it sits on, measured
// on the saved PNG (mean sRGB of a mask-free 5 x 5 patch at the object's projected centre, then WCAG contrast).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { _electron as electron } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const OUT = path.resolve(opt('out', path.join(APP_DIR, 'docs/design/factory-floor-shots/slice-6/art')))
const TAG = opt('tag', 'after')
const require = createRequire(path.join(APP_DIR, 'package.json'))
// --src DIR measures another copy of src/renderer/src (e.g. `git archive HEAD src/renderer/src` extracted elsewhere) for a "before".
const SRC = path.resolve(opt('src', path.join(APP_DIR, 'src/renderer/src'))).replace(/\\/g, '/')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-factory-carriers-'))

const entry = `
import { ACESFilmicToneMapping, Color, Group, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'
import { factoryKits, KEY_DIRECTION } from '${SRC}/components/canvas/factory/builders/index'
import { cameraPose, project, FOV_DEG } from '${SRC}/lib/factory/camera'
import { FACTORY_PALETTE } from '${SRC}/lib/factory/palette'

const TOKENS = { success: '#22c58b', warning: '#f5a524', danger: '#ff6b6b', accentText: '#a592ff' }
const W = 960
const H = 560
const canvas = document.createElement('canvas')
document.body.style.margin = '0'
document.body.style.overflow = 'hidden'
canvas.style.display = 'block'
document.body.appendChild(canvas)
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)
canvas.style.width = W + 'px'
canvas.style.height = H + 'px'

const bandFor = (ppm) => (ppm >= 24 ? 'near' : ppm >= 12 ? 'mid' : 'far')

/** The scene: a hall floor, a lead and two bench stations, and the carriers at fixed spots. Returns the world points of interest. */
function compose(theme, band) {
  const scene = new Scene()
  const pal = FACTORY_PALETTE[theme]
  scene.background = new Color(pal.clear)
  const mats = factoryKits.createMaterials(theme, TOKENS)
  mats.applyTheme(theme, TOKENS)
  const lighting = factoryKits.createLighting(theme)
  lighting.applyTheme(theme, 'on')
  lighting.key.castShadow = false
  for (const l of lighting.lights) scene.add(l)
  scene.add(lighting.key.target)
  const lamp = (key) => new MeshBasicMaterial({ color: key === 'lamp.bottom' ? TOKENS.success : key === 'lamp.middle' ? TOKENS.warning : pal.lampOff })
  const add = (kit, x, y, z, rotY = 0, s = 1) => {
    const g = new Group()
    g.position.set(x, y, z)
    g.rotation.y = rotY
    g.scale.setScalar(s)
    for (const p of kit.parts) {
      if (!p.lods.includes(band)) continue
      const m = new Mesh(p.geometry, p.instanceColor ? lamp(p.key) : mats.get(p.role))
      g.add(m)
    }
    scene.add(g)
    return g
  }
  add(factoryKits.hall({ minX: -8, maxX: 38, minZ: -10, maxZ: 22 }), 0, 0, 0)
  const lead = factoryKits.station('lead')
  const bench = factoryKits.station('bench')
  const stack = factoryKits.stackLight()
  const robot = factoryKits.robot()
  const machine = factoryKits.machine(0)
  const station = (kit, x, z, withMachine) => {
    add(kit, x, 0, z)
    const a = kit.anchors
    if (withMachine) add(machine, x + a.machine.x, a.machine.y, z + a.machine.z)
    add(robot, x + a.robot.x, a.robot.y, z + a.robot.z)
    add(stack, x + a.stackLight.x, a.stackLight.y, z + a.stackLight.z)
  }
  station(lead, 6, 1.5, false)
  station(bench, 10, 1.5, true)
  station(bench, 6, 8.5, true)
  const pts = {}
  // The probe argument is the offset (metres, scaled with the object) of the point whose rendered colour the contrast probe reads.
  const place = (name, kit, x, y, z, rotY, s, blob, probe = [0, 0.15, 0]) => {
    add(kit, x, y, z, rotY, s)
    if (blob) {
      const props = factoryKits.props()
      const b = props.parts.find((p) => p.key === 'blob')
      const g = new Group()
      g.position.set(x, 0, z)
      g.scale.set(blob, 1, blob)
      g.add(new Mesh(b.geometry, mats.get('blob')))
      scene.add(g)
    }
    pts[name] = { x: x + probe[0] * s, y: y + probe[1] * s, z: z + probe[2] * s }
  }
  // The tote leaving the lead's front for the bench below it, a capsule to the east bench and one coalesced (1.25x) to
  // the west, parts on the lead's belt (outfeed 0.1, 0.28, 0.6 in its frame) and a crate on its pad.
  place('tote', factoryKits.tote(), 6.3, 0.9, 4.6, 0, 1, 0.7, [0, 0.4, 0.26])
  place('capsule', factoryKits.capsule(), 8.6, 0.9, 3.4, 0, 1, 0.7, [0.2, 0.26, 0])
  place('capsule2', factoryKits.capsule(), 3.8, 0.9, 3.4, 0, 1.25, 0.7, [0.2, 0.26, 0])
  place('part', factoryKits.part(), 6.1, 0.28, 1.5 + 0.6 + 0.4, 0, 1, 0.3, [0, 0.17, 0])
  place('part2', factoryKits.part(), 10.1, 0.28, 1.5 + 0.6 + 0.9, 0, 1, 0.3, [0, 0.17, 0])
  place('crate', factoryKits.crate(), 7.05, 0, 3.5, 0, 1, 0, [0, 0.4, 0])
  pts.floor = { x: 12.5, y: 0, z: 6.5 }
  return { scene, lighting, pts, dispose: () => { mats.dispose(); lighting.dispose() } }
}

/** Render a theme at a zoom; returns the screen position of each point of interest (CSS px) for the contrast probe. */
window.shoot = (theme, ppm, tx, tz) => {
  const band = bandFor(ppm)
  const c = compose(theme, band)
  const view = { ppm, targetX: tx, targetZ: tz }
  const stage = { width: W, height: H, projection: 'perspective' }
  const pose = cameraPose(view, stage)
  const cam = new PerspectiveCamera(FOV_DEG, W / H, 0.5, 400)
  cam.position.set(pose.position.x, pose.position.y, pose.position.z)
  cam.lookAt(pose.target.x, pose.target.y, pose.target.z)
  const t = new Vector3(tx, 0, tz)
  c.lighting.key.position.copy(t).addScaledVector(KEY_DIRECTION, -60)
  c.lighting.key.target.position.copy(t)
  renderer.render(c.scene, cam)
  const screen = {}
  for (const [k, p] of Object.entries(c.pts)) {
    const s = project(view, stage, p)
    screen[k] = { x: s.x, y: s.y }
  }
  const tri = renderer.info.render.triangles
  const calls = renderer.info.render.calls
  c.dispose()
  return { screen, band, tri, calls, bg: pal(theme) }
}
const pal = (theme) => FACTORY_PALETTE[theme].roles
`

fs.writeFileSync(path.join(work, 'entry.ts'), entry)
fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><html><body><script src="./h.js"></script></body></html>')
fs.writeFileSync(
  path.join(work, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 960, height: 560, useContentSize: true, show: true, webPreferences: { sandbox: false } })
  w.loadFile(${JSON.stringify(path.join(work, 'index.html'))})
})
`
)
await build({
  configFile: false,
  logLevel: 'warn',
  root: work,
  resolve: { alias: [{ find: /^three$/, replacement: fileURLToPath(import.meta.resolve('three')) }] },
  build: { outDir: work, emptyOutDir: false, minify: false, target: 'chrome140', lib: { entry: path.join(work, 'entry.ts'), formats: ['iife'], name: 'H', fileName: () => 'h.js' } }
})

fs.mkdirSync(OUT, { recursive: true })
const app = await electron.launch({ executablePath: require('electron'), args: [path.join(work, 'main.cjs')], cwd: APP_DIR })
const page = await app.firstWindow()
await page.waitForFunction(() => typeof window.shoot === 'function', null, { timeout: 30_000 })

/** Decode a PNG buffer in the page and return the mean sRGB of a 5 x 5 patch at (x, y). */
const patch = (png, pts) =>
  page.evaluate(
    async ([b64, list]) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const cx = cv.getContext('2d')
      cx.drawImage(img, 0, 0)
      return list.map(([x, y]) => {
        const d = cx.getImageData(Math.round(x) - 2, Math.round(y) - 2, 5, 5).data
        let r = 0, g = 0, b = 0
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] }
        const n = d.length / 4
        return [r / n, g / n, b / n]
      })
    },
    [png.toString('base64'), pts]
  )
const lum = ([r, g, b]) => {
  const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)

const ZOOMS = [
  ['zoom', 60, 7.4, 3.4],
  ['near', 30, 7, 3.2],
  ['mid', 18, 7, 3.8],
  ['far', 10, 9, 6]
]
for (const theme of ['dark', 'light']) {
  for (const [name, ppm, tx, tz] of ZOOMS) {
    const info = await page.evaluate(([th, p, x, z]) => window.shoot(th, p, x, z), [theme, ppm, tx, tz])
    const file = path.join(OUT, `carriers-${name}-${theme}-${TAG}.png`)
    const png = await page.screenshot({ path: file })
    // Contrast of each carrier's body (rim, cylinder, top face; never the band) against a clear floor patch at (12.5, 6.5).
    const probe = Object.entries(info.screen).filter(([k, s]) => k !== 'floor' && s.x > 4 && s.x < 956 && s.y > 4 && s.y < 556)
    const cols = await patch(png, [[info.screen.floor.x, info.screen.floor.y], ...probe.map(([, s]) => [s.x, s.y])])
    const floor = cols[0]
    const rows = probe.map(([k], i) => `${k} ${ratio(cols[i + 1], floor).toFixed(2)}`)
    console.log(`${theme} ${name} (${info.band}, ${info.calls} calls, ${info.tri} tris): carrier body vs floor  ${rows.join('  ')}`)
    if (args.includes('--rgb')) console.log('   floor', cols[0].map(Math.round).join(','), probe.map(([k], i) => `${k} ${cols[i + 1].map(Math.round).join(',')}`).join('  '))
  }
}

// The contrast numbers worth quoting: one close shot (ppm 140, so the rim, cylinder and top face are many pixels wide) per
// carrier, body pixel against the floor patch below it, in both themes. Shots are not saved.
const worlds = { tote: [6.3, 4.6], capsule: [8.6, 3.4], part: [6.1, 2.5], crate: [7.05, 3.5] }
for (const theme of ['dark', 'light']) {
  const out = []
  for (const [name, [wx, wz]] of Object.entries(worlds)) {
    const info = await page.evaluate(([th, x, z]) => window.shoot(th, 140, x, z), [theme, wx, wz])
    const png = await page.screenshot()
    const at = info.screen[name]
    const [body, floor, belt] = await patch(png, [[at.x, at.y], [480, 520], [at.x, at.y + 60]])
    out.push(`${name} ${ratio(body, floor).toFixed(2)}${name === 'part' ? ` (vs the belt it rides ${ratio(body, belt).toFixed(2)})` : ''}`)
  }
  console.log(`${theme} close-up body vs floor: ${out.join('  ')}`)
}
await app.close()
fs.rmSync(work, { recursive: true, force: true })
