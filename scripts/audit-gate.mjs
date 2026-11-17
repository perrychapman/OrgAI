// CI dependency audit gate: `npm audit --audit-level=high` minus ONE owner-approved, time-limited exemption.
//
//   node scripts/audit-gate.mjs
//
// Runs `npm audit --json --ignore-scripts --include=dev`, exits 1 when a high or critical finding remains that the exempt list below
// does not fully explain, when the exemption has expired, or when the report cannot be read (fail closed). Moderate and
// low findings never fail, the same threshold as `--audit-level=high`.
//
// Changing EXEMPT, an entry's review date or this script's rules needs a new owner decision and Reviewer sign-off.
//
// To remove the exemption: delete the entry from EXEMPT (and, once nothing is exempt, this script can go back to a plain
// `npm audit --audit-level=high --ignore-scripts` in .github/workflows/ci.yml).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { npmInvocation } from './build-npm-package.mjs'

/** Owner decision 2026-11-17. Exactly one advisory; nothing else may be added without a new owner decision. */
export const EXEMPT = [
  {
    id: 'GHSA-fc5q-39xc-vjpf',
    package: 'picomatch',
    reason:
      'picomatch ReDoS (single-branch repeated extglobs): no patched release exists (4.0.7 is the latest); reachable only through dev and build dependencies (npm audit --omit=dev reports 0 vulnerabilities)',
    added: '2026-11-17',
    review: '2026-12-17'
  }
]

const FAILING = new Set(['high', 'critical'])
const SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical'])
/** The real `npm audit --json` report gives url "https://github.com/advisories/<id>". */
const ADVISORY_BASE = 'https://github.com/advisories/'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 'YYYY-MM-DD' that is a real calendar date, else null. */
function validDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null
}

function isoDay(today) {
  if (today instanceof Date) return Number.isNaN(today.getTime()) ? null : today.toISOString().slice(0, 10)
  return validDay(today)
}

/** True when this advisory object (a `via` entry under package `key`) is exactly the exempt entry's advisory. */
function matchesEntry(adv, key, entry) {
  if (!isObj(adv) || adv.name !== entry.package || key !== entry.package) return false
  return adv.url === `${ADVISORY_BASE}${entry.id}`
}

/**
 * Pure decision. `report` is the parsed `npm audit --json` output, `exempt` the list of entries, `today` a Date or
 * 'YYYY-MM-DD'. Returns { ok, exempted, failures, expired }:
 *   exempted: [{ id, package, reason, review, dependents }] for entries that explained at least one finding
 *   failures: strings, one per problem (non-exempt high/critical package, malformed report, bad date)
 *   expired:  entries whose review date has passed (they are NOT applied, and make ok false)
 *
 * Rule: a package with severity high/critical is exempt only if, over the package and every package reachable through
 * its `via` strings, at least one advisory object is an exempt entry's advisory (exact url, name equal to the package key
 * and the entry's package), no other high/critical advisory object exists, and every `via` string names a package
 * present in the report. Severities must be exactly info/low/moderate/high/critical. metadata must agree with the report
 * (high + critical count, a non-zero dev dependency count).
 */
