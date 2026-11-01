import type { KeyboardEvent, ReactElement } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { ChevronUp, Library, Package, Plus, Search, Sparkles } from 'lucide-react'
import type { ConnectorInfo, McpMutationResult, McpServerInfo, Project, Role } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Popover } from '../ui/Popover'
import { linkedServerFor } from '../mcp/mcpLibraryHelpers'
import { errMessage } from '../mcp/mcpHelpers'
import { grantServerRoles } from '../../lib/roleCapabilities'
import { CATEGORY_LABELS, EASE_BADGE, filterConnectors, infoEase, serviceCount, sortForGallery, stateChip } from '../../lib/connectors'
import { UseInProjectDialog, connectorAccess } from './ConnectedServices'
import { ConnectorLogo } from './ConnectorLogo'
import { EaseBadge } from './ConnectorTile'
import ConnectorDialog from './ConnectorDialog'
import { useRovingFocus } from './useRovingFocus'

export type OtherWay = 'assist' | 'link' | 'registry' | 'form'

type Step = { kind: 'list' } | { kind: 'connect'; info: ConnectorInfo } | { kind: 'use'; info: ConnectorInfo }

/** Scroll the project's row for a service into view and focus its role control (after this dialog has closed). */
function jumpToRow(connectorId: string): void {
  window.setTimeout(() => {
    const row = document.querySelector<HTMLElement>(`[data-testid=connected-service-row][data-connector="${connectorId}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    const target = row.querySelector<HTMLElement>('.mcp-role-access button') ?? row
    if (target === row) row.tabIndex = -1
    target.focus()
  }, 60)
}

/**
 * "Add a service": a search-first picker. Services ready to use (connected in the app) come first; a connected one goes
 * straight to the roles step, an unconnected one opens the connect dialog and continues to roles once connected. A service
 * already in this project offers "Manage roles". The other routes are pinned in the footer.
 */
export default function AddServiceDialog({
  project,
  connectors,
  error,
  servers,
  onClose,
  onResult,
  onOther,
  role
}: {
  project: Project
  connectors: ConnectorInfo[] | null
  error: string | null
  servers: McpServerInfo[]
  onClose: () => void
  onResult: (r: McpMutationResult) => void
  onOther: (way: OtherWay) => void
  /** Started from one role's "+ Add": that role is granted and no roles step is shown. */
  role?: Role
}): ReactElement {
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const roving = useRovingFocus(listRef, '[role=option]')
  const ids = useId()

  const { ready, more } = useMemo(() => {
    const ranked = filterConnectors(sortForGallery(connectors ?? []), query)
    // A query ranks by match; keep the Ready section on top without losing that order inside each section.
    return { ready: ranked.filter((i) => i.state === 'connected'), more: ranked.filter((i) => i.state !== 'connected') }
  }, [connectors, query])
  const total = ready.length + more.length

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
    return <UseInProjectDialog project={project} info={info} role={role} linked={linkedServerFor(info, servers)} onClose={onClose} onResult={onResult} />
  }

  const pick = (info: ConnectorInfo): void => {
    if (info.state === 'connected') {
      const linked = linkedServerFor(info, servers)
      if (linked && role) {
        // Already in the project: let this role use it.
        const roles = grantServerRoles(linked.spec, role)
        if (roles === undefined || linked.spec.roles?.includes(role.slug)) {
          // Every role (or this one) already has it: nothing to jump to, just finish.
          onClose()
          return
        }
        setPickError(null)
        window.orgai.mcp
          .upsert({ projectId: project.id, spec: { ...linked.spec, roles } })
          .then((r) => {
            onResult(r)
            onClose()
          })
          .catch((e) => setPickError(errMessage(e)))
        return
      }
      if (linked) {
        onClose()
        jumpToRow(info.connector.id)
        return
      }
      setStep({ kind: 'use', info })
    } else setStep({ kind: 'connect', info })
  }
  const other = (way: OtherWay): void => {
    onClose()
    onOther(way)
  }
  const optionKey = (e: KeyboardEvent<HTMLElement>, info: ConnectorInfo): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(info)
    }
  }

  const option = (info: ConnectorInfo, isReady: boolean): ReactElement => {
    const def = info.connector
    const used = !!linkedServerFor(info, servers)
    const status = isReady ? (used ? 'in this project' : 'ready to use') : info.state === 'available' ? EASE_BADGE[infoEase(info)].label.toLowerCase() : stateChip(info).label.toLowerCase()
    const descId = `${ids}-d-${def.id}`
    return (
      <li
        key={def.id}
        role="option"
        className="addsvc-opt"
        data-testid="add-service-option"
        data-connector={def.id}
        data-ready={isReady ? 'true' : undefined}
        data-used={used ? 'true' : undefined}
        aria-selected={activeId === def.id}
        aria-label={`${def.name}, ${CATEGORY_LABELS[def.category]}, ${status}`}
        aria-describedby={descId}
        tabIndex={-1}
        onFocus={() => setActiveId(def.id)}
        onClick={() => pick(info)}
        onKeyDown={(e) => optionKey(e, info)}
      >
        <ConnectorLogo def={def} />
        <span className="addsvc-text">
          <span className="mcp-name">{def.name}</span>
          <span id={descId} className="muted addsvc-desc">
            {def.description}
          </span>
        </span>
        <span className="addsvc-meta">
          {isReady ? (
            <>
              <span className="muted addsvc-access">{connectorAccess(info)}</span>
              {used ? <Badge tone="info">In this project</Badge> : null}
              <span className={`addsvc-act${used ? '' : ' primary'}`}>{used ? 'Manage roles' : 'Add to project'}</span>
            </>
          ) : info.state === 'available' ? (
            <EaseBadge ease={infoEase(info)} />
          ) : (
            <Badge tone={stateChip(info).tone === 'warning' ? 'attention' : stateChip(info).tone}>{stateChip(info).label}</Badge>
          )}
        </span>
      </li>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a service"
      description="Search for a service. One that is ready to use goes straight to choosing roles; the others sign in first."
      size="lg"
      testId="add-service-dialog"
      footer={
        <div className="addsvc-foot" data-testid="add-service-other">
          <Button size="sm" icon={Sparkles} onClick={() => other('assist')} testId="add-service-assist">
            Ask the Team assistant
          </Button>
          <Popover
            label="More ways to add a service"
            role="group"
            placement="top-start"
            className="addsvc-more"
            triggerClassName="btn sm"
            triggerTestId="add-service-more"
            trigger={
              <>
                Can't find it? More ways
                <Icon icon={ChevronUp} size="sm" />
              </>
            }
          >
            {({ close }) => (
              <div className="addsvc-more-list">
                <p className="muted addsvc-more-note">The assistant uses your assistant model and counts toward your usage. You approve each server it proposes.</p>
                <Button size="sm" icon={Library} onClick={() => { close(); other('link') }} testId="add-service-link">
                  Add from your custom servers
                </Button>
                <Button size="sm" icon={Package} onClick={() => { close(); other('registry') }}>
                  Browse community servers (unverified)
                </Button>
                <Button size="sm" icon={Plus} onClick={() => { close(); other('form') }} testId="add-service-custom">
                  Set up a custom server
                </Button>
              </div>
            )}
          </Popover>
          <Button size="sm" onClick={onClose} className="addsvc-close">
            Close
          </Button>
        </div>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not load services">
          {error}
        </Banner>
      )}
      {pickError && (
        <Banner tone="danger" title="Could not add the service">
          {pickError}
        </Banner>
      )}
      {connectors === null && !error ? (
        <p className="muted" role="status">
          Loading services...
        </p>
      ) : (
        <div className="addsvc">
          <div className="connector-search">
            <span className="connector-search-icon">
              <Icon icon={Search} size="sm" />
            </span>
            <Input
              role="searchbox"
              value={query}
              onChange={setQuery}
              placeholder="Search by name or what it does"
              aria-label="Search services"
              data-autofocus=""
              data-testid="add-service-search"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && total > 0) {
                  e.preventDefault()
                  roving.focusCurrent()
                }
              }}
            />
          </div>
          <p className="connector-count muted" role="status" aria-live="polite" data-testid="add-service-count">
            {serviceCount(total)}
          </p>
          {total === 0 ? (
            <div className="connector-empty" data-testid="add-service-empty">
              <strong>{query.trim() ? `No service matches "${query.trim()}"` : 'No services yet'}</strong>
              <p className="muted">Try a different name, or use "Can't find it?" below.</p>
              <div className="connector-empty-actions">
                <Button size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              </div>
            </div>
          ) : (
            <div ref={listRef} className="addsvc-lists" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
              {ready.length > 0 && (
                <section className="addsvc-group" data-testid="add-service-ready">
                  <h3 className="connector-group-title" id={`${ids}-ready`}>
                    Ready to use <span className="muted connector-group-n">{ready.length}</span>
                  </h3>
                  <ul role="listbox" aria-labelledby={`${ids}-ready`} className="addsvc-list">
                    {ready.map((i) => option(i, true))}
                  </ul>
                </section>
              )}
              {more.length > 0 && (
                <section className="addsvc-group" data-testid="add-service-new">
                  <h3 className="connector-group-title" id={`${ids}-new`}>
                    {ready.length > 0 || query.trim() ? 'Connect a new service' : 'Services'} <span className="muted connector-group-n">{more.length}</span>
                  </h3>
                  <ul role="listbox" aria-labelledby={`${ids}-new`} className="addsvc-list">
                    {more.map((i) => option(i, false))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
