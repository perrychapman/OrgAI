// Tests for the pure decision in scripts/audit-gate.mjs. Nothing here runs npm.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EXEMPT, evaluateAudit } from './audit-gate.mjs'

const ID = 'GHSA-fc5q-39xc-vjpf'
const URL = `https://github.com/advisories/${ID}`
const adv = (name, id, severity = 'high') => ({ name, url: `https://github.com/advisories/${id}`, severity, title: id })
const vuln = (via, severity = 'high') => ({ name: 'x', severity, via })
const entry = EXEMPT[0]
const TODAY = '2026-11-17'

/** A report with metadata consistent with its vulnerabilities (as npm prints it). */
function rpt(vulnerabilities, metaOver = {}) {
  const n = (s) => Object.values(vulnerabilities).filter((v) => v.severity === s).length
  return {
    vulnerabilities,
    metadata: {
      vulnerabilities: { high: n('high'), critical: n('critical') },
      dependencies: { dev: 334 },
      ...metaOver
    }
  }
}

/** picomatch (exempt advisory) -> tinyglobby -> vite -> vitest, like the real report. */
const base = () =>
  rpt({
    picomatch: vuln([adv('picomatch', ID)]),
    tinyglobby: vuln(['picomatch']),
    vite: vuln(['picomatch', 'tinyglobby']),
    vitest: vuln(['picomatch', 'vite'])
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
  assert.equal(run(rpt({ picomatch: vuln([adv('picomatch', 'GHSA-aaaa-bbbb-cccc')]) })).ok, false)
})

test('the exempt id on another package does not match', () => {
  assert.equal(run(rpt({ other: vuln([adv('other', ID)]) })).ok, false)
})

test('an exempt advisory object counts only under its own package key and name', () => {
  // right name, sitting under another package key
  assert.equal(run(rpt({ other: vuln([adv('picomatch', ID)]) })).ok, false)
  // right key, wrong name inside the advisory
  assert.equal(run(rpt({ picomatch: vuln([adv('other', ID)]) })).ok, false)
})

test('only the exact advisory url matches: other hosts, bare id, trailing slash, query and suffix forms fail', () => {
  for (const url of [
    ID,
    `https://evil.example/${ID}/x`,
    `https://evil.example/advisories/${ID}`,
    `http://github.com/advisories/${ID}`,
    `${URL}/`,
    `${URL}?x=1`,
    `${URL}#a`,
    `https://github.com/other/${ID}`,
    `${URL}x`,
    undefined
  ]) {
    const a = { name: 'picomatch', severity: 'high', url }
    assert.equal(run(rpt({ picomatch: vuln([a]) })).ok, false, String(url))
  }
  assert.equal(run(rpt({ picomatch: vuln([{ name: 'picomatch', severity: 'high', url: URL }]) })).ok, true)
})

test('another high on an unrelated package fails, the exempt part still passes', () => {
  const rep = base()
  rep.vulnerabilities.lodash = vuln([adv('lodash', 'GHSA-1111-2222-3333')])
  rep.metadata.vulnerabilities.high += 1
  const r = run(rep)
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 1)
  assert.match(r.failures[0], /^lodash/)
})

test('a dependent whose via chain mixes exempt and non-exempt fails', () => {
  const rep = rpt({
    picomatch: vuln([adv('picomatch', ID)]),
    mixed: vuln(['picomatch', 'lodash']),
    lodash: vuln([adv('lodash', 'GHSA-1111-2222-3333')])
  })
  const r = run(rep)
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => f.startsWith('mixed')))
  assert.ok(r.failures.some((f) => f.startsWith('lodash')))
})

test('a via string naming a package missing from the report fails closed', () => {
  assert.equal(run(rpt({ vite: vuln(['ghost']) })).ok, false)
})

test('a high package with an empty via fails', () => {
  const r = run(rpt({ a: vuln([]) }))
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 1)
})

test('a high package whose via holds only moderate entries fails', () => {
  const rep = rpt({ a: vuln([adv('a', 'GHSA-1111-2222-3333', 'moderate')]), b: vuln(['c']), c: vuln([adv('c', 'GHSA-4444-5555-6666', 'low')], 'low') })
  const r = run(rep)
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 2)
})

test('critical is never exempt unless the entry names that advisory', () => {
  assert.equal(run(rpt({ picomatch: vuln([adv('picomatch', 'GHSA-aaaa-bbbb-cccc', 'critical')], 'critical') })).ok, false)
  assert.equal(run(rpt({ picomatch: vuln([adv('picomatch', ID, 'critical')], 'critical') })).ok, true)
})

