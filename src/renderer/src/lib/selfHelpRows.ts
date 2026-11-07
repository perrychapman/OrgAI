/**
 * Pure helpers for the self-help tools in transcripts (docs/design/ux-review-self-help-pre.md M2): app_reference calls
 * fold into one quiet row, open_in_app collapses into the harness row main writes ("Opened <path> for you"), and the
 * two propose_* calls get sentences. Consumed by TranscriptPanel like lib/knowledgeRun.ts. No I/O.
 */
import type { TranscriptEntry } from '@shared/types'
import { APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL, PROPOSE_APP_SETTINGS_TOOL, PROPOSE_PROJECT_SETTINGS_TOOL } from '@shared/types'
import { clampLabel } from './clampLabel'
import { showHidden } from './hiddenChars'
import { bareToolName } from './transcriptRows'

export const QUERY_MAX = 60

/** One folded row: the sentence, the tool it stands for, the result behind "Show output" and whether it failed. */
export interface SelfHelpRow {
  tool: 'app_reference' | 'open_in_app'
  text: string
  body?: string
  failed?: boolean
}

export interface SelfHelpCollapse {
  /** Entry ids to hide (calls and results that a row stands for). */
  hidden: Set<string>
  /** Entry id (the call, or for open_in_app the harness row) -> the row to draw instead of the default one. */
  rows: Map<string, SelfHelpRow>
  /** Call entry id -> the sentence for a call that stays a normal tool row. */
  labels: Map<string, string>
}

const OPENED_RE = /^Opened .+ for you$/

/** A model-written value as one plain line: hidden characters shown, clamped. */
function plain(value: unknown, max: number): string {
  return typeof value === 'string' ? showHidden(clampLabel(value, max)) : ''
}

/** The sentence of an app_reference call. */
export function appReferenceText(input: unknown): string {
  const i = (input ?? {}) as { action?: unknown; query?: unknown }
  if (i.action === 'status') return "Checked OrgAI's status"
  if (i.action === 'read') return "Read a section of OrgAI's reference"
  const q = plain(i.query, QUERY_MAX)
  return q ? `Looked up ${q} in OrgAI's reference` : "Looked up OrgAI's reference"
}

export const isRefusedResult = (content: string): boolean => /^\s*REFUSED:/.test(content)

/**
 * @param projectName the name of a stored project by id (for "Proposed settings for <name>"); undefined when unknown.
 */
export function collapseSelfHelp(entries: readonly TranscriptEntry[], projectName: (id: string) => string | undefined = () => undefined): SelfHelpCollapse {
  const hidden = new Set<string>()
  const rows = new Map<string, SelfHelpRow>()
  const labels = new Map<string, string>()
  const results = new Map<string, TranscriptEntry>()
  for (const e of entries) if (e.block.kind === 'tool_result') results.set(e.block.toolUseId, e)
  const claimed = new Set<string>()

  entries.forEach((e, idx) => {
    const b = e.block
    if (b.kind !== 'tool_use') return
    const tool = bareToolName(b.name)
    const res = results.get(b.id)
    const result = res && res.block.kind === 'tool_result' ? res.block : undefined
    if (tool === APP_REFERENCE_TOOL) {
      const failed = !!result && (result.isError || isRefusedResult(result.content))
      if (failed) return // the failed result keeps its own row; the call keeps its default label
      rows.set(e.id, { tool: 'app_reference', text: appReferenceText(b.input), body: result?.content.trim() || undefined })
      if (res) hidden.add(res.id)
    } else if (tool === OPEN_IN_APP_TOOL) {
      const refused = !!result && (result.isError || isRefusedResult(result.content))
      if (!refused) {
        const row = entries.slice(idx + 1).find((x) => !claimed.has(x.id) && x.source === 'harness' && x.block.kind === 'system' && OPENED_RE.test(x.block.text))
        if (row && row.block.kind === 'system') {
          claimed.add(row.id)
          hidden.add(e.id)
          if (res) hidden.add(res.id)
          rows.set(row.id, { tool: 'open_in_app', text: row.block.text })
          return
        }
        if (!result) return
      }
      labels.set(e.id, 'Tried to open a place in OrgAI')
    } else if (tool === PROPOSE_APP_SETTINGS_TOOL) {
      labels.set(e.id, 'Proposed app settings')
    } else if (tool === PROPOSE_PROJECT_SETTINGS_TOOL) {
      const id = (b.input as { projectId?: unknown } | null)?.projectId
      const name = typeof id === 'string' ? projectName(id) : undefined
      labels.set(e.id, `Proposed settings for ${name ? plain(name, 60) || 'a project' : 'a project'}`)
    }
  })
  return { hidden, rows, labels }
}
