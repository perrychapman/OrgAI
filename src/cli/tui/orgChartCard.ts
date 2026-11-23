/**
 * The text of an org chart card in the decision tray: the same diff the desktop card shows, as plain lines, plus the
 * notice an approved team change leaves in a live run. Pure; no React, no I/O.
 *
 * Every string the card shows comes from the host or an agent, so it is handed to the caller's formatter (`fmt`)
 * before it goes into a line: `fmt.one` for one-line values, `fmt.text` for text that may keep its line breaks.
 */
import type { OrgChartProposalPayload, Role, RunRosterChange } from '../../shared/types'
import { addedRoleLines, diffOrgChart, modelDisplay, orgDiffBase, type DiffRole, type OrgDiff } from '../../shared/view/orgDiff'

/** How the card formats untrusted text: a clipped one-line value, and text that may keep its line breaks. */
export interface OrgCardFormat {
  one(s: unknown, max?: number): string
  text(s: unknown): string
}

/** A proposed chart compared with the roles approval would change, and which roles those were. */
export interface OrgChartCardDiff {
  diff: OrgDiff<Role>
  against: 'run' | 'saved'
}

/** A role with no parent, or a parent the card cannot name. */
const NO_PARENT = 'nobody'

function proposedRoles(payload: OrgChartProposalPayload): Role[] {
  return Array.isArray(payload.roles) ? payload.roles : []
}

function baseRoles(payload: OrgChartProposalPayload, saved: readonly Role[]): readonly Role[] {
  return orgDiffBase(payload, saved)
}

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0
}

/** The name a role reports to, resolved in `all` (the chart the card reads). */
function parentName(role: DiffRole, all: readonly DiffRole[], fmt: OrgCardFormat): string {
  if (!role.reportsTo) return NO_PARENT
  const hit = all.find((r) => r.id === role.reportsTo)
  const name = hit ? fmt.one(hit.name, 60) : ''
  return name ? name : NO_PARENT
}

function modelOf(role: DiffRole): string {
  return typeof role.model === 'string' ? modelDisplay(role.model) : ''
}

/** The diff a card shows, or undefined when there is nothing to compare with (no run baseline and no saved roles). */
export function orgChartCardDiff(payload: OrgChartProposalPayload, saved: readonly Role[] | undefined): OrgChartCardDiff | undefined {
  const hasRun = Array.isArray(payload.runBaseline)
  if (!hasRun && saved === undefined) return undefined
  const diff = diffOrgChart<Role>(baseRoles(payload, saved ?? []), proposedRoles(payload))
  return { diff, against: hasRun ? 'run' : 'saved' }
}

/** "1 added, 2 changed (compared with this run's team)" — the card's first line and the tray's preview. */
export function orgChartSummaryLine(payload: OrgChartProposalPayload, saved: readonly Role[] | undefined): string | undefined {
  const d = orgChartCardDiff(payload, saved)
  if (!d) return undefined
  return `${d.diff.summary} (compared with ${d.against === 'run' ? "this run's team" : 'the saved team'})`
}

/** The card's body lines (the diff), or undefined when there is nothing to compare with. */
export function orgChartCardLines(payload: OrgChartProposalPayload, saved: readonly Role[] | undefined, full: boolean, fmt: OrgCardFormat): string[] | undefined {
  const d = orgChartCardDiff(payload, saved)
  if (!d) return undefined
  const base = baseRoles(payload, saved ?? [])
  const proposed = proposedRoles(payload)
  const out: string[] = [orgChartSummaryLine(payload, saved) ?? d.diff.summary]

  for (const r of d.diff.added) {
    const model = modelOf(r)
    out.push(`+ ${fmt.one(r.name, 60)} (reports to ${parentName(r, proposed, fmt)})${model ? `, ${fmt.one(model, 60)}` : ''}: ${full ? fmt.text(r.description) : fmt.one(r.description, 200)}`)
    for (const line of addedRoleLines(r, proposed)) out.push(`    ${fmt.text(line)}`)
    if (full) {
      for (const resp of r.responsibilities ?? []) out.push(`    * ${fmt.text(resp)}`)
      if (Array.isArray(r.tools) && r.tools.length > 0) out.push(`    Tools: ${r.tools.map((t) => fmt.one(t, 40)).join(', ')}`)
      if (typeof r.tier === 'string' && r.tier) out.push(`    Tier: ${fmt.one(r.tier, 40)}`)
      if (typeof r.effort === 'string' && r.effort) out.push(`    Effort: ${fmt.one(r.effort, 40)}`)
      if (typeof r.connection === 'string' && r.connection) out.push(`    Connection: ${fmt.one(r.connection, 60)}`)
      if (r.staffing && typeof r.staffing.mode === 'string') {
        out.push(`    Staffing: ${fmt.one(r.staffing.mode, 40)}${r.staffing.minTier ? `, from ${fmt.one(r.staffing.minTier, 40)}` : ''}${r.staffing.maxEffort ? `, up to ${fmt.one(r.staffing.maxEffort, 40)} effort` : ''}`)
      }
      if (Array.isArray(r.skills) && r.skills.length > 0) out.push(`    Skills: ${r.skills.map((t) => fmt.one(t, 40)).join(', ')}`)
      if (r.prompt) out.push('    Prompt:', ...fmt.text(r.prompt).split('\n').map((l) => `      ${l}`))
    }
  }

  for (const c of d.diff.changed) {
    const renamed = c.renamed === true && c.before.name !== c.role.name
    out.push(`~ ${fmt.one(c.role.name, 60)}${renamed ? ` (renamed from ${fmt.one(c.before.name, 60)})` : ''}`)
    for (const ch of c.changes) {
      if (ch.field === 'prompt') {
        out.push(`    prompt changed${full ? '' : ' (v shows the new text)'}`)
        const prompt = c.prompt?.after ?? c.role.prompt ?? ''
        if (full && prompt) out.push('    New prompt:', ...fmt.text(prompt).split('\n').map((l) => `      ${l}`))
        continue
      }
      if (ch.field === 'responsibilities') {
        out.push(`    responsibilities changed${full ? '' : ' (v shows them)'}`)
        if (full) {
          const now = c.responsibilities?.after ?? []
          const before = c.responsibilities?.before ?? []
          out.push('    Now:', ...(now.length > 0 ? now.map((r) => `      * ${fmt.text(r)}`) : ['      (none)']))
          out.push('    Before:', ...(before.length > 0 ? before.map((r) => `      * ${fmt.text(r)}`) : ['      (none)']))
        }
        continue
      }
      // Full shows the whole value: a long list or a text that only differs at its end reads differently on both sides.
      out.push(`    ${fmt.one(ch.label, 40)}: ${full ? fmt.text(ch.from) : fmt.one(ch.from, 300)} -> ${full ? fmt.text(ch.to) : fmt.one(ch.to, 300)}`)
    }
  }

  for (const r of d.diff.removed) {
    out.push(`- ${fmt.one(r.name, 60)} (was reporting to ${parentName(r, base, fmt)})`)
  }

  const kept = d.diff.unchanged
  if (kept.length > 0) {
    const head = `${kept.length} ${kept.length === 1 ? 'role' : 'roles'} unchanged`
    out.push(full ? `${head}: ${kept.map((r) => fmt.one(r.name, 60)).join(', ')}` : head)
  }

  const why = typeof payload.rationale === 'string' && payload.rationale.trim() !== '' ? payload.rationale : ''
  if (why) out.push(`Why: ${fmt.text(why)}`)
  return out
}

