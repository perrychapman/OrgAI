import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { AGENT_IMPORT_SOURCES, AGENT_IMPORT_SOURCE_LABELS, type AgentImportSource, type AgentImportSourceSummary } from '@shared/types'
import {
  parseClaudeAgent,
  parseCodexAgent,
  parseCopilotAgent,
  parseGeminiAgent,
  parseKiroAgent,
  parseOpencodeAgentMd,
  parseOpencodeConfig,
  parseOrgExport,
  parseRooModes
} from './parsers'
import { IMPORT_LIMITS, type ImportedAgent, type ImportScanResult, type ParseResult } from './types'

/**
 * Finds agent definition files in a project folder at the known locations only (no full-repo walk). The folder is
 * untrusted: only regular files that really live inside the root are read, size and count are capped, nothing is
 * executed and there is no network or child process.
 */

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'GEMINI.md']
const AGENT_LOCATIONS = [
  '.orgai/org.json',
  '.claude/agents',
  '.opencode/agents',
  '.opencode/agent',
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
  '.codex/agents',
  '.github/agents',
  '.gemini/agents',
  '.kiro/agents',
  '.roomodes'
]
const CLAUDE_DEPTH = 4
/** Directory entries looked at in one scan (all agent folders together), so a huge folder cannot stall the main process. */
export const MAX_VISITED_ENTRIES = 5000
/** Prompt files another definition may reference ({file:...}, file://). */
const PROMPT_FILE = /\.(md|txt|prompt)$/i

export function importKey(agent: ImportedAgent): string {
  return `${agent.source}:${agent.file}#${agent.name}`
}

/** Which known agent definition locations exist in a folder (cheap existence check, for the repo profiler). */
export function agentDefinitionLocations(root: string): string[] {
  try {
    return AGENT_LOCATIONS.filter((loc) => existsSync(join(root, ...loc.split('/'))))
  } catch {
    return []
  }
}

/**
 * Whether a path relative to the root goes through a .git folder. Windows ignores trailing dots and spaces
 * (`.git.`, `.git `) and may answer to the 8.3 short name (`GIT~1`), so those count too.
 */
export function inGitDir(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => {
    let end = seg.length
    while (end > 0 && (seg[end - 1] === '.' || seg[end - 1] === ' ')) end--
    const s = seg.slice(0, end).toLowerCase()
    return s === '.git' || s === 'git~1'
  })
}

/** Whether `target` (a real path) lies inside `rootReal`. */
function isInside(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + sep)
}

interface Found {
  rel: string
  real: string
}

class Scanner {
  readonly warnings: string[] = []
  private filesCounted = 0
  private limitWarned = false
  private visited = 0
  private visitWarned = false
  constructor(readonly rootReal: string) {}

  /** The real path of `abs` when it exists and stays inside the root, else null (with a warning for an escape). */
  resolveInside(abs: string, rel: string, warn = true): string | null {
    let real: string
    try {
      real = realpathSync(abs)
    } catch {
      return null
    }
    if (!isInside(this.rootReal, real)) {
      if (warn) this.warnings.push(`${rel}: points outside the project folder, skipped`)
      return null
    }
    // Never read git internals, even through a link that lands in .git.
    if (inGitDir(relative(this.rootReal, real))) {
      if (warn) this.warnings.push(`${rel}: points into .git, skipped`)
      return null
    }
    return real
  }

  entry(rel: string): Found | null {
    const abs = join(this.rootReal, ...rel.split('/'))
    try {
      lstatSync(abs)
    } catch {
      return null
    }
    const real = this.resolveInside(abs, rel)
    return real ? { rel, real } : null
  }

  fileAt(rel: string): Found | null {
    const e = this.entry(rel)
    if (!e) return null
    try {
      return statSync(e.real).isFile() ? e : null
    } catch {
      return null
    }
  }

