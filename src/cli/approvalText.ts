/**
 * The words of what waits for approval (cli-parity 3.4, read-only as built): `orgai team files status`, `orgai projects
 * trust show`, the one line a run start prints while team-file changes wait, and the TUI's read-only /approvals. Pure: no host, ink or
 * electron. Every string from a repository (role names, prompts, summaries, MCP targets, file names, settings) is
 * untrusted: hidden characters are written out (showHidden), then terminal controls are removed (safe / safeLine).
 */
import { showHidden } from '../shared/view/hiddenChars'
import type { FolderConfigReview, TeamFileChange, TeamFilesStatus } from '../shared/types'
import { safe, safeLine } from './output'

/** One line of untrusted text: hidden characters shown, controls removed, whitespace folded. */
export const visibleLine = (s: unknown): string => safeLine(showHidden(String(s ?? '')))

/** Untrusted multi-line text, each line made visible. */
const visibleLines = (s: unknown): string[] => safe(showHidden(String(s ?? ''))).split('\n')

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Why approving is not offered in a terminal (cli-parity 3.4 as built). */
export const NOT_IN_TERMINAL_WHY = 'a terminal cannot yet prove that a person, not an agent, is answering'
/** Said wherever a pending change is reported. */
export const APPROVE_WHERE = `Approving is not available in the terminal yet: ${NOT_IN_TERMINAL_WHY}.`
export const TRUST_WHERE = `Allowing a folder's own config is not available in the terminal yet: ${NOT_IN_TERMINAL_WHY}.`
/** Printed by the approve-shaped subcommands (team files approve|reject|undo|commit|enable, projects trust allow|deny). */
export const NO_APPROVE_COMMAND = `Approving, rejecting, undoing or committing team-file changes, and allowing a folder's own config, are not done in the terminal: ${NOT_IN_TERMINAL_WHY}. To change the team from here, use orgai team role add, set, rm or move, which save directly. To see what waits: orgai team files status, orgai projects trust show.`

export const shortDigest = (d: string | undefined): string => (d ? d.slice(0, 12) : 'none')

/** Changes that need approval, most powerful first (the host's order). */
export const pendingChanges = (s: TeamFilesStatus): TeamFileChange[] => s.changes.filter((c) => c.needsApproval)

/** "Reviewer gains Bash." with its reason: the gate's "May spend more" leads its sentence. */
export function changeHeadline(c: TeamFileChange): string {
  const summary = visibleLine(c.summary)
  if (!c.needsApproval) return summary
  const reason = c.reason ? visibleLine(c.reason) : ''
  if (reason === 'May spend more') return `May spend more: ${summary}`
  return reason ? `${summary} (${reason})` : summary
}

/** The facts under one change: file, tools added, what an MCP server runs, scripts, secrets, reach. */
export function changeFacts(c: TeamFileChange): string[] {
  const out = [`file ${visibleLine(c.file)} · ${c.kind} ${c.action}`]
  if (c.elevatedAdded?.length) out.push(`gains ${c.elevatedAdded.map(visibleLine).join(', ')}`)
  else if (c.toolsAdded?.length) out.push(`adds tools ${c.toolsAdded.map(visibleLine).join(', ')}`)
  if (c.target) out.push(`runs ${visibleLine(c.target)}${c.usesStoredSignIn ? ' (with the sign-in stored on this computer)' : ''}`)
  if (c.secretNames?.length) out.push(`needs secrets ${c.secretNames.map(visibleLine).join(', ')}`)
  if (c.reachesRoles) out.push(`limited to ${c.reachesRoles.length ? c.reachesRoles.map(visibleLine).join(', ') : 'no role'}`)
  if (c.scripts?.length) out.push(`scripts ${c.scripts.map(visibleLine).join(', ')}`)
  return out
}

/** Who wrote it, as far as OrgAI can tell: git's view of the team files (OrgAI records no author). */
export function writtenByLine(s: TeamFilesStatus): string {
  if (!s.isGitRepo) return 'Written in a folder that is not a git repository; OrgAI does not record who edited the files.'
  if (s.uncommitted) {
    const files = s.uncommittedFiles.slice(0, 5).map(visibleLine)
    const more = s.uncommittedFiles.length > files.length ? ` and ${s.uncommittedFiles.length - files.length} more` : ''
    return `Not committed in git (edited here, by you or an agent): ${files.join(', ')}${more}.`
  }
  return 'Committed in git (it came with the repository); OrgAI does not record who edited the files.'
}

