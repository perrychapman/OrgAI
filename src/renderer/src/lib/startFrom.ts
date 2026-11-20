/** Pure content of the Team header's "Start from" menu (docs/design/team-tab-overhaul.md 1.3 / 1.8). */

export type StartFromItemId = 'template' | 'import' | 'architect' | 'save'

export interface StartFromItem {
  id: StartFromItemId
  title: string
  description: string
  /** Right-hand text. */
  side?: string
  sideTone?: 'accent' | 'muted'
  disabled?: boolean
  separatorBefore?: boolean
}

export interface StartFromState {
  found: number | null | 'error'
  templateCount: number | undefined
  roleCount: number
  sessionOpen: boolean
  /** An import was done for this project in this session (see agentImport.wasImported). */
  imported?: boolean
}

/** Accessible name of the trigger: the dot is decorative, so the count is spoken instead. */
export function startFromLabel(found: number | null | 'error', dot: boolean): string {
  if (dot && typeof found === 'number' && found > 0) return `Start from, ${found} agent ${found === 1 ? 'file' : 'files'} found`
  return 'Start from'
}

export function importSide(found: number | null | 'error', imported = false): Pick<StartFromItem, 'side' | 'sideTone'> {
  if (found === null) return { side: 'Checking...', sideTone: 'muted' }
  if (found === 'error') return { side: 'Could not check', sideTone: 'muted' }
  // The scan cannot say which found agents the team holds already, so after an import this session the count is dropped.
  if (found > 0 && imported) return { side: 'Imported', sideTone: 'muted' }
  if (found > 0) return { side: `${found} found`, sideTone: 'accent' }
  return { side: 'None found', sideTone: 'muted' }
}

export function startFromItems(s: StartFromState): StartFromItem[] {
  const noTemplates = !s.templateCount
  const cannotSave = s.roleCount <= 1
  return [
    {
      id: 'template',
      title: 'Use a template...',
      description: noTemplates ? 'No templates yet. Save this team as one first.' : 'Replace the team with one you saved.',
      side: s.templateCount ? `${s.templateCount} saved` : undefined,
      sideTone: 'muted',
      disabled: noTemplates
    },
    {
      id: 'import',
      title: 'Import agent files...',
      description: 'Roles from .claude, .codex, .opencode and other tools in this folder.',
      ...importSide(s.found, s.imported)
    },
    s.sessionOpen
      ? {
          id: 'architect',
          title: 'Open the Architect session',
          description: 'Describe what should change. The Architect proposes it on Live.',
          side: 'Session open',
          sideTone: 'accent'
        }
      : {
          id: 'architect',
          title: 'Redesign with the Architect...',
          description: 'Describe what should change. The Architect proposes it on Live.'
        },
    {
      id: 'save',
      title: 'Save as template...',
      description: cannotSave ? 'Add a role first.' : 'Keep this team to start other projects from.',
      disabled: cannotSave,
      separatorBefore: true
    }
  ]
}
