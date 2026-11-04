import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { flushSync } from 'react-dom'
import type { PermissionMode, Project, TeamReviewAuto } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES, PERMISSION_MODE_OPTIONS } from '@shared/types'
import { MAX_AUTO_CONTINUES_LIMIT, isolateWritersOn, projectKindOf, runMessagingOn, teamReviewOf } from '@shared/defaults'
import PermissionRulesPanel from '../PermissionRulesPanel'
import { Select } from '../ui/Select'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { PERMISSION_MODE_SHORT, SETTINGS_COPY, ISOLATE_WRITERS_STATE, RUN_MESSAGING_ENGAGEMENT_DESCRIPTION, TEAM_ASSISTANT_COPY } from '../../lib/settingsCopy'
import { foldersSummary } from '../../lib/folderLists'
import { PERMISSION_MODE_TRADEOFF, collapseRules, rulesApplyInMode } from '../../lib/permissionCopy'
import { scrollWithin } from '../../lib/scrollWithin'
import {
  PROJECT_ADVANCED_SECTIONS,
  PROJECT_SECTION_EVENT,
  PROJECT_SETTINGS_SECTIONS,
  takeProjectSettingsSection,
  type ProjectSettingsSection
} from '../../lib/settingsTarget'
import { AllowedDirectoriesSection } from './AllowedDirectoriesSection'
import { ReferenceDirectoriesSection } from './ReferenceDirectoriesSection'
import { ClampedNumber } from './ClampedNumber'
import { SettingsAdvanced, openSettingsAdvanced } from './SettingsAdvanced'
import { SettingsCard } from './SettingsCard'
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** Short names live in lib/settingsCopy.ts (one table for both settings pages); re-exported for existing imports. */
export { PERMISSION_MODE_SHORT }

/** What still asks in each mode (renderer copy; provider-neutral, config-review spec 5). */
const MODE_MORE =
  'Every mode except Never ask and Bypass can show approval cards in the live view. Unattended lets the model\'s safety check approve routine calls and asks least without turning checks off; Auto-accept edits still asks for commands and for files outside the project and its allowed folders. A card\'s "Always allow for project" saves its rules below, adds its folders to Allowed folders, and for an edit on "Ask for everything risky" switches the project to Auto-accept edits.'

/** "3 rules and 1 folder you allowed" / "2 reference folders, 1 folder you allowed"; null while the rule count is loading. */
export function allowedSummary(rules: number | null, folders: number, reference = 0): string | null {
  return foldersSummary(rules, folders, reference)
}

/**
 * Scroll to and focus a section a deep link asked for, inside the settings scroller only. Rules and folders open the
 * "Rules and folders you allowed" disclosure first; the Team assistant target opens Advanced and focuses its select.
 */
function useSectionTarget(openSummary: () => void): void {
  useEffect(() => {
    const take = (): void => {
      const target: ProjectSettingsSection | null = takeProjectSettingsSection('permissions')
      if (!target) return
      const advanced = PROJECT_ADVANCED_SECTIONS[target]
      if (advanced) {
        openSettingsAdvanced(advanced)
        requestAnimationFrame(() => {
          const select = document.querySelector<HTMLElement>('[data-testid=team-assistant-select]')
          scrollWithin(select?.closest('.setting-row') ?? select, 'center')
          select?.focus({ preventScroll: true })
        })
        return
      }
      if (target !== PROJECT_SETTINGS_SECTIONS.permissions) flushSync(openSummary)
      requestAnimationFrame(() => {
        const section = document.getElementById(target)
        const h3 = section?.querySelector<HTMLElement>('h3')
        // The Permissions section title repeats the pane title and is hidden (display: none), so the pane heading takes the focus.
        const heading = h3?.checkVisibility() ? h3 : section?.closest('[role=tabpanel]')?.querySelector<HTMLElement>('.settings-pane-title')
        scrollWithin(section, 'start')
        if (heading) {
          heading.setAttribute('tabindex', '-1')
          heading.focus({ preventScroll: true })
        }
      })
    }
    take()
    window.addEventListener(PROJECT_SECTION_EVENT, take)
    return () => window.removeEventListener(PROJECT_SECTION_EVENT, take)
  }, [openSummary])
}

