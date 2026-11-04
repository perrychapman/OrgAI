// Renders the OrgAI app icon without dependencies and writes the three committed files in build/:
//   icon.png  1024x1024, full bleed rounded square (Linux, dev window and Dock icon)
//   icon.ico  16, 20, 24, 32, 40, 48, 64, 128, 256 (Windows), each size rendered natively
//   icon.icns 16..1024 incl. @2x slots, the mark inset to ~80% with a transparent margin (macOS)
// Regenerate all three together; output is reproducible on the same Node version (zlib deflate output may differ between versions). The rasterizer lives in scripts/lib/icon.mjs.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICNS_TYPES, MAC_INSET, encodeIcns, encodeIco, encodePng, renderIcon } from './lib/icon.mjs'

export { ICNS_TYPES, MAC_INSET, encodeIcns, encodeIco, encodePng, renderIcon }

export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

function png(size, inset) {
  return encodePng(renderIcon(size, { inset }), size)
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const written = []
  const write = (name, data, sizes) => {
    writeFileSync(join(OUT_DIR, name), data)
    written.push(`Wrote build/${name} (${data.length} bytes; sizes ${sizes.join(', ')})`)
  }

  write('icon.png', png(1024, false), [1024])
  write('icon.ico', encodeIco(ICO_SIZES.map((size) => ({ size, png: png(size, false) }))), ICO_SIZES)

  const cache = new Map()
  const macPng = (size) => {
    if (!cache.has(size)) cache.set(size, png(size, MAC_INSET))
    return cache.get(size)
  }
  const icnsTypes = Object.entries(ICNS_TYPES)
  write(
    'icon.icns',
    encodeIcns(icnsTypes.map(([type, size]) => ({ type, png: macPng(size) }))),
    icnsTypes.map(([type, size]) => `${type}=${size}`)
  )
  for (const line of written) console.log(line)
}

function isEntry() {
  if (!process.argv[1]) return false
  try {
    const entry = realpathSync(process.argv[1])
    const self = realpathSync(fileURLToPath(import.meta.url))
    return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self
  } catch {
    return false
  }
}

if (isEntry()) main()
