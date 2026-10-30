import type { ReactElement } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, TriangleAlert } from 'lucide-react'
import type { ConnectorInfo } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { CATEGORY_LABELS, clampText, stateChip } from '../../lib/connectors'
import { ConnectorLogo } from './ConnectorLogo'

const CHIP_ICON = { success: CircleCheck, warning: TriangleAlert, danger: CircleAlert, neutral: CircleDashed }

/** The primary action's words for a state. */
export function actionLabel(state: ConnectorInfo['state']): string {
  if (state === 'connected') return 'Manage'
  if (state === 'needsSetup') return 'Finish setup'
  if (state === 'error') return 'Fix'
  return 'Connect'
}

/** One service in the gallery. */
export function ConnectorTile({ info, onOpen }: { info: ConnectorInfo; onOpen: () => void }): ReactElement {
  const def = info.connector
  const chip = stateChip(info)
  const rawAccount = info.state === 'connected' ? info.library?.auth.account : undefined
  const account = rawAccount ? clampText(rawAccount, 200) : undefined
  const label = actionLabel(info.state)
  return (
    <li className="connector-tile" data-testid="connector-tile" data-connector={def.id} data-state={info.state}>
      <div className="connector-tile-head">
        <ConnectorLogo def={def} />
        <div className="connector-tile-id">
          <h4 className="connector-name">{def.name}</h4>
          <span className="connector-cat">{CATEGORY_LABELS[def.category]}</span>
        </div>
      </div>
      <p className="connector-desc">{def.description}</p>
      <div className="connector-badges">
        <Badge tone="info">Official</Badge>
        {def.status === 'preview' && <Badge tone="neutral">Preview</Badge>}
      </div>
      <div className="connector-tile-foot">
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
        <Button size="sm" variant={info.state === 'connected' ? 'secondary' : 'primary'} testId="connector-action" ariaLabel={`${label} ${def.name}`} onClick={onOpen}>
          {label}
        </Button>
      </div>
    </li>
  )
}
