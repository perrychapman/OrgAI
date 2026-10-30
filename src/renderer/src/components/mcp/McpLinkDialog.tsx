import type { ReactElement } from 'react'
import { useState } from 'react'
import type { McpLibraryInfo, McpMutationResult, McpServerInfo, Project } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { AuthChip } from './McpAuth'
import { RoleChecklist } from './RoleAccess'
import { errMessage, launchTarget, securityPhrase } from './mcpHelpers'
import { transportWords } from './mcpLibraryHelpers'

/**
 * Add from library: pick one entry that this project does not link yet and choose who may use it. Least privilege:
 * no role is selected until the user picks some (or All roles), and the dialog needs at least one.
 */
export default function McpLinkDialog({
  project,
  library,
  servers,
  onClose,
  onResult,
  onOpenLibrary
}: {
  project: Project
  library: McpLibraryInfo[]
  servers: McpServerInfo[]
  onClose: () => void
  onResult: (r: McpMutationResult) => void
  onOpenLibrary: () => void
}): ReactElement {
  const linked = new Set(servers.map((s) => s.spec.libraryId).filter(Boolean))
  const taken = new Set(servers.map((s) => s.spec.name))
  const available = library.filter((l) => !linked.has(l.entry.id))
  const [pick, setPick] = useState<string | null>(null)
  const [roles, setRoles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picked = available.find((l) => l.entry.id === pick)
  const noRoles = project.roles.length === 0
  const canAdd = !!picked && !taken.has(picked.entry.name) && (noRoles || roles.length > 0)

  const add = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.orgai.mcp.linkLibrary({
        projectId: project.id,
        libraryId: picked.entry.id,
        ...(noRoles ? {} : { roles }),
        enabled: true
      })
      onResult(result)
      onClose()
    } catch (e) {
      setError(errMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title="Add MCP server from your library"
      description="The project uses the library's definition, credentials and sign-in. Edits in the library reach every project that links it."
      size="lg"
      testId="mcp-link-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!canAdd} testId="mcp-link-confirm" onClick={() => void add()}>
            Add to project
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not add the server">
          {error}
        </Banner>
      )}
      {available.length === 0 ? (
        <div className="stack-2">
          <p className="muted">
            {library.length === 0 ? 'Your library is empty.' : 'Every library server is already in this project.'} Add servers to the library in app
            settings.
          </p>
          <div>
            <Button size="sm" onClick={onOpenLibrary}>
              Open the MCP library
            </Button>
          </div>
        </div>
      ) : (
        <>
          <fieldset className="mcp-vars">
            <legend>Library server</legend>
            <ul className="mcp-pick-list">
              {available.map((l) => {
                const clash = taken.has(l.entry.name)
                const id = `mcp-pick-${l.entry.id}`
                return (
                  <li key={l.entry.id} className="mcp-pick">
                    <input
                      type="radio"
                      id={id}
                      name="mcp-link-pick"
                      checked={pick === l.entry.id}
                      disabled={clash}
                      data-autofocus={l === available[0] ? '' : undefined}
                      onChange={() => setPick(l.entry.id)}
                    />
                    <label htmlFor={id}>
                      <span className="mcp-name">{l.entry.name}</span>
                      <span className="mono mcp-target">{launchTarget(l.entry)}</span>
                      <span className="mcp-row-meta">
                        <Badge>{transportWords(l.entry.transport)}</Badge>
                        <AuthChip auth={l.auth} />
                        {l.missingSecrets.length > 0 && <Badge tone="warning">Secrets not set</Badge>}
                        {clash && <Badge tone="danger">Name already used in this project</Badge>}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </fieldset>
          {picked && (
            <>
              <p className="muted">{securityPhrase(picked.entry.transport)}</p>
              {(picked.auth.state === 'notAuthorized' || picked.auth.state === 'expired') && (
                <Banner tone="warning">Authorize this server in the library before runs can use it.</Banner>
              )}
              <fieldset className="mcp-vars">
                <legend>Who can use it?</legend>
                <RoleChecklist roles={project.roles} value={roles} onChange={setRoles} label="Role access" />
                {!noRoles && roles.length === 0 && <span className="hint">Choose at least one role, or All roles.</span>}
              </fieldset>
            </>
          )}
        </>
      )}
    </Dialog>
  )
}
