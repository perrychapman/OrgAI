import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project } from '@shared/types'
import { PROJECT_TEST_COMMAND_MAX_CHARS } from '@shared/types'
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
  const detected = branches?.[0]
  const branchOptions = [
    { value: '', label: detected ? `Detected: ${detected}` : branches === null ? 'Loading…' : 'Detected default' },
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
          description={project.requireTestsPass && !command.trim() ? 'Needed while "Tests must pass" is on.' : 'One line, run in the finished copy, for example npm test.'}
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
          description="So you can look at what went wrong. Cleaning up then removes the finished copy."
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
      </SettingsCard>
    </SettingsSection>
  )
}
