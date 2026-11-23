import { useEffect, useMemo, useRef, useState } from 'react'
import type { EngagementDocumentInfo, EngagementNote, KnowledgeGraph, McpServerInfo, Project, ProjectSpend, RunSummary, ScheduleHistoryEntry, TodoItem, UsageOverview } from '@shared/types'
import { todoScopeFor } from '@shared/view/todos'
import { itemsOf, type KnowledgeItem } from '@shared/view/knowledge'
import { isRunLive, useAppStore } from '../../store/useAppStore'
import { useTodosStore } from '../../store/todosStore'
import { monthStart } from '../../lib/projectHome'
import { normalizeGit, type HomeGit } from '../../lib/projectHomeGit'

/**
 * Data the Home tab reads beyond the store. Each hook answers `undefined` while the first answer is on its way and
 * `null` when the call is missing or failed: a section draws only on a real answer. A failure keeps the earlier answer.
 * Nothing here is sample data.
 */

/** The least time between two refreshes of one source triggered by run activity. */
export const HOME_REFRESH_MIN_MS = 15_000

type Api = typeof window.orgai

function api(): Api | undefined {
  return typeof window !== 'undefined' ? window.orgai : undefined
}

/** A run left the live set or a new one started: the key changes, so month spend and the like can refresh. */
export function useLiveKey(projectId: string): string {
  const runs = useAppStore((s) => s.runs)
  return useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.summary.projectId === projectId && isRunLive(r))
        .map((r) => r.summary.id)
        .sort()
        .join(','),
    [runs, projectId]
  )
}

