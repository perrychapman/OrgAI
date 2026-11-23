import type { ReactElement, ReactNode } from 'react'
import type { KeyboardEvent } from 'react'
import { isValidElement, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { decisionFocus } from './DecisionCard'
import PermissionCard from './PermissionCard'
import QuestionCard from './QuestionCard'
import RuleRequestCard from './RuleRequestCard'
import ProposalCard from './ProposalCard'
import MergeReviewCard from './MergeReviewCard'
import McpInstallCard from './McpInstallCard'
import { breakdownLine, setAlwaysAllowReceipt, useAlwaysAllowReceipt, type DecisionKindName } from '../lib/decisionCard'
import { useArrival } from '../lib/useArrival'
import { Icon } from './ui/Icon'

export interface DecisionItem {
  key: string
  /** Short action text for the list ("Run npm test", "Question"). Rendered as plain text, never as markup. */
  label: string
  node: ReactNode
}

/** The kind of a pending card, from the component its node renders (the tray's callers hand over nodes, not kinds). */
function kindOf(node: ReactNode): DecisionKindName | null {
  const t = isValidElement(node) ? node.type : null
  if (t === PermissionCard) return 'permission'
  if (t === QuestionCard) return 'question'
  if (t === RuleRequestCard) return 'rules'
  if (t === ProposalCard) return 'proposal'
  if (t === MergeReviewCard) return 'merge'
  if (t === McpInstallCard) return 'install'
  return null
}

function runIdOf(node: ReactNode): string | null {
  const id = isValidElement(node) ? (node.props as { runId?: unknown }).runId : undefined
  return typeof id === 'string' ? id : null
}

/** After "Always allow": says what was saved, that the allowed action stays done, and offers to remove the saved rule. */
function AlwaysAllowReceiptLine({ runId }: { runId: string | null }): ReactElement | null {
  const receipt = useAlwaysAllowReceipt()
  const [state, setState] = useState<{ key: string; phase: 'idle' | 'busy' | 'removed' | 'failed' }>({ key: '', phase: 'idle' })
  const key = receipt ? `${receipt.runId}|${receipt.rules.join('|')}` : ''
  const phase = state.key === key ? state.phase : 'idle'
  // A receipt is a short-lived note, not a record: it goes after a minute (or at once when another run is shown).
  useEffect(() => {
    if (!receipt) return undefined
    const t = setTimeout(() => setAlwaysAllowReceipt(null), 60_000)
    return () => clearTimeout(t)
  }, [receipt])
  if (!receipt || (runId && receipt.runId !== runId)) return null
  const undo = async (): Promise<void> => {
    setState({ key, phase: 'busy' })
    try {
      for (const rule of receipt.rules) await window.orgai.permissions.remove({ projectId: receipt.projectId, rule })
      setState({ key, phase: 'removed' })
    } catch {
      setState({ key, phase: 'failed' })
    }
  }
  const many = receipt.rules.length > 1
  return (
    <div className="decision-receipt" data-testid="decision-receipt" data-phase={phase}>
      <p role="status" className="decision-receipt-text">
        {phase === 'removed'
          ? `${many ? 'Rules' : 'Rule'} removed. Matching calls will ask again.`
          : phase === 'failed'
            ? `The ${many ? 'rules were' : 'rule was'} not removed. You can remove ${many ? 'them' : 'it'} in project Settings.`
            : `Saved ${many ? `${receipt.rules.length} rules` : 'a rule'}: `}
        {phase !== 'removed' && phase !== 'failed' && (
          <>
            <code className="decision-receipt-rule">{receipt.rules.join(', ')}</code>. Removing it does not take back the action you already allowed.
          </>
        )}
      </p>
      {(phase === 'idle' || phase === 'busy') && (
        <button type="button" className="btn ghost sm" data-testid="decision-receipt-undo" disabled={phase === 'busy'} onClick={() => void undo()}>
          Undo
        </button>
      )}
      <button type="button" className="btn ghost sm" data-testid="decision-receipt-dismiss" onClick={() => setAlwaysAllowReceipt(null)}>
        Dismiss
      </button>
    </div>
  )
}

/**
 * The open decisions of a run: when there are several, a list of all of them (one chip each, with a count and
 * previous/next) above the selected card. The cards come through unchanged; only one is mounted at a time, so a
 * card never loses its draft text because a sibling arrived. `onPin` fires on the first touch inside the card.
 */
export default function DecisionTray({
  items,
  selected,
  onSelect,
  onPin
}: {
  items: DecisionItem[]
  selected: number
  onSelect: (index: number) => void
  onPin: () => void
}): ReactElement | null {
  const listRef = useRef<HTMLUListElement>(null)
  // Keep the selected chip in view when stepping with Previous/Next.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [selected, items.length])
  // The chips are one Tab stop (roving tabindex): the focused chip, else the selected one.
  const [focused, setFocused] = useState<number | null>(null)
  // Arrival rule: a card present at mount (relaunch, pending cards) never animates; one that arrives while the user is
  // here enters with a rise and a one-shot ring. A switch between cards already there is a short view fade. The class
  // is decided once per shown card (a running animation must keep its class) and never speaks: tray-announce does.
  const isNew = useArrival(
    items.map((it) => it.key),
    'tray'
  )
  const shownKey = (items[selected] ?? items[items.length - 1])?.key
  const motion = useRef<{ key: string | undefined; cls: string | undefined }>({ key: undefined, cls: undefined })
  if (shownKey !== undefined && motion.current.key !== shownKey) {
    const hadCard = motion.current.key !== undefined
    motion.current = { key: shownKey, cls: isNew(shownKey) ? 'motion-enter-xl motion-ring' : hadCard ? 'motion-view' : undefined }
  }
  // The run these cards belong to; remembered so the receipt still shows once the last card has gone.
  const lastRun = useRef<string | null>(null)
  const nowRun = items.length > 0 ? runIdOf(items[0].node) : null
  if (nowRun) lastRun.current = nowRun
  if (items.length === 0) {
    motion.current = { key: undefined, cls: undefined }
    return lastRun.current ? <AlwaysAllowReceiptLine runId={lastRun.current} /> : null
  }
  const breakdown = breakdownLine(items.map((it) => kindOf(it.node)).filter((k): k is DecisionKindName => k !== null))
  const rover = Math.min(focused ?? selected, items.length - 1)
  const onChipKey = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const to = e.key === 'ArrowRight' ? Math.min(i + 1, items.length - 1) : e.key === 'ArrowLeft' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    setFocused(to)
    listRef.current?.querySelectorAll<HTMLElement>('.decision-chip')[to]?.focus()
  }
  const go = (to: number): void => {
    decisionFocus.suppress = true
    onSelect(to)
  }
  const current = items[selected] ?? items[items.length - 1]
  return (
    <>
      {items.length > 1 && (
        <div className="decision-stepper" role="group" aria-label="Pending decisions">
          <span className="decision-stepper-title">
            <span className="decision-waiting-dot motion-breathe" aria-hidden="true" />
            <span className="decision-count">{items.length}</span> waiting on you
            {breakdown && (
              <span className="decision-breakdown" data-testid="decision-breakdown">
                {breakdown}
              </span>
            )}
          </span>
          <ul
            className="decision-list"
            ref={listRef}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null)
            }}
          >
            {items.map((it, i) => (
              <li key={it.key}>
                <button
                  type="button"
                  className="decision-chip"
                  aria-current={i === selected ? 'true' : undefined}
                  aria-label={`Decision ${i + 1}: ${it.label}`}
                  title={it.label}
                  tabIndex={i === rover ? 0 : -1}
                  onFocus={() => setFocused(i)}
                  onKeyDown={(e) => onChipKey(e, i)}
                  onClick={() => go(i)}
                >
                  <span className="decision-chip-n">{i + 1}</span>
                  <span className="decision-chip-label">{it.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <span className="decision-steps">
            <button
              type="button"
              className="icon-btn size-sm"
              aria-label="Previous decision"
              title="Previous decision"
              aria-disabled={selected === 0 || undefined}
              onClick={() => {
                if (selected > 0) go(selected - 1)
              }}
            >
              <Icon icon={ChevronLeft} size="sm" />
            </button>
            <span>
              {selected + 1} of {items.length}
            </span>
            <button
              type="button"
              className="icon-btn size-sm"
              aria-label="Next decision"
              title="Next decision"
              aria-disabled={selected === items.length - 1 || undefined}
              onClick={() => {
                if (selected < items.length - 1) go(selected + 1)
              }}
            >
              <Icon icon={ChevronRight} size="sm" />
            </button>
          </span>
        </div>
      )}
      <div key={current.key} className={motion.current.cls ? `decision ${motion.current.cls}` : 'decision'} onPointerDownCapture={onPin} onKeyDownCapture={onPin}>
        {current.node}
      </div>
      <AlwaysAllowReceiptLine runId={lastRun.current} />
    </>
  )
}