function stateWords(s: TeamFilesStatus): string {
  const n = pendingChanges(s).length
  switch (s.state) {
    case 'pending':
      return `${plural(n, 'change')} ${n === 1 ? 'waits' : 'wait'} for approval; runs use the last approved team`
    case 'problem':
      return `a team file cannot be used (${visibleLine(s.problems[0]?.file ?? '.orgai')}); runs use the last approved team`
    case 'rejected':
      return 'you rejected the files as they are; runs use the last approved team until they change'
    case 'in-sync':
      return 'in sync'
    default:
      return `off${s.offReason ? ` (${s.offReason})` : ''}`
  }
}

/** `orgai team files status` text for one project. */
export function teamFilesStatusLines(s: TeamFilesStatus): string[] {
  const out = [`${visibleLine(s.projectName)}: ${stateWords(s)}.`, `  digest ${shortDigest(s.digest)}${s.firstSeen ? ' · first time this repository\'s team is seen here' : ''}`]
  for (const p of s.problems) out.push(`  problem: ${visibleLine(p.file)}: ${visibleLine(p.message)}`)
  const pending = pendingChanges(s)
  for (const c of pending) {
    out.push(`  - ${changeHeadline(c)}`)
    for (const f of changeFacts(c)) out.push(`      ${f}`)
  }
  if (s.omittedChanges) out.push(`  ...and ${plural(s.omittedChanges, 'more change')} not listed (too many to review at once).`)
  if (s.applied.length) out.push(`  Applied at once (undo available): ${s.applied.map((c) => visibleLine(c.summary)).join(' ')}`)
  if (s.undo && s.undoChanges?.length) out.push(`  Undo would bring back: ${s.undoChanges.map((c) => visibleLine(c.summary)).join(' ')}`)
  for (const w of s.warnings) out.push(`  warning: ${visibleLine(w.file)}: ${visibleLine(w.message)}`)
  if (s.state === 'pending' || s.state === 'problem' || s.state === 'rejected') out.push(`  ${writtenByLine(s)}`)
  return out
}

/** One line for a run start (exec, resume --exec) and the TUI on open; undefined when nothing waits for this project. */
export function pendingTeamFilesLine(statuses: readonly TeamFilesStatus[], projectId?: string): string | undefined {
  const mine = statuses.filter((s) => (projectId === undefined || s.projectId === projectId) && (s.state === 'pending' || s.state === 'problem'))
  if (!mine.length) return undefined
  const n = mine.reduce((sum, s) => sum + pendingChanges(s).length, 0)
  const problem = mine.some((s) => s.state === 'problem')
  const what = n ? `${plural(n, 'team-file change')} ${n === 1 ? 'waits' : 'wait'} for approval` : 'the team files have a problem'
  const where = projectId === undefined ? ` (${mine.map((s) => visibleLine(s.projectName)).join(', ')})` : ''
  return `Team files: ${what}${problem && n ? ' (and a file has a problem)' : ''}${where}; runs use the last approved team. Review: orgai team files status (approving is not available in the terminal yet).`
}

// ---------- folder config trust ----------

const TRUST_STATE_WORDS: Record<FolderConfigReview['state'], string> = {
  none: 'not gated (no folder config was found when the project was created)',
  untrusted: 'not allowed: agents ignore it until you allow it',
  trusted: 'allowed: agents load it',
  changed: 'changed since you allowed it: agents ignore it until you allow it again'
}

