import type { CSSProperties, ReactElement } from 'react'
import type { ConnectorDef } from '@shared/types'
import { connectorHue, connectorInitial } from '../../lib/connectors'
import { BrandMark } from '../brand/BrandMark'
import { brandMark } from '../brand/brandMarks'

/** A vendor mark (bundled inline SVG) on a neutral tile, or an initial on a tinted tile when none exists.
 * No external images are ever loaded. */
export function ConnectorLogo({ def, size = 'md' }: { def: Pick<ConnectorDef, 'id' | 'name'>; size?: 'sm' | 'md' | 'lg' }): ReactElement {
  if (brandMark(def.id)) {
    return (
      <span className={`connector-logo has-mark size-${size}`} aria-hidden="true">
        <BrandMark id={def.id} />
      </span>
    )
  }
  return (
    <span className={`connector-logo size-${size}`} style={{ '--connector-hue': connectorHue(def.id) } as CSSProperties} aria-hidden="true">
      {connectorInitial(def)}
    </span>
  )
}
