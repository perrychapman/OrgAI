import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { initials } from '../lib/layout'

export default function DraftPanel({ project }: { project: Project }): ReactElement {
  const drafting = useAppStore((s) => s.drafting)
  const draftResult = useAppStore((s) => s.draftResult)
  const draftError = useAppStore((s) => s.draftError)
  const draftOrgChart = useAppStore((s) => s.draftOrgChart)
  const applyDraft = useAppStore((s) => s.applyDraft)
  const discardDraft = useAppStore((s) => s.discardDraft)
  const startSetup = useAppStore((s) => s.startSetup)
  const [instruction, setInstruction] = useState('')
  const [mode, setMode] = useState<'replace' | 'revise'>('revise')
  const [architectBusy, setArchitectBusy] = useState(false)

  const reviseWithArchitect = async (): Promise<void> => {
    setArchitectBusy(true)
    try {
      await startSetup(
        instruction.trim()
          ? `Revise this project's setup. ${instruction.trim()}`
          : 'Review this project and revise its architecture document, org chart and settings where they no longer fit the code.'
      )
    } finally {
      setArchitectBusy(false)
    }
  }

  return (
    <>
      <div className="side-header">
        <h2>Design the org chart with AI</h2>
      </div>
      <div className="side-body">
        <div className="draft-box" style={{ marginTop: 0, marginBottom: 14 }}>
          <strong>Revise with the Architect</strong>
          <div className="rationale">
            Starts a setup session on the live view. The Architect reads the repository and the current chart, then proposes changes
            you approve one by one.
            {project.setup?.architecturePath ? ` The architecture document at ${project.setup.architecturePath} is revised too.` : ''}
          </div>
          <button className="btn primary" disabled={architectBusy} onClick={() => void reviseWithArchitect()}>
            {architectBusy ? (
              <>
                <span className="spinner" /> Starting…
              </>
            ) : (
              'Open a setup session'
            )}
          </button>
        </div>
        <div className="side-section-title">Quick draft (no repository access)</div>
        <p style={{ margin: '0 0 10px', color: 'var(--text-dim)', fontSize: 12.5 }}>
          A one-shot drafter that works from your description alone. Use the instruction box below for both.
        </p>
        <div className="field">
          <textarea
            className="textarea"
            style={{ minHeight: 110 }}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={
              project.brief
                ? 'e.g. "Add a dedicated test engineer and a database specialist; keep the reviewer read-only."'
                : 'e.g. "Next.js + Postgres SaaS. Mostly feature work and bug fixes, occasional migrations. I want a strict reviewer."'
            }
          />
        </div>
        <div className="row" style={{ marginBottom: 10 }}>
          <label className={`check ${mode === 'revise' ? 'on' : ''}`}>
            <input type="radio" checked={mode === 'revise'} onChange={() => setMode('revise')} /> Revise current chart
          </label>
          <label className={`check ${mode === 'replace' ? 'on' : ''}`}>
            <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Start fresh
          </label>
        </div>
        <button
          className="btn primary"
          disabled={drafting || (!instruction.trim() && !project.brief.trim())}
          onClick={() => void draftOrgChart({ instruction: instruction.trim() || 'Design an org chart that fits the project brief.', mode })}
        >
          {drafting ? (
            <>
              <span className="spinner" /> Drafting…
            </>
          ) : (
            'Draft org chart'
          )}
        </button>
        {draftError && (
          <div className="draft-box" style={{ borderColor: 'rgba(255,107,107,0.5)', color: 'var(--danger)' }}>
            {draftError}
          </div>
        )}
        {draftResult && (
          <div className="draft-box">
            <strong>Proposal: {draftResult.roles.length} roles</strong>
            <div className="rationale">{draftResult.rationale}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {draftResult.roles.map((r) => (
                <div key={r.id} className="row" style={{ fontSize: 12.5 }}>
                  <span className="avatar" style={{ ['--role' as string]: r.color, width: 22, height: 22, fontSize: 9 }}>
                    {initials(r.name)}
                  </span>
                  <span style={{ fontWeight: 600 }}>{r.name}</span>
                  <span className="chip">{r.model}</span>
                  {r.canSpawn && <span className="chip">leads {r.spawnable.length}</span>}
                  <span style={{ color: 'var(--text-faint)', marginLeft: 'auto', fontSize: 11 }}>
                    {r.reportsTo ? `→ ${draftResult.roles.find((x) => x.id === r.reportsTo)?.name ?? ''}` : 'root'}
                  </span>
                </div>
              ))}
            </div>
            <div className="row">
              <button className="btn primary" onClick={applyDraft}>
                Apply to project
              </button>
              <button className="btn ghost" onClick={discardDraft}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
