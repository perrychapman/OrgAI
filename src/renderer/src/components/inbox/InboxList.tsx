import type { ReactElement } from 'react'
import { Button } from '../ui/Button'
import { oneLine } from '../../lib/decisionTitle'
import { showHidden } from '../../lib/hiddenChars'
import { relativeAgo, rowName, type InboxItem } from '../../lib/inbox'

function Row({ item, selected, now, onSelect }: { item: InboxItem; selected: boolean; now: number; onSelect: (id: string) => void }): ReactElement {
  const when = relativeAgo(item.at, now)
  return (
    <li>
      <button
        type="button"
        className="inbox-row"
        data-testid="inbox-row"
        data-id={item.id}
        data-kind={item.kind}
        data-group={item.group}
        aria-current={selected ? 'true' : undefined}
        tabIndex={selected ? 0 : -1}
        aria-label={rowName(item, when)}
        onClick={() => onSelect(item.id)}
      >
        <span className={item.group === 'waiting' ? 'inbox-dot waiting motion-breathe' : item.kind === 'failed' ? 'inbox-dot failed' : 'inbox-dot done'} aria-hidden="true" />
        <span className="inbox-row-text">
          <span className="inbox-row-title">{oneLine(showHidden(item.title), 200)}</span>
          <span className="inbox-row-sub">
            {oneLine(showHidden(item.who), 120)} · {oneLine(showHidden(item.projectName), 80)}
          </span>
        </span>
        <span className="inbox-row-meta" aria-hidden="true">
          <span className="inbox-row-when">{when}</span>
          <span className="inbox-row-kind">{item.kindLabel}</span>
        </span>
      </button>
    </li>
  )
}

/**
 * The left pane: glass sections, one row per item, one Tab stop (the selected row; arrows, J and K move it, the view
 * handles the keys). `waiting` and `finished` are already filtered.
 */
export default function InboxList({
  waiting,
  finished,
  saysNothingWaiting,
  selectedId,
  now,
  onSelect,
  onMarkAllRead
}: {
  waiting: readonly InboxItem[]
  finished: readonly InboxItem[]
  /** Draw the Waiting section with "Nothing is waiting on you." when it is empty (only while no chip hides waiting items). */
  saysNothingWaiting: boolean
  selectedId: string | null
  now: number
  onSelect: (id: string) => void
  onMarkAllRead: () => void
}): ReactElement {
  return (
    <section className="inbox-list" aria-label="Inbox items" data-testid="inbox-list">
      {(waiting.length > 0 || (saysNothingWaiting && finished.length > 0)) && (
        <div className="glass inbox-section" data-testid="inbox-section-waiting" data-empty={waiting.length === 0 ? '' : undefined}>
          <h2 className="inbox-section-title waiting">Waiting on you</h2>
          {waiting.length > 0 ? (
            <ul className="inbox-rows">
              {waiting.map((it) => (
                <Row key={it.id} item={it} selected={it.id === selectedId} now={now} onSelect={onSelect} />
              ))}
            </ul>
          ) : (
            <p className="inbox-section-empty">Nothing is waiting on you.</p>
          )}
        </div>
      )}
      {finished.length > 0 && (
        <div className="glass inbox-section" data-testid="inbox-section-finished">
          <div className="inbox-section-head">
            <h2 className="inbox-section-title">Finished since you last looked</h2>
            <Button variant="ghost" size="sm" testId="inbox-mark-read" onClick={onMarkAllRead}>
              Mark all read
            </Button>
          </div>
          <ul className="inbox-rows">
            {finished.map((it) => (
              <Row key={it.id} item={it} selected={it.id === selectedId} now={now} onSelect={onSelect} />
            ))}
          </ul>
        </div>
      )}
      <p className="inbox-keys" data-testid="inbox-keys">
        <span>
          <kbd className="kbd-hint">J</kbd> <kbd className="kbd-hint">K</kbd> move
        </span>
        <span>
          <kbd className="kbd-hint">Enter</kbd> go to the main action
        </span>
        <span>
          <kbd className="kbd-hint">Esc</kbd> back to the list
        </span>
      </p>
    </section>
  )
}