  /** Files of a directory (optionally recursive) whose name matches. Sorted by relative path. */
  listFiles(relDir: string, match: (name: string) => boolean, maxDepth = 0): Found[] {
    const out: Found[] = []
    const seen = new Set<string>()
    const walk = (rel: string, depth: number): void => {
      const dir = this.entry(rel)
      if (!dir) return
      let isDir = false
      try {
        isDir = statSync(dir.real).isDirectory()
      } catch {
        return
      }
      if (!isDir || seen.has(dir.real)) return
      seen.add(dir.real)
      let names: string[]
      try {
        names = readdirSync(dir.real)
      } catch (err) {
        this.warnings.push(`${rel}: could not be read (${err instanceof Error ? err.message : 'error'})`)
        return
      }
      names.sort()
      for (const name of names) {
        if (++this.visited > MAX_VISITED_ENTRIES) {
          if (!this.visitWarned) {
            this.visitWarned = true
            this.warnings.push(`More than ${MAX_VISITED_ENTRIES} entries in the agent folders: the rest were not looked at (first skipped: ${rel}/${name})`)
          }
          return
        }
        const childRel = `${rel}/${name}`
        const child = this.entry(childRel)
        if (!child) continue
        let st
        try {
          st = statSync(child.real)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          if (depth < maxDepth) walk(childRel, depth + 1)
        } else if (st.isFile() && match(name)) out.push(child)
      }
    }
    walk(relDir, 0)
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  }

  /** Counts a file toward the cap. False (with one warning) once the cap is reached. */
  take(rel: string): boolean {
    if (this.filesCounted >= IMPORT_LIMITS.maxFiles) {
      if (!this.limitWarned) {
        this.limitWarned = true
        this.warnings.push(`File limit of ${IMPORT_LIMITS.maxFiles} reached: remaining files were skipped (first skipped: ${rel})`)
      }
      return false
    }
    this.filesCounted++
    return true
  }

