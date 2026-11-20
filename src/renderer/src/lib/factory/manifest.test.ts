// Schema test of the Factory Floor asset manifest (docs/design/factory-floor.md section 4.6, "GLB rules"). The first build
// is fully procedural (owner decision 2026-11-19), so `assets` is empty and assets/factory/models holds no files. The
// validator below is what a future GLB must pass: listed, hashed, CC0, small, uncompressed, no images, no external URIs.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ASSETS = resolve(__dirname, '..', '..', 'assets', 'factory')
const MODELS = join(ASSETS, 'models')

interface ManifestEntry {
  file: string
  source: string
  author: string
  licence: string
  licenceUrl: string
  sha256: string
  bytes: number
  triangles: number
  modified: string
}
interface Manifest {
  version: number
  budget: { maxFileBytes: number; maxTotalBytes: number; licence: string }
  assets: ManifestEntry[]
}

const FORBIDDEN_EXTENSIONS = /^(KHR_draco_mesh_compression|EXT_meshopt_compression|KHR_texture_basisu|KHR_texture_.*|EXT_texture_.*)$/

/** Lists files (relative, forward slashes) under a directory, empty when it does not exist. */
function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, `${prefix}${name}/`))
    else out.push(`${prefix}${name}`)
  }
  return out.sort()
}

/** The JSON chunk of a GLB, or a reason it is not a plain glTF 2.0 binary. */
function glbJson(buf: Buffer): { json?: Record<string, unknown>; problem?: string } {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return { problem: 'not a GLB (magic)' }
  if (buf.readUInt32LE(4) !== 2) return { problem: 'not glTF 2.0' }
  if (buf.readUInt32LE(16) !== 0x4e4f534a) return { problem: 'first chunk is not JSON' }
  const len = buf.readUInt32LE(12)
  try {
    return { json: JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as Record<string, unknown> }
  } catch {
    return { problem: 'JSON chunk does not parse' }
  }
}

