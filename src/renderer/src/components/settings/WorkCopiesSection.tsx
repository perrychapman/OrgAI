import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project } from '@shared/types'
import { isolateWritersOn, projectKindOf } from '@shared/defaults'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { SETTINGS_COPY, ISOLATE_WRITERS_STATE } from '../../lib/settingsCopy'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

/**
 * Branches board "Where work happens" / "Before anything reaches main": worktree isolation and merge review, moved
 * here from Permissions > Advanced > Runs. Same stored fields (isolateWriters, reviewMerges), same rules: the switch
 * shows the stored value and explains a missing git repository; review needs isolation. Engagements show the rows only
 * once the user opted in (or on this visit after turning it on), as before.
 */
export function WorkCopiesSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement | null {
  const id = useId()
  const row = (name: string): string => `${id}-${name}`
  const copy = SETTINGS_COPY
  const engagement = projectKindOf(project) === 'engagement'

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

  const noGit = isGit === false
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
  const [isoSeenOn, setIsoSeenOn] = useState(false)
  useEffect(() => {
    if (project.isolateWriters === true) setIsoSeenOn(true)
  }, [project.isolateWriters])
  const isoLabel = engagement ? 'Give each writer its own copy (git worktrees)' : copy.isolateWriters.label

  // Engagements show the rows only once the user opted in (isolateWriters === true); once seen on they stay for this
  // visit, so turning it off does not make the row vanish under the keyboard.
  const show = !engagement || isoSeenOn || project.isolateWriters === true
  if (!show) return null

  return (
    <SettingsSection
      id="settings-section-work-copies"
      title={engagement ? 'Separate copies' : 'Where work happens'}
      description={engagement ? 'For engagement folders that are git repositories.' : 'How the team keeps its changes apart until they are merged.'}
      testId="work-copies-section"
    >
      <SettingsCard>
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
      </SettingsCard>
    </SettingsSection>
  )
}
