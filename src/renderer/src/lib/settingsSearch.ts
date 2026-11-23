// Settings search (ui-overhaul settings boards: "Search settings"). Pure: matches the app atlas's settings surfaces
// (src/shared/view/atlas.ts, the same source self-help uses) and says where each one lives in the new settings menu.
import { ATLAS_SURFACES, type AtlasSurfaceId } from '@shared/view/atlas'
import { SURFACE_TARGETS, type NavTarget } from './appNavigate'
import { APP_MENU_PANES, appSettingsPaneFor, projectMenuPanes } from './settingsMenu'

export interface SettingsSearchHit {
  id: AtlasSurfaceId
  label: string
  /** Where it lives, in the menu's words ("App › Appearance", "Project › Permissions"). */
  where: string
  target: NavTarget
}

/** Most results shown at once. */
export const SETTINGS_SEARCH_MAX = 8

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/** The menu location of a settings target, or null when the target is not a settings page. */
export function settingsWhere(target: NavTarget, engagement: boolean): string | null {
  if (target.kind === 'app') {
    const pane = appSettingsPaneFor(target.target)
    const label = APP_MENU_PANES.find((p) => p.id === pane)?.label
    return label ? `App › ${label}` : null
  }
  if (target.kind === 'project' && target.view === 'settings') {
    const label = projectMenuPanes(engagement).find((p) => p.id === (target.pane ?? 'general'))?.label
    return label ? `${engagement ? 'Engagement' : 'Project'} › ${label}` : null
  }
  return null
}

/**
 * Settings surfaces matching `query` (every word must appear in the label, the summary or the breadcrumb), best first:
 * label matches before summary-only matches. Project settings only when a project is open (`hasProject`).
 */
export function searchSettings(query: string, opts: { hasProject: boolean; engagement: boolean }): SettingsSearchHit[] {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const scored: { hit: SettingsSearchHit; score: number }[] = []
  for (const s of ATLAS_SURFACES) {
    const target = SURFACE_TARGETS[s.id]
    if (!target) continue
    if (target.kind === 'project' && !opts.hasProject) continue
    const where = settingsWhere(target, opts.engagement)
    if (!where) continue
    const label = norm(s.label)
    const hay = `${label} ${norm(s.summary)} ${norm(where)}`
    if (!words.every((w) => hay.includes(w))) continue
    const score = words.every((w) => label.includes(w)) ? (label.startsWith(words[0]) ? 0 : 1) : 2
    scored.push({ hit: { id: s.id, label: s.label, where, target }, score })
  }
  scored.sort((a, b) => a.score - b.score || a.hit.label.localeCompare(b.hit.label))
  return scored.slice(0, SETTINGS_SEARCH_MAX).map((x) => x.hit)
}
