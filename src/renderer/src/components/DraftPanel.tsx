import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { initials } from '../lib/layout'
import { Button } from './ui/Button'
import ArchitectDecisions from './team/ArchitectDecisions'
import { useTeamAssistantStore } from '../store/teamAssistant'
import { isTeamSurfaceRun } from '../lib/runSurface'
import { cleanIpcError } from '../lib/ipcError'
import { Checkbox } from './ui/Checkbox'
import { Textarea } from './ui/Textarea'
import { useConfirm } from './ui/ConfirmDialog'

/** Status line and every open decision of a Team-tab Architect session, answered in place (the run is not on the Live strip). */
function ArchitectRunCards({ runId, project }: { runId: string; project: Project }): ReactElement | null {
  const run = useAppStore((s) => s.runs[runId])
  if (!run) return null
  const open = (run.questions?.length ?? 0) + run.proposals.length + run.permissions.length + (run.ruleRequests?.length ?? 0) + (run.mergeReviews?.length ?? 0) + (run.mcpInstalls?.length ?? 0)
  const status = run.summary.status
  const live = status === 'starting' || status === 'running'
  return (
    <section className="draft-box stack-2" aria-label="Architect session" data-testid="architect-session" data-status={status}>
      <p className="hint" role="status">
        {open > 0
          ? `The Architect needs ${open === 1 ? 'your decision' : `your ${open} decisions`}.`
          : live
            ? 'The Architect is working. Its questions, permission requests and proposals appear here.'
            : status === 'finished' || status === 'idle'
              ? 'The Architect session ended.'
              : 'The Architect session stopped.'}
      </p>
      <ArchitectDecisions runId={runId} project={project} />
    </section>
  )
}

/**
 * The Architect and quick draft. `variant="tray"` is the Team tab's tray form (a header row with a close button and no
 * sticky side header); `panel` is the old side-panel form.
 */
