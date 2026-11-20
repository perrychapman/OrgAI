import type { ReactElement, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import type { NoticeKind, TeamNotice } from '../../lib/teamNotices'

const KIND_ICON = { error: CircleAlert, edit: CircleCheck, session: Info, saved: CircleCheck, hint: Info } as const

export interface TeamNoticeRowProps {
  /** The message to show now (highest priority), or null when there is nothing to say. */
  current: TeamNotice | null
  /** The messages waiting behind it, in the order they would come up. */
  waiting: TeamNotice[]
  onAction: (notice: TeamNotice, actionId: string) => void
  onDismiss: (notice: TeamNotice) => void
  /** The control that held focus (Undo, Got it, Dismiss) went away with its message: put focus somewhere useful. */
  onFocusLost: () => void
  /** The right-hand slot (the chart legend, phase 5). */
  end?: ReactNode
}

/**
 * The Team tab's notice row (docs/design/team-tab-overhaul.md 1.5). Always rendered at a fixed 32 px so the stage never
 * moves when a message appears or goes: one message, clamped to one line with the full text in `title`, its actions, and
 * `+N` for what is waiting. A polite status region (stable and empty while idle).
 */
export default function TeamNoticeRow({ current, waiting, onAction, onDismiss, onFocusLost, end }: TeamNoticeRowProps): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  const lostRef = useRef(onFocusLost)
  lostRef.current = onFocusLost

  // Whether a control of the row held focus when its message last changed. Focus that moved to another control, or a
  // click elsewhere, is not a loss; a control removed under focus reports neither and keeps the flag.
  useEffect(() => {
    const el = rowRef.current
    if (!el) return undefined
    const onIn = (): void => {
      hadFocus.current = true
    }
    const onOut = (e: FocusEvent): void => {
      if (e.relatedTarget) hadFocus.current = false
    }
    const onPointer = (): void => {
      hadFocus.current = false
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [])

  // The message that held focus went away (Undo or Got it pressed, or it expired under the keyboard): after the commit
  // focus sits on the body, so hand it on.
  const identity = current ? `${current.key}|${current.text}|${current.actions?.map((a) => a.id).join(',') ?? ''}` : ''
  useLayoutEffect(() => {
    if (!hadFocus.current) return
    const a = document.activeElement
    if (!a || a === document.body) {
      hadFocus.current = false
      lostRef.current()
    }
  }, [identity])

  return (
    <div className="team-notice-row" ref={rowRef} role="status" aria-live="polite" data-testid="team-notice-row" data-has-message={current ? 'true' : 'false'}>
      <div className="team-notice-main">
        {current && (
          <>
            <span className={`team-notice-icon kind-${current.kind}`} aria-hidden="true">
              <Icon icon={KIND_ICON[current.kind as NoticeKind]} size="sm" />
            </span>
            <span className="team-notice-text" data-kind={current.kind} data-testid={current.testId} data-notice-key={current.key} title={current.title ?? current.text}>
              {current.text}
            </span>
          </>
        )}
      </div>
      {current && (
        <div className="team-notice-actions">
          {waiting.length > 0 && (
            <Popover
              label="More messages"
              role="dialog"
              placement="top-end"
              className="team-notice-waiting"
              testId="team-notice-waiting"
              triggerTestId="team-notice-more"
              triggerClassName="link-btn team-notice-more"
              triggerLabel={`${waiting.length} more ${waiting.length === 1 ? 'message' : 'messages'}`}
              trigger={<>+{waiting.length}</>}
            >
              <ul className="team-notice-list">
                {waiting.map((n) => (
                  <li key={n.key} data-kind={n.kind}>
                    <span>{n.text}</span>
                    {/* A waiting message keeps its actions (an add's Undo behind a newer "Saved" confirmation). */}
                    {n.actions?.map((a) => (
                      <Button key={a.id} size="sm" variant="ghost" loading={a.busy} onClick={() => onAction(n, a.id)}>
                        {a.label}
                      </Button>
                    ))}
                    {n.dismissible && (
                      <Button size="sm" variant="ghost" onClick={() => onDismiss(n)}>
                        Dismiss
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Popover>
          )}
          {current.actions?.map((a) => (
            <Button key={a.id} size="sm" variant="ghost" loading={a.busy} onClick={() => onAction(current, a.id)} testId={a.testId}>
              {a.label}
            </Button>
          ))}
          {current.dismissible && <IconButton icon={X} label="Dismiss notice" size="sm" onClick={() => onDismiss(current)} testId="team-notice-dismiss" />}
        </div>
      )}
      {end && <div className="team-notice-end">{end}</div>}
    </div>
  )
}
