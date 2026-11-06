import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link2, Unlink } from 'lucide-react'
import type { EngagementNote, KnowledgeNode } from '@shared/types'
import { KNOWLEDGE_NODE_NOTES_MAX } from '@shared/types'
import { noteCandidates } from '../../lib/knowledgeList'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'

/**
 * The Notes section of a node's detail (docs/design/knowledge.md section 3): the linked context notes as links that
 * open the note in the pane, Unlink per row, and "Link a note" (a title search with a listbox). Hidden when the
 * engagement has no notes to link.
 */
export function KnowledgeNotesLinks({
  node,
  notes,
  onOpenNote,
  onSaveNoteIds,
  announce
}: {
  node: KnowledgeNode
  notes: readonly EngagementNote[]
  onOpenNote: (id: string) => void
  /** Saves the full noteIds list; resolves to the refusal message or null. */
  onSaveNoteIds: (noteIds: string[]) => Promise<string | null>
  announce: (text: string) => void
}): ReactElement | null {
  const uid = useId()
  const linked = node.noteIds ?? []
  const byId = new Map(notes.map((n) => [n.id, n]))
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const candidates = picking ? noteCandidates(notes, query, linked) : []
  useEffect(() => {
    if (picking) document.getElementById(`${uid}-q`)?.focus()
  }, [picking, uid])
  useEffect(() => {
    setActive(0)
  }, [query])
  if (notes.length === 0) return null
  const focusLinkAdd = (): void => {
    requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>('[data-testid=knowledge-note-link-add]')?.focus())
  }
  const save = async (ids: string[], done: string): Promise<void> => {
    const problem = await onSaveNoteIds(ids)
    if (problem) setError(problem)
    else {
      setError(null)
      announce(done)
    }
  }
  const pick = async (n: EngagementNote): Promise<void> => {
    await save([...linked, n.id], `Linked the note ${n.title}.`)
    setPicking(false)
    setQuery('')
    focusLinkAdd()
  }
  const listId = `${uid}-list`
  const full = linked.length >= KNOWLEDGE_NODE_NOTES_MAX
  return (
    <section ref={sectionRef} className="knowledge-section" aria-labelledby={`${uid}-h`} data-testid="knowledge-notes">
      <h3 id={`${uid}-h`} className="knowledge-section-title">
        Notes <span className="knowledge-group-n">{linked.length}</span>
      </h3>
      {linked.length === 0 && !picking && <p className="panel-note">No linked notes.</p>}
      <ul className="knowledge-note-list">
        {linked.map((id) => {
          const n = byId.get(id)
          const title = n?.title ?? '(removed note)'
          return (
            <li key={id} className="knowledge-note-row" data-testid="knowledge-note-row" data-id={id}>
              <button type="button" className="link-btn knowledge-note-link" data-testid="knowledge-note-link" disabled={!n} onClick={() => onOpenNote(id)}>
                {title}
              </button>
              <IconButton icon={Unlink} size="sm" label={`Unlink the note ${title}`} testId="knowledge-note-unlink" onClick={() => void save(linked.filter((x) => x !== id), `Unlinked the note ${title}.`).then(focusLinkAdd)} />
            </li>
          )
        })}
      </ul>
      {picking ? (
        <div className="field">
          <label htmlFor={`${uid}-q`}>Note title</label>
          <Input
            id={`${uid}-q`}
            value={query}
            role="combobox"
            aria-expanded={candidates.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={candidates[active] ? `${uid}-opt-${candidates[active].id}` : undefined}
            placeholder="Start typing a title"
            autoComplete="off"
            spellCheck={false}
            data-testid="knowledge-note-search"
            onChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setPicking(false)
                setQuery('')
                focusLinkAdd()
                return
              }
              if (candidates.length === 0) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => (a + 1) % candidates.length)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => (a - 1 + candidates.length) % candidates.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const n = candidates[active]
                if (n) void pick(n)
              }
            }}
          />
          {candidates.length > 0 ? (
            <ul id={listId} role="listbox" aria-label="Matching notes" className="knowledge-picker" data-testid="knowledge-note-options">
              {candidates.map((n, i) => (
                <li key={n.id} id={`${uid}-opt-${n.id}`} role="option" aria-selected={i === active} className="knowledge-picker-opt" data-testid="knowledge-note-option" data-id={n.id} onMouseDown={(e) => e.preventDefault()} onClick={() => void pick(n)}>
                  <span className="knowledge-picker-name">{n.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="hint">No other note matches.</span>
          )}
        </div>
      ) : (
        <div className="knowledge-section-actions">
          <Button size="sm" icon={Link2} testId="knowledge-note-link-add" disabled={full} onClick={() => setPicking(true)}>
            Link a note
          </Button>
          {full && <span className="knowledge-quiet">{KNOWLEDGE_NODE_NOTES_MAX} notes is the most an item can link.</span>}
        </div>
      )}
      {error && (
        <span className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
          {error}
        </span>
      )}
    </section>
  )
}
