// CI dependency audit gate: `npm audit --audit-level=high` minus ONE owner-approved, time-limited exemption.
//
//   node scripts/audit-gate.mjs
//
// Runs `npm audit --json --ignore-scripts`, exits 1 when a high or critical finding remains that the exempt list below
// does not fully explain, when the exemption has expired, or when the report cannot be read (fail closed). Moderate and
// low findings never fail, the same threshold as `--audit-level=high`.
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

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function isoDay(today) {
  if (today instanceof Date) return Number.isNaN(today.getTime()) ? null : today.toISOString().slice(0, 10)
  if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)) return today
  return null
}

/** True when this advisory object (a `via` entry) is exactly the exempt entry's advisory on its package. */
function matchesEntry(adv, entry) {
  if (!isObj(adv) || adv.name !== entry.package || typeof adv.url !== 'string') return false
  return adv.url === entry.id || adv.url.endsWith(`/${entry.id}`)
}

/**
 * Pure decision. `report` is the parsed `npm audit --json` output, `exempt` the list of entries, `today` a Date or
 * 'YYYY-MM-DD'. Returns { ok, exempted, failures, expired }:
 *   exempted: [{ id, package, reason, review, dependents }] for entries that explained at least one finding
 *   failures: strings, one per problem (non-exempt high/critical package, malformed report, bad date)
 *   expired:  entries whose review date has passed (they are NOT applied, and make ok false)
 *
 * Rule: a package with severity high/critical is exempt only if, over the package and every package reachable through
 * its `via` strings, every high/critical advisory object is an exempt entry's advisory (matched by name and a url ending
 * in the GHSA id), and every `via` string names a package present in the report. Anything else fails.
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
    if (!isObj(v) || typeof v.severity !== 'string' || !Array.isArray(v.via)) {
      return result({ failures: [`audit report entry for ${name} is malformed`] })
    }
  }
  if (!Array.isArray(exempt)) return result({ failures: ['exempt list is not an array'] })

  const expired = exempt.filter((e) => typeof e.review !== 'string' || day > e.review)
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
          if (!FAILING.has(via.severity) && via.severity !== undefined) continue
          const entry = active.find((e) => matchesEntry(via, e))
          if (entry) hits.add(entry)
          else bad ??= `${cur}: ${via.url ?? via.title ?? 'unnamed advisory'} (${via.severity ?? 'unknown severity'})`
        } else bad ??= `${cur}: unreadable via entry`
      }
    }
    return { bad, hits }
  }

  for (const [name, v] of Object.entries(vulns)) {
    if (!FAILING.has(v.severity)) continue
    const { bad, hits } = explain(name)
    if (bad) failures.push(`${name} (${v.severity}): not covered by an exemption, caused by ${bad}`)
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
  const r = spawnSync(npm.command, [...npm.prefix, 'audit', '--json', '--ignore-scripts'], {
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
