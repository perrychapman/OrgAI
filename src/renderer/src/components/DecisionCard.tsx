import type { ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { initials } from '../lib/layout'
import { Badge, type BadgeTone } from './ui/Badge'
import { Banner } from './ui/Banner'
import { RunLabel } from './RunLabel'

export type DecisionKind = 'permission' | 'rules' | 'question' | 'proposal' | 'install' | 'merge'

const KIND: Record<DecisionKind, { label: string; tone: BadgeTone }> = {
  permission: { label: 'Permission', tone: 'warning' },
  rules: { label: 'Rule', tone: 'warning' },
  question: { label: 'Question', tone: 'info' },
  proposal: { label: 'Proposal', tone: 'accent' },
  install: { label: 'MCP install', tone: 'warning' },
  merge: { label: 'Merge', tone: 'info' }
}

interface Props {
  kind: DecisionKind
  /** The run this decision belongs to (named above the header). */
  runId: string
  /** The asking agent's display name. */
  who?: string
  /** What is asked, one line. The full text belongs in the body. */
  title: string
  /** Extra header content right of the title (e.g. a branch name). */
  headerExtra?: ReactNode
  /** Body: detail, capped in height with its own scroll. */
  children?: ReactNode
  /** Helper text under the body, always visible (scope explanations). */
  helper?: ReactNode
  /** Footer, leftmost: the one primary action (a Button variant primary). */
  primary?: ReactNode
  /** Footer, after the primary: scope buttons or menu (secondary Buttons). */
  secondary?: ReactNode
  /** Footer, rightmost: the quiet danger button (Button variant danger). */
  deny?: ReactNode
  /** Skip moving focus on mount (a card that is only a record, e.g. an answered install). */
  noAutoFocus?: boolean
  /** A failed answer, shown above the footer so the buttons stay in place. */
  error?: string | null
  testId?: string
}

/**
 * Busy and error state for answering a decision. `submit` runs the (possibly async) answer: busy stays on while it is
 * in flight and after it succeeds (the card goes away), and clears with the error shown when it rejects.
 */
export function useDecisionAnswer(): { busy: boolean; error: string | null; submit: (run: () => void | Promise<void>) => Promise<void>; reset: () => void } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = useCallback(async (run: () => void | Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await run()
    } catch (e) {
      setBusy(false)
      const raw = e instanceof Error ? e.message : ''
      setError(raw.replace(/^(Error invoking remote method '[^']*': )?(Error: )?/, '') || 'The answer could not be delivered. Try again.')
    }
  }, [])
  const reset = useCallback(() => {
    setBusy(false)
    setError(null)
  }, [])
  return { busy, error, submit, reset }
}

/** Set by the tray stepper just before it swaps cards: the next card mount keeps focus where it is. */
export const decisionFocus = { suppress: false }

/** True when the user is in the middle of typing in a text field; a new card must not steal focus then. */
function typingElsewhere(card: HTMLElement | null): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return false
  return !card?.contains(el) && el.value.length > 0
}

/**
 * The one shape of every decision (spec 12.1): header (kind chip, who, what, run), a body that scrolls on its own, and
 * a footer that is always visible. On mount focus goes to the primary button (M15) unless the user is typing.
 */
export default function DecisionCard({ kind, runId, who, title, headerExtra, children, helper, primary, secondary, deny, noAutoFocus, error, testId }: Props): ReactElement {
  const ref = useRef<HTMLElement>(null)
  const k = KIND[kind]
  useEffect(() => {
    if (decisionFocus.suppress) {
      decisionFocus.suppress = false
      return
    }
    if (noAutoFocus) return
    const card = ref.current
    if (!card || typingElsewhere(card)) return
    const target =
      card.querySelector<HTMLElement>('.decision-footer .btn.primary:not([disabled])') ??
      card.querySelector<HTMLElement>('.decision-body input:not([disabled]), .decision-body textarea:not([disabled]), .decision-body summary, .decision-body button:not([disabled])') ??
      card.querySelector<HTMLElement>('.decision-footer button:not([disabled])')
    target?.focus()
    // Mount only: later renders (a body change) must not pull focus back.
  }, [noAutoFocus])
  return (
    <article ref={ref} className={`decision-card kind-${kind}`} aria-label={`${k.label}: ${title}`} data-kind={kind} data-testid={testId}>
      <div className="decision-run">
        <RunLabel runId={runId} />
      </div>
      <header className="decision-head">
        <Badge tone={k.tone}>{k.label}</Badge>
        {who && (
          <span className="decision-who" title={who}>
            <span className="decision-avatar" aria-hidden="true">
              {initials(who)}
            </span>
            <span className="decision-who-name">{who}</span>
          </span>
        )}
        <span className="decision-title" title={title}>
          {title}
        </span>
        {headerExtra}
      </header>
      {children !== undefined && children !== null && <div className="decision-body">{children}</div>}
      {helper && <div className="decision-helper">{helper}</div>}
      {error && (
        <div className="decision-error">
          <Banner tone="danger" title="The answer was not delivered">
            {error}
          </Banner>
        </div>
      )}
      <footer className="decision-footer">
        {primary}
        {secondary && <div className="decision-secondary">{secondary}</div>}
        {deny && <div className="decision-deny">{deny}</div>}
      </footer>
    </article>
  )
}
