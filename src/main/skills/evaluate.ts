import type { Role, RunRecord, RunSummary, SkillFinding, SkillInfo, TranscriptEntry } from '@shared/types'
import { digestKey, digestRun, isRunDigest, type RunDigest } from '../store/runDigest'
import { jaccard, tokenSet } from './tokens'

export { jaccard, tokenSet }

/**
 * Pure, deterministic skill checks for skills:evaluate. Linear in the input (the overlap check is quadratic over at
 * most SKILL_MAX_PER_PROJECT skills). No fs: path probing goes through the injected `pathExists`. Everything read
 * from transcripts and SKILL.md is untrusted text and is only ever compared, counted or quoted, never executed.
 *
 * The run-derived checks (repeated tool sequences, repeated corrections) read per-run digests (store/runDigest.ts,
 * cached beside each record by RunStore.getDigest), so a pass parses no record twice. A run given as a summary and a
 * transcript is digested first (`evalDigest`), so there is one implementation. The Team review's evidence
 * (capabilities/evidence.ts) calls the same `gapFindings`.
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
export const MAX_GAP_FINDINGS = 5
/**
 * Corrections: similarity to join a group, runs a group must span, candidates overall. (Per run: at most 50, their
 * text length and the excerpt length are fixed when the run is digested, runDigest.ts.)
 */
export const CORRECTION_SIMILARITY = 0.5
export const CORRECTION_MIN_RUNS = 2
const MAX_CORRECTIONS_TOTAL = 400

export interface EvalSkill {
  info: SkillInfo
  /** The whole SKILL.md text ('' when it could not be read). */
  skillMd: string
}
export interface EvalRun {
  summary: RunSummary
  transcript: TranscriptEntry[]
}
/** A run as the checks read it: a digest (what the host passes) or a summary with its transcript (digested here). */
export type EvalRunInput = EvalRun | RunDigest
export interface EvalInput {
  roles: Pick<Role, 'id' | 'skills'>[]
  skills: EvalSkill[]
  runs: EvalRunInput[]
  /** Project-relative, '/'-separated, already screened (no absolute or '..' paths). Must not throw. */
  pathExists(relPath: string): boolean
}

/** The digest of a run given as a digest or as a summary and transcript. */
export function evalDigest(r: EvalRunInput): RunDigest {
  if (isRunDigest(r)) return r
  return digestRun({ summary: r.summary, transcript: r.transcript, agents: {}, logs: [] } as RunRecord)
}

const GENERIC = new Set(['helper', 'helpers', 'utility', 'utilities', 'stuff', 'various', 'misc', 'miscellaneous', 'things', 'thing', 'general', 'common', 'tasks', 'task', 'tool', 'tools', 'etc', 'work', 'help'])
/** A "when to use" cue. Bare "for" is not one: "helper for misc stuff" says nothing about when. */
const TRIGGER = /\b(?:when|whenever|use|used|using|if|before|after|while|during|once)\b/i

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
  const runs = input.runs.map(evalDigest)
  // Skill ids are compared as a digest holds them (digestKey: as written when plain, else a hash).
  const loads = new Map<string, number>()
  for (const run of runs) for (const u of run.skillLoads) loads.set(u.skillId, (loads.get(u.skillId) ?? 0) + u.loads)

  for (const { info, skillMd } of input.skills) {
    const spec = info.spec
    const isGranted = granted.has(spec.id) || info.grantedTo.length > 0
    if (info.libraryMissing) {
      push({ kind: 'libraryMissing', severity: 'warning', skillIds: [spec.id], title: `${spec.name} lost its library entry`, detail: 'The linked library skill no longer exists, so runs no longer get this skill. Relink it or remove it.' })
    }
    if (spec.enabled && !isGranted) {
      push({ kind: 'neverGranted', severity: 'info', skillIds: [spec.id], title: `${spec.name} is not granted to any role`, detail: 'No role may load this skill, so no agent ever uses it. Grant it to a role or remove it.' })
    }
    if (spec.enabled && isGranted && !info.libraryMissing && runs.length >= MIN_RUNS_FOR_NEVER_LOADED && !(loads.get(digestKey(spec.id)) ?? 0)) {
      push({ kind: 'neverLoaded', severity: 'info', skillIds: [spec.id], title: `${spec.name} was never loaded`, detail: `Granted to a role but not loaded in the last ${runs.length} runs. Its description may not match the work, or it may not be needed.`, evidence: { runIds: runs.map((r) => r.summary.id) } })
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

export function toolSequenceFindings(runs: readonly EvalRunInput[]): SkillFinding[] {
  const byWindow = new Map<string, { names: string[]; runIds: string[] }>()
  for (const raw of runs) {
    const run = evalDigest(raw)
    const seen = new Set<string>()
    // Each agent's calls in order (names as a digest holds them); a window with two or more distinct names counts once per run.
    for (const seq of run.toolSequences) {
      const names = seq.map((i) => run.toolNames[i] ?? '')
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

export function correctionFindings(runs: readonly EvalRunInput[]): SkillFinding[] {
  interface Cand {
    runId: string
    /** The digest's excerpt: redacted, at most 160 characters. */
    text: string
    /** Hashed words: Jaccard over them equals Jaccard over the words. */
    tokens: Set<string>
  }
  const cands: Cand[] = []
  for (const raw of runs) {
    const run = evalDigest(raw)
    for (const c of run.corrections) {
      if (cands.length >= MAX_CORRECTIONS_TOTAL) break
      cands.push({ runId: run.summary.id, text: c.excerpt, tokens: new Set(c.tokens) })
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
      detail: `Users said things like: "${g.rep.text}". A skill could carry this guidance so it need not be repeated.`,
      // count only when it adds a fact (more mentions than runs); equal, it would repeat the title's run count.
      evidence: g.members.length > runIds.length ? { runIds, count: g.members.length } : { runIds }
    }))
}

/** The skill gaps of a set of runs: repeated tool sequences, then repeated corrections. The Team review's evidence reuses it. */
export function gapFindings(runs: readonly EvalRunInput[]): SkillFinding[] {
  const digests = runs.map(evalDigest)
  return [...toolSequenceFindings(digests), ...correctionFindings(digests)]
}

export function evaluateSkills(input: EvalInput): { quality: SkillFinding[]; gaps: SkillFinding[] } {
  const runs = input.runs.map(evalDigest)
  return { quality: qualityFindings({ ...input, runs }), gaps: gapFindings(runs) }
}
