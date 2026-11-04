/**
 * The one label map keyed by project kind (engagement phase 1). Code keeps its existing words; an engagement uses
 * neutral working words. Pure: no IPC, no React.
 */

import type { ProjectKind } from '@shared/types'

export interface ArchitectureHeadings {
  summary: string
  stack: string
  modules: string
  conventions: string
  commands: string
  risks: string
}

export interface ProjectKindCopy {
  /** Headings of the architecture proposal card body. `summary` is the accessible name of the lead paragraph. */
  architecture: ArchitectureHeadings
  /** Card title of the architecture proposal. */
  architectureTitle: string
  /** What approving the architecture proposal does. */
  architectureApplyNote: string
  /** What approving the settings proposal does. */
  settingsApplyNote: string
  /** New-run page: setup lead (setup not finished). */
  setupLead: string
}

const CODE: ProjectKindCopy = {
  architecture: { summary: 'Summary', stack: 'Stack', modules: 'Modules', conventions: 'Conventions', commands: 'Commands', risks: 'Risks and gaps' },
  architectureTitle: 'Approve architecture proposal',
  architectureApplyNote: 'Approving writes .orgai/ARCHITECTURE.md into the working directory and references it from CLAUDE.md.',
  settingsApplyNote: 'Approving updates the project settings and brief, and saves any allowed commands to .claude/settings.local.json.',
  setupLead: 'The Architect scans the repository, reads the code, and proposes an architecture document, an org chart that fits the work already done, and run settings. You approve each one.'
}

const ENGAGEMENT: ProjectKindCopy = {
  architecture: {
    summary: 'Engagement summary',
    stack: 'Platforms and systems',
    modules: 'Workstreams',
    conventions: 'Working agreements',
    commands: 'Recurring procedures',
    risks: 'Risks'
  },
  architectureTitle: 'Approve engagement plan',
  architectureApplyNote: 'Approving saves the engagement plan in OrgAI. Nothing is written to your folder.',
  settingsApplyNote: 'Approving updates the project settings and brief, and saves any allowed actions for this project.',
  setupLead: 'The Architect looks through the folder and proposes a plan, a team and settings. You approve each one.'
}

export function projectKindCopy(kind: ProjectKind): ProjectKindCopy {
  return kind === 'engagement' ? ENGAGEMENT : CODE
}

/** The "give the lead a task" line of an engagement's new-run page; null for code (the page keeps its own words). */
export function newRunLead(kind: ProjectKind, rootName: string): string | null {
  if (kind !== 'engagement') return null
  return `Give ${rootName} a task. It plans the work and hands parts to the team. Each team member appears here when they start.`
}
