import type { ReactElement } from 'react'
import { useState } from 'react'
import { LogIn, X } from 'lucide-react'
import type { McpServerInfo, Role } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { serviceFor } from '../../lib/roleServices'
import { capList } from '../../lib/connectors'
import { accessLabel, grantedServers, needsSignIn, serverReadOnly } from '../../lib/roleCapabilities'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { AddButton, CapabilityGroup } from '../team/CapabilityBlock'
import { ConnectorLogo } from './ConnectorLogo'

/** Rows shown before "and N more". */
export const ROLE_SERVICES_CAP = 5

/**
 * The Connections group of "What it can use": a row per project connection this role may use, with its access in words,
 * a "Needs sign in" badge when it cannot work yet, and a remove control that revokes it for this role only. Access
 * belongs to the connection (set when it was connected), so it is shown, not edited, here.
 */
export default function RoleServices({
  role,
  servers,
  error,
  onRevoke,
  onAdd,
  onAsk
}: {
  role: Role
  /** null while the list loads. */
  servers: McpServerInfo[] | null
  error?: string | null
  onRevoke: (info: McpServerInfo) => void
  onAdd: () => void
  onAsk?: () => void
}): ReactElement {
  const setView = useAppStore((s) => s.setView)
  const granted = grantedServers(servers ?? [], role)
  const [showAll, setShowAll] = useState(false)
  const { shown, more } = capList(granted, showAll ? granted.length : ROLE_SERVICES_CAP)
  const signIn = (): void => {
    requestAppSettingsSection(APP_SETTINGS_SECTIONS.mcpLibrary)
    setView('appSettings')
  }
  const waiting = granted.filter(needsSignIn).length
  const summary =
    granted.length === 0
      ? undefined
      : `${granted.length} ${granted.length === 1 ? 'connection' : 'connections'}${waiting > 0 ? `, ${waiting} need${waiting === 1 ? 's' : ''} sign in` : ''}`
  return (
    <CapabilityGroup
      id="role-connections"
      testId="role-services"
      title="Connections"
      summary={summary}
      actions={<AddButton label={`Add a connection to ${role.name}`} testId="role-add-connection" onClick={onAdd} />}
      empty={
        servers !== null && granted.length === 0
          ? {
              text: 'No connections yet. A connection lets this role reach a service such as GitHub or Slack.',
              primaryLabel: 'Add a connection',
              primaryTestId: 'role-add-connection',
              onPrimary: onAdd,
              onAsk
            }
          : undefined
      }
    >
      {error && (
        <p className="invalid-text" role="alert">
          {error}
        </p>
      )}
      {servers === null ? (
        <p className="hint" role="status">
          Loading connections...
        </p>
      ) : (
        <ul className="role-cap-list" aria-label={`Connections for ${role.name}`}>
          {shown.map((info) => {
            const s = serviceFor(info.spec)
            const access = accessLabel(serverReadOnly(info.spec))
            const needs = needsSignIn(info)
            return (
              <li key={info.spec.id} className="role-cap-row role-cap-service" tabIndex={-1} data-testid="role-service" data-name={s.label} data-cap-id={info.spec.id} data-library-id={info.spec.libraryId}>
                {s.connectorId ? (
                  <ConnectorLogo def={{ id: s.connectorId, name: s.label }} size="sm" />
                ) : (
                  <span className="role-service-tile" style={{ ['--hue' as string]: s.hue }} aria-hidden="true">
                    {s.initial}
                  </span>
                )}
                <span className="role-cap-text">
                  <span className="role-service-name">{s.label}</span>
                  <span className="role-cap-sub">
                    {access ?? 'Custom connection'}
                    {info.spec.enabled ? '' : ' (paused in this project)'}
                  </span>
                </span>
                <span className="role-cap-tags">
                  {needs && (
                    <>
                      <Badge tone="attention" testId="role-needs-signin">
                        Needs sign in
                      </Badge>
                      <Button size="sm" icon={LogIn} ariaLabel={`Sign in to ${s.label} in App settings`} testId="role-signin" onClick={signIn}>
                        Sign in
                      </Button>
                    </>
                  )}
                </span>
                <IconButton icon={X} size="sm" label={`Remove ${s.label} from ${role.name}`} testId="role-connection-remove" onClick={() => onRevoke(info)} />
              </li>
            )
          })}
          {more > 0 && (
            <li className="role-cap-more">
              <Button size="sm" variant="ghost" testId="role-services-more" onClick={() => setShowAll(true)}>
                {`and ${more} more. Show all`}
              </Button>
            </li>
          )}
        </ul>
      )}
    </CapabilityGroup>
  )
}
