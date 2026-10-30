import type { ReactElement } from 'react'
import { useState } from 'react'
import { Plus, Puzzle, Trash2 } from 'lucide-react'
import type { PluginSpec, Project } from '@shared/types'
import { adapterForProject, newId, projectConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { ConfirmDialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import { errMessage } from './mcpHelpers'

const NOT_CLAUDE = 'Plugins work with Claude only. They are ignored on this connection.'

export default function PluginsSection({ project }: { project: Project }): ReactElement {
  const catalog = useAppStore((s) => s.models['litellm'])
  const connection = projectConnection(project)
  const claude = connection === 'anthropic' || (connection === 'litellm' && adapterForProject(project, catalog ?? []).adapter === 'claude')
  const plugins = project.plugins ?? []
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [removing, setRemoving] = useState<PluginSpec | null>(null)

  const add = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const path = await window.orgai.projects.pickDirectory()
      if (!path) return
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? 'plugin'
      const saved = await window.orgai.plugins.upsert({ projectId: project.id, plugin: { id: newId('plugin'), name, path, enabled: true } })
      useAppStore.getState().replaceProject(saved)
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (p: PluginSpec, enabled: boolean): Promise<void> => {
    setRowError((r) => ({ ...r, [p.id]: '' }))
    try {
      useAppStore.getState().replaceProject(await window.orgai.plugins.upsert({ projectId: project.id, plugin: { ...p, enabled } }))
    } catch (e) {
      setRowError((r) => ({ ...r, [p.id]: errMessage(e) }))
    }
  }
  const remove = async (p: PluginSpec): Promise<void> => {
    try {
      useAppStore.getState().replaceProject(await window.orgai.plugins.remove({ projectId: project.id, pluginId: p.id }))
    } catch (e) {
      setRowError((r) => ({ ...r, [p.id]: errMessage(e) }))
    }
  }

  return (
    <section id="settings-section-plugins" className="mcp-section" aria-labelledby="plugins-title" data-testid="plugins-section">
      <div className="section-head">
        <div>
          <h2 id="plugins-title">Plugins</h2>
          <p>Claude Code plugin folders loaded into this project&apos;s runs.</p>
        </div>
        <div className="section-actions">
          <Button icon={Plus} loading={busy} onClick={() => void add()}>
            Add plugin
          </Button>
        </div>
      </div>
      {!claude && <Banner tone="info">{NOT_CLAUDE}</Banner>}
      {error && (
        <Banner tone="danger" title="Could not add the plugin">
          {error}
        </Banner>
      )}
      {plugins.length === 0 ? (
        <div className="card-block mcp-empty">
          <Icon icon={Puzzle} size="lg" />
          <strong>No plugins</strong>
          <p className="muted">Add a plugin folder to give Claude agents its skills and commands.</p>
        </div>
      ) : (
        <ul className="card-block mcp-list" aria-label="Plugins">
          {plugins.map((p) => (
            <li key={p.id} className={`mcp-row${p.enabled && claude ? '' : ' off'}`} data-testid="plugin-row" data-plugin={p.name} aria-disabled={!claude || undefined}>
              <div className="mcp-row-main plugin">
                <Switch checked={p.enabled} label={`Enable ${p.name}`} disabled={!claude} title={claude ? undefined : NOT_CLAUDE} onChange={(v) => void toggle(p, v)} />
                <div className="mcp-row-id">
                  <span className="mcp-name">{p.name}</span>
                  <span className="mono mcp-target" title={p.path}>
                    {p.path}
                  </span>
                </div>
                <div className="mcp-row-actions">
                  <IconButton icon={Trash2} label={`Remove ${p.name}`} size="sm" onClick={() => setRemoving(p)} />
                </div>
              </div>
              {rowError[p.id] && (
                <p className="invalid-text mcp-row-error" role="alert">
                  {rowError[p.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'plugin'}?`}
        body={<p>The plugin folder stays on disk. Agents stop loading it.</p>}
        confirmLabel="Remove plugin"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const p = removing
          setRemoving(null)
          if (p) void remove(p)
        }}
      />
    </section>
  )
}
