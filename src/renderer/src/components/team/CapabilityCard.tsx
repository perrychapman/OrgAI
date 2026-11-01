import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Check, Plug, Undo2 } from 'lucide-react'
import type { CapabilityAccess, CapabilityItem, CapabilityRecommendation, Role } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { SegmentedControl } from '../ui/SegmentedControl'
import {
  accessChoiceOffered,
  accessSentence,
  clampText,
  flagViews,
  fullAllowed,
  isOutside,
  pinLabel,
  stripControl,
  sourceBadge
} from '../../lib/capabilities'

/** What the pane knows about one card after the user acted on it. */
export interface AppliedInfo {
  name: string
  roleNames: string[]
  access: CapabilityAccess
  undoId: string
  /** The project server id that now holds it, for the Finish setup link. */
  appliedId?: string
  connectorId?: string
  libraryId?: string
  /** A later apply replaced the undo token, so this row can no longer be undone. */
  superseded?: boolean
  needsSetup?: { secrets: string[]; signIn: boolean }
  notes: string[]
}

/**
 * One recommendation, on the decision-card shell (head, one scrolling body, opaque footer) but not a run decision: it is
 * an in-tab proposal the user may leave pending. Every string from the candidate is untrusted and rendered as clamped
 * text. Roles default to the ones named, access to read-only; nothing is applied until the user says so.
 */
