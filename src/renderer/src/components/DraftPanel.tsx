import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { initials } from '../lib/layout'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Textarea } from './ui/Textarea'
import { useConfirm } from './ui/ConfirmDialog'

export default function DraftPanel({ project }: { project: Project }): ReactElement {
  const drafting = useAppStore((s) => s.drafting)
  const draftResult = useAppStore((s) => s.draftResult)
  const draftError = useAppStore((s) => s.draftError)
  const draftOrgChart = useAppStore((s) => s.draftOrgChart)
  const applyDraft = useAppStore((s) => s.applyDraft)
  const discardDraft = useAppStore((s) => s.discardDraft)
  const startSetup = useAppStore((s) => s.startSetup)
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
        body: 'With nothing written, the Architect reviews the repository and revises the architecture document, org chart and settings. Starts an Architect session (spends tokens).',
        confirmLabel: 'Start full review'
      })
      if (!ok) return
    }
    setArchitectBusy(true)
    try {
      await startSetup(
        text
          ? `Revise this project's org chart and setup: ${text}`
          : 'Review this project and revise its architecture document, org chart and settings where they no longer fit the code.'
      )
      setRevision('')
    } finally {
      setArchitectBusy(false)
    }
  }

  return (
    <>
      <div className="side-header">
        <h2>Design the org chart with AI</h2>
      </div>
      <div className="side-body stack-3">
        <section className="draft-box stack-2" aria-labelledby="draft-architect">
          <h3 className="side-section-title" id="draft-architect">
            Revise with the Architect
          </h3>
          <p className="rationale">
            Say what should change. The Architect reads the repository and the current chart, then proposes the revised roles on the
            live view for you to approve. Leave it empty for a full review.
            {project.setup?.architecturePath ? ` The architecture document at ${project.setup.architecturePath} is revised too.` : ''}
          </p>
          <Textarea
            aria-label="What should change"
            rows={4}
            value={revision}
            onChange={setRevision}
            placeholder='e.g. "Add a database specialist under the orchestrator, make the reviewer check accessibility, and move the researcher to Sonnet."'
          />
          <div className="row gap-2 wrap">
            <Button variant="primary" loading={architectBusy} onClick={() => void reviseWithArchitect()}>
              {architectBusy ? 'Starting…' : 'Revise with the Architect'}
            </Button>
            <span className="hint">Starts an Architect session (spends tokens).</span>
          </div>
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
