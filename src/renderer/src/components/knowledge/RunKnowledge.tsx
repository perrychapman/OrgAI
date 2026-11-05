import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { EngagementNote, KnowledgeGraph, KnowledgeNode } from '@shared/types'
import { searchKnowledge } from '@shared/knowledge'
import { chainKeyOf, chainOf } from '../../lib/runChains'
import { HIDDEN_CLASS } from '../../lib/hiddenChars'
import {
  historyLines,
  itemExcerpt,
  itemsOf,
  keyWords,
  kindLabel,
  relatedRows,
  resolveFocus,
  runNamesOf,
  type KnowledgeItem
} from '../../lib/knowledge'
import { knowledgeReadLines } from '../../lib/knowledgeRun'
import {
  givenText,
  isRunWindow,
  popStep,
  pushStep,
  recalledRows,
  RECALLED_OLD_NOTE,
  resultsStatus,
  RUN_KNOWLEDGE_RESULT_LIMIT,
  RUN_WINDOW_NOTE
} from '../../lib/runKnowledge'
import { cleanIpcError } from '../../lib/ipcError'
import { EMPTY_RUN_KNOWLEDGE, useAppStore, useProjectSummaries, useRunIndexes, type RunKnowledgeUi } from '../../store/useAppStore'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { useRovingFocus } from '../connectors/useRovingFocus'
import { KindMark } from './KindMark'
import '../../styles/knowledge-run.css'

const HIDDEN_RUN = new RegExp(HIDDEN_CLASS, 'gu')
/** Item text drawn here is agent- or user-written: control, bidi and zero-width characters never reach the screen. */
const plain = (s: string): string => s.replace(HIDDEN_RUN, '')
const SEARCH_DEBOUNCE_MS = 150

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; graph: KnowledgeGraph; notes: EngagementNote[] }

/** One list row (a search result or a recalled item): mark, name, kind and one line of excerpt. */
function ItemRow({ node, testId, extra }: { node: KnowledgeNode; testId: string; extra?: string }): ReactElement {
  const item: KnowledgeItem = { type: 'node', id: node.id, node }
  const excerpt = plain(itemExcerpt(item))
  return (
    <>
      <KindMark kind={node.kind} />
      <span className="run-knowledge-row-text">
        <span className="run-knowledge-row-head">
          <span className="run-knowledge-row-name" title={plain(node.name)}>
            {plain(node.name)}
          </span>
          <span className="run-knowledge-row-kind">{kindLabel(node.kind)}</span>
          {node.retired && <span className="run-knowledge-row-kind">Retired</span>}
        </span>
        {excerpt && <span className="run-knowledge-row-excerpt">{excerpt}</span>}
        {extra && (
          <span className="run-knowledge-row-extra" data-testid={`${testId}-given`}>
            {extra}
          </span>
        )}
      </span>
    </>
  )
}

/**
 * The run side tab "Knowledge" (docs/design/knowledge-graph-2.md section 3): search what the team recorded, what agents
 * looked up or were given in this conversation, and a read-only compact detail with a Back stack. Reads
 * `knowledge.get` and searches here; no model call, no write.
 */