/** Month-to-date usage of the project from `runs.usageOverview` (the same numbers as the Usage page). */
export function useMonthOverview(projectId: string, refreshKey: string): UsageOverview | null | undefined {
  const [state, setState] = useState<UsageOverview | null | undefined>(undefined)
  const last = useRef(0)
  useEffect(() => {
    const a = api()
    if (!a?.runs?.usageOverview) {
      setState(null)
      return
    }
    let alive = true
    const wait = Math.max(0, last.current + HOME_REFRESH_MIN_MS - Date.now())
    const t = window.setTimeout(() => {
      last.current = Date.now()
      a.runs.usageOverview({ since: monthStart(Date.now()), projectIds: [projectId], limit: 500 }).then(
        (o) => {
          if (alive) setState(o)
        },
        () => {
          if (alive) setState((s) => s ?? null)
        }
      )
    }, wait)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [projectId, refreshKey])
  return state
}

/**
 * What the repository read answered. 'loading': the first answer is on its way. 'none': not a git repository, git is
 * missing, or this build has no git read (Home says "No git information", not an error). 'failed': the call rejected
 * and there is no earlier answer (a later failure keeps the earlier 'ready' answer).
 */
export type GitState = { kind: 'loading' } | { kind: 'none' } | { kind: 'failed' } | { kind: 'ready'; git: HomeGit }

function gitReader(): ((projectId: string) => Promise<unknown>) | null {
  const info = api()?.gitInfo
  return typeof info?.summary === 'function' ? (id) => info.summary(id) : null
}

/**
 * The repository facts of a code project through `gitInfo.summary`, normalized (lib/projectHomeGit `normalizeGit`).
 * Refreshed when `refreshKey` changes (a run started or ended), never more than once per HOME_REFRESH_MIN_MS.
 */
export function useProjectGit(projectId: string, refreshKey: string): GitState {
  const [state, setState] = useState<GitState>(() => (gitReader() ? { kind: 'loading' } : { kind: 'none' }))
  const last = useRef(0)
  const lastProject = useRef(projectId)
  useEffect(() => {
    if (lastProject.current !== projectId) {
      lastProject.current = projectId
      setState(gitReader() ? { kind: 'loading' } : { kind: 'none' })
    }
    const read = gitReader()
    if (!read) {
      setState({ kind: 'none' })
      return
    }
    let alive = true
    const t = window.setTimeout(
      () => {
        last.current = Date.now()
        read(projectId).then(
          (raw) => {
            if (!alive) return
            const git = normalizeGit(raw)
            setState(git ? { kind: 'ready', git } : { kind: 'none' })
          },
          () => {
            if (alive) setState((s) => (s.kind === 'ready' ? s : { kind: 'failed' }))
          }
        )
      },
      Math.max(0, last.current + HOME_REFRESH_MIN_MS - Date.now())
    )
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [projectId, refreshKey])
  return state
}

/** A schedule's history through the peek channel (it does not clear the unread count Schedules shows). */
export function useScheduleOutcomes(scheduleId: string | undefined, refreshKey: string): ScheduleHistoryEntry[] | null | undefined {
  const [state, setState] = useState<ScheduleHistoryEntry[] | null | undefined>(undefined)
  useEffect(() => {
    const peek = api()?.runInsights?.scheduleHistory
    if (!scheduleId || typeof peek !== 'function') {
      setState(null)
      return
    }
    let alive = true
    peek(scheduleId).then(
      (list) => {
        if (alive) setState(Array.isArray(list) ? list : [])
      },
      () => {
        if (alive) setState((s) => s ?? null)
      }
    )
    return () => {
      alive = false
    }
  }, [scheduleId, refreshKey])
  return state
}

/** Today's and this month's spend (`runInsights.projectSpend`). undefined while loading, null when unavailable or failed. */
export function useProjectSpend(projectId: string, refreshKey: string): ProjectSpend | null | undefined {
  const [state, setState] = useState<ProjectSpend | null | undefined>(undefined)
  useEffect(() => {
    const read = api()?.runInsights?.projectSpend
    if (typeof read !== 'function') {
      setState(null)
      return
    }
    let alive = true
    read(projectId).then(
      (s) => {
        if (alive) setState(s && typeof s === 'object' && s.month ? s : null)
      },
      () => {
        if (alive) setState((s) => s ?? null)
      }
    )
    return () => {
      alive = false
    }
  }, [projectId, refreshKey])
  return state
}

/** The project's open and done to-dos (shared store, follows todos:changed). undefined until loaded, null when unavailable. */
export function useProjectTodos(projectId: string): TodoItem[] | null | undefined {
  const scope = useMemo(() => todoScopeFor(projectId), [projectId])
  const key = scope ? `project:${projectId}` : ''
  const items = useTodosStore((s) => (key ? s.byScope[key] : undefined))
  const error = useTodosStore((s) => (key ? s.errorByScope[key] : undefined))
  useEffect(() => {
    if (scope) void useTodosStore.getState().load(scope)
  }, [scope])
  if (!scope) return null
  if (items) return items
  return error ? null : undefined
}

/** The project's MCP servers with their secret and sign-in state (engagement Home, Connections). */
export function useProjectMcp(project: Project): McpServerInfo[] | null | undefined {
  const [state, setState] = useState<McpServerInfo[] | null | undefined>(undefined)
  const servers = project.mcpServers
  const key = (servers ?? []).map((s) => `${s.id}:${s.enabled ? 1 : 0}`).join(',')
  useEffect(() => {
    const a = api()
    if (!a?.mcp?.list) {
      setState(null)
      return
    }
    let alive = true
    a.mcp.list(project.id).then(
      (list) => {
        if (alive) setState(Array.isArray(list) ? list : [])
      },
      () => {
        if (alive) setState((s) => s ?? null)
      }
    )
    return () => {
      alive = false
    }
  }, [project.id, key])
  return state
}

export interface EngagementData {
  document: EngagementDocumentInfo | null | undefined
  /** Graph nodes and notes as one list of items; undefined until the graph answered, null when it could not be read. */
  items: KnowledgeItem[] | null | undefined
}

/** The engagement document, the knowledge graph and the context notes, refreshed on `engagement changed` pushes. */
export function useEngagementData(projectId: string): EngagementData {
  const [document, setDocument] = useState<EngagementDocumentInfo | null | undefined>(undefined)
  const [graph, setGraph] = useState<KnowledgeGraph | null | undefined>(undefined)
  const [notes, setNotes] = useState<EngagementNote[] | null | undefined>(undefined)
  useEffect(() => {
    const a = api()
    let alive = true
    const loadDoc = (): void => {
      if (!a?.engagement?.document) return setDocument(null)
      a.engagement.document(projectId).then(
        (d) => alive && setDocument(d),
        () => alive && setDocument((s) => s ?? null)
      )
    }
    const loadGraph = (): void => {
      if (!a?.knowledge?.get) return setGraph(null)
      a.knowledge.get(projectId).then(
        (g) => alive && setGraph(g),
        () => alive && setGraph((s) => s ?? null)
      )
    }
    const loadNotes = (): void => {
      if (!a?.engagement?.listNotes) return setNotes(null)
      a.engagement.listNotes(projectId).then(
        (n) => alive && setNotes(Array.isArray(n) ? n : []),
        () => alive && setNotes((s) => s ?? null)
      )
    }
    loadDoc()
    loadGraph()
    loadNotes()
    let off: (() => void) | undefined
    try {
      off = a?.onEngagementChanged?.((ev) => {
        if (ev?.projectId !== projectId) return
        if (ev.what === 'document') loadDoc()
        else if (ev.what === 'knowledge') loadGraph()
        else if (ev.what === 'notes') loadNotes()
      })
    } catch {
      /* an older preload without the push: the page refreshes when it is opened again */
    }
    return () => {
      alive = false
      off?.()
    }
  }, [projectId])
  const items = useMemo<KnowledgeItem[] | null | undefined>(() => {
    if (graph === undefined || notes === undefined) return undefined
    if (graph === null && notes === null) return null
    return itemsOf(graph ?? { nodes: [] }, notes ?? [])
  }, [graph, notes])
  return { document, items }
}

/** Summaries of one project (the persisted history merged with live runs, newest first), as the History tab holds them. */
export function useProjectHistory(projectId: string): RunSummary[] {
  const history = useAppStore((s) => s.historyByProject[projectId])
  const runs = useAppStore((s) => s.runs)
  const loadHistory = useAppStore((s) => s.loadHistory)
  const selected = useAppStore((s) => s.selectedProjectId)
  const selectedHistory = useAppStore((s) => s.history)
  useEffect(() => {
    // `history` holds the selected project's list; Home is always shown for the selected project.
    if (selected === projectId && history === undefined) void loadHistory()
  }, [selected, projectId, history, loadHistory])
  return useMemo(() => {
    const byId = new Map<string, RunSummary>()
    for (const h of history ?? (selected === projectId ? selectedHistory : [])) byId.set(h.id, h)
    for (const r of Object.values(runs)) if (r.summary.projectId === projectId) byId.set(r.summary.id, r.summary)
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
  }, [history, runs, projectId, selected, selectedHistory])
}
