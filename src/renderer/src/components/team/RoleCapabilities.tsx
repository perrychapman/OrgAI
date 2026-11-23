import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Pencil, TriangleAlert } from 'lucide-react'
import type { McpMutationResult, McpServerInfo, Project, Role } from '@shared/types'
import { TOOL_CATALOG } from '@shared/types'
import RoleServices from '../connectors/RoleServices'
import RoleSkills from '../skills/RoleSkills'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { useAppStore } from '../../store/useAppStore'
import { expectInspectorSave, reportLiveRuns } from '../../store/liveChangeStore'
import { LiveChangeNote } from '../LiveChangeNote'
import { cleanIpcError } from '../../lib/ipcError'
import { inferAction, serverReach } from '../../lib/liveRunChange'
import { cannotEditFiles, grantServerRoles, grantedServers, revokePlan, roleSkillSplit, roleUseChips } from '../../lib/roleCapabilities'
import { groupState, resolveGroups, summaryParts, summarySentence } from '../../lib/toolGroups'
import { perProjectState } from '../mcp/mcpHelpers'
import { CapabilityGroup, type CapabilityKind } from './CapabilityBlock'
import { CapabilityChooser, type ChooserActions } from './CapabilityChooser'
import RoleToolGroups from './RoleToolGroups'

