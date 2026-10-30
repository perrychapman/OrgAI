import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Bot, Network, Sparkles } from 'lucide-react'
import type { ConnectionId, Project } from '@shared/types'
import { CONNECTION_IDS } from '@shared/types'
import { adapterForProject, projectConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { ConnectionStatusBadge } from '../ui/ConnectionStatusBadge'
import { Icon } from '../ui/Icon'
import { SettingsCard } from '../settings/SettingsCard'
import { SettingsSection } from '../settings/SettingsSection'
import { SettingRow } from '../ui/SettingRow'
import RemapPreviewDialog from '../RemapPreviewDialog'
import { familyMismatches, previewRemap, FAMILY_LABEL } from '../../lib/remap'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'

const NAME: Record<ConnectionId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }
const ICON = { anthropic: Sparkles, openai: Bot, litellm: Network }

/** Project settings > Connection: pick the connection, preview the remap, apply with Undo. */
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
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const current = projectConnection(project)
  const [pending, setPending] = useState<ConnectionId | null>(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const target = pending ?? current

  useEffect(() => {
    void loadAppInfo()
  }, [loadAppInfo])
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
  const mismatches = useMemo(() => (target === 'litellm' ? familyMismatches(project, catalog, tierModels) : []), [target, project, catalog, tierModels])

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

  if (connectionsError && !connections) {
    return (
      <div className="pconn-section" id="settings-section-connection">
        <Banner tone="danger" title="Could not load connections" actions={<Button size="sm" onClick={() => void loadConnections()}>Retry</Button>}>
          {connectionsError}
        </Banner>
      </div>
    )
  }

  return (
    <SettingsSection
      id="settings-section-connection"
      title="Connection"
      description={
        <>
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
          <legend className="sr-only">Connection</legend>
          {CONNECTION_IDS.map((id) => {
            const info = infoOf(id)
            return (
              <label key={id} className={`pconn-card ${pending === id || (!pending && current === id) ? 'on' : ''} ${current === id ? 'current' : ''}`}>
                <input type="radio" name={`pconn-${project.id}`} checked={target === id} onChange={() => setPending(id === current ? null : id)} />
                <span className="pconn-name">
                  <Icon icon={ICON[id]} size="md" /> {NAME[id]}
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
          {rolesOn} {rolesOn === 1 ? 'role uses' : 'roles use'} this connection{everyday ? ` · Everyday tier: ${everyday}` : ''}
        </p>
      </SettingsCard>

      {target === 'litellm' && (
        <>
          <Banner tone="info">
            The orchestrator&apos;s model family picks the adapter, and every role must match it.
            <details className="setting-row-more">
              <summary>Learn more</summary>
              <div className="setting-row-more-body">
                LiteLLM runs through one adapter per model family: Claude models use the Claude adapter and OpenAI models use the OpenAI adapter.
              </div>
            </details>
          </Banner>
          <div className="row">
            <span className="muted">Root model family</span>
            <span title="Change the orchestrator's model to change the family.">
              <Badge tone="neutral">{adapter.family ? FAMILY_LABEL[adapter.family] : 'Unknown'}</Badge>
            </span>
          </div>
          {mismatches.length > 0 && (
            <div className="field">
              <label>Roles that must change ({mismatches.length})</label>
              <ul className="remap-roles flush">
                {mismatches.map((m) => (
                  <li key={m.roleId}>
                    <span className="remap-role">{m.roleName}</span>
                    <span className="remap-from mono">{m.from}</span>
                    <span className="muted">to</span>
                    <span className="mono">{m.suggestion ?? 'choose a model'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {current === 'litellm' && !pending && adapter.mismatched.length > 0 && (
        <Banner tone="danger" title="This project cannot start as configured">
          Other model family: {project.roles.filter((r) => adapter.mismatched.includes(r.id)).map((r) => r.name).join(', ')}.
          <details className="setting-row-more">
            <summary>Learn more</summary>
            <div className="setting-row-more-body">
              Pick models from the {adapter.family ? FAMILY_LABEL[adapter.family] : "orchestrator's"} family or Inherit.
            </div>
          </details>
        </Banner>
      )}

      {(appInfo?.mockAdapter || mock) && (
        <SettingsCard>
          <SettingRow
            title="Run on the mock adapter"
            description={mock && appInfo?.mockAdapter ? 'On: the connection above does not apply to runs.' : 'Scripted runs and approvals, no tokens.'}
            control={<Switch checked={mock} onChange={(on) => void toggleMock(on)} label="Run on the scripted mock adapter" testId="mock-adapter-toggle" />}
            hint={mock && !appInfo?.mockAdapter ? <span className="pconn-mock-warn">Not loaded in this app. Turn off to use your connection.</span> : undefined}
          />
        </SettingsCard>
      )}

      <RemapPreviewDialog
        open={preview}
        projects={[change]}
        busy={busy}
        error={error}
        onCancel={() => setPreview(false)}
        onConfirm={() => void apply()}
        confirmDisabled={!!pending && disconnected(pending)}
        disabledReason={`${NAME[pending ?? target]} is not connected, so its models cannot be checked. Connect it in App settings > Connections first.`}
        extra={
          mismatches.length > 0 ? (
            <p className="muted">
              {mismatches.length} role{mismatches.length === 1 ? '' : 's'} use another model family and must change for this project to run on LiteLLM.
            </p>
          ) : undefined
        }
      />
    </SettingsSection>
  )
}
