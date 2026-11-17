// Tests for the pure decision in scripts/audit-gate.mjs. Nothing here runs npm.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EXEMPT, evaluateAudit } from './audit-gate.mjs'

const ID = 'GHSA-fc5q-39xc-vjpf'
const adv = (name, id, severity = 'high') => ({ name, url: `https://github.com/advisories/${id}`, severity, title: id })
const vuln = (via, severity = 'high') => ({ name: 'x', severity, via })
const entry = EXEMPT[0]
const TODAY = '2026-11-17'

/** picomatch (exempt advisory) -> tinyglobby -> vite -> vitest, like the real report. */
const base = () => ({
  vulnerabilities: {
    picomatch: vuln([adv('picomatch', ID)]),
    tinyglobby: vuln(['picomatch']),
    vite: vuln(['picomatch', 'tinyglobby']),
    vitest: vuln(['picomatch', 'vite'])
  }
})
const run = (report, today = TODAY, list = EXEMPT) => evaluateAudit(report, list, today)

test('the exempt entry is exactly one advisory with a 30 day review', () => {
  assert.equal(EXEMPT.length, 1)
  assert.equal(entry.id, ID)
  assert.equal(entry.package, 'picomatch')
  assert.equal(entry.added, '2026-11-17')
  assert.equal(entry.review, '2026-12-17')
})

test('only the exempt advisory and its dependents: ok, reported with a dependent count', () => {
  const r = run(base())
  assert.equal(r.ok, true)
  assert.deepEqual(r.failures, [])
  assert.equal(r.exempted.length, 1)
  assert.equal(r.exempted[0].id, ID)
  assert.equal(r.exempted[0].dependents, 3)
})

test('the same report with an empty exempt list fails for every package', () => {
  const r = run(base(), TODAY, [])
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 4)
})

test('the exempt advisory plus another high on the same package fails', () => {
  const rep = base()
  rep.vulnerabilities.picomatch.via.push(adv('picomatch', 'GHSA-aaaa-bbbb-cccc'))
  const r = run(rep)
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => f.startsWith('picomatch')))
})

test('a different advisory on picomatch fails', () => {
  const rep = { vulnerabilities: { picomatch: vuln([adv('picomatch', 'GHSA-aaaa-bbbb-cccc')]) } }
  assert.equal(run(rep).ok, false)
})

test('the exempt id on another package does not match', () => {
  const rep = { vulnerabilities: { other: vuln([adv('other', ID)]) } }
  assert.equal(run(rep).ok, false)
})

test('a url that merely contains the id does not match', () => {
  const a = { name: 'picomatch', severity: 'high', url: `https://evil.example/${ID}/x` }
  assert.equal(run({ vulnerabilities: { picomatch: vuln([a]) } }).ok, false)
})

test('another high on an unrelated package fails, the exempt part still passes', () => {
  const rep = base()
  rep.vulnerabilities.lodash = vuln([adv('lodash', 'GHSA-1111-2222-3333')])
  const r = run(rep)
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 1)
  assert.match(r.failures[0], /^lodash/)
})

test('a dependent whose via chain mixes exempt and non-exempt fails', () => {
  const rep = base()
  rep.vulnerabilities.mixed = vuln(['picomatch', 'lodash'])
  rep.vulnerabilities.lodash = vuln([adv('lodash', 'GHSA-1111-2222-3333')])
  const r = run(rep)
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => f.startsWith('mixed')))
  assert.ok(r.failures.some((f) => f.startsWith('lodash')))
})

test('a via string naming a package missing from the report fails closed', () => {
  const rep = { vulnerabilities: { vite: vuln(['ghost']) } }
  assert.equal(run(rep).ok, false)
})

test('critical is never exempt unless the entry names that advisory', () => {
  const rep = { vulnerabilities: { picomatch: vuln([adv('picomatch', 'GHSA-aaaa-bbbb-cccc', 'critical')], 'critical') } }
  assert.equal(run(rep).ok, false)
  const listed = { vulnerabilities: { picomatch: vuln([adv('picomatch', ID, 'critical')], 'critical') } }
  assert.equal(run(listed).ok, true)
})

test('moderate and low findings only: ok, nothing exempted', () => {
  const rep = { vulnerabilities: { a: vuln([adv('a', 'GHSA-1111-2222-3333', 'moderate')], 'moderate'), b: vuln([adv('b', 'GHSA-4444-5555-6666', 'low')], 'low') } }
  const r = run(rep)
  assert.equal(r.ok, true)
  assert.deepEqual(r.exempted, [])
})

test('an empty report is clean', () => {
  assert.equal(run({ vulnerabilities: {} }).ok, true)
})

test('after the review date the exemption has expired and the gate fails', () => {
  const r = run(base(), '2026-12-18')
  assert.equal(r.ok, false)
  assert.equal(r.expired.length, 1)
  assert.ok(r.failures.length > 0, 'expired entries are not applied')
  assert.equal(run(base(), '2026-12-17').ok, true, 'the review day itself still passes')
  assert.equal(run(base(), new Date('2027-01-01T00:00:00Z')).ok, false)
})

test('an expired exemption fails even when nothing is vulnerable', () => {
  const r = run({ vulnerabilities: {} }, '2027-06-01')
  assert.equal(r.ok, false)
  assert.equal(r.expired.length, 1)
})

test('malformed reports fail', () => {
  for (const bad of [null, undefined, 'x', [], 42, {}, { vulnerabilities: null }, { vulnerabilities: [] }, { error: { code: 'EAUDIT', summary: 'nope' } }, { error: 'x', vulnerabilities: {} }, { vulnerabilities: { a: 'x' } }, { vulnerabilities: { a: { severity: 'high' } } }, { vulnerabilities: { a: { via: [] } } }]) {
    const r = run(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.ok(r.failures.length > 0)
  }
})

test('a bad date or exempt list fails', () => {
  assert.equal(evaluateAudit(base(), EXEMPT, 'yesterday').ok, false)
  assert.equal(evaluateAudit(base(), EXEMPT, undefined).ok, false)
  assert.equal(evaluateAudit(base(), null, TODAY).ok, false)
})

test('a via cycle does not hang and still decides', () => {
  const rep = { vulnerabilities: { a: vuln(['b']), b: vuln(['a', 'picomatch']), picomatch: vuln([adv('picomatch', ID)]) } }
  assert.equal(run(rep).ok, true)
  const bad = { vulnerabilities: { a: vuln(['b']), b: vuln(['a']) , c: vuln([adv('c', 'GHSA-1111-2222-3333')]) } }
  const r = run(bad)
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 1)
  const self = { vulnerabilities: { a: vuln(['a', 'picomatch']), picomatch: vuln([adv('picomatch', ID)]) } }
  assert.equal(run(self).ok, true)
})