/** Problems with a manifest and the model files next to it; an empty list means it is valid. */
export function validateManifest(manifest: unknown, modelFiles: string[], read: (file: string) => Buffer): string[] {
  const problems: string[] = []
  const m = manifest as Partial<Manifest> | null
  if (!m || typeof m !== 'object') return ['manifest is not an object']
  if (m.version !== 1) problems.push('version must be 1')
  const budget = m.budget
  if (!budget || typeof budget.maxFileBytes !== 'number' || typeof budget.maxTotalBytes !== 'number' || budget.licence !== 'CC0-1.0') {
    problems.push('budget must give maxFileBytes, maxTotalBytes and licence "CC0-1.0"')
  }
  if (!Array.isArray(m.assets)) return [...problems, 'assets must be an array']

  const listed = new Set<string>()
  let total = 0
  for (const [i, e] of m.assets.entries()) {
    const id = `assets[${i}] ${typeof e?.file === 'string' ? e.file : '?'}`
    for (const k of ['file', 'source', 'author', 'licence', 'licenceUrl', 'sha256', 'modified'] as const) {
      if (typeof e?.[k] !== 'string' || !e[k]) problems.push(`${id}: ${k} must be a non-empty string`)
    }
    for (const k of ['bytes', 'triangles'] as const) {
      if (!Number.isInteger(e?.[k]) || (e[k] as number) <= 0) problems.push(`${id}: ${k} must be a positive integer`)
    }
    if (typeof e?.file !== 'string') continue
    if (!/^[a-z0-9][a-z0-9._-]*\.glb$/i.test(e.file)) problems.push(`${id}: file must be a plain .glb file name`)
    if (listed.has(e.file)) problems.push(`${id}: listed twice`)
    listed.add(e.file)
    if (e.licence !== 'CC0-1.0') problems.push(`${id}: licence must be CC0-1.0`)
    if (typeof e.licenceUrl === 'string' && !/^https:\/\//.test(e.licenceUrl)) problems.push(`${id}: licenceUrl must be https`)
    if (typeof e.source === 'string' && !/^https:\/\//.test(e.source)) problems.push(`${id}: source must be an https URL`)
    if (typeof e.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(e.sha256)) problems.push(`${id}: sha256 must be 64 lower-case hex digits`)
    if (!modelFiles.includes(e.file)) {
      problems.push(`${id}: file is listed but missing from assets/factory/models`)
      continue
    }
    const buf = read(e.file)
    total += buf.length
    if (e.bytes !== buf.length) problems.push(`${id}: bytes ${e.bytes} does not match the file (${buf.length})`)
    if (createHash('sha256').update(buf).digest('hex') !== e.sha256) problems.push(`${id}: sha256 does not match the file`)
    if (budget && buf.length > budget.maxFileBytes) problems.push(`${id}: ${buf.length} bytes exceeds the per-file budget`)
    const { json, problem } = glbJson(buf)
    if (problem || !json) {
      problems.push(`${id}: ${problem}`)
      continue
    }
    if (Array.isArray(json.images) && json.images.length > 0) problems.push(`${id}: embedded images are not allowed`)
    if (Array.isArray(json.textures) && json.textures.length > 0) problems.push(`${id}: textures are not allowed`)
    for (const ext of (json.extensionsUsed as string[] | undefined) ?? []) {
      if (FORBIDDEN_EXTENSIONS.test(ext)) problems.push(`${id}: extension ${ext} is not allowed`)
    }
    for (const b of (json.buffers as { uri?: string }[] | undefined) ?? []) {
      if (b.uri) problems.push(`${id}: buffers must not use a URI`)
    }
  }
  if (budget && total > budget.maxTotalBytes) problems.push(`models total ${total} bytes exceeds the budget`)
  for (const f of modelFiles) if (!listed.has(f)) problems.push(`${f}: file in assets/factory/models is not listed in the manifest`)
  return problems
}

function glb(json: Record<string, unknown>): Buffer {
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(20)
  head.writeUInt32LE(0x46546c67, 0)
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(20 + body.length, 8)
  head.writeUInt32LE(body.length, 12)
  head.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([head, body])
}

const BUDGET = { maxFileBytes: 409600, maxTotalBytes: 1572864, licence: 'CC0-1.0' }
function entryFor(file: string, buf: Buffer, over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    file,
    source: 'https://example.invalid/kit',
    author: 'Example',
    licence: 'CC0-1.0',
    licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
    triangles: 100,
    modified: 'none',
    ...over
  }
}

describe('shipped manifest', () => {
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8')) as Manifest
  const files = filesUnder(MODELS)

  it('is valid against the schema and the files on disk', () => {
    expect(validateManifest(manifest, files, (f) => readFileSync(join(MODELS, f)))).toEqual([])
  })

  it('ships no models in the first build (fully procedural)', () => {
    expect(manifest.assets).toEqual([])
    expect(files).toEqual([])
  })

  it('names the CC0 licence and the section 4.6 size budget', () => {
    expect(manifest.budget).toEqual(BUDGET)
  })
})

describe('validateManifest', () => {
  const good = glb({ asset: { version: '2.0' }, meshes: [], buffers: [{ byteLength: 0 }] })

  it('accepts a listed, hashed, plain GLB', () => {
    const m = { version: 1, budget: BUDGET, assets: [entryFor('robot.glb', good)] }
    expect(validateManifest(m, ['robot.glb'], () => good)).toEqual([])
  })

  it('fails on a file that is not listed', () => {
    const m = { version: 1, budget: BUDGET, assets: [] }
    expect(validateManifest(m, ['stray.glb'], () => good).join('\n')).toMatch(/stray\.glb: file in assets\/factory\/models is not listed/)
  })

  it('fails on a listed file that is missing, a hash or size mismatch, another licence', () => {
    const e = entryFor('robot.glb', good)
    expect(validateManifest({ version: 1, budget: BUDGET, assets: [e] }, [], () => good).join('\n')).toMatch(/missing/)
    expect(validateManifest({ version: 1, budget: BUDGET, assets: [{ ...e, sha256: '0'.repeat(64) }] }, ['robot.glb'], () => good).join('\n')).toMatch(/sha256 does not match/)
    expect(validateManifest({ version: 1, budget: BUDGET, assets: [{ ...e, bytes: 1 }] }, ['robot.glb'], () => good).join('\n')).toMatch(/bytes/)
    expect(validateManifest({ version: 1, budget: BUDGET, assets: [{ ...e, licence: 'CC-BY-4.0' }] }, ['robot.glb'], () => good).join('\n')).toMatch(/licence must be CC0-1.0/)
    expect(validateManifest({ version: 1, budget: BUDGET, assets: [{ ...e, author: '' }] }, ['robot.glb'], () => good).join('\n')).toMatch(/author/)
  })

  it('fails on images, compression extensions, external URIs and oversize files', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ asset: { version: '2.0' }, images: [{ uri: 'x.png' }] }, /images/],
      [{ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }, /KHR_draco/],
      [{ asset: { version: '2.0' }, extensionsUsed: ['KHR_texture_basisu'] }, /KHR_texture_basisu/],
      [{ asset: { version: '2.0' }, extensionsUsed: ['EXT_meshopt_compression'] }, /meshopt/],
      [{ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAA' }] }, /URI/]
    ]
    for (const [json, re] of cases) {
      const buf = glb(json)
      expect(validateManifest({ version: 1, budget: BUDGET, assets: [entryFor('a.glb', buf)] }, ['a.glb'], () => buf).join('\n')).toMatch(re)
    }
    const small = { ...BUDGET, maxFileBytes: 10 }
    expect(validateManifest({ version: 1, budget: small, assets: [entryFor('a.glb', good)] }, ['a.glb'], () => good).join('\n')).toMatch(/per-file budget/)
    const tiny = { ...BUDGET, maxTotalBytes: 10 }
    expect(validateManifest({ version: 1, budget: tiny, assets: [entryFor('a.glb', good)] }, ['a.glb'], () => good).join('\n')).toMatch(/total/)
  })

  it('fails on a file that is not a glTF 2.0 binary and on a path-like name', () => {
    const junk = Buffer.from('not a glb at all, just text bytes here')
    expect(validateManifest({ version: 1, budget: BUDGET, assets: [entryFor('a.glb', junk)] }, ['a.glb'], () => junk).join('\n')).toMatch(/not a GLB/)
    expect(validateManifest({ version: 1, budget: BUDGET, assets: [entryFor('../a.glb', good)] }, [], () => good).join('\n')).toMatch(/plain \.glb file name/)
  })

  it('rejects a malformed manifest', () => {
    expect(validateManifest(null, [], () => good)).not.toEqual([])
    expect(validateManifest({ version: 2, assets: 'x' }, [], () => good)).not.toEqual([])
  })
})
