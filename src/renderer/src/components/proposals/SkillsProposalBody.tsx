import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Minus, Pencil, Plus, TriangleAlert } from 'lucide-react'
import type { SkillsProposalPayload } from '@shared/types'
import { clampLabel } from '../../lib/clampLabel'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { diffSkillsProposal, type SkillCurrent, type SkillGroup, type SkillRowItem, type SkillRowView } from '../../lib/skillProposal'
import { Badge } from '../ui/Badge'
import { ClampText } from './ClampText'

const ICONS: Record<SkillGroup, typeof Plus | undefined> = { create: Plus, link: Plus, grant: Pencil, update: Pencil, remove: Minus }

/** The skill's current instructions, read once for an Update row. 'error' when the read failed. */
function useCurrentBody(projectId: string | undefined, skillId: string | undefined, wanted: boolean): { status: 'idle' | 'loading' | 'ok' | 'error'; body: string | null } {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; body: string | null }>({ status: 'idle', body: null })
  useEffect(() => {
    setState({ status: 'idle', body: null })
    if (!wanted || !projectId || !skillId) return
    let live = true
    setState({ status: 'loading', body: null })
    window.orgai.skills
      .read({ projectId, skillId })
      .then((c) => {
        if (live) setState({ status: 'ok', body: c.body })
      })
      .catch(() => {
        if (live) setState({ status: 'error', body: null })
      })
    return () => {
      live = false
    }
  }, [wanted, projectId, skillId])
  return state
}

function SkillItemRow({ item, view, projectId, current }: { item: SkillProposalItemLike; view: SkillRowView; projectId?: string; current: SkillCurrent }): ReactElement {
  const spec = item.scope === 'project' ? current.skills.find((s) => s.name === item.draft.name) : undefined
  const read = useCurrentBody(projectId, spec?.id, view.showChanges)
  const before = read.body
  const after = item.draft.body ?? ''
  const changed = before !== null && before !== after
  const name = clampLabel(item.draft.name, 64)
  return (
    <li className="skill-prop-item" data-testid="proposal-skill-item" data-skill={clampLabel(item.draft.name)} data-action={item.action}>
      <div className="skill-prop-head">
        <Badge tone={view.badge.tone} icon={ICONS[view.group]}>
          {view.badge.text}
        </Badge>
        <Badge tone="info">{item.scope === 'library' ? 'Library' : 'This project'}</Badge>
        <span className="skill-prop-name mono">{name}</span>
        {(hasHidden(item.draft.name) || hasHidden(item.draft.description)) && (
          <Badge tone="danger" icon={TriangleAlert} testId="proposal-skill-hidden">
            Contains hidden characters
          </Badge>
        )}
      </div>
      {view.line1 && <div className="skill-prop-line">{view.line1}</div>}
      {item.draft.description && <ClampText text={item.draft.description} label={name} />}
      {view.line2 && <div className="skill-prop-roles muted">{view.line2}</div>}
      {view.stateLine && (
        <div className="skill-prop-line" data-testid="proposal-skill-state">
          {view.stateLine}
        </div>
      )}
      {view.note && <div className="skill-prop-note muted">{view.note}</div>}
      {view.showChanges && read.status === 'error' && (
        <div className="proposal-read-error" role="status" data-testid="proposal-read-error">
          <TriangleAlert size={14} aria-hidden="true" /> Current instructions could not be read.
        </div>
      )}
      {view.showChanges && changed && (
        <details className="skill-prop-body" data-testid="proposal-skill-changes">
          <summary>Show changes</summary>
          <div className="skill-prop-diff">
            <div>
              <div className="skill-prop-diff-title">Before</div>
              <pre className="skill-prop-pre">{showHidden(before ?? '')}</pre>
            </div>
            <div>
              <div className="skill-prop-diff-title">After</div>
              <pre className="skill-prop-pre">{showHidden(after)}</pre>
            </div>
          </div>
        </details>
      )}
      {view.showBody && item.draft.body !== undefined && (
        <details className="skill-prop-body">
          <summary>{view.showChanges ? 'Show new instructions' : 'Show instructions'}</summary>
          <pre className="skill-prop-pre">{showHidden(item.draft.body)}</pre>
        </details>
      )}
    </li>
  )
}

type SkillProposalItemLike = SkillRowItem

/** The body of a skills proposal: a summary against the project, then New, Link, Access, Changed and Remove rows. */
export function SkillsProposalBody({ payload, current, projectId }: { payload: SkillsProposalPayload; current: SkillCurrent; projectId?: string }): ReactElement {
  const diff = diffSkillsProposal(payload.items, current)
  return (
    <div className="skill-prop">
      <p className="proposal-summary" data-testid="proposal-summary">
        {diff.summary}
      </p>
      <p className="proposal-rationale">{showHidden(payload.rationale)}</p>
      <ul className="skill-prop-list" aria-label="Skills in this proposal">
        {diff.rows.map(({ item, view }, i) => (
          <SkillItemRow key={`${item.draft.name}-${i}`} item={item} view={view} projectId={projectId} current={current} />
        ))}
      </ul>
      {diff.untouched && diff.untouched.length > 0 && (
        <details className="org-diff-unchanged" data-testid="skills-proposal-unchanged">
          <summary>
            {diff.untouched.length} unchanged {diff.untouched.length === 1 ? 'skill' : 'skills'}
          </summary>
          <ul className="proposal-list">
            {diff.untouched.map((n, i) => (
              <li key={`${n}-${i}`}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
