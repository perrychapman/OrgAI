import type { ReactElement } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, Loader } from 'lucide-react'
import type { ConnectionStatus } from '@shared/types'
import { Badge, type BadgeTone } from './Badge'

const MAP: Record<ConnectionStatus['state'], { tone: BadgeTone; label: string; icon: typeof Loader }> = {
  disconnected: { tone: 'neutral', label: 'Not connected', icon: CircleDashed },
  connecting: { tone: 'info', label: 'Connecting', icon: Loader },
  connected: { tone: 'success', label: 'Connected', icon: CircleCheck },
  error: { tone: 'danger', label: 'Error', icon: CircleAlert }
}

/** Status label for a connection: icon plus words, never color alone. */
export function ConnectionStatusBadge({ state, testId }: { state: ConnectionStatus['state']; testId?: string }): ReactElement {
  const m = MAP[state]
  return (
    <Badge tone={m.tone} icon={m.icon} spin={state === 'connecting'} testId={testId}>
      {m.label}
    </Badge>
  )
}
