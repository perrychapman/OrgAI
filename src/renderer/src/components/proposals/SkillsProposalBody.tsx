import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Minus, Pencil, Plus } from 'lucide-react'
import type { SkillsProposalPayload } from '@shared/types'
import { clampLabel } from '../../lib/clampLabel'
import { diffSkillsProposal, type SkillCurrent, type SkillGroup, type SkillRowItem, type SkillRowView } from '../../lib/skillProposal'
import { Badge } from '../ui/Badge'
import { Markdown } from '../Markdown'
import { ClampText } from './ClampText'

const ICONS: Record<SkillGroup, typeof Plus | undefined> = { create: Plus, link: Plus, grant: Pencil, update: Pencil, remove: Minus }

/** The skill's current instructions, read once for an Update row; null when unavailable. */
function useCurrentBody(projectId: string | undefined, skillId: string | undefined, wanted: boolean): string | null {
  const [body, setBody] = useState<string | null>(null)
  useEffect(() => {
    if (!wanted || !projectId || !skillId) return
    let live = true
    window.orgai.skills
      .read({ projectId, skillId })
      .then((c) => {
        if (live) setBody(c.body)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [wanted, projectId, skillId])
  return body
}

function SkillItemRow({ item, view, projectId, current }: { item: SkillProposalItemLike; view: SkillRowView; projectId?: string; current: SkillCurrent }): ReactElement {
  const spec = item.scope === 'project' ? current.skills.find((s) => s.name === item.draft.name) : undefined
  const before = useCurrentBody(projectId, spec?.id, view.showChanges && item.scope === 'project')
  const after = item.draft.body ?? ''
  const changed = before !== null && before !== after
  return (
    <li className="skill-prop-item" data-testid="proposal-skill-item" data-skill={clampLabel(item.draft.name)} data-action={item.action}>
      <div className="skill-prop-head">
        <Badge tone={view.badge.tone} icon={ICONS[view.group]}>
          {view.badge.text}
        </Badge>
        <Badge tone="info">{item.scope === 'library' ? 'Library' : 'This project'}</Badge>
        <span className="skill-prop-name mono">{clampLabel(item.draft.name, 64)}</span>
      </div>
      {view.line1 && <div className="skill-prop-line">{view.line1}</div>}
      {item.draft.description && <ClampText text={item.draft.description} />}
      {view.line2 && <div className="skill-prop-roles muted">{view.line2}</div>}
      {view.note && <div className="skill-prop-note muted">{view.note}</div>}
      {view.showChanges && changed && (
        <details className="skill-prop-body" data-testid="proposal-skill-changes">
          <summary>Show changes</summary>
          <div className="skill-prop-diff">
            <div>
              <div className="skill-prop-diff-title">Before</div>
              <pre className="skill-prop-pre">{before}</pre>
            </div>
            <div>
              <div className="skill-prop-diff-title">After</div>
              <pre className="skill-prop-pre">{after}</pre>
            </div>
          </div>
        </details>
      )}
      {view.showBody && item.draft.body !== undefined && (
        <details className="skill-prop-body">
          <summary>{view.showChanges ? 'Show new instructions' : 'Show instructions'}</summary>
          <div className="skill-prop-md">
            <Markdown text={item.draft.body} />
          </div>
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
      <p className="proposal-rationale">{payload.rationale}</p>
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
