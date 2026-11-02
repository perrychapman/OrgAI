import type { ReactElement } from 'react'
import { useEffect, useId } from 'react'
import type { PermissionMode, Project, TeamReviewAuto } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES, PERMISSION_MODE_OPTIONS, TEAM_REVIEW_MAX_BUDGET, TEAM_REVIEW_MAX_EVERY_RUNS, TEAM_REVIEW_MIN_BUDGET } from '@shared/types'
import { MAX_AUTO_CONTINUES_LIMIT, runMessagingOn, teamReviewOf } from '@shared/defaults'
import PermissionRulesPanel from '../PermissionRulesPanel'
import { Select } from '../ui/Select'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { SETTINGS_COPY } from '../../lib/settingsCopy'
import { PERMISSION_MODE_TRADEOFF, rulesApplyInMode } from '../../lib/permissionCopy'
import { PROJECT_SECTION_EVENT, PROJECT_SETTINGS_PANES, PROJECT_SETTINGS_SECTIONS, takeProjectSettingsSection } from '../../lib/settingsTarget'
import { AllowedDirectoriesSection } from './AllowedDirectoriesSection'
import { ClampedNumber } from './ClampedNumber'
import { SettingsCard } from './SettingsCard'
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** Short names for the select; the full wording from PERMISSION_MODE_OPTIONS is the one line shown for the selected mode. */
const SHORT: Record<PermissionMode, string> = {
  auto: 'Unattended',
  acceptEdits: 'Auto-accept edits',
  default: 'Ask for everything risky',
  dontAsk: 'Never ask',
  plan: 'Plan only',
  bypassPermissions: 'Bypass all prompts'
}

/** Learn more under the mode: what still asks in each mode (renderer copy; fixes ux-review-permissions M3). */
const MODE_MORE =
  'Every mode except Never ask and Bypass can show approval cards in the live view. Unattended asks least without turning checks off; Auto-accept edits still asks for commands and for files outside the project and its allowed folders. A card\'s "Always allow for project" saves its rules below, adds its folders to Allowed folders, and for an edit on "Ask for everything risky" switches the project to Auto-accept edits.'

/** Scroll to and focus a section a deep link asked for (a permission card's "Fewer prompts" link). */
function useSectionTarget(): void {
  useEffect(() => {
    const take = (): void => {
      const id = takeProjectSettingsSection(PROJECT_SETTINGS_PANES.agents)
      if (!id) return
      requestAnimationFrame(() => {
        const section = document.getElementById(id)
        const heading = section?.querySelector<HTMLElement>('h3')
        section?.scrollIntoView({ block: 'start' })
        if (heading) {
          heading.setAttribute('tabindex', '-1')
          heading.focus({ preventScroll: true })
        }
      })
    }
    take()
    window.addEventListener(PROJECT_SECTION_EVENT, take)
    return () => window.removeEventListener(PROJECT_SECTION_EVENT, take)
  }, [])
}

