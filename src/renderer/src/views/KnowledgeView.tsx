import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { EngagementNote, EngagementNoteContent, KnowledgeGraph as KnowledgeGraphData, KnowledgeInferredResult, KnowledgeNode, Project } from '@shared/types'
import { ENGAGEMENT_NOTES_MAX, KNOWLEDGE_NODES_MAX } from '@shared/types'
import { emptyKnowledgeGraph } from '@shared/knowledge'
import type { KnowledgeFilter, KnowledgeItem, RunFacts } from '../lib/knowledge'
import { EMPTY_FILTER, countLine, groupItems, idAfterRemoval, isFilterActive, itemName, itemsOf, kindCounts, originCounts, resolveFocus, runNamesOf, searchItems } from '../lib/knowledge'
import type { RecordedBatch } from '../lib/knowledgeList'
import { EMPTY_BATCH, NOTICE_MS, addRecorded, emptyKind, eventItemIds, flushRecorded, hiddenNewIds, isOwnEvent, itemsCapText, notesCapText, restoreReady, retireNoticeText } from '../lib/knowledgeList'
import { cleanIpcError } from '../lib/ipcError'
import { useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { SidePanel } from '../components/layout/SidePanel'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { KnowledgeFilters } from '../components/knowledge/KnowledgeFilters'
import { KnowledgeList, type KnowledgeListHandle } from '../components/knowledge/KnowledgeList'
import { DETAIL_HEADING_ID, KnowledgeDetail, type DetailMode } from '../components/knowledge/KnowledgeDetail'
import KnowledgeNeural, { type KnowledgeNeuralHandle } from '../components/knowledge/KnowledgeNeural'
import NoteDialog from '../components/knowledge/NoteDialog'
import type { KnowledgeWrites } from '../components/knowledge/knowledgeWrites'
import { focusLater } from '../components/knowledge/knowledgeWrites'
import '../styles/knowledge.css'

type ViewMode = 'list' | 'graph'

const VIEW_KEY = 'orgai.knowledgeView.'
const RETIRED_KEY = 'orgai.knowledgeRetired.'
const INFERRED_KEY = 'orgai.knowledgeInferred.'

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

/** The count line is spoken this long after the last filter change (spec 2). */
const COUNT_ANNOUNCE_MS = 400

/** After a History run link opens the run (this view unmounts): land focus on a real element unless something already has it. */
function settleRunFocus(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body) return
      const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
      if (composer && !composer.disabled) {
        composer.focus({ preventScroll: true })
        return
      }
      const tab = document.querySelector<HTMLElement>('.run-tab[aria-selected=true]')
      if (tab) {
        tab.focus({ preventScroll: true })
        return
      }
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  )
}

/** The retire / delete notice: a labelled region (the announcement itself goes through `knowledge-status`). The timer pauses while pointer or focus is inside. */
function WriteNotice({ text, undoable, onUndo, onDismiss, onExpire }: { text: string; undoable: boolean; onUndo: () => void; onDismiss: () => void; onExpire: () => void }): ReactElement {
  const [pointer, setPointer] = useState(false)
  const [focus, setFocus] = useState(false)
  const held = pointer || focus
  useEffect(() => {
    if (held) return undefined
    const t = window.setTimeout(onExpire, NOTICE_MS)
    return () => window.clearTimeout(t)
    // Restarted when a new notice replaces this one or the hold ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, text])
  return (
    <div
      className="knowledge-notice-wrap"
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false)
      }}
    >
      <Banner
        tone="info"
        label="Last change"
        testId="knowledge-notice"
        onDismiss={onDismiss}
        actions={
          undoable ? (
            <Button size="sm" testId="knowledge-notice-undo" onClick={onUndo}>
              Undo
            </Button>
          ) : undefined
        }
      >
        {text}
      </Banner>
    </div>
  )
}

/**
 * The Knowledge tab (docs/design/knowledge.md): the engagement's items (entities of the graph and context notes) as
 * a filterable grouped list or a graph, with a detail pane. Loads the graph and the note index, follows
 * `onEngagementChanged` pushes (refetch, never re-sort, never move focus), announces the team's writes at most once
 * per 5 s, and resolves the store's `knowledgeFocus` deep link once it has its data.
 */
