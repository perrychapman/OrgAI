import type { ReactElement } from 'react'
import { useState } from 'react'
import { Library, Package, Plus, Sparkles } from 'lucide-react'
import type { ConnectorInfo, McpMutationResult, McpServerInfo, Project } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { linkedServerFor } from '../mcp/mcpLibraryHelpers'
import { stateChip, CATEGORY_LABELS } from '../../lib/connectors'
import { UseInProjectDialog, connectorAccess } from './ConnectedServices'
import { ConnectorLogo } from './ConnectorLogo'
import ConnectorDialog from './ConnectorDialog'

export type OtherWay = 'assist' | 'link' | 'registry' | 'form'

type Step = { kind: 'list' } | { kind: 'connect'; info: ConnectorInfo } | { kind: 'use'; info: ConnectorInfo }

/**
 * "Add a service": the connectors, connected or not. A connected one goes straight to the roles step; an unconnected
 * one opens the connect dialog first and continues to roles once it is connected. "Not listed?" holds the other routes.
 */
export default function AddServiceDialog({
  project,
  connectors,
  error,
  servers,
  onClose,
  onResult,
  onOther
}: {
  project: Project
  connectors: ConnectorInfo[] | null
  error: string | null
  servers: McpServerInfo[]
  onClose: () => void
  onResult: (r: McpMutationResult) => void
  onOther: (way: OtherWay) => void
}): ReactElement {
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const [lastPicked, setLastPicked] = useState<string | null>(null)

  if (step.kind === 'connect') {
    return (
      <ConnectorDialog
        info={step.info}
        onClose={() => setStep((s) => (s.kind === 'connect' ? { kind: 'list' } : s))}
        onConnected={(next) => setStep({ kind: 'use', info: next })}
      />
    )
  }
  if (step.kind === 'use') {
    // Use the live info so a just-connected connector has its library entry.
    const live = connectors?.find((c) => c.connector.id === step.info.connector.id)
    const info = live?.library ? live : step.info
    return <UseInProjectDialog project={project} info={info} onClose={onClose} onResult={onResult} />
  }

  const pick = (info: ConnectorInfo): void => {
    setLastPicked(info.connector.id)
    if (info.state === 'connected') setStep({ kind: 'use', info })
    else setStep({ kind: 'connect', info })
  }
  const other = (way: OtherWay): void => {
    onClose()
    onOther(way)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a service"
      description="Connect a service once, then choose which roles in this project may use it."
      size="lg"
      testId="add-service-dialog"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && (
        <Banner tone="danger" title="Could not load services">
          {error}
        </Banner>
      )}
      {connectors === null && !error ? (
        <p className="muted" role="status">
          Loading services...
        </p>
      ) : (
        <ul className="svc-pick-list" aria-label="Services">
          {(connectors ?? []).map((info, i) => {
            const chip = stateChip(info)
            const used = !!linkedServerFor(info, servers)
            return (
              <li key={info.connector.id}>
                <button
                  type="button"
                  className="svc-pick"
                  data-testid="add-service-option"
                  data-connector={info.connector.id}
                  data-autofocus={(lastPicked ? info.connector.id === lastPicked : i === 0) ? '' : undefined}
                  disabled={used}
                  onClick={() => pick(info)}
                >
                  <ConnectorLogo def={info.connector} />
                  <span className="svc-pick-text">
                    <span className="mcp-name">{info.connector.name}</span>
                    <span className="muted svc-pick-desc">{info.connector.description}</span>
                  </span>
                  <span className="svc-pick-meta">
                    <Badge>{CATEGORY_LABELS[info.connector.category]}</Badge>
                    {info.state === 'connected' && <span className="muted">{connectorAccess(info)}</span>}
                    {used ? <Badge tone="info">In this project</Badge> : <Badge tone={chip.tone}>{chip.label}</Badge>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="svc-other" data-testid="add-service-other">
        <h3 className="svc-other-title">Not listed?</h3>
        <div className="svc-other-actions">
          <Button icon={Sparkles} onClick={() => other('assist')} testId="add-service-assist">
            Describe it to an assistant
          </Button>
          <Button icon={Library} onClick={() => other('link')} testId="add-service-link">
            Add from your custom servers
          </Button>
          <Button icon={Package} onClick={() => other('registry')}>
            Browse community servers (unverified)
          </Button>
          <Button icon={Plus} onClick={() => other('form')}>
            Set up a custom server
          </Button>
        </div>
        <p className="muted">The assistant uses your assistant model and counts toward your usage. You approve each server it proposes.</p>
      </div>
    </Dialog>
  )
}
