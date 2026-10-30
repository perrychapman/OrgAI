import { TOOL_CATALOG, type ToolName } from '@shared/types'

/**
 * Tools given when a file lists none: read-only. A definition never gets Bash, Edit or Write (or spawning) without
 * naming them, even where the other harness reads a missing list as "all tools".
 */
export const DEFAULT_IMPORT_TOOLS: readonly ToolName[] = ['Read', 'Glob', 'Grep']

const TABLE: Record<string, ToolName[]> = {
  read: ['Read'],
  read_file: ['Read'],
  read_many_files: ['Read'],
  fs_read: ['Read'],
  view: ['Read'],
  edit: ['Edit', 'Write'],
  multiedit: ['Edit'],
  replace: ['Edit'],
  patch: ['Edit', 'Write'],
  write: ['Write'],
  write_file: ['Write'],
  fs_write: ['Edit', 'Write'],
  grep: ['Grep'],
  search_file_content: ['Grep'],
  search: ['Grep', 'Glob'],
  glob: ['Glob'],
  list_directory: ['Glob'],
  ls: ['Glob'],
  list: ['Glob'],
  bash: ['Bash'],
  shell: ['Bash'],
  execute: ['Bash'],
  run_shell_command: ['Bash'],
  execute_bash: ['Bash'],
  command: ['Bash'],
  webfetch: ['WebFetch'],
  web_fetch: ['WebFetch'],
  web: ['WebFetch', 'WebSearch'],
  websearch: ['WebSearch'],
  web_search: ['WebSearch'],
  google_web_search: ['WebSearch'],
  todowrite: ['TodoWrite'],
  todo: ['TodoWrite'],
  notebookedit: ['NotebookEdit'],
  sendmessage: ['SendMessage'],
  listagents: ['ListAgents']
}

const SPAWN_NAMES = new Set(['agent', 'task', 'custom-agent', 'custom_agent', 'subagent'])

/** The tool name without a Claude permission pattern: `Bash(git:*)` -> `Bash`. */
function baseName(name: string): string {
  const t = name.trim()
  const i = t.indexOf('(')
  return (i > 0 ? t.slice(0, i) : t).trim()
}

interface One {
  tools: ToolName[]
  spawn: boolean
  known: boolean
}

function mapOne(name: string): One {
  const base = baseName(name).toLowerCase()
  if (!base || base.startsWith('mcp__')) return { tools: [], spawn: false, known: false }
  if (SPAWN_NAMES.has(base)) return { tools: [], spawn: true, known: true }
  // Own keys only: repo-controlled names such as "constructor" or "__proto__" must not reach Object.prototype.
  const hit = Object.hasOwn(TABLE, base) ? TABLE[base] : undefined
  return hit ? { tools: hit, spawn: false, known: true } : { tools: [], spawn: false, known: false }
}

export function mapTools(raw: string[] | undefined, denied?: string[]): { tools: ToolName[]; dropped: string[]; canSpawn: boolean } {
  const set = new Set<ToolName>()
  const dropped: string[] = []
  let canSpawn = false
  if (raw === undefined) {
    for (const t of DEFAULT_IMPORT_TOOLS) set.add(t)
  } else {
    for (const name of raw) {
      if (typeof name !== 'string' || !name.trim()) continue
      const one = mapOne(name)
      if (!one.known) {
        if (!dropped.includes(name.trim())) dropped.push(name.trim())
        continue
      }
      if (one.spawn) canSpawn = true
      for (const t of one.tools) set.add(t)
    }
  }
  for (const name of denied ?? []) {
    if (typeof name !== 'string') continue
    const one = mapOne(name)
    if (one.spawn) canSpawn = false
    for (const t of one.tools) set.delete(t)
  }
  return { tools: TOOL_CATALOG.filter((t) => set.has(t)), dropped, canSpawn }
}

/** Roo Code groups (`'read'` or `['edit', { fileRegex }]`) as raw tool names for mapTools. `mcp` and unknown groups give nothing. */
export function rooGroupTools(groups: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(groups)) return out
  for (const g of groups) {
    const name = Array.isArray(g) ? g[0] : g
    if (typeof name !== 'string') continue
    switch (name.trim().toLowerCase()) {
      case 'read': out.push('read', 'glob', 'grep'); break
      case 'edit': out.push('edit', 'write'); break
      case 'command': out.push('bash'); break
      case 'browser': out.push('webfetch'); break
      default: break
    }
  }
  return out
}