export default function KnowledgeView({ project }: { project: Project }): ReactElement {
  const uid = useId()
  const projectId = project.id
  const { confirm, dialog } = useConfirm()
  const focusRun = useAppStore((s) => s.focusRun)
  const knowledgeFocus = useAppStore((s) => s.knowledgeFocus)
  const clearKnowledgeFocus = useAppStore((s) => s.clearKnowledgeFocus)
  const indexes = useRunIndexes()
  const summaries = useProjectSummaries()
  const runs = useMemo<RunFacts>(() => ({ indexes, names: runNamesOf(summaries) }), [indexes, summaries])
  const hasWorkRun = summaries.some((s) => s.kind === 'work')

  // ---- data ----
  const [graph, setGraph] = useState<KnowledgeGraphData | null>(null)
  const [notes, setNotes] = useState<EngagementNote[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef<{ graph?: Promise<void>; notes?: Promise<void>; again: { graph: boolean; notes: boolean } }>({ again: { graph: false, notes: false } })
  const reload = useCallback(
    (what: 'graph' | 'notes'): Promise<void> => {
      const state = inFlight.current
      const running = state[what]
      if (running) {
        state.again[what] = true
        return running
      }
      const run = (what === 'graph' ? window.orgai.knowledge.get(projectId).then((g) => setGraph(g)) : window.orgai.engagement.listNotes(projectId).then((n) => setNotes(n)))
        .then(() => setLoadError(null))
        .catch((e) => {
          // A failed first load keeps the view in its loading state (the Banner offers Retry); later failures keep the data shown.
          setLoadError(cleanIpcError(e))
        })
        .finally(() => {
          state[what] = undefined
          if (state.again[what]) {
            state.again[what] = false
            void reload(what)
          }
        })
      state[what] = run
      return run
    },
    [projectId]
  )
  useEffect(() => {
    setGraph(null)
    setNotes(null)
    setLoadError(null)
    void reload('graph')
    void reload('notes')
  }, [projectId, reload])
  const loaded = graph !== null && notes !== null
  // Inferred links and appearance counts follow each graph revision (main computes them once per revision).
  const [inferred, setInferred] = useState<KnowledgeInferredResult | null>(null)
  const [inferredFailed, setInferredFailed] = useState(false)
  const inferredSeq = useRef(0)
  const reloadInferred = useCallback((): void => {
    const seq = ++inferredSeq.current
    window.orgai.knowledge.inferredLinks(projectId).then(
      (r) => {
        if (seq !== inferredSeq.current) return
        setInferred(r)
        setInferredFailed(false)
      },
      () => {
        if (seq === inferredSeq.current) setInferredFailed(true)
      }
    )
  }, [projectId])
  useEffect(() => {
    if (graph) reloadInferred()
    else setInferred(null)
  }, [graph, reloadInferred])
  const dismissLink = useCallback(
    async (linkId: string): Promise<void> => {
      const seq = ++inferredSeq.current
      const r = await window.orgai.knowledge.dismissLink({ projectId, linkId })
      if (seq === inferredSeq.current) setInferred(r)
    },
    [projectId]
  )
  const [showInferred, setShowInferredState] = useState(() => readPref(INFERRED_KEY + projectId) === 'on')
  const setShowInferred = useCallback(
    (on: boolean): void => {
      setShowInferredState(on)
      writePref(INFERRED_KEY + projectId, on ? 'on' : 'off')
    },
    [projectId]
  )
  const items = useMemo(() => itemsOf(graph ?? emptyKnowledgeGraph(), notes ?? []), [graph, notes])

  // ---- filter ----
  const [filter, setFilter] = useState<KnowledgeFilter>(() => ({ ...EMPTY_FILTER, showRetired: readPref(RETIRED_KEY + projectId) === 'on' }))
  const changeFilter = useCallback(
    (next: Partial<KnowledgeFilter>): void => {
      setFilter((f) => ({ ...f, ...next }))
      if (next.showRetired !== undefined) writePref(RETIRED_KEY + projectId, next.showRetired ? 'on' : 'off')
    },
    [projectId]
  )
  const shown = useMemo(() => searchItems(items, filter), [items, filter])
  useEffect(() => {
    // A pending restore focus is spent when the filter changes (the item may now be filtered out).
    setPendingRestore(null)
  }, [filter.query, filter.kinds, filter.origins])
  const groups = useMemo(() => groupItems(shown), [shown])
  const kinds = useMemo(() => kindCounts(items, filter.showRetired), [items, filter.showRetired])
  const origins = useMemo(() => originCounts(items, filter.showRetired), [items, filter.showRetired])
  const total = filter.showRetired ? items.length : items.filter((i) => !(i.type === 'node' ? i.node.retired : i.note.retired)).length
  const countText = countLine(shown.length, total)
  const empty = loaded ? emptyKind(total, shown.length, isFilterActive(filter), hasWorkRun) : null

  // ---- status region ----
  const [status, setStatus] = useState('')
  const statusSeq = useRef(0)
  const announce = useCallback((text: string): void => {
    const seq = ++statusSeq.current
    setStatus('')
    window.setTimeout(() => {
      if (seq === statusSeq.current) setStatus(text)
    }, 40)
  }, [])
  // The count line is spoken after a filter change, never on load: the flag is armed once the data is in.
  const countArmed = useRef(false)
  useEffect(() => {
    if (loaded) countArmed.current = true
  }, [loaded])
  useEffect(() => {
    if (!countArmed.current) return undefined
    const t = window.setTimeout(() => announce(countText), COUNT_ANNOUNCE_MS)
    return () => window.clearTimeout(t)
    // Spoken on filter changes only (the count text follows the filter and the data).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.query, filter.kinds, filter.origins, filter.showRetired])

  // ---- view switch ----
  const [view, setView] = useState<ViewMode>(() => (readPref(VIEW_KEY + projectId) === 'graph' ? 'graph' : 'list'))
  const changeView = (v: ViewMode): void => {
    setView(v)
    writePref(VIEW_KEY + projectId, v)
  }

  // ---- selection and the pane ----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [paneOpen, setPaneOpen] = useState(true)
  const [reveal, setReveal] = useState<string | null>(null)
  const listRef = useRef<KnowledgeListHandle>(null)
  const selected = selectedId ? (items.find((i) => i.id === selectedId) ?? null) : null
  const focusHeading = useCallback((): void => {
    focusLater(() => document.getElementById(DETAIL_HEADING_ID))
  }, [])
  const openItem = useCallback(
    (id: string): void => {
      setCreating(false)
      setSelectedId(id)
      setPaneOpen(true)
      setReveal(`${id}:${Date.now()}`)
      focusHeading()
    },
    [focusHeading]
  )
  /** A click on a graph node: the panel opens on the item and focus stays where it is. */
  const openPanel = useCallback((id: string): void => {
    setCreating(false)
    setSelectedId(id)
    setPaneOpen(true)
    setReveal(`${id}:${Date.now()}`)
  }, [])
  const neuralRef = useRef<KnowledgeNeuralHandle>(null)
  const selectItem = useCallback((id: string | null): void => {
    setCreating(false)
    setSelectedId(id)
  }, [])
  const focusRow = useCallback((id: string | null): void => {
    requestAnimationFrame(() => {
      if (id) listRef.current?.focusRow(id)
      else listRef.current?.focusCurrent()
    })
  }, [])
  /** A real element when no row or node can take focus: Add a note, else Add an item (disabled at the cap), else the view switch. */
  const focusAddNote = (): void =>
    focusLater(
      () =>
        document.querySelector<HTMLElement>('[data-testid=knowledge-add-note]:not(:disabled)') ??
        document.querySelector<HTMLElement>('[data-testid=knowledge-add-item]:not(:disabled)') ??
        document.querySelector<HTMLElement>('[data-testid=knowledge-view-switch] input:checked')
    )

  // ---- the write notice (retire / delete) ----
  const [notice, setNotice] = useState<{ id: string; item: KnowledgeItem; text: string; undoable: boolean } | null>(null)
  /** A restored item takes focus once the refetch shows it live in the list. */
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)
  useEffect(() => {
    setNotice(null)
    setPendingRestore(null)
  }, [projectId])
  /** Focus a node of the graph once it has mounted (bounded wait, no fixed delay). */
  const focusGraphNode = (id: string | null = null, tries = 40): void => {
    requestAnimationFrame(() => {
      if (neuralRef.current?.focusNode(id)) return
      if (tries > 0) focusGraphNode(id, tries - 1)
      else focusAddNote()
    })
  }
  /** A request with no (or a vanished) target: land focus without opening the pane. */
  const landFallback = (): void => {
    if (view === 'graph') {
      focusGraphNode()
      return
    }
    requestAnimationFrame(() => {
      if (!listRef.current) focusAddNote()
      else if (selectedId && shown.some((i) => i.id === selectedId)) listRef.current.focusRow(selectedId)
      else listRef.current.focusCurrent()
    })
  }
  const landRef = useRef(landFallback)
  landRef.current = landFallback
  useEffect(() => {
    if (!pendingRestore || !restoreReady(shown, pendingRestore)) return
    setPendingRestore(null)
    if (view === 'graph') focusAddNote()
    else focusRow(pendingRestore)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRestore, shown, view])
  const dismissNotice = (): void => {
    setNotice(null)
    if (view === 'graph' || shown.length === 0) focusAddNote()
    else focusRow(selectedId)
  }

  // ---- writes (own ids, in-flight count, refetch) ----
  const ownIds = useRef(new Map<string, number>())
  const writesInFlight = useRef(0)
  const markOwn = (ids: readonly (string | undefined)[]): void => {
    const now = Date.now()
    for (const id of ids) if (id) ownIds.current.set(id, now)
  }
  const track = async <T,>(fn: () => Promise<T>, ids: (r: T) => (string | undefined)[], what: ('graph' | 'notes')[]): Promise<T> => {
    writesInFlight.current++
    try {
      const r = await fn()
      markOwn(ids(r))
      return r
    } finally {
      writesInFlight.current--
      for (const w of what) void reload(w)
    }
  }
  const writes = useMemo<KnowledgeWrites>(
    () => ({
      saveNode: (input) => track(() => window.orgai.knowledge.saveNode({ projectId, ...input }), (n) => [n.id], ['graph']),
      removeNode: async (nodeId) => {
        const edges = (graph?.edges ?? []).filter((e) => e.from === nodeId || e.to === nodeId).map((e) => e.id)
        await track(() => window.orgai.knowledge.removeNode({ projectId, nodeId }), () => [nodeId, ...edges], ['graph'])
      },
      saveEdge: (input) => track(() => window.orgai.knowledge.saveEdge({ projectId, ...input }), (e) => [e.id], ['graph']),
      removeEdge: async (edgeId) => {
        await track(() => window.orgai.knowledge.removeEdge({ projectId, edgeId }), () => [edgeId], ['graph'])
      },
      saveNote: (input) => track(() => window.orgai.engagement.saveNote({ projectId, ...input }), (n) => [n.id], ['notes', 'graph']),
      removeNote: async (noteId) => {
        await track(() => window.orgai.engagement.removeNote({ projectId, noteId }), () => [noteId], ['notes', 'graph'])
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, graph]
  )

  // ---- live updates ----
  const batch = useRef<RecordedBatch>(EMPTY_BATCH)
  const batchTimer = useRef<number | undefined>(undefined)
  const [pendingNew, setPendingNew] = useState<string[]>([])
  useEffect(() => {
    const flush = (): void => {
      const r = flushRecorded(batch.current, Date.now())
      batch.current = r.batch
      if (r.announce) announce(r.announce)
    }
    const off = window.orgai.onEngagementChanged((ev) => {
      if (ev.projectId !== projectId) return
      if (ev.what === 'document') return
      const own = isOwnEvent(ev.ids, ownIds.current, writesInFlight.current, Date.now())
      const itemIds = eventItemIds(ev.ids)
      void reload(ev.what === 'knowledge' ? 'graph' : 'notes').then(() => {
        if (own || itemIds.length === 0) return
        setPendingNew((p) => [...new Set([...p, ...itemIds])])
        const r = addRecorded(batch.current, itemIds.length, Date.now())
        batch.current = r.batch
        if (r.announce) announce(r.announce)
        if (r.delay !== null) {
          window.clearTimeout(batchTimer.current)
          batchTimer.current = window.setTimeout(flush, r.delay)
        }
      })
    })
    return () => {
      off()
      window.clearTimeout(batchTimer.current)
    }
  }, [projectId, reload, announce])
  const hiddenNew = useMemo(() => hiddenNewIds(pendingNew, new Set(items.map((i) => i.id)), new Set(shown.map((i) => i.id))), [pendingNew, items, shown])
  useEffect(() => {
    // Once every pushed item is shown (or gone), the "Show new" offer is spent.
    if (pendingNew.length > 0 && hiddenNew.length === 0) setPendingNew([])
  }, [pendingNew, hiddenNew])
  const showNew = (): void => {
    changeFilter({ kinds: [], origins: [], query: '' })
    setPendingNew([])
  }

  // ---- deep link ----
  useEffect(() => {
    if (!knowledgeFocus || knowledgeFocus.projectId !== projectId || !loaded) return
    const id = resolveFocus(items, knowledgeFocus)
    clearKnowledgeFocus()
    if (id) openItem(id)
    else landRef.current()
  }, [knowledgeFocus, projectId, loaded, items, openItem, clearKnowledgeFocus])

  // ---- notes dialog ----
  const [noteDialog, setNoteDialogState] = useState<{ note: EngagementNoteContent | null; from: 'row' | 'detail' | 'toolbar' } | null>(null)
  // The dialog saves through the IPC itself; while it is open its push counts as this tab's own write.
  const setNoteDialog = (d: { note: EngagementNoteContent | null; from: 'row' | 'detail' | 'toolbar' } | null): void => {
    setNoteDialogState((was) => {
      if (!was && d) writesInFlight.current++
      else if (was && !d) writesInFlight.current = Math.max(0, writesInFlight.current - 1)
      return d
    })
  }
  const editNote = async (noteId: string, from: 'row' | 'detail'): Promise<void> => {
    try {
      setNoteDialog({ note: await window.orgai.engagement.getNote({ projectId, noteId }), from })
    } catch (e) {
      setError(cleanIpcError(e))
    }
  }

  // ---- retire, restore, delete ----
  const setRetired = async (item: KnowledgeItem, retired: boolean): Promise<void> => {
    const name = itemName(item)
    const shownIds = shown.map((i) => i.id)
    try {
      if (item.type === 'node') await writes.saveNode({ nodeId: item.id, kind: item.node.kind, name: item.node.name, retired })
      else {
        const full = await window.orgai.engagement.getNote({ projectId, noteId: item.id })
        await writes.saveNote({ noteId: item.id, title: full.title, text: full.text, retired })
      }
      if (retired) {
        announce(retireNoticeText(name, 'retired'))
        setPendingRestore(null)
        setNotice({ id: item.id, item, text: retireNoticeText(name, 'retired'), undoable: true })
        // The pane stays on the retired item (Retired badge, Restore): the selection never jumps to the next one.
        if (view === 'graph') focusLater(() => document.querySelector<HTMLElement>('[data-testid=knowledge-notice-undo]'))
        else if (!filter.showRetired) {
          const next = idAfterRemoval(shownIds, item.id)
          if (next) focusRow(next)
          else focusAddNote()
        } else focusRow(item.id)
      } else {
        announce(`Restored ${name}.`)
        setNotice((n) => (n?.id === item.id ? null : n))
        setPendingRestore(item.id)
      }
    } catch (e) {
      setError(cleanIpcError(e))
    }
  }
  /** Undo restores the item as it is now (a rename made after the retire survives); a vanished item just clears the notice. */
  const undoRetire = (id: string): void => {
    const live = items.find((i) => i.id === id)
    if (!live) {
      setNotice(null)
      announce('That item no longer exists.')
      if (view === 'graph' || shown.length === 0) focusAddNote()
      else focusRow(selectedId)
      return
    }
    void setRetired(live, false)
  }
  const remove = async (item: KnowledgeItem): Promise<void> => {
    const name = itemName(item)
    const ok =
      item.type === 'node'
        ? await confirm({ title: `Delete ${name}?`, body: 'Agents and you can no longer see it. Retire it instead to keep the record.', confirmLabel: 'Delete', danger: true, confirmTestId: 'knowledge-delete-confirm' })
        : await confirm({ title: `Remove the note ${name}?`, body: 'Agents can no longer read it. This cannot be undone.', confirmLabel: 'Remove note', danger: true })
    if (!ok) return
    const shownIds = shown.map((i) => i.id)
    try {
      if (item.type === 'node') await writes.removeNode(item.id)
      else await writes.removeNote(item.id)
      announce(retireNoticeText(name, 'deleted'))
      setNotice({ id: item.id, item, text: retireNoticeText(name, 'deleted'), undoable: false })
      const next = idAfterRemoval(shownIds, item.id)
      selectItem(next)
      if (view === 'graph') focusAddNote()
      else if (next) focusRow(next)
      else focusAddNote()
    } catch (e) {
      setError(cleanIpcError(e))
    }
  }

  const mode: DetailMode = creating ? { kind: 'create' } : selected ? { kind: 'item', item: selected } : { kind: 'empty' }
  const notesFull = (notes?.length ?? 0) >= ENGAGEMENT_NOTES_MAX
  const nodesFull = (graph?.nodes.length ?? 0) >= KNOWLEDGE_NODES_MAX
  const listDomId = `${uid}-list`
  const filtersDomId = `${uid}-filters`
  const addButtons = (
    <>
      <Button size="sm" icon={Plus} testId="knowledge-add-note" disabled={notesFull} ariaDescribedBy={notesFull ? `${uid}-notes-cap` : undefined} onClick={() => setNoteDialog({ note: null, from: 'toolbar' })}>
        Add a note
      </Button>
      {notesFull && (
        <span id={`${uid}-notes-cap`} className="knowledge-quiet">
          {notesCapText(ENGAGEMENT_NOTES_MAX)}
        </span>
      )}
      <Button
        size="sm"
        icon={Plus}
        testId="knowledge-add-item"
        disabled={nodesFull}
        ariaDescribedBy={nodesFull ? `${uid}-items-cap` : undefined}
        onClick={() => {
          setCreating(true)
          setSelectedId(null)
          setPaneOpen(true)
          setReveal(`new:${Date.now()}`)
          focusLater(() => document.querySelector<HTMLElement>('[data-testid=knowledge-create] [data-testid=knowledge-name-input]'))
        }}
      >
        Add an item
      </Button>
      {nodesFull && (
        <span id={`${uid}-items-cap`} className="knowledge-quiet">
          {itemsCapText(KNOWLEDGE_NODES_MAX)}
        </span>
      )}
    </>
  )

  return (
    <div className="knowledge" data-testid="knowledge-view" data-project={projectId} data-view={view}>
      <div className="knowledge-toolbar" data-testid="knowledge-toolbar">
        <span data-testid="knowledge-view-switch">
          <SegmentedControl<ViewMode>
            label="View"
            value={view}
            options={[
              { value: 'list', label: 'List' },
              { value: 'graph', label: 'Graph' }
            ]}
            onChange={changeView}
          />
        </span>
        <span className="spacer" />
        {addButtons}
      </div>
      <KnowledgeFilters domId={filtersDomId} filter={filter} kinds={kinds} origins={origins} onChange={changeFilter} countText={countText} hiddenNew={hiddenNew.length} onShowNew={showNew} />
      <div className="knowledge-main" data-testid="knowledge-main">
        {notice && <WriteNotice text={notice.text} undoable={notice.undoable} onUndo={() => undoRetire(notice.id)} onDismiss={dismissNotice} onExpire={() => setNotice(null)} />}
        {(loadError || error) && (
          <Banner
            tone="danger"
            title="Knowledge"
            testId="knowledge-error"
            onDismiss={() => {
              setError(null)
              setLoadError(null)
            }}
            actions={
              loadError ? (
                <Button
                  size="sm"
                  onClick={() => {
                    void reload('graph')
                    void reload('notes')
                  }}
                >
                  Retry
                </Button>
              ) : undefined
            }
          >
            {loadError ?? error}
          </Banner>
        )}
        {!loaded ? (
          !loadError && <p className="panel-note knowledge-loading">Looking…</p>
        ) : view === 'graph' ? (
          <KnowledgeNeural
            ref={neuralRef}
            projectId={projectId}
            graph={graph ?? emptyKnowledgeGraph()}
            inferred={inferred}
            filter={filter}
            showInferred={showInferred}
            selectedId={selectedId}
            onSelect={selectItem}
            onOpenPanel={openPanel}
            onOpen={openItem}
            onShowList={() => {
              changeView('list')
              focusRow(selectedId)
            }}
            onSkipToDetail={focusHeading}
            onClearFilters={() => changeFilter({ query: '', kinds: [], origins: [] })}
            announce={announce}
          />
        ) : empty === 'none' || empty === 'none-runs' ? (
          <EmptyState
            compact
            testId={empty === 'none' ? 'knowledge-empty' : 'knowledge-empty-runs'}
            title={empty === 'none' ? 'Nothing recorded yet' : 'The team has not recorded anything yet'}
            description={empty === 'none' ? 'Add a note for the team, or run the team and it records people, systems, decisions and risks here as it works.' : 'Notes you add here are read at the start of every run.'}
            actions={addButtons}
          />
        ) : empty === 'filter' ? (
          <EmptyState
            compact
            testId="knowledge-empty-filter"
            title={filter.query.trim() ? `No items match ${filter.query.trim()}.` : 'No items match these filters.'}
            actions={
              <Button size="sm" testId="knowledge-clear-filters" onClick={() => changeFilter({ query: '', kinds: [], origins: [] })}>
                Clear search
              </Button>
            }
          />
        ) : empty === 'retired' ? (
          <EmptyState compact testId="knowledge-empty-retired" title="Only retired items." description="Show retired to see them." />
        ) : (
          <KnowledgeList
            ref={listRef}
            domId={listDomId}
            groups={groups}
            runs={runs}
            selectedId={selectedId}
            showAgentBadge={filter.origins.length === 0}
            onSelect={selectItem}
            onOpen={openItem}
            onRetire={(item, retired) => void setRetired(item, retired)}
            onEditNote={(id) => void editNote(id, 'row')}
          />
        )}
      </div>
      <SidePanel label="item details" persistKey="knowledge" autoCollapseBelow={1100} revealOn={reveal} open={paneOpen} onOpenChange={setPaneOpen} testId="knowledge-detail">
        <KnowledgeDetail
          mode={mode}
          graph={graph ?? emptyKnowledgeGraph()}
          notes={notes ?? []}
          runs={runs}
          showRetired={filter.showRetired}
          writes={writes}
          onSelect={openItem}
          onOpenRun={(runId) => void focusRun(projectId, runId).then(settleRunFocus)}
          onEditNote={(id) => void editNote(id, 'detail')}
          onRetire={(item, retired) => void setRetired(item, retired)}
          onDelete={(item) => void remove(item)}
          onCreated={(node: KnowledgeNode) => {
            setCreating(false)
            announce(`Saved ${node.name}.`)
            openItem(node.id)
          }}
          onCancelCreate={() => {
            setCreating(false)
            focusLater(() => document.querySelector<HTMLElement>('[data-testid=knowledge-add-item]'))
          }}
          onEscape={() => {
            if (view === 'graph') focusGraphNode(selectedId)
            else focusRow(selectedId)
          }}
          onError={(m) => setError(cleanIpcError(m))}
          announce={announce}
        />
      </SidePanel>
      <p className="sr-only" role="status" data-testid="knowledge-status">
        {status}
      </p>
      {noteDialog && (
        <NoteDialog
          key={noteDialog.note?.id ?? 'new'}
          projectId={projectId}
          note={noteDialog.note}
          onClose={() => setNoteDialog(null)}
          onSaved={(saved) => {
            const wasNew = noteDialog.note === null
            const from = noteDialog.from
            setNoteDialog(null)
            markOwn([saved.id])
            void reload('notes').then(() => {
              announce('Note saved.')
              if (wasNew) {
                selectItem(saved.id)
                focusRow(saved.id)
              } else if (from === 'detail') focusLater(() => document.querySelector<HTMLElement>('[data-testid=knowledge-note-edit]'))
              else focusRow(saved.id)
            })
          }}
        />
      )}
      {dialog}
    </div>
  )
}