/** `orgai projects trust show` text (and the TUI's folder trust body). */
export function folderTrustLines(r: FolderConfigReview, projectName: string): string[] {
  const out = [`Folder config of ${visibleLine(projectName)}: ${TRUST_STATE_WORDS[r.state]}.`, `  digest ${shortDigest(r.digest)}`]
  if (r.unreviewable) out.push(`  cannot be allowed: ${visibleLine(r.unreviewable)}`)
  if (r.truncated) out.push('  some lists or file text were cut; anything that runs is always shown in full.')
  const section = (title: string, rows: string[]): void => {
    if (!rows.length) return
    out.push(`  ${title} (${rows.length}):`)
    for (const row of rows) out.push(`    ${row}`)
  }
  section('Commands it runs', r.commands.map((c) => `${c.kind} ${visibleLine(c.label)} [${visibleLine(c.source)}]: ${visibleLine(c.command)}${c.masked ? ' (part masked)' : ''}`))
  section('MCP servers', r.mcpServers.map((m) => `${visibleLine(m.name)} [${visibleLine(m.source)}]: ${visibleLine(m.target)}${m.masked ? ' (part masked)' : ''}`))
  section('Environment', r.env.map((e) => `${visibleLine(e.name)}=${visibleLine(e.value)} [${visibleLine(e.source)}]${e.routing ? ' (redirects requests)' : ''}`))
  section('Allow rules', r.allowRules.map((a) => `${visibleLine(a.rule)} [${visibleLine(a.source)}]${a.refused ? ` (not used: ${visibleLine(a.refused)})` : ''}`))
  section('Other settings', r.otherSettings.map((o) => `${visibleLine(o.key)} = ${visibleLine(o.value)} [${visibleLine(o.source)}]`))
  section('Files', r.files.map((f) => `${visibleLine(f.path)} (${f.effect}${f.digested ? '' : ', not bound by the digest'})${f.hiddenChar ? ` hidden character ${visibleLine(f.hiddenChar)}` : ''}`))
  return out
}

// ---------- the TUI overlay body ----------

/**
 * The whole team files change list for the approval overlay: every change in full, prompts before and after; with
 * `undoChanges` (TeamFilesStatus.undoChanges from teamFiles:listAttention), what Undo would bring back, role by role.
 */
export function teamFilesDetailLines(s: TeamFilesStatus, undoChanges: readonly TeamFileChange[] = s.undoChanges ?? []): string[] {
  const out = teamFilesStatusLines(s).slice(0, 2)
  for (const p of s.problems) out.push(`problem: ${visibleLine(p.file)}: ${visibleLine(p.message)}`)
  const pending = pendingChanges(s)
  pending.forEach((c, i) => {
    out.push('', `${i + 1}. ${changeHeadline(c)}`)
    for (const f of changeFacts(c)) out.push(`   ${f}`)
    if (c.toolsBefore || c.toolsAfter) out.push(`   tools before: ${(c.toolsBefore ?? []).map(visibleLine).join(', ') || 'none'}`, `   tools after:  ${(c.toolsAfter ?? []).map(visibleLine).join(', ') || 'none'}`)
    if (c.before !== undefined) out.push('   before:', ...visibleLines(c.before).map((l) => `   | ${l}`))
    if (c.after !== undefined) out.push('   after:', ...visibleLines(c.after).map((l) => `   | ${l}`))
  })
  if (s.omittedChanges) out.push('', `...and ${plural(s.omittedChanges, 'more change')} not listed: approve is refused until fewer change at once.`)
  if (s.undo) {
    out.push('', `Undo: ${visibleLine(s.undo.label)} (rewrites ${s.undo.files.map(visibleLine).join(', ') || 'the team files'}).`)
    if (undoChanges.length) {
      out.push('Undo brings back:')
      for (const c of undoChanges) {
        out.push(`  - ${visibleLine(c.summary)}`)
        for (const f of changeFacts(c)) out.push(`      ${f}`)
        if (c.toolsBefore || c.toolsAfter) out.push(`      tools now: ${(c.toolsBefore ?? []).map(visibleLine).join(', ') || 'none'}; after undo: ${(c.toolsAfter ?? []).map(visibleLine).join(', ') || 'none'}`)
      }
    } else out.push('Undo brings back no difference OrgAI can describe.')
  }
  if (s.isGitRepo && s.uncommitted) out.push('', `Not committed: ${s.uncommittedFiles.map(visibleLine).join(', ')}.`)
  out.push('', writtenByLine(s))
  return out
}
