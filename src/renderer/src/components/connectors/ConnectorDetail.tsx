import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import type { ConnectorInfo } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { mcpServersForRole } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { CATEGORY_LABELS, stateChip, tileAction } from '../../lib/connectors'
import { DetailActions, DetailChips, DetailHeader, DetailList, DetailNote, type GalleryTone } from '../settings/SettingsGallery'
import { ConnectorLogo } from './ConnectorLogo'
import { toolCapabilities, variantOf } from './toolCapabilities'

const TONE: Record<ConnectorInfo['state'], GalleryTone> = { connected: 'ok', needsSetup: 'warn', error: 'danger', available: 'off' }

/**
 * The Tools board's detail panel for the service last picked in the gallery: what it is, its state in words, what the
 * team can (or could) do with it and what this connection is not set up for, which projects and roles use it, and the
 * same action as its tile (which opens the full dialog with every control). Read-only summary; nothing here changes
 * anything by itself.
 */
export function ConnectorDetail({ info, onOpen }: { info: ConnectorInfo; onOpen: () => void }): ReactElement {
  const def = info.connector
  const caps = toolCapabilities(info)
  const variant = variantOf(info)
  const action = tileAction(info)
  const chip = stateChip(info)
  const projects = useAppStore((s) => s.projects)
  const libraryId = info.library?.entry.id

  // Roles that can use it, across the projects that link it (McpServerSpec.roles plus Role.mcpServers grants).
  const roles = useMemo(() => {
    if (!libraryId) return []
    const out: string[] = []
    for (const p of projects) {
      if (isVirtualProjectId(p.id)) continue
      const spec = (p.mcpServers ?? []).find((s) => s.libraryId === libraryId && s.enabled)
      if (!spec) continue
      for (const r of p.roles) {
        if (mcpServersForRole(p, r).some((s) => s.id === spec.id)) out.push(`${r.name} (${p.name})`)
      }
    }
    return out
  }, [projects, libraryId])

  const scope = info.state === 'available' ? 'Not added' : caps.projects.length === 0 ? 'Added, no project uses it yet' : `Used in ${caps.projects.length} ${caps.projects.length === 1 ? 'project' : 'projects'}`
  const note =
    info.state === 'connected'
      ? `${chip.label}. Roles that may use it act with this sign-in, with every tool the service offers that account.`
      : info.state === 'needsSetup'
        ? 'Added, but it is not signed in yet. Runs that need it cannot use it until you finish setup.'
        : info.state === 'error'
          ? `The last sign-in failed${info.library?.auth.error ? `: ${info.library.auth.error.slice(0, 300)}` : '.'}`
          : def.description

  return (
    <aside className="settings-gallery-aside glass" aria-label={`Selected service: ${def.name}`} data-testid="connector-detail" data-connector={def.id}>
      <DetailHeader mark={<ConnectorLogo def={def} />} name={def.name} tag={`${CATEGORY_LABELS[def.category]} · ${scope}`} />
      <DetailNote tone={TONE[info.state]} testId="connector-detail-note">
        {note}
        {caps.signIn && <span className="connector-detail-signin"> {caps.signIn}</span>}
      </DetailNote>
      <DetailList
        title={caps.mode === 'can' ? 'The team can' : 'The team could'}
        mark="can"
        items={caps.can.map((t) => ({ text: t }))}
        testId="connector-detail-can"
      />
      <DetailList title={caps.mode === 'can' ? 'The team cannot' : 'The team could not'} mark="cannot" items={caps.cannot.map((t) => ({ text: t }))} testId="connector-detail-cannot" />
      {info.state === 'connected' && caps.projects.length === 0 && <p className="settings-detail-hint muted">No project uses it yet. Add it to a project on its Team tab so roles can use it.</p>}
      {variant && def.variants.length > 1 && (
        <p className="settings-detail-hint muted">
          {info.state === 'available' ? 'Starts as' : 'Set up as'} "{variant.label}". {def.variants.length - 1} other {def.variants.length === 2 ? 'option' : 'options'} in {action.label}.
        </p>
      )}
      {def.notes && def.notes.length > 0 && (
        <details className="setting-row-more" data-testid="connector-detail-notes">
          <summary>Good to know ({def.notes.length})</summary>
          <div className="setting-row-more-body">
            <DetailList title="Notes from the preset" mark="plain" items={def.notes.map((t) => ({ text: t }))} />
          </div>
        </details>
      )}
      {info.state !== 'available' && <DetailChips title="Projects that use it" chips={caps.projects} empty="None yet" />}
      {info.state !== 'available' && <DetailChips title="Roles that use it" chips={roles} empty="None yet" />}
      <DetailActions>
        <Button size="sm" variant={action.primary ? 'primary' : 'secondary'} ariaLabel={action.aria} testId="connector-detail-action" onClick={onOpen}>
          {action.label}
        </Button>
      </DetailActions>
      <Button variant="ghost" size="sm" icon={Sparkles} className="settings-detail-help" testId="connector-detail-helper" onClick={() => void useAppStore.getState().openAssistant('harness', { fresh: true })}>
        Not sure what you need? Ask the Tools helper
      </Button>
    </aside>
  )
}
