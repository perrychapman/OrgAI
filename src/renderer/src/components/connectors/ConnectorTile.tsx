import type { ReactElement } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, KeyRound, LogIn, TriangleAlert, Wrench, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ConnectorEase, ConnectorInfo } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { EASE_BADGE, clampText, infoEase, stateChip, tileAction } from '../../lib/connectors'
import { ConnectorLogo } from './ConnectorLogo'

const CHIP_ICON = { success: CircleCheck, warning: TriangleAlert, danger: CircleAlert, neutral: CircleDashed }
const EASE_ICON: Record<ConnectorEase, LucideIcon> = { signIn: LogIn, none: Zap, token: KeyRound, ownApp: Wrench }

/** The method badge (icon and words): how much work connecting this service takes. */
export function EaseBadge({ ease }: { ease: ConnectorEase }): ReactElement {
  const b = EASE_BADGE[ease]
  return (
    <Badge tone={b.tone} icon={EASE_ICON[ease]} testId="connector-ease">
      {b.label}
    </Badge>
  )
}

/** One service in the gallery: logo, name, one line, and one badge plus one button. */
export function ConnectorTile({ info, onOpen }: { info: ConnectorInfo; onOpen: () => void }): ReactElement {
  const def = info.connector
  const ease = infoEase(info)
  const action = tileAction(info)
  const available = info.state === 'available'
  const chip = stateChip(info)
  const rawAccount = info.state === 'connected' ? info.library?.auth.account : undefined
  const account = rawAccount ? clampText(rawAccount, 200) : undefined
  return (
    <li className="connector-tile" data-testid="connector-tile" data-connector={def.id} data-state={info.state} data-ease={ease}>
      <ConnectorLogo def={def} />
      <div className="connector-tile-main">
        <span className="connector-name">{def.name}</span>
        <span className="connector-meta">
          {available ? (
            <span data-ease={ease} data-testid="connector-ease-wrap">
              <EaseBadge ease={ease} />
            </span>
          ) : (
            <span className="connector-state" data-testid="connector-state" data-tone={chip.tone}>
              <Badge tone={chip.tone === 'warning' ? 'attention' : chip.tone} icon={CHIP_ICON[chip.tone]}>
                {account ? 'Connected' : chip.label}
              </Badge>
              {account && (
                <span className="connector-account" title={account}>
                  {account}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="connector-desc" title={def.description}>
          {def.description}
        </span>
      </div>
      <div className="connector-tile-act">
        <Button size="sm" variant={action.primary ? 'primary' : 'secondary'} testId="connector-action" ariaLabel={action.aria} onClick={onOpen}>
          {action.label}
        </Button>
      </div>
    </li>
  )
}
