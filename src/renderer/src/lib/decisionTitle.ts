/**
 * Decision card titles (ui-review-2.md B.7): the title is the action the user is asked to allow or answer, never the
 * agent. Every helper takes untrusted agent text, flattens it to one line, drops bidi and control characters and clips
 * it; the full text lives in the card body. Output is only ever rendered as React text.
 */

const MAX_TITLE = 120

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F‪-‮⁦-⁩]+/g

/** One line, no control or bidi override characters, clipped to `max` with an ellipsis. */
export function oneLine(s: unknown, max = MAX_TITLE): string {
  const t = (typeof s === 'string' ? s : '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t
}

/** The last path segment, for either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** "Run npm test", "Edit server.js", "Write notes.md", "Read a.ts", "Use <tool>". */
export function permissionTitle(toolName: string, input: unknown): string {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const file = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path)
  switch (toolName) {
    case 'Bash': {
      const cmd = str(o.command)
      const first = cmd?.split(/\r?\n/).find((l) => l.trim()) ?? ''
      return first ? oneLine(`Run ${first}`) : 'Run a shell command'
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? oneLine(`Edit ${baseName(file)}`) : `Use ${oneLine(toolName, 40)}`
    case 'Write':
      return file ? oneLine(`Write ${baseName(file)}`) : `Use ${oneLine(toolName, 40)}`
    case 'Read':
      return file ? oneLine(`Read ${baseName(file)}`) : `Use ${oneLine(toolName, 40)}`
    case 'WebFetch': {
      const url = str(o.url)
      return url ? oneLine(`Fetch ${hostOf(url)}`) : 'Fetch a web page'
    }
    case 'WebSearch': {
      const q = str(o.query)
      return q ? oneLine(`Search the web: ${q}`) : 'Search the web'
    }
    default:
      return `Use ${oneLine(toolName, 60) || 'a tool'}`
  }
}

/** "Answer: <question>". */
export function questionTitle(question: string): string {
  return oneLine(`Answer: ${question}`)
}

/** "Allow <rule>" for one rule, "Allow N rules" otherwise. */
export function rulesTitle(rules: readonly string[]): string {
  if (rules.length === 1) return oneLine(`Allow ${rules[0]}`)
  return `Allow ${rules.length} rules`
}

/** "Approve architecture proposal". `label` is the proposal kind label. */
export function proposalTitle(label: string): string {
  return oneLine(`Approve ${label.toLowerCase()} proposal`)
}

/** "Merge engineer-1's changes". */
export function mergeTitle(agentName: string): string {
  return oneLine(`Merge ${agentName}'s changes`)
}

/** "Install <server>". */
export function installTitle(serverName: string): string {
  return oneLine(`Install ${serverName}`)
}
