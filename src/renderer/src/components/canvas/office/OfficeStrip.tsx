import { useState, type ReactElement } from 'react'
import type { AgentMessage } from '@shared/types'
import { bubbleText } from '../../../lib/office/motion'
import { Button } from '../../ui/Button'

/**
 * The message strip under the stage: a log of the run's last three messages (three 24 px rows, height reserved even when empty), newest first (rework spec section 4).
 * It never replays anything; each row names both ends, carries the (trimmed) text and a `Show {To}` button.
 */
export interface OfficeStripProps {
  mode: 'live' | 'team' | 'sample'
  /** Motion is off (reduced motion or Pause): the scheduler counters read 0, the log still shows. */
  motionOff: boolean
  /** Display name per agent id (the people who are present). */
  names: ReadonlyMap<string, string>
  /** The last messages of this run, newest first (`recentMessages`). */
  messages: readonly AgentMessage[]
  active: number
  queued: number
  /** Select the recipient, pan to them and ring them. */
  onShow?(id: string): void
}

const rowKeys = new WeakMap<AgentMessage, number>()
let nextRow = 1
/** One stable key per message object: a Show button keeps focus while newer rows push it down. */
function rowKey(message: AgentMessage): number {
  let key = rowKeys.get(message)
  if (key === undefined) { key = nextRow++; rowKeys.set(message, key) }
  return key
}

/** Names in a row are bounded so one long unbroken name cannot crowd out the message; the full name stays in the title and accessible name. */
const NAME_LIMIT = 24
function clipName(name: string): string {
  const chars = Array.from(name)
  return chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT - 1).join('')}…` : name
}

export function OfficeStrip({ mode, motionOff, names, messages, active, queued, onShow }: OfficeStripProps): ReactElement {
  // While keyboard focus is inside the strip the rows hold still, so the rolling log never removes the focused Show
  // button (focus would drop to the page). Newer messages appear as soon as focus leaves the strip.
  const [held, setHeld] = useState<readonly AgentMessage[] | null>(null)
  const latest = mode === 'live' ? messages : []
  const rows = held ?? latest
  return <div
    className="office-message-strip" role="region" aria-label="Office message deliveries" tabIndex={rows.length ? 0 : undefined}
    data-office-strip-held={held ? 'true' : undefined}
    onFocus={() => { if (!held) setHeld(latest) }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(null) }}
  >
    {mode === 'live' && !rows.length && <p className="office-delivery-empty">Messages appear here as agents communicate.</p>}
    <div data-testid="office-deliveries" data-active={mode === 'live' && !motionOff ? active : 0} data-queued={mode === 'live' && !motionOff ? queued : 0}>
      {rows.map(message => {
        const from = names.get(message.from) ?? message.from
        const to = message.to ? names.get(message.to) ?? message.to : 'team'
        const present = !!message.to && names.has(message.to)
        return <div key={rowKey(message)} className="office-strip-row" data-testid="office-caption" title={`${from} to ${to}: ${message.text}`}>
          <span className="office-strip-text">{clipName(from)} to {clipName(to)} · {bubbleText(message.text)}</span>
          <span className="office-full-message"> Full available message: {message.text}</span>
          {present && onShow && <Button size="sm" testId="office-show" ariaLabel={`Show ${to}`} title={`Show ${to}`} onClick={() => onShow(message.to!)}>Show {clipName(to)}</Button>}
        </div>
      })}
    </div>
  </div>
}
