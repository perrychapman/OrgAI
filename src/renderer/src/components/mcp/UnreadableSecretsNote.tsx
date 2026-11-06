import type { ReactElement } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { UnreadableSecretSlot } from '@shared/types'
import { appSecretReason } from '@shared/view/secretNotices'
import { Icon } from '../ui/Icon'

/** Slots whose saved value cannot be read here, with why, in the app's words (no terminal command; the Dashboard notice has the buttons). */
export function UnreadableSecretsNote({ slots }: { slots: UnreadableSecretSlot[] | undefined }): ReactElement | null {
  if (!slots?.length) return null
  return (
    <>
      {slots.map((s) => (
        <p key={s.name} className="mcp-row-note warn" role="status" data-testid="mcp-unreadable-secret" data-name={s.name}>
          <Icon icon={TriangleAlert} size="sm" />
          <span>
            <span className="mono">{s.name}</span> cannot be read: {appSecretReason(s.reason)}
          </span>
        </p>
      ))}
    </>
  )
}
