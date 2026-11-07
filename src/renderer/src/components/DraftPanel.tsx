import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { isRunLive, useAppStore } from '../store/useAppStore'
import { initials } from '../lib/layout'
import { needsYou } from '../lib/runChains'
import { statusOfRun, statusText } from '../lib/runStatus'
import { displayRunName, liveOrgChangeRun, orgChangePrompt } from '../lib/orgChange'
import { cleanIpcError } from '../lib/ipcError'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Textarea } from './ui/Textarea'
import { useConfirm } from './ui/ConfirmDialog'

/** Spoken once the session's tab is open on Live (focus is already in its composer). */
const STARTED_NOTICE = 'Org change session started. Its questions and proposals appear here, and it stays in the sidebar while it is open.'

/**
 * One quiet line on the Team tab while an org change session of this project is open: its name, its status word and
 * "Open session", which shows the run's tab on Live. The cards and the composer live there, never in this tray.
 */
function OrgChangePointer({ project }: { project: Project }): ReactElement | null {
  const runId = useAppStore((s) => liveOrgChangeRun(Object.values(s.runs), project.id, isRunLive, needsYou)?.summary.id ?? null)
  const run = useAppStore((s) => (runId ? s.runs[runId] : undefined))
  const openRun = useAppStore((s) => s.openRun)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  if (!run) return null
  const waiting = needsYou(run)
  const word = statusText(statusOfRun(run, project, waiting))
  const name = displayRunName(run.summary)
  const open = (): void => {
    // A waiting session lands on its first card; otherwise on the composer.
    if (waiting) void jumpToDecision(project.id, run.summary.id)
    else void openRun(run.summary.id).then(() => focusComposer())
  }
  return (
    <p className="org-change-pointer" data-testid="org-change-pointer" data-run={run.summary.id} data-status={run.summary.status}>
      <span className="org-change-pointer-name">
        {name} is open · {word}.
      </span>
      <button type="button" className="link-btn" data-testid="org-change-open" aria-label={`Open session: ${name}`} onClick={open}>
        Open session
      </button>
    </p>
  )
}

/**
 * Design mode of the Team tab's tray: "Revise with the Architect" starts an org change session (an ordinary setup run
 * with its own run tab, sidebar row and History row) and switches to it; the quick draft stays here.
 */
export default function DraftPanel({ project }: { project: Project }): ReactElement {
  const [startError, setStartError] = useState<string | null>(null)
  const drafting = useAppStore((s) => s.drafting)
  const draftResult = useAppStore((s) => s.draftResult)
  const draftError = useAppStore((s) => s.draftError)
  const draftOrgChart = useAppStore((s) => s.draftOrgChart)
  const applyDraft = useAppStore((s) => s.applyDraft)
  const discardDraft = useAppStore((s) => s.discardDraft)
  const startSetup = useAppStore((s) => s.startSetup)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const setTabNotice = useAppStore((s) => s.setTabNotice)
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const cost = mock ? '(mock, no tokens)' : '(spends tokens)'
  const engagement = projectKindOf(project) === 'engagement'
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
        body: `With nothing written, the Architect reviews the ${engagement ? 'engagement' : 'repository'} and revises the ${engagement ? 'plan' : 'architecture document'}, org chart and settings. Starts an org change session ${cost}.`,
        confirmLabel: 'Start full review'
      })
      if (!ok) return
    }
    setArchitectBusy(true)
    setStartError(null)
    try {
      // An ordinary setup run: startSetup opens its tab on Live; focus goes to its composer and the start is announced.
      await startSetup(orgChangePrompt(text, projectKindOf(project)))
      setRevision('')
      // The Live view mounts with this render; the composer takes a token bumped after its mount.
      window.requestAnimationFrame(() => focusComposer())
      setTabNotice(STARTED_NOTICE)
    } catch (e) {
      setStartError(cleanIpcError(e))
    } finally {
      setArchitectBusy(false)
    }
  }

  return (
    <>
      <div className="team-tray-body stack-3">
        <OrgChangePointer project={project} />
        <section className="draft-box stack-2" aria-labelledby="draft-architect">
          <h3 className="side-section-title" id="draft-architect">
            Revise with the Architect
          </h3>
          <p className="rationale">
            Say what should change. The Architect reads the {engagement ? 'engagement' : 'repository'} and the current chart, then proposes the revised
            roles for you to approve. The session opens on Live and stays in the sidebar, so you can leave it and come back. Leave it empty for a full
            review.
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
            <Button variant="primary" loading={architectBusy} testId="org-change-start" onClick={() => void reviseWithArchitect()}>
              {architectBusy ? 'Starting…' : 'Revise with the Architect'}
            </Button>
            <span className="hint">Starts an org change session {cost}.</span>
          </div>
          {startError && (
            <p className="capability-warn" role="alert">
              {startError}
            </p>
          )}
        </section>

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
