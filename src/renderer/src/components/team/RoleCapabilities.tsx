import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Pencil, TriangleAlert } from 'lucide-react'
import type { McpMutationResult, McpServerInfo, Project, Role, ToolName } from '@shared/types'
import { TOOL_CATALOG, TOOL_HINTS } from '@shared/types'
import RoleServices from '../connectors/RoleServices'
import RoleSkills from '../skills/RoleSkills'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { grantServerRoles, revokePlan, toolsSummaryParts } from '../../lib/roleCapabilities'
import { CapabilityGroup, type CapabilityKind } from './CapabilityBlock'
import { CapabilityChooser, type ChooserActions } from './CapabilityChooser'

/** Tools that change files or run commands keep a warning style in the editor. */
const ELEVATED_TOOLS: readonly ToolName[] = ['Edit', 'Write', 'Bash', 'NotebookEdit']

/** "Read, Glob, Grep + Bash, Edit": elevated tools are named and set in the warning colour. */
function ToolsSummary({ tools }: { tools: readonly string[] }): ReactElement {
  if (tools.length === 0) return <>No tools</>
  const { base, elevated, more } = toolsSummaryParts(tools, TOOL_CATALOG)
  const tail = elevated.length + (more > 0 ? 1 : 0)
  return (
    <>
      {base.join(', ')}
      {tail > 0 && (base.length > 0 ? ' + ' : '')}
      {elevated.map((t, i) => (
        <span key={t} className="role-tool-elevated-text">
          {i > 0 ? ', ' : ''}
          {t}
        </span>
      ))}
      {more > 0 && `${elevated.length > 0 ? ', ' : ''}${more} more`}
    </>
  )
}

/**
 * "What it can use": one block with the role's Tools, Connections and Skills, edited in place. Each group has a scoped
 * "+ Add" chooser (a dialog) that grants only to this role. Tools and skills save through `onChange` (the normal project
 * save); connection grants go through the mcp:* calls the Catalog's "Use in this project" flow uses.
 * `onAskAssistant` hands a scope to the Team assistant (Brief 2c fills it).
 */