/** "Can read files, change files and run commands.": elevated phrases carry the warning colour and an icon plus the words. */
function ToolsSummary({ tools }: { tools: readonly string[] }): ReactElement {
  const groups = resolveGroups(TOOL_CATALOG, tools)
  const parts = summaryParts(groups, tools)
  if (parts.length === 0) return <>{summarySentence(groups, tools)}</>
  return (
    <>
      Can{' '}
      {parts.map((p, i) => (
        <span key={p.text}>
          {i === 0 ? '' : i === parts.length - 1 ? ' and ' : ', '}
          {p.elevated ? (
            <span className="role-tool-elevated-text">
              <Icon icon={TriangleAlert} size="xs" />{p.text}
            </span>
          ) : (
            p.text
          )}
        </span>
      ))}
      .
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

  const serversNow = useRef<McpServerInfo[] | null>(null)
  serversNow.current = servers
  const surface = `role:${role.id}` as const
  const applyResult = useCallback(
    (r: McpMutationResult): void => {
      seq.current++
      const before = serversNow.current
      setServers(r.servers)
      setConnError(null)
      replaceProject(r.project)
      reportLiveRuns(r.project.id, surface, r.liveRuns, inferAction(before ? before.map((s) => serverReach(s.spec)) : null, r.servers.map((s) => serverReach(s.spec))), 'connections')
    },
    [replaceProject, surface]
  )


  const revoke = (info: McpServerInfo): void => {
    setConnError(null)
    const plan = revokePlan(info.spec, project.roles, role)
    window.orgai.mcp
      .upsert({ projectId: project.id, spec: { ...info.spec, roles: plan.roles } })
      .then((r) => {
        applyResult(r)
        if (plan.roleMcpServers !== undefined) {
          // This role save has its own run.liveChange event; it reports here, under Connections, not in the org chart note.
          expectInspectorSave(project.id, surface, 'connections')
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
    // Through the skills call (not the org chart save) so the result says what reached the live runs.
    grantSkill: async (skillId) => {
      const list = await window.orgai.skills.list(project.id)
      const info = list.find((i) => i.spec.id === skillId)
      if (!info || info.grantedTo.includes(role.id)) return
      const result = await window.orgai.skills.update({ projectId: project.id, skillId, roleIds: [...info.grantedTo, role.id] })
      replaceProject(result.project)
      reportLiveRuns(result.project.id, surface, result.liveRuns, { kind: 'grant', name: info.spec.name }, 'skills')
    }
  }

  const waitingForValues = grantedServers(servers ?? [], role).filter((s) => s.spec.libraryId && perProjectState(s).missingCount > 0)

  const chips = roleUseChips({
    toolGroupLabels: resolveGroups(TOOL_CATALOG, role.tools)
      .filter((g) => groupState(g, role.tools) !== 'off')
      .map((g) => g.label),
    services: grantedServers(servers ?? [], role).map((s) => s.spec.name),
    skills: roleSkillSplit(project.skills ?? [], role).granted.map((s) => s.name)
  })

  // onAskAssistant stays in the props (RoleInspector passes it) but the phase 2 panel has no "Ask the Team assistant" links.
  void onAskAssistant

  return (
    <section ref={root} className="stack-3 role-capabilities" aria-labelledby="role-capabilities-title" data-testid="role-capabilities">
      <div className="ri-head">
        <h3 className="side-section-title role-capabilities-title" id="role-capabilities-title">
          What it can use
        </h3>
        <button
          type="button"
          className="link-btn ri-edit"
          data-testid="role-use-edit"
          aria-label={`Edit what ${role.name || 'this role'} can use`}
          onClick={() => {
            setEditingTools(true)
            window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid=role-tool-group-read]')?.focus())
          }}
        >
          Edit
        </button>
      </div>
      <ul className="ri-chips" aria-label="What it can use at a glance" data-testid="role-use-chips">
        {chips.map((c, i) => (
          <li key={`${c.kind}:${c.label}:${i}`} className="ri-chip" data-kind={c.kind}>
            {c.label}
          </li>
        ))}
        {cannotEditFiles(role.tools) && (
          <li className="ri-chip ri-chip-dashed" data-testid="role-cannot-edit">
            Cannot edit files
          </li>
        )}
      </ul>

      <CapabilityGroup
        id="role-tools"
        testId="role-tools"
        title="Tools"
        summary={editingTools ? undefined : <ToolsSummary tools={role.tools} />}
        actions={
          <Button size="sm" icon={editingTools ? Check : Pencil} ariaLabel={editingTools ? 'Done editing tools' : `Edit tools for ${role.name}`} testId="role-edit-tools" onClick={() => setEditingTools((v) => !v)}>
            {editingTools ? 'Done' : 'Edit'}
          </Button>
        }
      >
        {editingTools && <RoleToolGroups tools={role.tools} onChange={(tools) => onChange({ tools: tools as Role['tools'] })} />}
      </CapabilityGroup>

      <RoleServices role={role} servers={servers} error={connError} onRevoke={revoke} onAdd={() => setChooser('connections')} />
      <LiveChangeNote projectId={project.id} surface={surface} part="connections" />

      {servers && waitingForValues.length > 0 && (
        <ul className="role-cap-list" aria-label={`Connections of ${role.name} that need values`} data-testid="role-needs-values-list">
          {waitingForValues.map((info) => (
            <li key={info.spec.id} className="role-cap-row" data-testid="role-needs-values" data-name={info.spec.name}>
              <span className="role-cap-text">
                <span className="role-service-name">{info.spec.name}</span>
              </span>
              <span className="role-cap-tags">
                <Badge tone="attention" testId="role-needs-values-badge">
                  Needs values
                </Badge>
                <Button
                  size="sm"
                  ariaLabel={`Fill in values for ${info.spec.name}`}
                  testId="role-fill-in"
                  onClick={() => useAppStore.getState().openProjectMcp(project.id, info.spec.id)}
                >
                  Fill in
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <RoleSkills
        project={project}
        role={role}
        onChange={(skills) => {
          // The project save has its own run.liveChange event; it reports here, under Skills, not in the org chart note.
          expectInspectorSave(project.id, surface, 'skills')
          onChange({ skills })
          setFocusId('group:role-add-skill')
        }}
        onAdd={() => setChooser('skills')}
      />
      <LiveChangeNote projectId={project.id} surface={surface} part="skills" />

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
        />
      )}
    </section>
  )
}
