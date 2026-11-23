import { projectKindOf } from '@shared/defaults'
import type { PermissionMode, Project } from '@shared/types'

/**
 * Pure helpers for Home's task box (docs/design/ui-overhaul/project/Main.dc.html): the heading, the "Try" suggestions, the
 * target choice (stored projects plus Chat) and the read-only scope and permission labels. No store, no IPC.
 */

export const HERO_HEADING = 'What should your team work on?'

/** Text-only starters: choosing one fills the task box, nothing else happens. */
export const HERO_SUGGESTIONS: readonly string[] = ['Fix a failing test', 'Review my last change', 'Plan a new feature']

/** The target id that means "a new Chat" (never a stored project id, which are generated). */
export const HERO_CHAT_TARGET = '__chat__'

export interface HeroTarget {
  id: string
  label: string
  kind: 'code' | 'engagement' | 'chat'
}

/** Stored projects in the order given, then Chat. Names are shown as typed. */
export function heroTargets(projects: readonly Project[]): HeroTarget[] {
  return [
    ...projects.map((p): HeroTarget => ({ id: p.id, label: p.name, kind: projectKindOf(p) })),
    { id: HERO_CHAT_TARGET, label: 'Chat', kind: 'chat' }
  ]
}

/**
 * The target to show: the one chosen if it still exists, else the preferred project (the one Continue points at), else the
 * first project, else Chat.
 */
export function pickHeroTarget(chosen: string | null, preferred: string | null | undefined, targets: readonly HeroTarget[]): string {
  const has = (id: string | null | undefined): id is string => !!id && targets.some((t) => t.id === id)
  if (has(chosen)) return chosen
  if (has(preferred)) return preferred
  return targets[0]?.id ?? HERO_CHAT_TARGET
}

/** "Whole team · 12 roles" (a project's team scope, read only). Empty for Chat. */
export function heroScopeLabel(project: Pick<Project, 'roles'> | undefined): string {
  if (!project) return ''
  const n = project.roles.length
  return `Whole team · ${n} ${n === 1 ? 'role' : 'roles'}`
}

const PERMISSION_WORDS: Record<PermissionMode, string> = {
  default: 'Asks before risky actions',
  acceptEdits: 'Edits allowed, asks for commands',
  auto: 'Unattended, asks when unsure',
  dontAsk: 'Only pre-approved actions',
  plan: 'Plans first, changes nothing',
  bypassPermissions: 'Never asks'
}

/** The project's permission setting in plain words (read only here; the New run page changes it). */
export function heroPermissionLabel(mode: PermissionMode | undefined): string {
  return mode ? PERMISSION_WORDS[mode] : ''
}

/** A task can be sent when it has something other than white space. */
export function heroCanStart(text: string): boolean {
  return text.trim().length > 0
}
