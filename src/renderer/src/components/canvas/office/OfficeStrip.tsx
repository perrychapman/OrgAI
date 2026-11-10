import type { ReactElement } from 'react'
import type { Delivery } from '../../../lib/office/scheduler'

/**
 * The message strip under the stage. Slice S2 ports the current captions without the floor clause; slice S5b turns it
 * into the 48 px log (last three messages of the run, `Show {To}` buttons calling `onShow`).
 */
export interface OfficeStripProps {
  mode: 'live' | 'team' | 'sample'
  /** Motion is off (reduced motion or Pause): the scheduler counters read 0, the captions still show. */
  motionOff: boolean
  /** Display name per agent id. */
  names: ReadonlyMap<string, string>
  /** Active deliveries between people who are both present. */
  deliveries: readonly Delivery[]
  active: number
  queued: number
  /** Select the recipient, pan to them and ring them (S5b wires the `Show` buttons). */
  onShow?(id: string): void
}

export function OfficeStrip({ mode, motionOff, names, deliveries, active, queued }: OfficeStripProps): ReactElement {
  return <div className="office-message-strip" role="region" aria-label="Office message deliveries" tabIndex={deliveries.length ? 0 : undefined}>
    {mode === 'live' && !deliveries.length && <p className="office-delivery-empty">Messages appear here as agents communicate.</p>}
    <div data-testid="office-deliveries" data-active={mode === 'live' && !motionOff ? active : 0} data-queued={mode === 'live' && !motionOff ? queued : 0}>
      {deliveries.slice(0, 3).map((delivery, index) => {
        const { message } = delivery
        const text = message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text
        return <p key={index} data-testid="office-caption" title={message.text}>
          {names.get(message.from) ?? message.from} to {message.to ? names.get(message.to) ?? message.to : 'team'} · {text}{delivery.count > 1 ? ` (${delivery.count} messages)` : ''}
          <span className="office-full-message"> Full available message: {message.text}</span>
        </p>
      })}
    </div>
  </div>
}
