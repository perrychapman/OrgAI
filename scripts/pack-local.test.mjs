// node --test scripts/pack-local.test.mjs (npm run test:scripts). Pure parts only; never runs the pack.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { formatBuildInfo, unpackedLayout, assertInside, plan } from './pack-local.mjs'

test('formatBuildInfo writes version, commit and ISO time', () => {
  const s = formatBuildInfo({ version: '0.1.6-dev1', commit: 'abc1234', builtAt: new Date('2026-11-03T10:00:00Z') })
  assert.equal(s, 'version: 0.1.6-dev1\ncommit: abc1234\nbuilt: 2026-11-03T10:00:00.000Z\n')
})

test('formatBuildInfo fills unknowns and adds a note', () => {
  const s = formatBuildInfo({ version: '', commit: undefined, builtAt: '2026-11-03T10:00:00.000Z', note: 'x' })
  assert.equal(s, 'version: unknown\ncommit: unknown\nbuilt: 2026-11-03T10:00:00.000Z\nnote: x\n')
})

test('unpackedLayout per platform', () => {
  assert.deepEqual(unpackedLayout('win32', 'x64'), { dir: 'win-unpacked', marker: 'OrgAI.exe' })
  assert.deepEqual(unpackedLayout('darwin', 'arm64'), { dir: 'mac-arm64', marker: 'OrgAI.app' })
  assert.deepEqual(unpackedLayout('darwin', 'x64'), { dir: 'mac', marker: 'OrgAI.app' })
})

test('assertInside refuses the folder itself and anything outside', () => {
  const rel = path.resolve('/r/release')
  assert.doesNotThrow(() => assertInside(rel, path.join(rel, 'previous')))
  assert.throws(() => assertInside(rel, rel))
  assert.throws(() => assertInside(rel, path.resolve('/r/release-v3')))
  assert.throws(() => assertInside(rel, path.join(rel, '..', 'out')))
})

test('plan keeps every path under release/', () => {
  const root = path.resolve('/repo')
  const p = plan(root, 'win32', 'x64')
  assert.equal(p.current, path.join(root, 'release', 'win-unpacked'))
  assert.equal(p.marker, path.join(root, 'release', 'win-unpacked', 'OrgAI.exe'))
  assert.equal(p.previousDir, path.join(root, 'release', 'previous', 'win-unpacked'))
  assert.equal(p.previousTxt, path.join(root, 'release', 'previous', 'BUILD.txt'))
  assert.equal(p.buildTxt, path.join(root, 'release', 'BUILD.txt'))
  for (const k of ['current', 'previous', 'previousDir', 'previousTxt', 'buildTxt']) assertInside(p.release, p[k])
})
