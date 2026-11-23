// The shared settings menu (ui-overhaul `snav`): the App panes and the project panes, their labels and one-line
// descriptions, in menu order. Pane ids are the atlas ids (src/shared/view/atlas.ts) so deep links keep working; the
// one renderer-only pane is 'appearance', split out of General by the overhaul (its sections still map to 'general' in
// the atlas, so `appSettingsPaneFor` moves them here).
import { APP_SETTINGS_SECTIONS, appPaneForSection } from './settingsTarget'

export interface SettingsMenuPane {
  id: string
  label: string
  description: string
}

/** Renderer-only App settings pane (not in the atlas). */
export const APPEARANCE_PANE = 'appearance'

export const APP_MENU_PANES: readonly SettingsMenuPane[] = [
  { id: 'general', label: 'General', description: 'How OrgAI behaves on this computer.' },
  { id: APPEARANCE_PANE, label: 'Appearance', description: 'How OrgAI looks and moves. Changes show as you pick them.' },
  { id: 'connections', label: 'AI providers', description: 'Where your teams get their models from. One is the default; a project can use another.' },
  { id: 'mcp-library', label: 'Tools and services', description: 'What your teams can reach beyond the project folder.' },
  { id: 'skill-library', label: 'Skills', description: 'Reusable know-how you give to roles.' },
  { id: 'kit', label: 'Templates', description: 'Whole teams you can reuse, and kits to share them.' },
  { id: 'about', label: 'About and updates', description: 'Version, updates and where OrgAI keeps its files.' }
]

/** Project panes; the maintenance pane reads "Branches" on code projects and "Maintenance" on engagements. */
export function projectMenuPanes(engagement: boolean): SettingsMenuPane[] {
  return [
    { id: 'general', label: 'Basics', description: engagement ? 'Name, who or what it is for, folder, plan and the provider this engagement uses.' : 'Name, folder, brief and the provider this project uses.' },
    { id: 'permissions', label: 'Permissions', description: 'How much the team asks you, and what it may touch.' },
    { id: 'limits', label: 'Spending limits', description: 'What this project spent, the cap that stops a run, and how big a run can get.' },
    engagement
      ? { id: 'maintenance', label: 'Maintenance', description: 'What OrgAI keeps for this engagement, and how to clear it.' }
      : { id: 'maintenance', label: 'Branches', description: "How the team's changes get from an agent into your code." }
  ]
}

const APPEARANCE_SECTIONS: readonly string[] = [APP_SETTINGS_SECTIONS.appearance, APP_SETTINGS_SECTIONS.canvas, APPEARANCE_PANE]

/** The App settings pane holding a section or pane id (Appearance included); undefined when unknown. */
export function appSettingsPaneFor(id: string): string | undefined {
  if (APPEARANCE_SECTIONS.includes(id)) return APPEARANCE_PANE
  return appPaneForSection(id)
}