export default function RunKnowledge({ runId, projectId }: { runId: string; projectId: string }): ReactElement {
  const summaries = useProjectSummaries()
  const chainIds = useMemo(() => chainOf(summaries, runId).map((m) => m.id), [summaries, runId])
  const key = useMemo(() => chainKeyOf(summaries, runId), [summaries, runId])
  const ui = useAppStore((s) => s.runKnowledgeByChain[key]) ?? EMPTY_RUN_KNOWLEDGE
  const patchRunKnowledge = useAppStore((s) => s.patchRunKnowledge)
  const patch = useCallback((p: Partial<RunKnowledgeUi>) => patchRunKnowledge(runId, p), [patchRunKnowledge, runId])
  const events = useAppStore((s) => s.knowledgeRecalledByRun)
  const readLinesKey = useAppStore((s) => chainIds.flatMap((id) => knowledgeReadLines(s.runs[id]?.transcript ?? [])).join('\u0001'))
  const indexes = useRunIndexes()
  const names = useMemo(() => runNamesOf(summaries), [summaries])
  const inWindow = isRunWindow()

  // ---- data: one fetch in flight, a push while it runs asks for one more ----
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const alive = useRef(true)
  const inflight = useRef(false)
  const again = useRef(false)
  const fetchGraph = useCallback(async (): Promise<void> => {
    if (inflight.current) {
      again.current = true
      return
    }
    inflight.current = true
    try {
      do {
        again.current = false
        try {
          const [graph, notes] = await Promise.all([window.orgai.knowledge.get(projectId), window.orgai.engagement.listNotes(projectId).catch(() => [] as EngagementNote[])])
          if (!alive.current) return
          setLoad({ state: 'ready', graph, notes })
        } catch (e) {
          if (!alive.current) return
          setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'error', message: cleanIpcError(e) }))
        }
      } while (again.current && alive.current)
    } finally {
      inflight.current = false
    }
  }, [projectId])
  useEffect(() => {
    alive.current = true
    void fetchGraph()
    const off = window.orgai.onEngagementChanged((ev) => {
      if (ev.projectId === projectId && (ev.what === 'knowledge' || ev.what === 'notes')) void fetchGraph()
    })
    return () => {
      alive.current = false
      off()
    }
  }, [projectId, fetchGraph])

  const graph = load.state === 'ready' ? load.graph : null
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])

  // ---- search (debounced; Esc clears and keeps focus) ----
  const [text, setText] = useState(ui.query)
  const lastSent = useRef(ui.query)
  useEffect(() => {
    // An open from a link sets the query in the store: show it in the box.
    if (ui.query !== lastSent.current) {
      lastSent.current = ui.query
      setText(ui.query)
    }
  }, [ui.query])
  const textNow = useRef(text)
  textNow.current = text
  useEffect(() => {
    if (text === lastSent.current) return undefined
    const t = setTimeout(() => {
      lastSent.current = text
      patch({ query: text })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text, patch])
  // Leaving the tab inside the debounce keeps what was typed.
  useEffect(
    () => () => {
      if (textNow.current !== lastSent.current) {
        lastSent.current = textNow.current
        patch({ query: textNow.current })
      }
    },
    [patch]
  )
  const query = ui.query.trim()
  const hits = useMemo(() => (graph && query ? searchKnowledge(graph, { query, limit: RUN_KNOWLEDGE_RESULT_LIMIT }) : []), [graph, query])

  // ---- recalled in this run (over the whole chain) ----
  const recalled = useMemo(() => {
    const all = chainIds.flatMap((id) => events[id] ?? [])
    return recalledRows(all, new Set(nodeById.keys()))
  }, [chainIds, events, nodeById])
  const readLines = useMemo(() => (readLinesKey ? readLinesKey.split('\u0001') : []), [readLinesKey])

  // ---- status (the panel's one live region) ----
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (load.state === 'error') setStatus('Could not read what the team recorded.')
    else if (load.state === 'ready' && query && !ui.openId) setStatus(resultsStatus(hits.length, query))
    else setStatus('')
  }, [load.state, query, hits.length, ui.openId])

  // ---- open item, Back stack, focus ----
  const root = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const wantFocus = useRef<'heading' | { id: string } | 'search' | null>(null)
  const open = (id: string): void => {
    wantFocus.current = 'heading'
    patch({ openId: id, stack: pushStep(ui.stack, ui.openId) })
  }
  const back = (): void => {
    const step = popStep(ui.stack, ui.openId)
    wantFocus.current = step.left ? { id: step.left } : 'search'
    patch({ openId: step.openId, stack: step.stack })
  }
  useLayoutEffect(() => {
    const want = wantFocus.current
    if (!want) return
    if (want === 'heading') {
      if (!headingRef.current) return
      wantFocus.current = null
      headingRef.current.focus({ preventScroll: true })
      return
    }
    wantFocus.current = null
    const search = root.current?.querySelector<HTMLElement>('[data-testid=run-knowledge-search]')
    if (want === 'search') {
      search?.focus({ preventScroll: true })
      return
    }
    const target = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-return-id]') ?? []).find((el) => el.dataset.returnId === want.id)
    if (target) target.focus({ preventScroll: true })
    else (search ?? headingRef.current)?.focus({ preventScroll: true })
  })

  // A request from a transcript link or RunMeta (run windows): resolve once the graph is here.
  useEffect(() => {
    const req = ui.request
    if (!req || !graph) return
    if (!req.nodeId && !req.name && !req.noteTitle) {
      patch({ request: undefined })
      return
    }
    const id = resolveFocus(itemsOf(graph, []), req)
    if (id) {
      wantFocus.current = 'heading'
      patch({ request: undefined, openId: id, stack: [] })
    } else patch({ request: undefined, query: req.name ?? req.noteTitle ?? '', openId: null, stack: [] })
  }, [ui.request, graph, patch])

  // Rows reorder as agents recall things; if the focused row moved and lost focus, put it back.
  const lastFocusedId = useRef<string | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && root.current?.contains(active) && active.dataset.returnId) lastFocusedId.current = active.dataset.returnId
    else if ((active === document.body || active === null) && lastFocusedId.current) {
      Array.from(root.current?.querySelectorAll<HTMLElement>('[data-return-id]') ?? [])
        .find((el) => el.dataset.returnId === lastFocusedId.current)
        ?.focus({ preventScroll: true })
    }
  })

  const resultsRef = useRef<HTMLUListElement>(null)
  const recalledRef = useRef<HTMLUListElement>(null)
  const resultsRove = useRovingFocus(resultsRef, '[data-testid=run-knowledge-result]')
  const recalledRove = useRovingFocus(recalledRef, '[data-testid=run-knowledge-recalled-row]')

  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (ui.openId) {
      e.preventDefault()
      e.stopPropagation()
      back()
    }
  }

  // ---- render ----
  let body: ReactElement
  if (load.state === 'loading') {
    body = (
      <p className="panel-note" data-testid="run-knowledge-loading">
        Looking…
      </p>
    )
  } else if (load.state === 'error') {
    body = (
      <div className="run-knowledge-error" data-testid="run-knowledge-error">
        <p className="panel-note">Could not read what the team recorded.</p>
        <Button
          size="sm"
          onClick={() => {
            setLoad({ state: 'loading' })
            void fetchGraph()
          }}
          testId="run-knowledge-retry"
        >
          Retry
        </Button>
      </div>
    )
  } else if (ui.openId) {
    const node = nodeById.get(ui.openId)
    const runs = { indexes, names }
    const item: KnowledgeItem | null = node ? { type: 'node', id: node.id, node } : null
    const liveFacts = node ? node.facts.filter((f) => !f.retired) : []
    const related = node ? relatedRows(load.graph, node.id, false) : []
    const noteTitles = node ? (node.noteIds ?? []).map((id) => load.notes.find((n) => n.id === id)?.title).filter((t): t is string => !!t) : []
    const firstHistory = item ? historyLines(item, runs)[0]?.text : undefined
    body = (
      <div className="run-knowledge-detail" data-testid="run-knowledge-detail" data-id={ui.openId}>
        <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={back} testId="run-knowledge-back">
          Back
        </Button>
        {!node ? (
          <p className="panel-note" data-testid="run-knowledge-gone">
            This item no longer exists.
          </p>
        ) : (
          <>
            <h3 className="run-knowledge-name" tabIndex={-1} ref={headingRef}>
              <KindMark kind={node.kind} />
              <span>{plain(node.name)}</span>
            </h3>
            <p className="run-knowledge-badges">
              <Badge tone="neutral">{kindLabel(node.kind)}</Badge>
              {node.retired && <Badge tone="neutral">Retired</Badge>}
            </p>
            {node.summary && <p className="run-knowledge-summary">{plain(node.summary)}</p>}
            {liveFacts.length > 0 && (
              <section aria-labelledby={`rk-facts-${node.id}`}>
                <h4 id={`rk-facts-${node.id}`}>Facts</h4>
                <ul className="run-knowledge-facts">
                  {liveFacts.map((f) => (
                    <li key={f.id}>{plain(f.text)}</li>
                  ))}
                </ul>
              </section>
            )}
            {related.length > 0 && (
              <section aria-labelledby={`rk-related-${node.id}`}>
                <h4 id={`rk-related-${node.id}`}>Related</h4>
                <ul className="run-knowledge-related">
                  {related.map((r) => {
                    const word = keyWords(r.edge.relation)
                    const link = r.other ? (
                      <button type="button" className="link-btn" data-return-id={r.other.id} data-testid="run-knowledge-related-link" onClick={() => open(r.other!.id)}>
                        {plain(r.other.name)}
                      </button>
                    ) : (
                      <span>(removed)</span>
                    )
                    return (
                      <li key={r.edge.id}>
                        {r.outgoing ? (
                          <>
                            {word} {link}
                          </>
                        ) : (
                          <>
                            {link} {word}
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
            {noteTitles.length > 0 && (
              <section aria-labelledby={`rk-notes-${node.id}`}>
                <h4 id={`rk-notes-${node.id}`}>Notes</h4>
                <ul className="run-knowledge-facts">
                  {noteTitles.map((t, i) => (
                    <li key={`${i}-${t}`}>{plain(t)}</li>
                  ))}
                </ul>
              </section>
            )}
            {firstHistory && <p className="run-knowledge-history">{plain(firstHistory)}</p>}
            {inWindow ? (
              <p className="run-knowledge-window-note" data-testid="run-knowledge-window-note">
                {RUN_WINDOW_NOTE}
              </p>
            ) : (
              <Button size="sm" onClick={() => useAppStore.getState().openKnowledgeItem({ projectId, nodeId: node.id })} testId="run-knowledge-open-tab">
                Open in Knowledge
              </Button>
            )}
          </>
        )}
      </div>
    )
  } else if (load.graph.nodes.length === 0) {
    body = (
      <p className="panel-note" data-testid="run-knowledge-empty">
        Nothing recorded yet. Agents add items here as they work.
      </p>
    )
  } else {
    body = (
      <>
        <div className="run-knowledge-search">
          <label htmlFor={`rk-search-${key}`}>Search what the team knows</label>
          <Input
            id={`rk-search-${key}`}
            value={text}
            placeholder="Name, fact or alias"
            autoComplete="off"
            onChange={setText}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && text) {
                e.preventDefault()
                e.stopPropagation()
                lastSent.current = ''
                setText('')
                patch({ query: '' })
              } else if (e.key === 'ArrowDown' && hits.length > 0 && text.trim() === ui.query.trim()) {
                e.preventDefault()
                resultsRove.focusCurrent()
              }
            }}
            data-testid="run-knowledge-search"
          />
        </div>
        {query ? (
          <section className="run-knowledge-section" aria-label="Search results">
            {hits.length === 0 ? (
              <p className="panel-note" data-testid="run-knowledge-none">
                Nothing recorded matches {query}.
              </p>
            ) : (
              <ul className="run-knowledge-list" data-testid="run-knowledge-results" ref={resultsRef} onKeyDown={resultsRove.onKeyDown} onFocus={resultsRove.onFocus}>
                {hits.map((h) => (
                  <li key={h.node.id}>
                    <button
                      type="button"
                      className="run-knowledge-row"
                      data-testid="run-knowledge-result"
                      data-id={h.node.id}
                      data-kind={h.node.kind}
                      data-return-id={h.node.id}
                      onClick={() => open(h.node.id)}
                    >
                      <ItemRow node={h.node} testId="run-knowledge-result" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {hits.length >= RUN_KNOWLEDGE_RESULT_LIMIT && (
              <p className="run-knowledge-more" data-testid="run-knowledge-limit">
                Showing the first {RUN_KNOWLEDGE_RESULT_LIMIT}. Search for more of the name.
              </p>
            )}
          </section>
        ) : (
          <section className="run-knowledge-section" data-testid="run-knowledge-recalled" aria-labelledby={`rk-recalled-${key}`}>
            <h3 id={`rk-recalled-${key}`}>Recalled in this run</h3>
            <p className="run-knowledge-caption">What agents looked up or were given.</p>
            {recalled.length > 0 ? (
              <ul className="run-knowledge-list" ref={recalledRef} onKeyDown={recalledRove.onKeyDown} onFocus={recalledRove.onFocus}>
                {recalled.map((r) => {
                  const node = nodeById.get(r.id)!
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="run-knowledge-row"
                        data-testid="run-knowledge-recalled-row"
                        data-id={r.id}
                        data-kind={node.kind}
                        data-count={r.count}
                        data-return-id={r.id}
                        onClick={() => open(r.id)}
                      >
                        <ItemRow node={node} testId="run-knowledge-recalled-row" extra={givenText(r.count)} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : readLines.length > 0 ? (
              <>
                <ul className="run-knowledge-lines">
                  {readLines.map((l, i) => (
                    <li key={i} data-testid="run-knowledge-recalled-line">
                      {plain(l)}
                    </li>
                  ))}
                </ul>
                <p className="run-knowledge-caption" data-testid="run-knowledge-recalled-note">
                  {RECALLED_OLD_NOTE}
                </p>
              </>
            ) : (
              <p className="panel-note" data-testid="run-knowledge-recalled-empty">
                Nothing recalled yet. Items agents look up or are given show here.
              </p>
            )}
          </section>
        )}
        <p className="run-knowledge-free" data-testid="run-knowledge-free">
          Searching here does not call a model.
        </p>
      </>
    )
  }

  return (
    <div className="run-knowledge" data-testid="run-knowledge" onKeyDown={onRootKeyDown} ref={root}>
      <p className="sr-only" role="status" data-testid="run-knowledge-status">
        {status}
      </p>
      {body}
    </div>
  )
}
