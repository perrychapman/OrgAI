import type { Role, RunSummary, SkillFinding, SkillInfo, TranscriptEntry } from '@shared/types'

/**
 * Pure, deterministic skill checks for skills:evaluate. Linear in the input (the overlap check is quadratic over at
 * most SKILL_MAX_PER_PROJECT skills). No fs: path probing goes through the injected `pathExists`. Everything read
 * from transcripts and SKILL.md is untrusted text and is only ever compared, counted or quoted, never executed.
 */

/** neverLoaded needs at least this many considered runs, else it would flag skills in a young project. */
export const MIN_RUNS_FOR_NEVER_LOADED = 3
/** Descriptions with a token-set Jaccard similarity at or above this overlap. */
export const OVERLAP_THRESHOLD = 0.6
/** A description shorter than this (characters), or with fewer words (stopwords included) than VAGUE_MIN_WORDS, is vague. */
export const VAGUE_MIN_CHARS = 40
export const VAGUE_MIN_WORDS = 6
/** Share of generic words among the meaningful words at or above which a description with no "when to use" cue is vague. */
export const VAGUE_GENERIC_SHARE = 0.5
/** Stale check: most referenced paths probed per skill. */
export const MAX_STALE_PATHS = 50
/** Tool sequences: window length, the runs a window must appear in, entries read per run, findings kept. */
export const SEQUENCE_WINDOW = 4
export const SEQUENCE_MIN_RUNS = 3
export const MAX_TRANSCRIPT_ENTRIES = 5000
export const MAX_GAP_FINDINGS = 5
/** Corrections: similarity to join a group, runs a group must span, candidates per run and overall, excerpt length. */
export const CORRECTION_SIMILARITY = 0.5
export const CORRECTION_MIN_RUNS = 2
const MAX_CORRECTIONS_PER_RUN = 50
const MAX_CORRECTIONS_TOTAL = 400
const CORRECTION_TEXT_CHARS = 500
export const EXCERPT_CHARS = 160

export interface EvalSkill {
  info: SkillInfo
  /** The whole SKILL.md text ('' when it could not be read). */
  skillMd: string
}
export interface EvalRun {
  summary: RunSummary
  transcript: TranscriptEntry[]
}
export interface EvalInput {
  roles: Pick<Role, 'id' | 'skills'>[]
  skills: EvalSkill[]
  runs: EvalRun[]
  /** Project-relative, '/'-separated, already screened (no absolute or '..' paths). Must not throw. */
  pathExists(relPath: string): boolean
}

const STOPWORDS = new Set(
  ('a an the and or but of to in on for with at by from as is are was were be been it its this that these those you your we our they them their ' +
    'i me my can could should would will may might do does did done not no if then than so such into onto over under up down out about any all ' +
    'also just only more most other some each every which who whom what where how why there here has have had having use used using when whenever').split(' ')
)
const GENERIC = new Set(['helper', 'helpers', 'utility', 'utilities', 'stuff', 'various', 'misc', 'miscellaneous', 'things', 'thing', 'general', 'common', 'tasks', 'task', 'tool', 'tools', 'etc', 'work', 'help'])
/** A "when to use" cue. Bare "for" is not one: "helper for misc stuff" says nothing about when. */
const TRIGGER = /\b(?:when|whenever|use|used|using|if|before|after|while|during|once)\b/i

/** Lowercased alphanumeric words minus stopwords, as a set. */
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length > 1 && !STOPWORDS.has(w)) out.add(w)
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (large.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

const oneLine = (s: string): string => s.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g, ' ').replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * Why a description is too thin for an agent to know when to load the skill, or null. Flags only genuinely vague
 * text: under VAGUE_MIN_CHARS characters, under VAGUE_MIN_WORDS words, nothing but generic words, or mostly generic
 * words with no "when to use" cue. A specific description without a cue passes. Deterministic and linear.
 */
export function vagueReason(description: string): string | null {
  const d = description.trim()
  if (d.length < VAGUE_MIN_CHARS) return `only ${d.length} characters`
  let wordCount = 0
  for (const w of d.split(/[^\p{L}\p{N}]+/u)) if (w) wordCount++
  if (wordCount < VAGUE_MIN_WORDS) return `only ${wordCount} words`
  const words = [...tokenSet(d)]
  const generic = words.filter((w) => GENERIC.has(w)).length
  if (generic === words.length) return 'only generic words'
  if (generic / words.length >= VAGUE_GENERIC_SHARE && !TRIGGER.test(d)) return 'mostly generic words and no cue for when to use it'
  return null
}

// ---------- stale paths ----------