/**
 * One short line per role the card changes, for the tray's compact card: "+ QA", "~ Dev: tools, connection", "- Ops"
 * (added, then changed with the names of the fields that change, then removed). At most `max` lines: when there are
 * more, the last line says how many are left and that v shows them all. Undefined when there is nothing to compare with.
 */
export function orgChartRoleLines(payload: OrgChartProposalPayload, saved: readonly Role[] | undefined, fmt: OrgCardFormat, max = 6): string[] | undefined {
  const d = orgChartCardDiff(payload, saved)
  if (!d) return undefined
  const out: string[] = []
  for (const r of d.diff.added) out.push(`+ ${fmt.one(r.name, 60)}`)
  for (const c of d.diff.changed) {
    const renamed = c.renamed === true && c.before.name !== c.role.name
    const fields = c.changes.map((ch) => fmt.one(ch.label, 40)).join(', ')
    out.push(`~ ${fmt.one(c.role.name, 60)}${renamed ? ` (renamed from ${fmt.one(c.before.name, 60)})` : ''}: ${fields}`)
  }
  for (const r of d.diff.removed) out.push(`- ${fmt.one(r.name, 60)}`)
  if (out.length <= max) return out
  const shown = out.slice(0, Math.max(0, max - 1))
  shown.push(`+${out.length - shown.length} more (v shows all)`)
  return shown
}

/** Whether approving this card changes the team of the run that shows it (so approval asks first). */
export function orgChartAppliesNow(proposal: { kind: string; effect?: string; payload?: unknown }): boolean {
  if (proposal.kind !== 'orgChart') return false
  if (proposal.effect !== 'now' && proposal.effect !== 'after-turn') return false
  const payload = proposal.payload as { runBaseline?: unknown } | undefined
  return !!payload && Array.isArray(payload.runBaseline)
}

/**
 * The status notice after an approved team change reached a live run (`run.roster`). A run that is not on screen is
 * named by its tag (`who`, e.g. "R2"); without it the notice says "this run". Host text: the caller sanitizes it.
 */
export function rosterNotice(change: RunRosterChange, who?: string): { text: string; tone: 'ok' | 'warn' } | undefined {
  if (!change) return undefined
  const added = count(change.added)
  const changed = count(change.changed)
  const removed = count(change.removed)
  const deferred = Array.isArray(change.deferred) ? change.deferred : []
  if (added + changed + removed === 0 && deferred.length === 0) return undefined

  const parts: string[] = []
  if (added > 0) parts.push(`${added} ${added === 1 ? 'role' : 'roles'} added`)
  if (changed > 0) parts.push(`${changed} changed`)
  if (removed > 0) parts.push(`${removed} removed`)

  // Nothing moved and something waits: say that, not an empty list of changes.
  let text = parts.length > 0 ? `The team of ${who ?? 'this run'} changed: ${parts.join(', ')}.` : `The team of ${who ?? 'this run'} did not change.`
  if (deferred.length > 0) {
    const first = deferred[0] as { name?: unknown; reason?: unknown } | undefined
    const name = typeof first?.name === 'string' ? first.name : ''
    const reason = typeof first?.reason === 'string' ? first.reason.trim() : ''
    const sentence = reason === '' ? '' : /[.!?]$/.test(reason) ? reason : `${reason}.`
    text += ` ${deferred.length} ${deferred.length === 1 ? 'waits' : 'wait'} for the next run: ${name}${sentence ? `: ${sentence}` : ''}`
  }
  return { text, tone: deferred.length > 0 ? 'warn' : 'ok' }
}