  /**
   * Read a regular file through one descriptor: fstat, then at most maxFileBytes + 1 bytes, so a file that grows
   * between the size check and the read still cannot exceed the cap. Returns 'big' over the cap.
   */
  private boundedRead(real: string): string | 'big' | null {
    let fd: number | undefined
    try {
      fd = openSync(real, 'r')
      const st = fstatSync(fd)
      if (!st.isFile()) return null
      if (st.size > IMPORT_LIMITS.maxFileBytes) return 'big'
      const buf = Buffer.alloc(IMPORT_LIMITS.maxFileBytes + 1)
      let len = 0
      while (len < buf.length) {
        const n = readSync(fd, buf, len, buf.length - len, len)
        if (n <= 0) break
        len += n
      }
      if (len > IMPORT_LIMITS.maxFileBytes) return 'big'
      return buf.subarray(0, len).toString('utf8')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  /** Reads a counted file, applying the size cap. Null (with a warning) when skipped. */
  read(f: Found): string | null {
    if (!this.take(f.rel)) return null
    try {
      const text = this.boundedRead(f.real)
      if (text === 'big') {
        this.warnings.push(`${f.rel}: over the ${IMPORT_LIMITS.maxFileBytes / 1024} KB limit, skipped`)
        return null
      }
      return text
    } catch (err) {
      this.warnings.push(`${f.rel}: could not be read (${err instanceof Error ? err.message : 'error'})`)
      return null
    }
  }

  private relativeCache = new Map<string, string | null>()

  /**
   * Reads a prompt file referenced from another file (opencode `{file:...}`, Kiro `file://`), confined to the
   * root: only .md, .txt and .prompt files outside .git, counted toward maxFiles, read once per real path.
   * Null on any failure.
   */
  readRelativeTo(fromRel: string, relPath: string): string | null {
    try {
      const p = relPath.replace(/\\/g, '/')
      if (!p || isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('/') || p.startsWith('~')) return null
      if (!PROMPT_FILE.test(p)) return null
      const base = dirname(fromRel.split('/').join(sep))
      const abs = resolve(this.rootReal, base, p)
      if (!isInside(this.rootReal, abs)) return null
      const real = this.resolveInside(abs, p, false)
      if (!real) return null
      // Prompt files often live in .opencode/ or .kiro/, so dot folders are allowed, but never git internals
      // (resolveInside checks the real path; the path as written is checked too).
      if (inGitDir(relative(this.rootReal, abs)) || inGitDir(relative(this.rootReal, real))) return null
      if (this.relativeCache.has(real)) return this.relativeCache.get(real) ?? null
      if (!this.take(p)) return null
      // Regular files only, checked before open: opening a FIFO or device would block.
      if (!statSync(real).isFile()) return null
      const text = this.boundedRead(real)
      const out = text === 'big' ? null : text
      this.relativeCache.set(real, out)
      return out
    } catch {
      return null
    }
  }
}

function emptyResult(warnings: string[] = []): ImportScanResult {
  return { scan: { sources: [], instructionFiles: [], warnings }, agents: [] }
}

export function scanAgentSources(root: string, opts?: { sources?: AgentImportSource[] }): ImportScanResult {
  try {
    // A relative root would resolve against the app's cwd.
    if (typeof root !== 'string' || !isAbsolute(root)) return emptyResult()
    let rootReal: string
    try {
      rootReal = realpathSync(root)
      if (!statSync(rootReal).isDirectory()) return emptyResult()
    } catch {
      return emptyResult()
    }
    const sc = new Scanner(rootReal)
    const wanted = new Set<AgentImportSource>(opts?.sources ?? AGENT_IMPORT_SOURCES)

    const mdOf = (suffix: string) => (name: string): boolean => name.toLowerCase().endsWith(suffix)
    const filesFor: Record<AgentImportSource, () => Found[]> = {
      orgai: () => [sc.fileAt('.orgai/org.json')].filter((f): f is Found => !!f),
      claude: () => sc.listFiles('.claude/agents', mdOf('.md'), CLAUDE_DEPTH),
      opencode: () => [
        ...sc.listFiles('.opencode/agents', mdOf('.md')),
        ...sc.listFiles('.opencode/agent', mdOf('.md')),
        ...['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'].map((p) => sc.fileAt(p)).filter((f): f is Found => !!f)
      ],
      codex: () => sc.listFiles('.codex/agents', mdOf('.toml')),
      copilot: () => sc.listFiles('.github/agents', mdOf('.agent.md')),
      gemini: () => sc.listFiles('.gemini/agents', mdOf('.md')),
      kiro: () => sc.listFiles('.kiro/agents', (n) => mdOf('.json')(n) || mdOf('.md')(n)),
      roo: () => [sc.fileAt('.roomodes')].filter((f): f is Found => !!f)
    }

    const parse = (source: AgentImportSource, f: Found, text: string): ParseResult => {
      const readRel = (p: string): string | null => sc.readRelativeTo(f.rel, p)
      switch (source) {
        case 'orgai': return parseOrgExport(text, f.rel)
        case 'claude': return parseClaudeAgent(text, f.rel)
        case 'opencode': return f.rel.toLowerCase().endsWith('.md') ? parseOpencodeAgentMd(text, f.rel) : parseOpencodeConfig(text, f.rel, readRel)
        case 'codex': return parseCodexAgent(text, f.rel)
        case 'copilot': return parseCopilotAgent(text, f.rel)
        case 'gemini': return parseGeminiAgent(text, f.rel)
        case 'kiro': return parseKiroAgent(text, f.rel, readRel)
        case 'roo': return parseRooModes(text, f.rel)
      }
    }

    const perSource: { source: AgentImportSource; files: string[]; agents: ImportedAgent[] }[] = []
    for (const source of AGENT_IMPORT_SOURCES) {
      if (!wanted.has(source)) continue
      const files: string[] = []
      const agents: ImportedAgent[] = []
      for (const f of filesFor[source]()) {
        const text = sc.read(f)
        if (text === null) continue
        files.push(f.rel)
        const r = parse(source, f, text)
        sc.warnings.push(...r.warnings)
        agents.push(...r.agents)
      }
      if (files.length) perSource.push({ source, files, agents })
    }

    // Instruction-only files: listed always, never parsed.
    const instructionFiles: string[] = []
    const instr: Found[] = INSTRUCTION_FILES.map((p) => sc.fileAt(p)).filter((f): f is Found => !!f)
    instr.push(...sc.listFiles('.cursor/rules', mdOf('.mdc')))
    for (const f of instr) if (sc.take(f.rel)) instructionFiles.push(f.rel)

    // Overall agent cap, in source order.
    let budget: number = IMPORT_LIMITS.maxAgents
    let dropped = 0
    const agents: ImportedAgent[] = []
    const sources: AgentImportSourceSummary[] = []
    for (const s of perSource) {
      const keep = s.agents.slice(0, Math.max(0, budget))
      dropped += s.agents.length - keep.length
      budget -= keep.length
      agents.push(...keep)
      sources.push({ source: s.source, label: AGENT_IMPORT_SOURCE_LABELS[s.source], files: [...s.files].sort(), agentCount: keep.length })
    }
    if (dropped > 0) sc.warnings.push(`Only the first ${IMPORT_LIMITS.maxAgents} agents are kept: ${dropped} more dropped`)

    return { scan: { sources, instructionFiles: instructionFiles.map((p) => posix.normalize(p)), warnings: sc.warnings }, agents }
  } catch (err) {
    return emptyResult([`Scan failed: ${err instanceof Error ? err.message : 'unexpected error'}`])
  }
}