export function CapabilityCard({
  item,
  rec,
  roles,
  busy,
  error,
  primary,
  onApply,
  onDismiss
}: {
  item: CapabilityItem
  rec: CapabilityRecommendation
  roles: Role[]
  busy?: boolean
  error?: string | null
  /** The first card carries the primary Apply; the others are secondary. */
  primary?: boolean
  onApply: (roleIds: string[], access: CapabilityAccess) => void
  onDismiss: () => void
}): ReactElement {
  const [chosen, setChosen] = useState<string[]>(() => rec.roleIds.filter((id) => roles.some((r) => r.id === id)))
  const [wanted, setWanted] = useState<CapabilityAccess>(rec.access)
  const chosenRoles = useMemo(() => roles.filter((r) => chosen.includes(r.id)), [roles, chosen])
  const canFull = fullAllowed(chosenRoles)
  const access: CapabilityAccess = canFull ? wanted : 'read'
  const offerAccess = accessChoiceOffered(item)
  const runsCode = item.flags.includes('runsCode')
  const allFlags = flagViews(item)
  const runsCodeLabel = allFlags.find((f) => f.key === 'runsCode')?.label ?? 'Runs code on this machine'
  const flags = item.kind !== 'skill' && item.target ? allFlags.filter((f) => f.key !== 'runsCode') : allFlags
  const pin = pinLabel(item)
  const outside = isOutside(item)
  const blocked = item.blockedReason ? clampText(item.blockedReason, 160) : null
  const noRole = chosen.length === 0
  const needsPin = outside && !pin
  const disabled = !!blocked || noRole || needsPin || busy
  const [more, setMore] = useState(false)
  const reason = clampText(rec.reason)
  const long = reason.length > 140
  const KindIcon = item.kind === 'skill' ? BookOpen : Plug
  const name = clampText(item.name, 80)
  const toggle = (id: string, on: boolean): void => setChosen((c) => (on ? [...c.filter((x) => x !== id), id] : c.filter((x) => x !== id)))

  return (
    <article
      className="decision-card kind-proposal capability-card"
      aria-label={`Recommendation: ${name}`}
      data-testid="capability-card"
      data-kind={item.kind}
      data-origin={item.origin}
      data-name={name}
      data-rec={rec.id}
      data-expanded="true"
    >
      <header className="decision-head">
        <div className="decision-meta">
          <Badge tone={outside ? 'attention' : 'neutral'} testId="capability-source">
            {sourceBadge(item)}
          </Badge>
          <Badge tone="neutral">{item.kind === 'skill' ? 'Skill' : 'Connection'}</Badge>
          {item.location && (
            <span className="capability-location mono" title={clampText(item.location, 200)}>
              {clampText(item.location, 80)}
            </span>
          )}
        </div>
        <div className="decision-titlebar">
          <span className="capability-kind-icon">
            <Icon icon={KindIcon} size="sm" />
          </span>
          <span className="decision-title" title={name}>
            {name}
          </span>
        </div>
      </header>
      <div className="decision-body capability-body">
        {reason && (
          <p className={long && !more ? 'capability-reason clamped' : 'capability-reason'}>
            {reason}
            {long && (
              <>
                {' '}
                <button type="button" className="mcp-link" onClick={() => setMore((v) => !v)} aria-expanded={more}>
                  <span className="mcp-link-text">{more ? 'Less' : 'More'}</span>
                </button>
              </>
            )}
          </p>
        )}
        {item.description && <p className="capability-desc hint">{clampText(item.description, 200)}</p>}
        {pin && (
          <p className="capability-pin">
            <span className="mono">{pin}</span>
          </p>
        )}
        {item.kind !== 'skill' && item.target && (
          <div className="capability-command" data-testid="capability-command">
            <div className="capability-command-head">
              <span className="hint">{runsCode ? 'This exact command is what gets added' : 'This is what gets added'}</span>
              {runsCode && (
                <Badge tone="danger" testId="capability-runs-code">
                  {runsCodeLabel}
                </Badge>
              )}
            </div>
            <code className="capability-target" tabIndex={0} aria-label="Full command">
              {stripControl(item.target)}
            </code>
          </div>
        )}
        {needsPin && <p className="capability-warn">Not pinned. Can&apos;t be added.</p>}
        {blocked && <p className="capability-warn">{blocked}</p>}
        {flags.length > 0 && (
          <ul className="capability-flags" aria-label="Things to know">
            {flags.map((f) => (
              <li key={f.key}>
                <Badge tone={f.tone === 'danger' ? 'danger' : f.tone === 'attention' ? 'attention' : 'neutral'} testId={f.key === 'needs' ? 'capability-needs' : undefined}>
                  {f.label}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="capability-access" data-testid="capability-access">
          {accessSentence(
            chosenRoles.map((r) => r.name),
            item.name,
            access,
            item.kind
          )}
        </p>
        {offerAccess && canFull && (
          <div className="capability-access-pick">
            <SegmentedControl
              label={`Access for ${name}`}
              value={access}
              options={[
                { value: 'read', label: 'Can read' },
                { value: 'full', label: 'Can read and change' }
              ]}
              onChange={setWanted}
            />
            {access === 'full' && <span className="hint">Lets {chosenRoles.length === 1 ? chosenRoles[0].name : 'these roles'} change things.</span>}
          </div>
        )}
        {offerAccess && !canFull && chosenRoles.length > 0 && <p className="hint">Read-only: a chosen role has no tool that changes things.</p>}
        <details className="disclosure capability-roles">
          <summary>Roles ({chosen.length})</summary>
          <div className="stack-1 disclosure-body">
            {roles.map((r) => (
              <Checkbox key={r.id} checked={chosen.includes(r.id)} onChange={(on) => toggle(r.id, on)} label={r.name} />
            ))}
          </div>
        </details>
        {noRole && <p className="hint">Choose a role. Nobody gets it until you do.</p>}
        {item.notes.length > 0 && <p className="hint">{item.notes.map((n) => clampText(n, 120)).join(' ')}</p>}
      </div>
      {error && (
        <div className="decision-error">
          <p className="capability-warn" role="alert">
            {error}
          </p>
        </div>
      )}
      <footer className="decision-footer">
        <Button
          variant={primary ? 'primary' : 'secondary'}
          size="sm"
          loading={busy}
          disabled={disabled}
          ariaLabel={`Apply ${name}`}
          testId="capability-apply"
          onClick={() => onApply(chosen, access)}
        >
          Apply
        </Button>
        <div className="decision-secondary">
          <Button variant="ghost" size="sm" disabled={busy} ariaLabel={`Dismiss ${name}`} testId="capability-dismiss" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </footer>
    </article>
  )
}

/** The card after Apply: what happened, Undo, and a way into sign-in when the connection still needs the user. */
export function AppliedRow({
  info,
  busy,
  error,
  onUndo,
  onSetup
}: {
  info: AppliedInfo
  busy?: boolean
  error?: string | null
  onUndo: () => void
  onSetup?: () => void
}): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // Focus follows the card that was replaced.
    rootRef.current?.querySelector<HTMLElement>('[data-testid=capability-undo]')?.focus()
  }, [])
  const who = info.roleNames.length ? info.roleNames.map((n) => clampText(n, 30)).join(', ') : 'no role'
  const needs = info.needsSetup
  return (
    <div className="capability-applied" ref={rootRef} data-testid="capability-applied" role="group" aria-label={`Applied ${info.name}`}>
      <span className="capability-applied-text">
        <Icon icon={Check} size="sm" />
        <span>
          Applied <strong>{clampText(info.name, 60)}</strong> to {who}
          {info.access === 'full' ? ' (can read and change)' : ''}.
          {needs ? ` It stays off until you ${needs.signIn ? 'sign in' : `add ${needs.secrets.map((s) => clampText(s, 40)).join(', ')}`}.` : ''}
        </span>
      </span>
      <span className="row gap-2">
        {needs && onSetup && (
          <Button size="sm" onClick={onSetup} testId="capability-setup">
            Finish setup
          </Button>
        )}
        {info.superseded ? (
          <span className="hint" data-testid="capability-undo-gone">
            Can&apos;t undo after a later change
          </span>
        ) : (
          <Button size="sm" variant="ghost" icon={Undo2} loading={busy} ariaLabel={`Undo ${info.name}`} testId="capability-undo" onClick={onUndo}>
            Undo
          </Button>
        )}
      </span>
      {error && (
        <p className="capability-warn" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
