import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Bot, Network, Sparkles } from 'lucide-react'
import type { ConnectionId, Project } from '@shared/types'
import { CONNECTION_IDS, MODEL_TIER_OPTIONS } from '@shared/types'
import { adapterForProject, projectConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { ConnectionStatusBadge } from '../ui/ConnectionStatusBadge'
import { BrandMark } from '../brand/BrandMark'
import { brandMark } from '../brand/brandMarks'
import { Icon } from '../ui/Icon'
import { SettingsCard } from '../settings/SettingsCard'
import { SettingsSection } from '../settings/SettingsSection'
import { SettingRow } from '../ui/SettingRow'
import RemapPreviewDialog from '../RemapPreviewDialog'
import { otherFamilyRoles, previewRemap, proxyFamilyNotice, roleTier, startRefusal, START_REFUSAL_COPY, FAMILY_LABEL } from '../../lib/remap'
import { connectionWithAuth } from '../../lib/connectionLabel'
import { CONNECTION_NAME as NAME } from '../../lib/settingsCopy'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection, requestModelPrice } from '../../lib/settingsTarget'

const ICON = { anthropic: Sparkles, openai: Bot, litellm: Network }

/**
 * Project settings > General > Connection. One line while there is nothing to choose; the three cards (pick the
 * connection, preview the remap, apply with Undo) when 2+ connections are connected or the project's own is not.
 * The project's connection is the "Default connection for roles": on LiteLLM, other roles may run other model families.
 */