test('moderate and low findings only: ok, nothing exempted', () => {
  const rep = rpt({ a: vuln([adv('a', 'GHSA-1111-2222-3333', 'moderate')], 'moderate'), b: vuln([adv('b', 'GHSA-4444-5555-6666', 'low')], 'low') })
  const r = run(rep)
  assert.equal(r.ok, true)
  assert.deepEqual(r.exempted, [])
})

test('an empty report is clean', () => {
  assert.equal(run(rpt({})).ok, true)
})

test('severity must be exactly info, low, moderate, high or critical, top level and in via', () => {
  for (const sev of ['High', 'severe', 'CRITICAL', '', undefined, null, 3, ['high']]) {
    const top = rpt({ a: vuln([adv('a', 'GHSA-1111-2222-3333', 'moderate')], 'moderate') })
    top.vulnerabilities.a.severity = sev
    assert.equal(run(top).ok, false, `top ${String(sev)}`)
    const inVia = base()
    inVia.vulnerabilities.picomatch.via[0].severity = sev
    assert.equal(run(inVia).ok, false, `via ${String(sev)}`)
  }
  for (const sev of ['info', 'low', 'moderate']) {
    assert.equal(run(rpt({ a: vuln([adv('a', 'GHSA-1111-2222-3333', sev)], sev) })).ok, true, sev)
  }
})

test('metadata: missing, malformed, a count mismatch or no dev dependencies fails', () => {
  const noMeta = base()
  delete noMeta.metadata
  assert.equal(run(noMeta).ok, false)
  assert.equal(run(rpt({}, { vulnerabilities: undefined })).ok, false)
  assert.equal(run(rpt({}, { vulnerabilities: { high: '0', critical: 0 } })).ok, false)
  const fewer = base()
  fewer.metadata.vulnerabilities.high = 3
  assert.equal(run(fewer).ok, false)
  const more = base()
  more.metadata.vulnerabilities.critical = 1
  assert.equal(run(more).ok, false)
  // the report lists a high package that metadata does not count
  const hidden = base()
  hidden.metadata.vulnerabilities.high = 0
  assert.equal(run(hidden).ok, false)
  for (const dependencies of [undefined, {}, { dev: 0 }, { dev: '12' }, null]) {
    assert.equal(run(base().metadata && rpt(base().vulnerabilities, { dependencies })).ok, false, JSON.stringify(dependencies))
  }
  assert.equal(run(base()).ok, true)
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
  const r = run(rpt({}), '2027-06-01')
  assert.equal(r.ok, false)
  assert.equal(r.expired.length, 1)
})

test('exempt entry dates must be real YYYY-MM-DD calendar dates', () => {
  for (const review of ['2099-99-99', '2026-02-30', '2026-1-1', 'soon', '', undefined, 20261217]) {
    const r = run(base(), TODAY, [{ ...entry, review }])
    assert.equal(r.ok, false, String(review))
    assert.ok(r.failures.length > 0)
  }
  for (const added of ['2099-99-99', 'x', undefined]) {
    assert.equal(run(base(), TODAY, [{ ...entry, added }]).ok, false, String(added))
  }
  assert.equal(run(base(), TODAY, [{ ...entry, review: '2026-12-17' }]).ok, true)
})

test('malformed reports fail', () => {
  const m = { vulnerabilities: { high: 0, critical: 0 }, dependencies: { dev: 1 } }
  for (const bad of [
    null,
    undefined,
    'x',
    [],
    42,
    {},
    { vulnerabilities: null },
    { vulnerabilities: [] },
    { error: { code: 'EAUDIT', summary: 'nope' } },
    { error: 'x', vulnerabilities: {}, metadata: m },
    { vulnerabilities: { a: 'x' }, metadata: m },
    { vulnerabilities: { a: { severity: 'high' } }, metadata: m },
    { vulnerabilities: { a: { via: [] } }, metadata: m }
  ]) {
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

test('a via cycle does not hang; a pure high cycle fails', () => {
  const rep = rpt({ a: vuln(['b']), b: vuln(['a', 'picomatch']), picomatch: vuln([adv('picomatch', ID)]) })
  assert.equal(run(rep).ok, true)
  const bad = rpt({ a: vuln(['b']), b: vuln(['a']), c: vuln([adv('c', 'GHSA-1111-2222-3333')]) })
  const r = run(bad)
  assert.equal(r.ok, false)
  assert.equal(r.failures.length, 3)
  const self = rpt({ a: vuln(['a', 'picomatch']), picomatch: vuln([adv('picomatch', ID)]) })
  assert.equal(run(self).ok, true)
})
