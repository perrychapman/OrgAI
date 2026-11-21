import type { CSSProperties, ReactElement } from 'react'
import { useId } from 'react'
import { formatDuration, type CostInput } from '../../lib/cost'
import { useCountUp } from '../../lib/useCountUp'
import { MOVE_GLYPH, type StatCard } from '../../lib/weekRecap'
import { Cost } from '../ui/Cost'
import Sparkline from '../usage/Sparkline'

/**
 * The four stat cards of Your week (docs/design/dashboard-usage-redesign components/StatCards): a figure, how it moved
 * against the 7 days before, and an area sparkline. Each card is ONE native button that opens Usage on the same 7 days
 * (the caller decides with which metric). The focus figure leads and draws its sparkline in the accent text colour; the
 * others in secondary text. A rising cost is not coloured as bad: the movement line is text and a glyph, never colour.
 *
 * Motion: figures count up and sparklines wipe in only while the page arrives (`arriving`); a live change tweens the
 * figure alone; `still` (reduced motion, Pause motion) shows the final values. The accessible name is static, so the
 * counting frames are never announced.
 */

const noop = (): void => undefined

/** The figure of one card: counted up, formatted exactly like its final text so the shape never changes. */
function Figure({ card, arriving, still }: { card: StatCard; arriving: boolean; still: boolean }): ReactElement {
  const shown = useCountUp(card.value, { arriving, still })
  if (shown === null || card.value === null) {
    return (
      <span className="dash-stat-value" data-testid="dash-stat-value" data-word="">
        {card.text}
      </span>
    )
  }
  let content: ReactElement | string
  if (card.id === 'spend' && card.cost) {
    const input: CostInput = { ...card.cost, costUsd: shown }
    content = <Cost value={input} compact />
  } else if (card.id === 'time') {
    content = `${formatDuration(Math.round(shown))}${card.partial ? '+' : ''}`
  } else {
    content = `${Math.round(shown)}${card.partial ? '+' : ''}`
  }
  return (
    <span className="dash-stat-value" data-testid="dash-stat-value">
      {content}
    </span>
  )
}

function Move({ card }: { card: StatCard }): ReactElement {
  const m = card.movement
  return (
    <span className="dash-stat-move" data-dir={m.dir} data-testid="dash-stat-move">
      {(m.dir === 'up' || m.dir === 'down') && (
        <span className="dash-stat-glyph" aria-hidden="true">
          {MOVE_GLYPH[m.dir]}
        </span>
      )}
      <span className="dash-stat-move-text">{m.text}</span>
    </span>
  )
}

export function StatCards({
  cards,
  arriving,
  still,
  pending,
  onOpen
}: {
  cards: readonly StatCard[]
  arriving: boolean
  still: boolean
  /** History is still loading: the cards hold their place with a dash, and never read as zero. */
  pending?: boolean
  onOpen: (card: StatCard) => void
}): ReactElement {
  const helpId = useId()
  const draw = arriving && !still
  return (
    <ul className="dash-stats" data-testid="dash-stats" data-count={cards.length}>
      {cards.map((c, i) => (
        <li
          key={c.id}
          className={draw ? 'dash-stat motion-enter' : 'dash-stat'}
          style={{ '--i': i } as CSSProperties}
          data-testid="dash-stat"
          data-stat={c.id}
          data-focus={i === 0 ? '' : undefined}
        >
          <button
            type="button"
            className="dash-stat-btn"
            data-testid={`dash-stat-${c.id}`}
            aria-label={pending ? `${c.label}, loading` : c.name}
            aria-describedby={c.help ? `${helpId}-${c.id}` : undefined}
            aria-busy={pending ? true : undefined}
            title={c.help || undefined}
            onClick={() => onOpen(c)}
          >
            <span className="dash-stat-label">{c.label}</span>
            {pending ? <span className="dash-stat-value">-</span> : <Figure card={c} arriving={arriving} still={still} />}
            {pending ? <span className="dash-stat-move" /> : <Move card={c} />}
            <span className="dash-stat-spark" aria-hidden="true">
              {!pending && <Sparkline points={c.series} active={null} onScrub={noop} area draw={draw} />}
            </span>
          </button>
          {c.help && (
            <span id={`${helpId}-${c.id}`} className="sr-only">
              {c.help}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