export default function ProjectConnection({ project }: { project: Project }): ReactElement {
  const connections = useAppStore((s) => s.connections)
  const connectionsError = useAppStore((s) => s.connectionsError)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const models = useAppStore((s) => s.models)
  const loadModels = useAppStore((s) => s.loadModels)
  const setView = useAppStore((s) => s.setView)
  const openConnections = (): void => {
    requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
    setView('appSettings')
  }
  const appInfo = useAppStore((s) => s.appInfo)
  // The effective default (connections:list isDefault), never the raw setting.
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const loadDefault = useAppStore((s) => s.loadDefaultConnection)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const current = projectConnection(project)
  const [pending, setPending] = useState<ConnectionId | null>(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const target = pending ?? current

  useEffect(() => {
    void loadAppInfo()
    void loadDefault()
  }, [loadAppInfo, loadDefault])
  useEffect(() => {
    if (!connections) void loadConnections()
  }, [connections, loadConnections])
  useEffect(() => {
    if (!models[target]) void loadModels(target)
  }, [target, models, loadModels])

  const infoOf = (id: ConnectionId) => connections?.find((c) => c.connection.id === id)
  const targetInfo = infoOf(target)
  const catalog = models[target] ?? []
  const tierModels = targetInfo?.connection.tierModels ?? {}

  const rootRole = project.roles.find((r) => r.reportsTo === null)
  const adapter = adapterForProject({ ...project, provider: { ...project.provider, connection: target } }, catalog)
  const otherFamilies = useMemo(() => (target === 'litellm' ? otherFamilyRoles(project, catalog) : []), [target, project, catalog])
  const familyNotice = proxyFamilyNotice(adapter.family, otherFamilies.length)
  const refusal = project.provider.id === 'mock' ? null : startRefusal(adapter)

  const change = useMemo(
    () => previewRemap({ project, connection: target, tierModels, catalog, switching: pending !== null && pending !== current }),
    [project, target, tierModels, catalog, pending, current]
  )

  const apply = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      const before = project
      const out = await window.orgai.projects.remapModels({ projectId: project.id, connection: pending })
      useAppStore.getState().replaceProject(out.project)
      useAppStore.getState().pushRemapNotice(`after switching ${project.name} to ${NAME[pending]}`, [out.result], [before])
      setPending(null)
      setPreview(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const mock = project.provider.id === 'mock'
  const toggleMock = async (on: boolean): Promise<void> => {
    setError(null)
    try {
      const provider = on
        ? { ...project.provider, id: 'mock' as const }
        : { ...project.provider, id: adapterForProject({ ...project, provider: { ...project.provider, id: 'claude' } }, catalog).adapter }
      await useAppStore.getState().saveProjectNow({ ...project, provider })
      setPending(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const rolesOn = project.roles.length
  const everyday = tierModels.everyday
  const disconnected = (id: ConnectionId): boolean => infoOf(id)?.status.state !== 'connected'
  const noRootModel = target === 'litellm' && rootRole?.model === 'inherit' && !tierModels.top
  const connectedCount = connections?.filter((c) => c.status.state === 'connected').length ?? 0
  // Nothing to choose: one connected connection and the project is on it.
  const simple = !!connections && connectedCount < 2 && !disconnected(current) && !pending

  if (connectionsError && !connections) {
    return (
      <div className="pconn-section" id="settings-section-connection">
        <Banner tone="danger" title="Could not load connections" actions={<Button size="sm" onClick={() => void loadConnections()}>Retry</Button>}>
          {connectionsError}
        </Banner>
      </div>
    )
  }

  const mockCard = (appInfo?.mockAdapter || mock) && (
    <SettingsCard>
      <SettingRow
        title="Run on the mock adapter"
        description={mock && appInfo?.mockAdapter ? 'On: runs use scripted data, not the connection above.' : 'Scripted runs and approvals, no tokens.'}
        control={<Switch checked={mock} onChange={(on) => void toggleMock(on)} label="Run on the scripted mock adapter" testId="mock-adapter-toggle" />}
        hint={mock && !appInfo?.mockAdapter ? <span className="pconn-mock-warn">Not loaded in this app. Turn off to use your connection.</span> : undefined}
      />
    </SettingsCard>
  )

  // LiteLLM: one connection for the project, any model the proxy serves; the orchestrator's family picks the adapter.
  const refusalBanner = refusal && (
    <Banner tone="danger" testId="project-start-refusal">
      {START_REFUSAL_COPY[refusal]}
    </Banner>
  )
  const litellmNotice = target === 'litellm' && (
    <>
      <Banner tone="info">
        The orchestrator&apos;s model family picks the adapter. Other roles can use any model the proxy serves.
        {familyNotice && !refusal && <span data-testid="proxy-family-notice"> {familyNotice}</span>}
      </Banner>
      <div className="row">
        <span className="muted">Orchestrator model family</span>
        <span title="Change the orchestrator's model to change the family.">
          <Badge tone="neutral">{adapter.family ? FAMILY_LABEL[adapter.family] : 'Unknown'}</Badge>
        </span>
      </div>
    </>
  )

  if (simple) {
    const info = infoOf(current)
    return (
      <SettingsSection id="settings-section-connection" title="Connection">
        <p className="pconn-line" data-testid="project-connection-line">
          <span>Default connection for roles: {info ? connectionWithAuth(info) : NAME[current]}.</span>
          <button type="button" className="link-btn" onClick={openConnections}>
            App settings &gt; Connections
          </button>
        </p>
        {error && <Banner tone="danger">{error}</Banner>}
        {refusalBanner}
        {litellmNotice}
        {mockCard}
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      id="settings-section-connection"
      title="Connection"
      description={
        <>
          {mock && appInfo?.mockAdapter ? 'This project runs on the mock adapter, so the connection applies once you turn it off. ' : 'Default connection for roles in this project. '}
          {defaultConnection && defaultConnection !== current ? `App default for new projects: ${NAME[defaultConnection]}. ` : ''}
          Sign-in and keys are set in{' '}
          <button type="button" className="link-btn" onClick={openConnections}>
            App settings &gt; Connections
          </button>
          .
        </>
      }
    >
      {error && !preview && <Banner tone="danger">{error}</Banner>}
      {!connections ? (
        <div className="pconn-cards" aria-busy="true">
          {CONNECTION_IDS.map((id) => (
            <div key={id} className="pconn-card">
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          ))}
        </div>
      ) : (
        <fieldset className="pconn-cards" data-testid="project-connection" disabled={mock && !!appInfo?.mockAdapter} aria-disabled={mock && !!appInfo?.mockAdapter ? true : undefined}>
          <legend className="sr-only">Default connection for roles</legend>
          {CONNECTION_IDS.map((id) => {
            const info = infoOf(id)
            return (
              <label key={id} className={`pconn-card ${pending === id || (!pending && current === id) ? 'on' : ''} ${current === id ? 'current' : ''}`}>
                <input type="radio" name={`pconn-${project.id}`} checked={target === id} onChange={() => setPending(id === current ? null : id)} />
                <span className="pconn-name">
                  <span className="pconn-mark">{brandMark(id) ? <BrandMark id={id} /> : <Icon icon={ICON[id]} size="sm" />}</span> {NAME[id]}
                  {current === id && pending && <span className="muted"> (current)</span>}
                </span>
                <ConnectionStatusBadge state={info?.status.state ?? 'disconnected'} />
              </label>
            )
          })}
        </fieldset>
      )}

      {connections && !mock && disconnected(target) && (
        <Banner
          tone="warning"
          actions={<Button size="sm" onClick={openConnections}>Open connections</Button>}
        >
          {NAME[target]} is not connected. Connect it to run this project.
        </Banner>
      )}

      {pending && (
        <div className="pconn-foot">
          <Button variant="primary" onClick={() => setPreview(true)} disabled={noRootModel} title={noRootModel ? 'Choose a model for the orchestrator first' : undefined}>
            Review changes
          </Button>
          <Button onClick={() => setPending(null)}>Cancel</Button>
        </div>
      )}

      <SettingsCard>
        <p className="settings-card-note">
          {rolesOn} {rolesOn === 1 ? 'role uses' : 'roles use'} this connection by default{everyday ? ` · Everyday tier: ${everyday}` : ''}
        </p>
        <details className="setting-row-more role-models" data-testid="role-models">
          <summary>Role models</summary>
          <ul className="remap-roles flush">
            {project.roles.map((r) => {
              const tier = r.model === 'inherit' ? undefined : roleTier(r)
              return (
                <li key={r.id}>
                  <span className="remap-role">{r.name}</span>
                  <span className="muted">{tier ? MODEL_TIER_OPTIONS.find((o) => o.value === tier)?.label : r.model === 'inherit' ? 'Inherit' : 'Custom'}</span>
                  <span className="mono">{r.model === 'inherit' ? "its parent's model" : r.model}</span>
                </li>
              )
            })}
          </ul>
        </details>
        <p className="settings-card-note" data-testid="model-prices-link">
          Model prices are set in App settings.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              requestModelPrice()
              setView('appSettings')
            }}
          >
            Open model prices
          </button>
        </p>
      </SettingsCard>

      {refusalBanner}
        {litellmNotice}
      {mockCard}

      <RemapPreviewDialog
        open={preview}
        projects={[change]}
        busy={busy}
        error={error}
        onCancel={() => setPreview(false)}
        onConfirm={() => void apply()}
        confirmDisabled={!!pending && disconnected(pending)}
        disabledReason={`${NAME[pending ?? target]} is not connected, so its models cannot be checked. Connect it in App settings > Connections first.`}
      />
    </SettingsSection>
  )
}