export default function RoleCapabilities({
  project,
  role,
  onChange,
  onAskAssistant
}: {
  project: Project
  role: Role
  onChange: (patch: Partial<Role>) => void
  onAskAssistant?: (scope: CapabilityKind) => void
}): ReactElement {
  const updateRoles = useAppStore((s) => s.updateRoles)
  const replaceProject = useAppStore((s) => s.replaceProject)
  const root = useRef<HTMLElement>(null)
  const [editingTools, setEditingTools] = useState(false)
  const [servers, setServers] = useState<McpServerInfo[] | null>(null)
  const [connError, setConnError] = useState<string | null>(null)
  const [chooser, setChooser] = useState<Exclude<CapabilityKind, 'tools'> | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback((): void => {
    const mine = ++seq.current
    window.orgai.mcp
      .list(project.id)
      .then((list) => {
        if (mine === seq.current) setServers(list)
      })
      .catch((e) => {
        if (mine === seq.current) setConnError(cleanIpcError(e))
      })
  }, [project.id])
  useEffect(() => {
    setServers(null)
    reload()
    return window.orgai.onMcpLibraryChanged(() => reload())
  }, [reload])
  useEffect(() => {
    if (servers !== null) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.mcpServers])

  // Move focus to a row that was just added (or to the group's Add button after a removal).
  useEffect(() => {
    if (!focusId) return undefined
    const el = root.current
    if (!el) return undefined
    const find = (): HTMLElement | null => {
      if (focusId.startsWith('group:')) return el.querySelector<HTMLElement>(`[data-testid=${focusId.slice(6)}]`)
      const lib = focusId.startsWith('lib:') ? focusId.slice(4) : null
      return lib ? el.querySelector<HTMLElement>(`[data-library-id="${CSS.escape(lib)}"]`) : el.querySelector<HTMLElement>(`[data-cap-id="${CSS.escape(focusId)}"]`)
    }
    const target = find()
    if (target) {
      target.focus()
      setFocusId(null)
      return undefined
    }
    const t = window.setTimeout(() => setFocusId(null), 1500)
    return () => window.clearTimeout(t)
  }, [focusId, servers, project])

  const applyResult = useCallback(
    (r: McpMutationResult): void => {
      seq.current++
      setServers(r.servers)
      setConnError(null)
      replaceProject(r.project)
    },
    [replaceProject]
  )

  const toggleTool = (t: ToolName): void => {
    onChange({ tools: role.tools.includes(t) ? role.tools.filter((x) => x !== t) : [...role.tools, t] })
  }

  const revoke = (info: McpServerInfo): void => {
    setConnError(null)
    const plan = revokePlan(info.spec, project.roles, role)
    window.orgai.mcp
      .upsert({ projectId: project.id, spec: { ...info.spec, roles: plan.roles } })
      .then((r) => {
        applyResult(r)
        if (plan.roleMcpServers !== undefined) {
          const next = plan.roleMcpServers
          updateRoles(project.id, (roles) => roles.map((x) => (x.id === role.id ? { ...x, mcpServers: next } : x)))
        }
        setFocusId('group:role-add-connection')
      })
      .catch((e) => setConnError(cleanIpcError(e)))
  }

  const actions: ChooserActions = {
    grantServer: async (info) => {
      const roles = grantServerRoles(info.spec, role)
      if (roles === undefined) return
      applyResult(await window.orgai.mcp.upsert({ projectId: project.id, spec: { ...info.spec, roles } }))
    },
    linkLibraryServer: async (libraryId) => {
      applyResult(await window.orgai.mcp.linkLibrary({ projectId: project.id, libraryId, roles: [role.slug], enabled: true }))
    },
    applyResult,
    grantSkill: (skillId) => {
      updateRoles(project.id, (roles) =>
        roles.map((x) => (x.id === role.id && !(x.skills ?? []).includes(skillId) ? { ...x, skills: [...(x.skills ?? []), skillId] } : x))
      )
    }
  }

  const ask = onAskAssistant
  const askFor = (scope: CapabilityKind): (() => void) | undefined =>
    ask
      ? () => {
          setChooser(null)
          ask(scope)
        }
      : undefined

  return (
    <section ref={root} className="stack-3 role-capabilities" aria-labelledby="role-capabilities-title" data-testid="role-capabilities">
      <h3 className="side-section-title role-capabilities-title" id="role-capabilities-title">
        What it can use
      </h3>

      <CapabilityGroup
        id="role-tools"
        testId="role-tools"
        title="Tools"
        summary={<ToolsSummary tools={role.tools} />}
        helper="What this role may do on your files and shell."
        actions={
          <Button size="sm" icon={editingTools ? Check : Pencil} ariaLabel={editingTools ? 'Done editing tools' : `Edit tools for ${role.name}`} testId="role-edit-tools" onClick={() => setEditingTools((v) => !v)}>
            {editingTools ? 'Done' : 'Edit'}
          </Button>
        }
      >
        {editingTools && (
          <div className="check-grid" data-testid="role-tools-grid">
            {TOOL_CATALOG.map((t) => (
              <Checkbox
                key={t}
                checked={role.tools.includes(t)}
                onChange={() => toggleTool(t)}
                label={
                  ELEVATED_TOOLS.includes(t) ? (
                    <span className="role-tool-elevated">
                      {t}
                      <Icon icon={TriangleAlert} size="xs" />
                    </span>
                  ) : (
                    t
                  )
                }
                title={TOOL_HINTS[t] ?? (ELEVATED_TOOLS.includes(t) ? 'Can change files or run commands.' : undefined)}
                testId={`role-tool-${t}`}
              />
            ))}
          </div>
        )}
      </CapabilityGroup>

      <RoleServices role={role} servers={servers} error={connError} onRevoke={revoke} onAdd={() => setChooser('connections')} onAsk={askFor('connections')} />

      <RoleSkills
        project={project}
        role={role}
        onChange={(skills) => {
          onChange({ skills })
          setFocusId('group:role-add-skill')
        }}
        onAdd={() => setChooser('skills')}
        onAsk={askFor('skills')}
      />

      {chooser && (
        <CapabilityChooser
          kind={chooser}
          project={project}
          role={role}
          servers={servers ?? []}
          actions={actions}
          onClose={() => setChooser(null)}
          onDone={(id) => {
            setChooser(null)
            setFocusId(id ?? `group:${chooser === 'connections' ? 'role-add-connection' : 'role-add-skill'}`)
          }}
          onAskAssistant={askFor(chooser)}
        />
      )}
    </section>
  )
}
