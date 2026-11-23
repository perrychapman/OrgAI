import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { FinishedCopiesSize, Project } from '@shared/types'
import { PROJECT_TEST_COMMAND_MAX_CHARS } from '@shared/types'
import { formatBytes } from '../../lib/outputs'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

const KEEP_DAYS = [1, 7, 14, 30, 90]

/**
 * Branches board "Main branch", "Before anything reaches main" (tests must pass, test command) and "Tidying up" (keep
 * branches of failed runs). Code projects only. Main enforces each: merges land on `mainBranch` (an existing local
 * branch; missing = the detected default), a failing `testCommand` in the finished copy refuses the merge, and
 * Maintenance removes failed or discarded copies after `keepFailedBranchesDays`.
 */
/**
 * "Finished copies on this computer": count and size from maintenanceExtra.finishedCopiesSize. Loading, failed and
 * unknown (a copy count of 0 is said as none; a truncated walk says "at least") are told apart; a size never shows as 0.
 */
function FinishedCopiesRow({ projectId, rowId }: { projectId: string; rowId: string }): ReactElement {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'failed' } | { kind: 'done'; data: FinishedCopiesSize }>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    window.orgai.maintenanceExtra
      .finishedCopiesSize(projectId)
      .then((data) => live && setState({ kind: 'done', data }))
      .catch(() => live && setState({ kind: 'failed' }))
    return () => {
      live = false
    }
  }, [projectId])
  let text: string
  if (state.kind === 'loading') text = 'Measuring…'
  else if (state.kind === 'failed') text = 'Could not be measured'
  else if (state.data.count === 0) text = 'None'
  else {
    const size = formatBytes(state.data.bytes)
    text = `${state.data.count} ${state.data.count === 1 ? 'copy' : 'copies'}${size ? ` · ${state.data.truncated ? 'at least ' : ''}${size}` : ''}`
  }
  return (
    <SettingRow
      id={rowId}
      title="Finished copies on this computer"
      description="Separate working copies agents leave behind. Work already merged into main is safe there; discard or delete a branch under Branches to remove its copy."
      control={
        <span className="settings-quiet" data-testid="finished-copies-size" role="status" aria-describedby={settingDescId(rowId)}>
          {text}
        </span>
      }
    />
  )
}

export function BranchRulesSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  const row = (n: string): string => `${uid}-${n}-row`
  const [branches, setBranches] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    window.orgai.gitInfo
      .branches(project.id)
      .then((b) => live && setBranches(b))
      .catch(() => live && setBranches([]))
    return () => {
      live = false
    }
  }, [project.id])
  const [cmd, setCmd] = useState<string | null>(null)
  const command = cmd ?? project.testCommand ?? ''
  const commitCmd = (): void => {
    if (cmd === null) return
    const v = cmd.replace(/[\r\n]+/g, ' ').trim().slice(0, PROJECT_TEST_COMMAND_MAX_CHARS)
    patch({ testCommand: v || undefined })
    setCmd(null)
  }
  // Main lists the branch merges land on first: the detected default only while no main branch is chosen.
  const detected = project.mainBranch ? undefined : branches?.[0]
  const branchOptions = [
    { value: '', label: branches === null ? 'Loading…' : detected ? `Automatic (${detected})` : "Automatic (the repository's default)" },
    ...(branches ?? []).map((b) => ({ value: b, label: b })),
    ...(project.mainBranch && branches && !branches.includes(project.mainBranch) ? [{ value: project.mainBranch, label: `${project.mainBranch} (not found)` }] : [])
  ]
  const keepOptions = [
    { value: '', label: 'Keep them' },
    ...[...new Set([...KEEP_DAYS, ...(project.keepFailedBranchesDays ? [project.keepFailedBranchesDays] : [])])]
      .sort((a, b) => a - b)
      .map((d) => ({ value: String(d), label: d === 1 ? '1 day' : `${d} days` }))
  ]
  return (
    <SettingsSection id="settings-section-branch-rules" title="Before anything reaches main" testId="branch-rules-section">
      <SettingsCard>
        <SettingRow
          id={row('main')}
          title="Main branch"
          description="Finished work is merged here."
          width="select"
          control={
            <Select
              label="Main branch"
              describedBy={settingDescId(row('main'))}
              value={project.mainBranch ?? ''}
              options={branchOptions}
              disabled={branches === null || branches.length === 0}
              onChange={(v) => patch({ mainBranch: v || undefined })}
            />
          }
        />
        <SettingRow
          id={row('tests')}
          title="Tests must pass"
          description="Runs the test command in the finished copy before it is merged. A failing command stops the merge."
          control={
            <Switch
              checked={project.requireTestsPass === true}
              label="Tests must pass"
              testId="require-tests-switch"
              describedBy={settingDescId(row('tests'))}
              onChange={(requireTestsPass) => patch({ requireTestsPass })}
            />
          }
        />
        <SettingRow
          id={row('cmd')}
          title="Test command"
          description={project.requireTestsPass && !command.trim() ? 'Add a command: while this is empty, merges are refused because there is nothing to run.' : 'One line, run in the finished copy, for example npm test.'}
          width="select"
          control={
            <Input
              id={`${uid}-cmd`}
              mono
              aria-label="Test command"
              aria-describedby={settingDescId(row('cmd'))}
              data-testid="test-command-input"
              value={command}
              maxLength={PROJECT_TEST_COMMAND_MAX_CHARS}
              placeholder="npm test"
              invalid={!!project.requireTestsPass && !command.trim()}
              onChange={setCmd}
              onBlur={commitCmd}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCmd()
              }}
            />
          }
        />
        <SettingRow
          id={row('keep')}
          title="Keep branches of failed runs for"
          description="So you can look at what went wrong. After that, failed copies are removed when OrgAI starts with no run working."
          width="select"
          control={
            <Select
              label="Keep branches of failed runs for"
              describedBy={settingDescId(row('keep'))}
              value={project.keepFailedBranchesDays ? String(project.keepFailedBranchesDays) : ''}
              options={keepOptions}
              onChange={(v) => patch({ keepFailedBranchesDays: v ? Number(v) : undefined })}
            />
          }
        />
        <FinishedCopiesRow projectId={project.id} rowId={row('copies')} />
      </SettingsCard>
    </SettingsSection>
  )
}