/** Agents pane: what agents may do unasked, the allowed folders, the saved rules, and how unattended runs behave. */
export function AgentsSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  useSectionTarget()
  const id = useId()
  const current = PERMISSION_MODE_OPTIONS.find((o) => o.value === project.permissionMode)
  const copy = SETTINGS_COPY
  const autoOn = project.autoContinue !== false
  const isolated = project.isolateWriters !== false
  const review = teamReviewOf(project)
  const row = (name: string): string => `${id}-${name}`
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
            more={MODE_MORE}
            control={
              <Select
                id={row('mode')}
                label={copy.permissionMode.label}
                describedBy={settingDescId(row('mode-row'))}
                value={project.permissionMode}
                options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: SHORT[o.value] ?? o.label }))}
                onChange={(v) => patch({ permissionMode: v as PermissionMode })}
              />
            }
          />
          <p className="perm-mode-note" data-testid="permission-mode-note">
            {rulesApplyInMode(project.permissionMode)
              ? 'Saved rules and allowed folders apply in every mode except Plan only and Bypass.'
              : 'Saved rules and allowed folders are not used in this mode.'}
          </p>
        </SettingsCard>
      </SettingsSection>

      <AllowedDirectoriesSection project={project} />

      <PermissionRulesPanel project={project} />

      <SettingsSection id="settings-section-behaviour" title="Behaviour">
        <SettingsCard>
          <SettingRow
            id={row('auto-row')}
            title={copy.autoContinue.label}
            description={copy.autoContinue.description}
            control={<Switch checked={autoOn} label={copy.autoContinue.label} describedBy={settingDescId(row('auto-row'))} onChange={(v) => patch({ autoContinue: v })} />}
          />
          <SettingRow
            title={copy.maxAutoContinues.label}
            width="number"
            control={
              <ClampedNumber
                label={copy.maxAutoContinues.label}
                min={0}
                max={MAX_AUTO_CONTINUES_LIMIT}
                disabled={!autoOn}
                value={project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES}
                onCommit={(n) => patch({ maxAutoContinues: n })}
              />
            }
          />
          <SettingRow
            id={row('iso-row')}
            title={copy.isolateWriters.label}
            description={copy.isolateWriters.description}
            more={copy.isolateWriters.more}
            control={<Switch checked={isolated} label={copy.isolateWriters.label} describedBy={settingDescId(row('iso-row'))} onChange={(v) => patch({ isolateWriters: v })} />}
          />
          <SettingRow
            id={row('review-row')}
            title="Review each report's changes before merge"
            description="You merge, hold or discard each diff."
            control={
              <Switch
                checked={!!project.reviewMerges}
                disabled={!isolated}
                label="Review each report's changes before merge"
                describedBy={settingDescId(row('review-row'))}
                onChange={(v) => patch({ reviewMerges: v })}
              />
            }
          />
          <SettingRow
            id={row('msg-row')}
            title="Let runs message each other"
            description="Orchestrators can exchange short notes."
            more="Orchestrators of this project's runs can read each other's prompts and exchange short notes. On by default; messages between projects need it on in both."
            control={<Switch checked={runMessagingOn(project)} label="Let runs message each other" describedBy={settingDescId(row('msg-row'))} onChange={(next) => patch({ runMessaging: next })} />}
          />
        </SettingsCard>
        <SettingsGroup title="Team assistant: review">
          <p className="hint">Looks now and then for tools and skills your team is missing, and suggests them on the Team tab.</p>
          <SettingsCard>
          <SettingRow
            id={row('team-review-row')}
            title="Team assistant review"
            description="After every N finished runs, within the token budget; AI review sends the names of found tools and skills to the model."
            width="select"
            control={
              <Select
                id={row('team-review')}
                label="Team assistant review"
                describedBy={settingDescId(row('team-review-row'))}
                value={review.auto}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'free', label: 'Free checks' },
                  { value: 'ai', label: 'AI review' }
                ]}
                onChange={(v) => patch({ teamReview: { ...review, auto: v as TeamReviewAuto } })}
              />
            }
          />
          <SettingRow
            title="Review every N finished runs"
            width="number"
            control={
              <ClampedNumber
                label="Review every N finished runs"
                min={1}
                max={TEAM_REVIEW_MAX_EVERY_RUNS}
                disabled={review.auto === 'off'}
                value={review.everyRuns}
                onCommit={(n) => patch({ teamReview: { ...review, everyRuns: n } })}
              />
            }
          />
          <SettingRow
            title="Team assistant review token budget"
            width="number"
            control={
              <ClampedNumber
                label="Team assistant review token budget"
                min={TEAM_REVIEW_MIN_BUDGET}
                max={TEAM_REVIEW_MAX_BUDGET}
                disabled={review.auto !== 'ai'}
                value={review.tokenBudget}
                onCommit={(n) => patch({ teamReview: { ...review, tokenBudget: n } })}
              />
            }
          />
          </SettingsCard>
        </SettingsGroup>
      </SettingsSection>
    </>
  )
}
