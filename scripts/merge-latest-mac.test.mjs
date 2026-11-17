// node --test scripts/merge-latest-mac.test.mjs (npm run test:scripts). Pure parse/merge/serialize plus main() on temp files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main, mergeLatestMac, parseUpdateYaml, serializeUpdateYaml } from './merge-latest-mac.mjs'

const leg = (arch, over = {}) => {
  const v = over.version ?? '0.1.8'
  const files = over.files ?? `  - url: OrgAI-${v}-${arch}.zip
    sha512: zip${arch}+/AA==
    size: 123
    blockMapSize: 9
  - url: OrgAI-${v}-${arch}.dmg
    sha512: dmg${arch}BB==
    size: 456`
  return `version: ${v}
files:
${files}
path: ${over.path ?? `OrgAI-${v}-${arch}.zip`}
sha512: ${over.sha ?? `zip${arch}+/AA==`}
releaseDate: '${over.date ?? '2026-11-17T10:00:00.000Z'}'
`
}

const merge = (a, b) => mergeLatestMac(parseUpdateYaml(a), parseUpdateYaml(b))

test('happy merge: arm64 then x64, legacy fields from x64, round trip', () => {
  const doc = merge(leg('arm64', { date: '2026-11-17T10:05:00.000Z' }), leg('x64'))
  assert.deepEqual(
    doc.files.map((f) => f.url),
    ['OrgAI-0.1.8-arm64.zip', 'OrgAI-0.1.8-arm64.dmg', 'OrgAI-0.1.8-x64.zip', 'OrgAI-0.1.8-x64.dmg']
  )
  assert.equal(doc.top.path, 'OrgAI-0.1.8-x64.zip')
  assert.equal(doc.top.sha512, 'zipx64+/AA==')
  assert.equal(doc.top.releaseDate, '2026-11-17T10:05:00.000Z')
  const text = serializeUpdateYaml(doc)
  assert.match(text, /releaseDate: '2026-11-17T10:05:00.000Z'/)
  assert.match(text, /size: 123\n/)
  const back = parseUpdateYaml(text)
  assert.deepEqual(back.files, doc.files)
  assert.deepEqual(back.top, doc.top)
})

test('extra per-file keys are preserved', () => {
  const files = `  - url: OrgAI-0.1.8-arm64.zip
    sha512: abc=
    size: 1
    isAdminRightsRequired: false
    blockMapSize: 7`
  const doc = merge(leg('arm64', { files }), leg('x64'))
  assert.equal(doc.files[0].isAdminRightsRequired, 'false')
  const text = serializeUpdateYaml(doc)
  assert.match(text, /isAdminRightsRequired: false/)
  assert.equal(parseUpdateYaml(text).files[0].blockMapSize, '7')
})

test('quoted scalars parse and re-serialize safely', () => {
  const files = `  - url: "OrgAI-0.1.8-arm64.zip"
    sha512: 'it''s+/a b='
    size: 5`
  const doc = merge(leg('arm64', { files }), leg('x64'))
  assert.equal(doc.files[0].url, 'OrgAI-0.1.8-arm64.zip')
  assert.equal(doc.files[0].sha512, "it's+/a b=")
  const back = parseUpdateYaml(serializeUpdateYaml(doc))
  assert.equal(back.files[0].sha512, "it's+/a b=")
})

test('version mismatch fails', () => {
  assert.throws(() => merge(leg('arm64'), leg('x64', { version: '0.1.9' })), /versions differ/)
})

test('version must be semver', () => {
  assert.throws(() => merge(leg('arm64', { version: '1.0' }), leg('x64', { version: '1.0' })), /not semver/)
})

test('empty or missing files fail', () => {
  assert.throws(() => parseUpdateYaml(''), /empty file/)
  assert.throws(() => merge("version: 0.1.8\nfiles:\npath: a\nreleaseDate: '2026-01-01'\n", leg('x64')), /no files/)
  assert.throws(() => merge('version: 0.1.8\npath: a.zip\nsha512: x\nreleaseDate: \'2026-01-01\'\n', leg('x64')), /no files/)
})

test('duplicate url across legs fails', () => {
  const files = `  - url: OrgAI-0.1.8-arm64.zip
    sha512: a=
  - url: OrgAI-0.1.8-x64.zip
    sha512: b=`
  const x = `  - url: OrgAI-0.1.8-x64.zip
    sha512: b=`
  assert.throws(() => merge(leg('arm64', { files }), leg('x64', { files: x })), /both legs/)
})

test('arch mixups fail', () => {
  assert.throws(() => merge(leg('x64'), leg('x64')), /no url contains arm64/)
  assert.throws(() => merge(leg('arm64'), leg('arm64')), /contains an arm64 url/)
})

test('path-like urls fail', () => {
  for (const url of ['../OrgAI-arm64.zip', 'a/OrgAI-arm64.zip', "'a\\OrgAI-arm64.zip'", 'OrgAI..arm64.zip', 'https://h/OrgAI-arm64.zip']) {
    const files = `  - url: ${url}\n    sha512: a=`
    assert.throws(() => merge(leg('arm64', { files }), leg('x64')), /plain file name|unsupported syntax/, url)
  }
})

test('missing sha512 fails', () => {
  const files = `  - url: OrgAI-0.1.8-arm64.zip\n    size: 1`
  assert.throws(() => merge(leg('arm64', { files }), leg('x64')), /no sha512/)
})

test('unknown syntax fails closed', () => {
  assert.throws(() => parseUpdateYaml('version: 0.1.8\nfiles: [a, b]\n'), /block list/)
  assert.throws(() => parseUpdateYaml('version: 0.1.8\nfoo:\n  bar: 1\n'), /no scalar value/)
  assert.throws(() => parseUpdateYaml('version: &a 0.1.8\n'), /unsupported syntax/)
  assert.throws(() => parseUpdateYaml('version: 0.1.8\nversion: 0.1.9\n'), /duplicate key/)
  assert.throws(() => parseUpdateYaml('version: "a\n'), /unterminated/)
  assert.throws(() => parseUpdateYaml('just text\n'), /unsupported syntax/)
  assert.throws(() => parseUpdateYaml('  - url: a\n'), /outside files/)
})

test('main: writes the merged file atomically, and writes nothing on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-latest-'))
  try {
    const a = path.join(dir, 'a.yml')
    const x = path.join(dir, 'x.yml')
    const out = path.join(dir, 'update', 'latest-mac.yml')
    fs.writeFileSync(a, leg('arm64'))
    fs.writeFileSync(x, leg('x64'))
    main([a, x, out])
    assert.equal(parseUpdateYaml(fs.readFileSync(out, 'utf8')).files.length, 4)
    assert.deepEqual(fs.readdirSync(path.dirname(out)), ['latest-mac.yml'])

    const bad = path.join(dir, 'bad', 'out.yml')
    fs.writeFileSync(x, leg('x64', { version: '0.2.0' }))
    assert.throws(() => main([a, x, bad]), /versions differ/)
    assert.equal(fs.existsSync(bad), false)
    assert.throws(() => main([a, path.join(dir, 'missing.yml'), bad]), /cannot read/)
    fs.writeFileSync(x, '')
    assert.throws(() => main([a, x, bad]), /empty file/)
    assert.equal(fs.existsSync(bad), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
