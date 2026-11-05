import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KnowledgeGraph, KnowledgeInferredLink, KnowledgeNode } from '@shared/types'
import { keyWords } from '../../lib/knowledge'
import { relationsInUse } from '../../lib/knowledgeList'
import { cleanIpcError } from '../../lib/ipcError'
import { POSSIBLE_LOAD_FAILED, POSSIBLE_QUIET, POSSIBLE_VISIBLE, confirmWord, dismissLabel, initialWord, linkedStatus, moreLabel, possibleRows, rowAfterRemoval } from '../../lib/knowledgePossible'
import type { PossibleRow } from '../../lib/knowledgePossible'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import type { KnowledgeWrites } from './knowledgeWrites'

const ADD_RELATION = '[data-testid=knowledge-relation-add]'

/**
 * Possible connections (docs/design/knowledge-graph-2.md section 2.2), directly under Related on a live item: links OrgAI
 * derived from the text, each with its why, an editable relation word, Confirm (an ordinary user relation) and Dismiss.
 * Suggestions are never facts; all text is rendered as text. No undo and no merge.
 */
export function KnowledgePossible({
  node,
  graph,
  links,
  failed,
  partialNote,
  writes,
  onSelect,
  onRetry,
  onDismiss,
  announce
}: {
  node: KnowledgeNode
  graph: KnowledgeGraph
  /** Null until the first answer. */
  links: readonly KnowledgeInferredLink[] | null
  failed: boolean
  /** The matcher stopped at its budget: the honest line, else null. */
  partialNote: string | null
  writes: KnowledgeWrites
  onSelect: (id: string) => void
  onRetry: () => void
  onDismiss: (linkId: string) => Promise<void>
  announce: (text: string) => void
}): ReactElement | null {
  const uid = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const rows = useMemo(() => possibleRows(links ?? [], node.id, graph.nodes, graph.edges), [links, node.id, graph.nodes, graph.edges])
  const [expanded, setExpanded] = useState(false)
  const [words, setWords] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const relations = useMemo(() => relationsInUse(graph.edges), [graph.edges])
  const shown = expanded ? rows : rows.slice(0, POSSIBLE_VISIBLE)

  // Another item: a fresh list.
  useEffect(() => {
    setExpanded(false)
    setWords({})
    setErrors({})
    setBusy(null)
    tracked.current = null
  }, [node.id])

  // Focus rule: the row that had focus left the list (confirmed, dismissed, or a push removed it) and focus fell to the
  // page: the next row's Confirm, else "Add a relation".
  const tracked = useRef<{ id: string; order: string[] } | null>(null)
  const orderRef = useRef<string[]>([])
  orderRef.current = rows.map((r) => r.link.id)
  useEffect(() => {
    const t = tracked.current
    if (!t || rows.some((r) => r.link.id === t.id)) return
    tracked.current = null
    const a = document.activeElement
    if (a && a !== document.body && sectionRef.current && !sectionRef.current.contains(a)) return
    const next = rowAfterRemoval(t.order, rows.map((r) => r.link.id), t.id)
    requestAnimationFrame(() => {
      const el = (next ? sectionRef.current?.querySelector<HTMLElement>(`[data-testid=knowledge-possible-row][data-link="${next}"] [data-testid=knowledge-possible-confirm]`) : null) ?? document.querySelector<HTMLElement>(ADD_RELATION)
      el?.focus()
    })
  }, [rows])

  if (rows.length === 0) return failed ? <FailedLoad uid={uid} onRetry={onRetry} /> : null

  const wordOf = (r: PossibleRow): string => words[r.link.id] ?? initialWord(r.link)
  const confirm = async (r: PossibleRow): Promise<void> => {
    const id = r.link.id
    const word = wordOf(r)
    const checked = confirmWord(word)
    if ('error' in checked) {
      setErrors((e) => ({ ...e, [id]: checked.error }))
      sectionRef.current?.querySelector<HTMLElement>(`[data-link="${id}"] [data-testid=knowledge-possible-word]`)?.focus()
      return
    }
    setBusy(id)
    try {
      await writes.saveEdge({ from: r.link.from, to: r.link.to, relation: checked.key })
      announce(linkedStatus(r.from.name, keyWords(checked.key), r.to.name))
    } catch (e) {
      setErrors((m) => ({ ...m, [id]: cleanIpcError(e) }))
      requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>(`[data-link="${id}"] [data-testid=knowledge-possible-word]`)?.focus())
    } finally {
      setBusy(null)
    }
  }
  const dismiss = async (r: PossibleRow): Promise<void> => {
    setBusy(r.link.id)
    try {
      await onDismiss(r.link.id)
      announce('Dismissed.')
    } catch (e) {
      setErrors((m) => ({ ...m, [r.link.id]: cleanIpcError(e) }))
    } finally {
      setBusy(null)
    }
  }
  const hidden = rows.length - shown.length

  return (
    <section ref={sectionRef} className="knowledge-section" aria-labelledby={`${uid}-h`} data-testid="knowledge-possible">
      <h3 id={`${uid}-h`} className="knowledge-section-title">
        Possible connections
      </h3>
      {failed && (
        <p className="knowledge-possible-failed" data-testid="knowledge-possible-error-load" role="status">
          {POSSIBLE_LOAD_FAILED}{' '}
          <button type="button" className="link-btn" data-testid="knowledge-possible-retry" onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
      <p className="knowledge-quiet">{POSSIBLE_QUIET}</p>
      {partialNote && (
        <p className="knowledge-quiet" data-testid="knowledge-possible-partial">
          {partialNote}
        </p>
      )}
      <ul className="knowledge-possible-list">
        {shown.map((r) => {
          const id = r.link.id
          const err = errors[id]
          const otherLink = (
            <button type="button" className="link-btn knowledge-relation-link" data-testid="knowledge-possible-other" data-target={r.other.id} onClick={() => onSelect(r.other.id)}>
              {r.other.name}
            </button>
          )
          const word = wordOf(r)
          return (
            <li key={id} className="knowledge-possible" data-testid="knowledge-possible-row" data-link={id} data-basis={r.link.basis} onFocus={() => (tracked.current = { id, order: orderRef.current })}>
              <form
                className="knowledge-possible-form"
                aria-label={`Possible connection with ${r.other.name}`}
                onSubmit={(e) => {
                  e.preventDefault()
                  void confirm(r)
                }}
              >
                {r.why.sameName ? (
                  <p className="knowledge-possible-why" data-testid="knowledge-possible-why">
                    Same name as {otherLink}: might be the same thing
                  </p>
                ) : (
                  <>
                    <p className="knowledge-possible-other">{otherLink}</p>
                    <p className="knowledge-possible-why" data-testid="knowledge-possible-why">
                      {r.why.lead}
                      {r.why.snippet && <>: {r.why.snippet}</>}
                    </p>
                  </>
                )}
                <div className="knowledge-possible-statement">
                  <span className="knowledge-possible-name">{r.from.name}</span>
                  <label htmlFor={`${uid}-w-${id}`} className="sr-only">
                    Relation
                  </label>
                  <Input
                    id={`${uid}-w-${id}`}
                    value={word}
                    list={relations.length ? `${uid}-rels` : undefined}
                    invalid={!!err}
                    aria-describedby={err ? `${uid}-e-${id}` : undefined}
                    placeholder="works at"
                    autoComplete="off"
                    spellCheck={false}
                    data-testid="knowledge-possible-word"
                    onChange={(v) => {
                      setWords((w) => ({ ...w, [id]: v }))
                      if (err) setErrors((m) => ({ ...m, [id]: '' }))
                    }}
                  />
                  <span className="knowledge-possible-name">{r.to.name}</span>
                </div>
                {err && (
                  <span id={`${uid}-e-${id}`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-possible-error">
                    {err}
                  </span>
                )}
                <div className="knowledge-section-actions">
                  <Button type="submit" size="sm" loading={busy === id} testId="knowledge-possible-confirm">
                    Confirm
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === id} ariaLabel={dismissLabel(r.other.name)} testId="knowledge-possible-dismiss" onClick={() => void dismiss(r)}>
                    Dismiss
                  </Button>
                </div>
              </form>
            </li>
          )
        })}
      </ul>
      {relations.length > 0 && (
        <datalist id={`${uid}-rels`}>
          {relations.map((rel) => (
            <option key={rel} value={keyWords(rel)} />
          ))}
        </datalist>
      )}
      {hidden > 0 && (
        <div className="knowledge-section-actions">
          <Button
            size="sm"
            variant="ghost"
            testId="knowledge-possible-more"
            onClick={() => {
              const first = rows[POSSIBLE_VISIBLE]?.link.id
              setExpanded(true)
              requestAnimationFrame(() => requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>(`[data-link="${first}"] [data-testid=knowledge-possible-word]`)?.focus()))
            }}
          >
            {moreLabel(hidden)}
          </Button>
        </div>
      )}
    </section>
  )
}

function FailedLoad({ uid, onRetry }: { uid: string; onRetry: () => void }): ReactElement {
  return (
    <section className="knowledge-section" aria-labelledby={`${uid}-h`} data-testid="knowledge-possible">
      <h3 id={`${uid}-h`} className="knowledge-section-title">
        Possible connections
      </h3>
      <p className="knowledge-possible-failed" data-testid="knowledge-possible-error-load" role="status">
        {POSSIBLE_LOAD_FAILED}
      </p>
      <div className="knowledge-section-actions">
        <Button size="sm" testId="knowledge-possible-retry" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </section>
  )
}