export default function DraftPanel({ project, variant = 'panel', onClose }: { project: Project; variant?: 'panel' | 'tray'; onClose?: () => void }): ReactElement {
  void onClose
  const storedRun = useTeamAssistantStore((s) => s.designRun[project.id])
  const setDesignRun = useTeamAssistantStore((s) => s.setDesignRun)
  // The newest live Team-surface session of this project when none was started here (a reload, another window).
  const liveTeamRun = useAppStore((s) => {
    let best: { id: string; at: number } | null = null
    for (const r of Object.values(s.runs)) {
      const sm = r.summary
      if (sm.projectId !== project.id || !isTeamSurfaceRun(sm) || (sm.status !== 'starting' && sm.status !== 'running' && sm.status !== 'idle')) continue
      if (!best || sm.startedAt > best.at) best = { id: sm.id, at: sm.startedAt }
    }
    return best?.id ?? null
  })
  const teamRunId = storedRun ?? liveTeamRun
  const [startError, setStartError] = useState<string | null>(null)
  const tray = variant === 'tray'
  const drafting = useAppStore((s) => s.drafting)
  const draftResult = useAppStore((s) => s.draftResult)
  const draftError = useAppStore((s) => s.draftError)
  const draftOrgChart = useAppStore((s) => s.draftOrgChart)
  const applyDraft = useAppStore((s) => s.applyDraft)
  const discardDraft = useAppStore((s) => s.discardDraft)
  const startSetup = useAppStore((s) => s.startSetup)
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const cost = mock ? '(mock, no tokens)' : '(spends tokens)'
  const { confirm, dialog } = useConfirm()
  const [instruction, setInstruction] = useState('')
  const [startFresh, setStartFresh] = useState(false)
  const [architectBusy, setArchitectBusy] = useState(false)
  const [revision, setRevision] = useState('')

  const reviseWithArchitect = async (): Promise<void> => {
    const text = revision.trim()
    if (!text) {
      const ok = await confirm({
        title: 'Review the whole project?',
        body: `With nothing written, the Architect reviews the repository and revises the architecture document, org chart and settings. Starts an Architect session ${cost}.`,
        confirmLabel: 'Start full review'
      })
      if (!ok) return
    }
    setArchitectBusy(true)
    setStartError(null)
    const instruction = text
      ? `Revise this project's org chart and setup: ${text}`
      : 'Review this project and revise its architecture document, org chart and settings where they no longer fit the code.'
    try {
      if (tray) {
        // A Team-tab session stays on the Team tab: no navigation to Live, no run tab.
        const summary = await window.orgai.setup.start({ projectId: project.id, instruction, surface: 'team' })
        setDesignRun(project.id, summary.id)
      } else {
        await startSetup(instruction)
      }
      setRevision('')
    } catch (e) {
      setStartError(cleanIpcError(e))
    } finally {
      setArchitectBusy(false)
    }
  }

  return (
    <>
      {!tray && (
        <div className="side-header">
          <h2>Design the org chart with AI</h2>
        </div>
      )}
      <div className={tray ? 'team-tray-body stack-3' : 'side-body stack-3'}>
        <section className="draft-box stack-2" aria-labelledby="draft-architect">
          <h3 className="side-section-title" id="draft-architect">
            Revise with the Architect
          </h3>
          <p className="rationale">
            Say what should change. The Architect reads the repository and the current chart, then proposes the revised roles
            {tray ? ' in the tray' : ' on the live view'} for you to approve. Leave it empty for a full review.
            {project.setup?.architecturePath ? ` The architecture document at ${project.setup.architecturePath} is revised too.` : ''}
          </p>
          <Textarea
            aria-label="What should change"
            rows={4}
            value={revision}
            onChange={setRevision}
            placeholder='e.g. "Add a database specialist under the orchestrator, make the reviewer check accessibility, and move the researcher to the fast tier."'
          />
          <div className="row gap-2 wrap">
            <Button variant="primary" loading={architectBusy} onClick={() => void reviseWithArchitect()}>
              {architectBusy ? 'Starting…' : 'Revise with the Architect'}
            </Button>
            <span className="hint">Starts an Architect session {cost}.</span>
          </div>
          {startError && (
            <p className="capability-warn" role="alert">
              {startError}
            </p>
          )}
        </section>
        {teamRunId && <ArchitectRunCards runId={teamRunId} project={project} />}

        <details className="disclosure">
          <summary>Advanced: quick draft</summary>
          <div className="stack-2 disclosure-body">
            <p className="hint">
              A one-shot drafter that works from your description alone, without reading the repository or asking for approval.
            </p>
            <Textarea
              aria-label="Describe the team you want"
              rows={5}
              value={instruction}
              onChange={setInstruction}
              placeholder={
                project.brief
                  ? 'e.g. "Add a dedicated test engineer and a database specialist; keep the reviewer read-only."'
                  : 'e.g. "Next.js + Postgres SaaS. Mostly feature work and bug fixes, occasional migrations. I want a strict reviewer."'
              }
            />
            <Checkbox checked={startFresh} onChange={setStartFresh} label="Start fresh" description="Replace the current chart instead of revising it." />
            <div>
              <Button
                loading={drafting}
                disabled={!instruction.trim() && !project.brief.trim()}
                onClick={() =>
                  void draftOrgChart({
                    instruction: instruction.trim() || 'Design an org chart that fits the project brief.',
                    mode: startFresh ? 'replace' : 'revise'
                  })
                }
              >
                {drafting ? 'Drafting…' : 'Draft org chart'}
              </Button>
            </div>
          </div>
        </details>

        {draftError && <div className="draft-box is-error">{draftError}</div>}
        {draftResult && (
          <section className="draft-box stack-2" aria-label="Draft proposal">
            <strong>Proposal: {draftResult.roles.length} roles</strong>
            <p className="rationale">{draftResult.rationale}</p>
            <div className="stack-2">
              {draftResult.roles.map((r) => (
                <div key={r.id} className="row draft-role">
                  <span className="avatar sm" style={{ ['--role' as string]: r.color }} aria-hidden="true">
                    {initials(r.name)}
                  </span>
                  <span className="draft-role-name">{r.name}</span>
                  <span className="chip">{r.model}</span>
                  {r.canSpawn && <span className="chip">leads {r.spawnable.length}</span>}
                  <span className="draft-role-parent">
                    {r.reportsTo ? `Reports to ${draftResult.roles.find((x) => x.id === r.reportsTo)?.name ?? 'unknown'}` : 'Root'}
                  </span>
                </div>
              ))}
            </div>
            <div className="row gap-2">
              <Button variant="primary" onClick={applyDraft}>
                Apply to project
              </Button>
              <Button variant="ghost" onClick={discardDraft}>
                Discard
              </Button>
            </div>
          </section>
        )}
      </div>
      {dialog}
    </>
  )
}
