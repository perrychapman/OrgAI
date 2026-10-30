import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project } from '@shared/types'
import { DEFAULT_KEEP_RUNS, DEFAULT_MAX_AUTO_CONTINUES } from '@shared/types'
import { MAX_AUTO_CONTINUES_LIMIT, MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT } from '@shared/defaults'
import { Checkbox } from '../ui/Checkbox'
import { Input } from '../ui/Input'
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** Cost caps, concurrency, unattended execution, subscription limits, worktrees and retention. */
export function LimitsSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  const [opusGuard, setOpusGuard] = useState<number | null>(null)
  useEffect(() => {
    window.orgai.settings
      .get()
      .then((s) => setOpusGuard(s.opusGuardThreshold))
      .catch(() => setOpusGuard(null))
  }, [])
  return (
    <SettingsSection id="settings-section-limits" title="Limits" description="Caps on spend, parallelism and how long agents keep going on their own.">
      <div className="settings-grid">
        <div className="field">
          <label htmlFor={`${uid}-cost`}>Estimated-cost cap per run (API-equivalent USD)</label>
          <Input
            id={`${uid}-cost`}
            type="number"
            min={0}
            step={0.5}
            value={project.maxBudgetUsd ?? ''}
            placeholder="No cap"
            onChange={(v) => patch({ maxBudgetUsd: v ? Number(v) : undefined })}
          />
          <span className="hint">Measured at API prices. On a subscription this is a safety cap, not money you are billed.</span>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-keep`}>Runs to keep</label>
          <Input
            id={`${uid}-keep`}
            type="number"
            min={1}
            max={5000}
            value={project.keepRuns ?? DEFAULT_KEEP_RUNS}
            onChange={(v) => patch({ keepRuns: Math.max(1, Number(v) || DEFAULT_KEEP_RUNS) })}
          />
          <span className="hint">Older finished runs and their transcripts are deleted from disk when a run ends.</span>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-depth`}>Max subagent depth</label>
          <Input
            id={`${uid}-depth`}
            type="number"
            min={1}
            max={MAX_SUBAGENT_DEPTH_LIMIT}
            value={project.maxSubagentDepth}
            onChange={(v) => patch({ maxSubagentDepth: Math.min(MAX_SUBAGENT_DEPTH_LIMIT, Number(v) || 1) })}
          />
          <span className="hint">1 means reports cannot spawn their own subagents.</span>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-conc`}>Max concurrent subagents</label>
          <Input
            id={`${uid}-conc`}
            type="number"
            min={1}
            max={MAX_CONCURRENT_SUBAGENTS_LIMIT}
            value={project.maxConcurrentSubagents}
            onChange={(v) => patch({ maxConcurrentSubagents: Math.min(MAX_CONCURRENT_SUBAGENTS_LIMIT, Number(v) || 1) })}
          />
          <span className="hint">Reports that may run at the same time across the whole org.</span>
        </div>
      </div>

      <SettingsGroup title="Unattended execution">
        <Checkbox
          checked={project.autoContinue !== false}
          onChange={(v) => patch({ autoContinue: v })}
          label="Keep the orchestrator going until the plan is complete"
          description="The orchestrator plans each task with set_plan. Whenever a turn ends with steps left, the harness reminds it what remains, unless reports are still running, a card waits for you, or the run is stopping. It stops for genuine decisions (ask_user, mark_blocked); interrupting a turn also pauses it until you reply."
        />
        <div className="field narrow">
          <label htmlFor={`${uid}-cont`}>Max automatic continues per run</label>
          <Input
            id={`${uid}-cont`}
            type="number"
            min={0}
            max={MAX_AUTO_CONTINUES_LIMIT}
            disabled={project.autoContinue === false}
            value={project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES}
            onChange={(e) => {
              const v = Number(e)
              patch({ maxAutoContinues: Number.isFinite(v) ? Math.min(MAX_AUTO_CONTINUES_LIMIT, Math.max(0, Math.floor(v))) : DEFAULT_MAX_AUTO_CONTINUES })
            }}
          />
          <span className="hint">When the limit is reached the orchestrator waits for you and the transcript says why.</span>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Subscription limits">
        <div className="field narrow">
          <label htmlFor={`${uid}-share`}>Stop when one run uses more than (% of the five-hour window)</label>
          <Input
            id={`${uid}-share`}
            type="number"
            min={1}
            max={100}
            placeholder="Off"
            value={project.maxWindowShare ?? ''}
            onChange={(e) => {
              const v = Number(e)
              patch({ maxWindowShare: e && Number.isFinite(v) && v > 0 ? Math.min(100, v) : undefined })
            }}
          />
          <span className="hint">Blank turns it off. The run is interrupted and waits for you; the orchestrator is told why with your next message.</span>
        </div>
        <Checkbox
          checked={!!project.preferSonnetNearLimit}
          onChange={(v) => patch({ preferSonnetNearLimit: v })}
          label={`Prefer Sonnet for new reports when the Opus weekly window is above ${opusGuard ?? 80}%`}
          description="Reports whose role uses Opus are spawned on Sonnet while the Opus weekly window (or the seven-day window, on plans without one) is at or above the threshold in app settings. Running agents are not changed."
        />
      </SettingsGroup>

      <SettingsGroup title="Parallel work">
        <Checkbox
          checked={project.isolateWriters !== false}
          onChange={(v) => patch({ isolateWriters: v })}
          label="Isolate writing reports in git worktrees"
          description="Each report that can edit files works in its own git worktree. When it reports back, the harness commits its changes and merges them into the main checkout; conflicts are handed to the orchestrator. Needs a git repository."
        />
        <Checkbox
          checked={!!project.reviewMerges}
          disabled={project.isolateWriters === false}
          onChange={(v) => patch({ reviewMerges: v })}
          label="Review each report's changes before it is merged"
          description="The live view shows each finished report's diff; you merge it, hold it for later, or discard it."
        />
      </SettingsGroup>
    </SettingsSection>
  )
}