export function evaluateAudit(report, exempt, today) {
  const failures = []
  const result = (extra = {}) => ({ ok: false, exempted: [], failures, expired: [], ...extra })
  const day = isoDay(today)
  if (!day) return result({ failures: ['invalid date passed to the audit gate'] })
  if (!isObj(report)) return result({ failures: ['audit report is not a JSON object'] })
  if (report.error !== undefined) {
    const e = isObj(report.error) ? `${report.error.code ?? ''} ${report.error.summary ?? ''}`.trim() : String(report.error)
    return result({ failures: [`npm audit reported an error: ${e || 'unknown'}`] })
  }
  const vulns = report.vulnerabilities
  if (!isObj(vulns)) return result({ failures: ['audit report has no "vulnerabilities" object'] })
  for (const [name, v] of Object.entries(vulns)) {
    if (!isObj(v) || !Array.isArray(v.via)) return result({ failures: [`audit report entry for ${name} is malformed`] })
    if (!SEVERITIES.has(v.severity)) return result({ failures: [`audit report entry for ${name} has an unknown severity`] })
    for (const via of v.via) {
      if (isObj(via) && !SEVERITIES.has(via.severity)) {
        return result({ failures: [`audit report entry for ${name} has an advisory with an unknown severity`] })
      }
    }
  }
  const meta = report.metadata
  const counts = isObj(meta) && isObj(meta.vulnerabilities) ? meta.vulnerabilities : null
  if (!counts || !Number.isInteger(counts.high) || !Number.isInteger(counts.critical)) {
    return result({ failures: ['audit report has no usable metadata.vulnerabilities'] })
  }
  const highCount = Object.values(vulns).filter((v) => FAILING.has(v.severity)).length
  if (counts.high + counts.critical !== highCount) {
    return result({ failures: [`audit metadata counts ${counts.high + counts.critical} high/critical but the report lists ${highCount}`] })
  }
  const dev = isObj(meta.dependencies) ? meta.dependencies.dev : undefined
  if (!Number.isInteger(dev) || dev <= 0) {
    return result({ failures: ['audit report covers no dev dependencies (metadata.dependencies.dev is 0 or missing)'] })
  }
  if (!Array.isArray(exempt)) return result({ failures: ['exempt list is not an array'] })
  for (const e of exempt) {
    if (!isObj(e) || !validDay(e.review) || !validDay(e.added)) {
      return result({ failures: ['an exempt entry has a missing or invalid added/review date'] })
    }
  }

  const expired = exempt.filter((e) => day > e.review)
  const active = exempt.filter((e) => !expired.includes(e))
  const used = new Map(active.map((e) => [e, new Set()]))

  /** Advisory/dependency problems for `name`, walking via strings (cycle-safe: each package is visited once). */
  function explain(name) {
    const seen = new Set()
    const stack = [name]
    const hits = new Set()
    let bad = null
    while (stack.length) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      const v = vulns[cur]
      if (!v) {
        bad ??= `${cur} (named in a via chain but missing from the report)`
        continue
      }
      for (const via of v.via) {
        if (typeof via === 'string') stack.push(via)
        else if (isObj(via)) {
          if (!FAILING.has(via.severity)) continue
          const entry = active.find((e) => matchesEntry(via, cur, e))
          if (entry) hits.add(entry)
          else bad ??= `${cur}: ${via.url ?? via.title ?? 'unnamed advisory'} (${via.severity})`
        } else bad ??= `${cur}: unreadable via entry`
      }
    }
    return { bad, hits }
  }

  for (const [name, v] of Object.entries(vulns)) {
    if (!FAILING.has(v.severity)) continue
    const { bad, hits } = explain(name)
    if (bad) failures.push(`${name} (${v.severity}): not covered by an exemption, caused by ${bad}`)
    else if (hits.size === 0) failures.push(`${name} (${v.severity}): no exempt advisory in its chain explains it`)
    else for (const e of hits) if (name !== e.package) used.get(e).add(name)
  }

  const exempted = []
  for (const [e, dependents] of used) {
    const direct = FAILING.has(vulns[e.package]?.severity)
    if (direct || dependents.size) {
      exempted.push({ id: e.id, package: e.package, reason: e.reason, review: e.review, dependents: dependents.size })
    }
  }
  return { ok: failures.length === 0 && expired.length === 0, exempted, failures, expired }
}

function runNpmAudit() {
  const npm = npmInvocation(process.env, process.execPath, process.platform)
  const r = spawnSync(npm.command, [...npm.prefix, 'audit', '--json', '--ignore-scripts', '--include=dev'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
    windowsHide: true,
    shell: false
  })
  return r
}

export function main(today = new Date()) {
  const r = runNpmAudit()
  if (r.error) return fail(`could not run npm audit: ${r.error.message}`)
  // npm audit exits 0 (clean) or 1 (findings); anything else is an unexpected failure.
  if (r.status !== 0 && r.status !== 1) return fail(`npm audit exited with ${r.status ?? r.signal}: ${(r.stderr || '').slice(0, 500)}`)
  let report
  try {
    report = JSON.parse(r.stdout)
  } catch {
    return fail(`npm audit did not print JSON (exit ${r.status}): ${(r.stdout || r.stderr || '').slice(0, 300)}`)
  }
  const res = evaluateAudit(report, EXEMPT, today)
  for (const e of res.exempted) {
    console.log(`audit-gate: EXEMPT ${e.id} on ${e.package} (${e.dependents} dependent package${e.dependents === 1 ? '' : 's'}); review by ${e.review}. ${e.reason}`)
  }
  for (const e of res.expired) {
    console.error(`audit-gate: the exemption ${e.id} expired (review date ${e.review}). It must be re-decided by the owner: renew it in scripts/audit-gate.mjs or remove it.`)
  }
  for (const f of res.failures) console.error(`audit-gate: FAIL ${f}`)
  if (!res.ok) return 1
  console.log('audit-gate: ok (no high or critical finding outside the exemption)')
  return 0
}

function fail(msg) {
  console.error(`audit-gate: FAIL ${msg}`)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main())
}