const WIN_DRIVE = /^[A-Za-z]:/
/** A project-relative path candidate, normalized, or null (URL, absolute, '..', glob, no '/' or no extension). */
export function relativePathCandidate(raw: string): string | null {
  let s = raw.trim().replace(/^[("'<[]+|[)"'>\].,;:!?]+$/g, '')
  s = s.replace(/[#?].*$/, '')
  if (s.startsWith('./')) s = s.slice(2)
  if (!s || s.length > 200) return null
  if (/[\s*?<>{}$|\\\u0000]/.test(s)) return null
  if (s.includes('://') || s.startsWith('/') || s.startsWith('~') || s.startsWith('@') || WIN_DRIVE.test(s) || s.includes(':')) return null
  const segs = s.split('/')
  if (segs.length < 2) return null
  if (segs.some((g) => g === '' || g === '..' || g === '.')) return null
  const last = segs[segs.length - 1]
  if (!/^[^.].*\.[A-Za-z0-9]{1,8}$/.test(last)) return null
  // "github.com/x/y.md" is a URL without scheme, not a repo path.
  if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(segs[0]) && !segs[0].startsWith('.')) return null
  return segs.join('/')
}

/** Project-relative paths a SKILL.md mentions (backticks, markdown link targets, bare tokens), deduped, at most `max`. */
export function referencedPaths(skillMd: string, ownFiles: string[], max = MAX_STALE_PATHS): string[] {
  const own = new Set(ownFiles.map((f) => f.toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string): void => {
    if (out.length >= max) return
    const p = relativePathCandidate(raw)
    if (!p || seen.has(p)) return
    seen.add(p)
    if (own.has(p.toLowerCase())) return
    out.push(p)
  }
  for (const line of skillMd.split(/\r?\n/)) {
    if (out.length >= max) break
    if (line.length > 4000) continue
    for (const m of line.matchAll(/`([^`]{1,200})`/g)) add(m[1])
    for (const m of line.matchAll(/\]\(([^)\s]{1,200})\)/g)) add(m[1])
    for (const tok of line.split(/\s+/)) if (tok.includes('/') && !tok.includes('](')) add(tok)
  }
  return out
}

// ---------- quality ----------

export function qualityFindings(input: EvalInput): SkillFinding[] {
  const findings: SkillFinding[] = []
  const counters = new Map<string, number>()
  const push = (f: Omit<SkillFinding, 'id'>): void => {
    const n = counters.get(f.kind) ?? 0
    counters.set(f.kind, n + 1)
    findings.push({ id: `${f.kind}-${n + 1}`, ...f })
  }
  const granted = new Set<string>()
  for (const r of input.roles) for (const id of r.skills ?? []) granted.add(id)
  const loads = new Map<string, number>()
  for (const run of input.runs) for (const u of run.summary.usage?.skills ?? []) loads.set(u.skillId, (loads.get(u.skillId) ?? 0) + u.loads)

  for (const { info, skillMd } of input.skills) {
    const spec = info.spec
    const isGranted = granted.has(spec.id) || info.grantedTo.length > 0
    if (info.libraryMissing) {
      push({ kind: 'libraryMissing', severity: 'warning', skillIds: [spec.id], title: `${spec.name} lost its library entry`, detail: 'The linked library skill no longer exists, so runs no longer get this skill. Relink it or remove it.' })
    }
    if (spec.enabled && !isGranted) {
      push({ kind: 'neverGranted', severity: 'info', skillIds: [spec.id], title: `${spec.name} is not granted to any role`, detail: 'No role may load this skill, so no agent ever uses it. Grant it to a role or remove it.' })
    }
    if (spec.enabled && isGranted && !info.libraryMissing && input.runs.length >= MIN_RUNS_FOR_NEVER_LOADED && !(loads.get(spec.id) ?? 0)) {
      push({ kind: 'neverLoaded', severity: 'info', skillIds: [spec.id], title: `${spec.name} was never loaded`, detail: `Granted to a role but not loaded in the last ${input.runs.length} runs. Its description may not match the work, or it may not be needed.`, evidence: { runIds: input.runs.map((r) => r.summary.id) } })
    }
    const vague = vagueReason(spec.description)
    if (vague) {
      push({ kind: 'vagueDescription', severity: 'warning', skillIds: [spec.id], title: `${spec.name} has a vague description`, detail: `The description is too thin for an agent to know when to load the skill (${vague}). Say what it does and when to use it.` })
    }
    if (skillMd) {
      const paths = referencedPaths(skillMd, spec.files.map((f) => f.path))
      const missing = paths.filter((p) => {
        try {
          return !input.pathExists(p)
        } catch {
          return false
        }
      })
      if (missing.length) {
        push({ kind: 'stale', severity: 'warning', skillIds: [spec.id], title: `${spec.name} mentions ${missing.length} missing ${missing.length === 1 ? 'path' : 'paths'}`, detail: 'SKILL.md refers to files that are not in the project any more. Update the skill.', evidence: { paths: missing } })
      }
    }
  }

  const sets = input.skills.map((s) => tokenSet(s.info.spec.description))
  for (let i = 0; i < input.skills.length; i++) {
    for (let j = i + 1; j < input.skills.length; j++) {
      const sim = jaccard(sets[i], sets[j])
      if (sim >= OVERLAP_THRESHOLD) {
        const a = input.skills[i].info.spec
        const b = input.skills[j].info.spec
        push({ kind: 'overlap', severity: 'info', skillIds: [a.id, b.id], title: `${a.name} and ${b.name} overlap`, detail: 'Their descriptions are very alike, so agents may load the wrong one. Merge them or sharpen the difference.', evidence: { similarity: Math.round(sim * 100) / 100 } })
      }
    }
  }
  return findings
}

// ---------- gaps ----------

export function toolSequenceFindings(runs: EvalRun[]): SkillFinding[] {
  const byWindow = new Map<string, { names: string[]; runIds: string[] }>()
  for (const run of runs) {
    const perAgent = new Map<string, string[]>()
    const t = run.transcript
    for (let i = 0; i < t.length && i < MAX_TRANSCRIPT_ENTRIES; i++) {
      const b = t[i].block
      if (b.kind !== 'tool_use') continue
      const list = perAgent.get(t[i].agentId) ?? []
      list.push(String(b.name))
      perAgent.set(t[i].agentId, list)
    }
    const seen = new Set<string>()
    for (const names of perAgent.values()) {
      for (let i = 0; i + SEQUENCE_WINDOW <= names.length; i++) {
        const win = names.slice(i, i + SEQUENCE_WINDOW)
        if (new Set(win).size < 2) continue
        const key = win.join('\u0000')
        if (seen.has(key)) continue
        seen.add(key)
        const e = byWindow.get(key)
        if (e) e.runIds.push(run.summary.id)
        else byWindow.set(key, { names: win, runIds: [run.summary.id] })
      }
    }
  }
  return [...byWindow.entries()]
    .filter(([, e]) => e.runIds.length >= SEQUENCE_MIN_RUNS)
    .sort((a, b) => b[1].runIds.length - a[1].runIds.length || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_GAP_FINDINGS)
    .map(([, e], i) => ({
      id: `repeatedToolSequence-${i + 1}`,
      kind: 'repeatedToolSequence' as const,
      severity: 'info' as const,
      skillIds: [],
      title: `The same ${SEQUENCE_WINDOW} tool calls repeat in ${e.runIds.length} runs`,
      // The run count is stated once, in the title. No evidence.count: it would only repeat it.
      detail: `Agents ran ${e.names.join(', then ')}, in that order, each time. A skill could capture this routine.`,
      evidence: { sequence: e.names, runIds: e.runIds }
    }))
}

const CORRECTION =
  /(?:^|[\s,.;!(])(?:no[,.!]|nope|don'?t|do not|doesn'?t|didn'?t|instead|wrong|not what|again|stop|i said|as i said|remember to|always|never)(?=$|[\s,.;!?)])/i

export function correctionFindings(runs: EvalRun[]): SkillFinding[] {
  interface Cand {
    runId: string
    text: string
    tokens: Set<string>
  }
  const cands: Cand[] = []
  for (const run of runs) {
    let first = true
    let n = 0
    const t = run.transcript
    for (let i = 0; i < t.length && i < MAX_TRANSCRIPT_ENTRIES && n < MAX_CORRECTIONS_PER_RUN && cands.length < MAX_CORRECTIONS_TOTAL; i++) {
      const e = t[i]
      if (e.block.kind !== 'user' || e.source === 'harness') continue
      if (first) {
        first = false
        continue
      }
      const text = oneLine(e.block.text.slice(0, CORRECTION_TEXT_CHARS * 2))
      if (!text || !CORRECTION.test(text)) continue
      const tokens = tokenSet(text.slice(0, CORRECTION_TEXT_CHARS))
      if (tokens.size < 2) continue
      cands.push({ runId: run.summary.id, text, tokens })
      n++
    }
  }
  const groups: { rep: Cand; members: Cand[] }[] = []
  for (const c of cands) {
    const g = groups.find((x) => jaccard(x.rep.tokens, c.tokens) >= CORRECTION_SIMILARITY)
    if (g) g.members.push(c)
    else groups.push({ rep: c, members: [c] })
  }
  return groups
    .map((g) => ({ g, runIds: [...new Set(g.members.map((m) => m.runId))] }))
    .filter((x) => x.runIds.length >= CORRECTION_MIN_RUNS)
    .sort((a, b) => b.runIds.length - a.runIds.length || b.g.members.length - a.g.members.length)
    .slice(0, MAX_GAP_FINDINGS)
    .map(({ g, runIds }, i) => ({
      id: `repeatedCorrection-${i + 1}`,
      kind: 'repeatedCorrection' as const,
      severity: 'info' as const,
      skillIds: [],
      title: `The same correction came up in ${runIds.length} runs`,
      detail: `Users said things like: "${clip(g.rep.text, EXCERPT_CHARS)}". A skill could carry this guidance so it need not be repeated.`,
      // count only when it adds a fact (more mentions than runs); equal, it would repeat the title's run count.
      evidence: g.members.length > runIds.length ? { runIds, count: g.members.length } : { runIds }
    }))
}

export function evaluateSkills(input: EvalInput): { quality: SkillFinding[]; gaps: SkillFinding[] } {
  return { quality: qualityFindings(input), gaps: [...toolSequenceFindings(input.runs), ...correctionFindings(input.runs)] }
}