/** Permissions pane: the mode, what you allowed (disclosed in the flow) and, under Advanced, how runs behave. */
export function PermissionsSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const id = useId()
  const row = (name: string): string => `${id}-${name}`
  const copy = SETTINGS_COPY
  const [summaryOpen, setSummaryOpen] = useState(false)
  const openSummary = useCallback(() => setSummaryOpen(true), [])
  useSectionTarget(openSummary)

  // App default mode, shown as a hint only.
  const [appDefault, setAppDefault] = useState<PermissionMode | null>(null)
  useEffect(() => {
    let live = true
    window.orgai.settings
      .get()
      .then((s) => live && setAppDefault(s.defaultPermissionMode))
      .catch(() => live && setAppDefault(null))
    return () => {
      live = false
    }
  }, [])

  // Rule count: the same preload call the rules panel makes, refreshed through its change callback.
  const [ruleCount, setRuleCount] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    window.orgai.permissions
      .list(project.id)
      .then((r) => live && setRuleCount(collapseRules(r).length))
      .catch(() => live && setRuleCount(0))
    return () => {
      live = false
    }
  }, [project.id])
  const onRulesChange = useCallback((r: string[]) => setRuleCount(collapseRules(r).length), [])
  const folderCount = (project.allowedDirectories ?? []).length
  const referenceCount = (project.referenceDirectories ?? []).length
  const engagement = projectKindOf(project) === 'engagement'

  // Git state, once per mount and path.
  const [isGit, setIsGit] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    window.orgai.projects
      .checkPath(project.path)
      .then((c) => live && setIsGit(c.isGitRepo))
      .catch(() => live && setIsGit(null))
    return () => {
      live = false
    }
  }, [project.path])

  const current = PERMISSION_MODE_OPTIONS.find((o) => o.value === project.permissionMode)
  const review = teamReviewOf(project)
  const autoOn = project.autoContinue !== false
  const noGit = isGit === false
  // The switch always shows the stored value (isolateWritersOn); a missing git repository is explained, never shown as Off.
  const isoStored = isolateWritersOn(project)
  const isolated = isoStored && !noGit
  const isoDesc = engagement
    ? !isoStored
      ? ISOLATE_WRITERS_STATE.off
      : noGit
        ? ISOLATE_WRITERS_STATE.engagementOnNoGit
        : ISOLATE_WRITERS_STATE.engagementOn
    : noGit
      ? isoStored
        ? 'On, but this folder is not a git repository, so writers work in the folder itself.'
        : ISOLATE_WRITERS_STATE.off
      : isoStored
        ? ISOLATE_WRITERS_STATE.auto
        : ISOLATE_WRITERS_STATE.off
  // Engagements show the isolation rows only once the user opted in (isolateWriters === true); once seen on they stay
  // for this visit, so turning it off does not make the row vanish under the keyboard.
  const [isoSeenOn, setIsoSeenOn] = useState(false)
  useEffect(() => {
    if (project.isolateWriters === true) setIsoSeenOn(true)
  }, [project.isolateWriters])
  const showIsolation = !engagement || isoSeenOn || project.isolateWriters === true
  const isoLabel = engagement ? 'Give each writer its own copy (git worktrees)' : copy.isolateWriters.label
  const summary = allowedSummary(ruleCount, folderCount, referenceCount)
  const bodyId = row('summary-body')

  return (
    <>
      <SettingsSection id={PROJECT_SETTINGS_SECTIONS.permissions} title="Permissions">
        <SettingsCard>
          <SettingRow
            id={row('mode-row')}
            title={copy.permissionMode.label}
            description={
              <span className="perm-mode-tradeoff" data-testid="permission-mode-tradeoff">
                {PERMISSION_MODE_TRADEOFF[project.permissionMode] ?? current?.label}
              </span>
            }
            width="select"
            hint={
              appDefault ? (
                <span data-testid="permission-mode-default">App default for new projects: {PERMISSION_MODE_SHORT[appDefault] ?? appDefault}</span>
              ) : undefined
            }
            control={
              <Select
                id={row('mode')}
                label={copy.permissionMode.label}
                describedBy={settingDescId(row('mode-row'))}
                value={project.permissionMode}
                options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: PERMISSION_MODE_SHORT[o.value] ?? o.label }))}
                onChange={(v) => patch({ permissionMode: v as PermissionMode })}
              />
            }
          />
          <p className="perm-mode-note" data-testid="permission-mode-note">
            {rulesApplyInMode(project.permissionMode)
              ? 'Saved rules and allowed folders apply in every mode except Plan only and Bypass.'
              : 'Saved rules and allowed folders are not used in this mode.'}
          </p>
          <div data-testid="permissions-summary">
            <SettingRow
              id={row('summary-row')}
              title="Rules and folders you allowed"
              description={summary ?? 'Loading…'}
              control={
                <button
                  type="button"
                  className="btn"
                  data-testid="permissions-summary-toggle"
                  aria-expanded={summaryOpen}
                  aria-controls={bodyId}
                  aria-label={`${summaryOpen ? 'Hide' : 'Show'} rules and folders you allowed`}
                  aria-describedby={settingDescId(row('summary-row'))}
                  onClick={() => setSummaryOpen((o) => !o)}
                >
                  {summaryOpen ? 'Hide' : 'Show'}
                </button>
              }
            />
          </div>
        </SettingsCard>
        <div id={bodyId} className="perm-summary-body" hidden={!summaryOpen}>
          <p>{MODE_MORE}</p>
          <ReferenceDirectoriesSection project={project} />
          <AllowedDirectoriesSection project={project} />
          <PermissionRulesPanel project={project} onRulesChange={onRulesChange} />
        </div>
      </SettingsSection>

      <SettingsAdvanced paneKey="project-permissions">
        <SettingsGroup title="Runs">
          <SettingsCard>
            {showIsolation && (
              <SettingRow
                id={row('iso-row')}
                title={isoLabel}
                description={isoDesc}
                control={
                  <Switch
                    checked={isoStored}
                    // A code folder without git cannot turn it on, but a stored "on" can always be turned off.
                    disabled={noGit && !isoStored && !engagement}
                    title={noGit && !isoStored && !engagement ? ISOLATE_WRITERS_STATE.noGit : undefined}
                    label={isoLabel}
                    describedBy={settingDescId(row('iso-row'))}
                    onChange={(v) => patch({ isolateWriters: engagement ? (v ? true : undefined) : v ? undefined : false })}
                  />
                }
              />
            )}
            {showIsolation && (
              <SettingRow
                id={row('review-row')}
                title={copy.reviewMerges.label}
                description={isolated ? copy.reviewMerges.description : copy.reviewMerges.disabled}
                control={
                  <Switch
                    checked={!!project.reviewMerges}
                    disabled={!isolated}
                    title={isolated ? undefined : copy.reviewMerges.disabled}
                    label={copy.reviewMerges.label}
                    describedBy={settingDescId(row('review-row'))}
                    onChange={(v) => patch({ reviewMerges: v })}
                  />
                }
              />
            )}
            <SettingRow
              id={row('msg-row')}
              title={copy.runMessaging.label}
              description={engagement ? RUN_MESSAGING_ENGAGEMENT_DESCRIPTION : copy.runMessaging.description}
              control={
                <Switch
                  checked={runMessagingOn(project)}
                  label={copy.runMessaging.label}
                  describedBy={settingDescId(row('msg-row'))}
                  onChange={(next) => patch({ runMessaging: next })}
                />
              }
            />
            <SettingRow
              id={row('cont-row')}
              title={copy.maxAutoContinues.label}
              description={copy.maxAutoContinues.description}
              width="number"
              control={
                <ClampedNumber
                  label={copy.maxAutoContinues.label}
                  describedBy={settingDescId(row('cont-row'))}
                  min={0}
                  max={MAX_AUTO_CONTINUES_LIMIT}
                  disabled={!autoOn}
                  value={project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES}
                  onCommit={(n) => patch({ maxAutoContinues: n })}
                />
              }
            />
            <SettingRow
              id={row('team-row')}
              title={copy.teamAssistant.label}
              description={TEAM_ASSISTANT_COPY[review.auto].description}
              width="select"
              control={
                // Native select so it can carry the testid (components/ui/Select has no testId prop).
                <select
                  id={row('team')}
                  className="select"
                  data-testid="team-assistant-select"
                  aria-label={copy.teamAssistant.label}
                  aria-describedby={settingDescId(row('team-row'))}
                  value={review.auto}
                  onChange={(e) => patch({ teamReview: { ...review, auto: e.target.value as TeamReviewAuto } })}
                >
                  {(['off', 'free', 'ai'] as const).map((v) => (
                    <option key={v} value={v}>
                      {TEAM_ASSISTANT_COPY[v].label}
                    </option>
                  ))}
                </select>
              }
            />
            {!autoOn && (
              <SettingRow
                id={row('auto-row')}
                title={copy.autoContinue.label}
                description={copy.autoContinue.description}
                control={
                  <Switch checked={false} label={copy.autoContinue.label} describedBy={settingDescId(row('auto-row'))} onChange={(v) => patch({ autoContinue: v })} />
                }
              />
            )}
          </SettingsCard>
        </SettingsGroup>
      </SettingsAdvanced>
    </>
  )
}

