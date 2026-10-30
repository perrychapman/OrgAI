import type { CSSProperties, ReactElement } from 'react'
import type { ConnectorDef } from '@shared/types'
import { connectorHue, connectorInitial } from '../../lib/connectors'

/** An initial on a tinted tile; the hue is stable per connector. No external images are ever loaded. */
export function ConnectorLogo({ def, size = 'md' }: { def: Pick<ConnectorDef, 'id' | 'name'>; size?: 'md' | 'lg' }): ReactElement {
  return (
    <span className={`connector-logo size-${size}`} style={{ '--connector-hue': connectorHue(def.id) } as CSSProperties} aria-hidden="true">
      {connectorInitial(def)}
    </span>
  )
}
