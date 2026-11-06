import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Archive, ArchiveRestore, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { KnowledgeFact, KnowledgeFactInput, KnowledgeNode } from '@shared/types'
import { KNOWLEDGE_FACT_MAX_CHARS, KNOWLEDGE_NODE_FACTS_MAX } from '@shared/types'
import { factsInOrder } from '../../lib/knowledge'
import { withFactRetired, withFactText, withNewFact, withoutFact } from '../../lib/knowledgeList'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Popover } from '../ui/Popover'
import { onMenuKey } from './menuKeys'

/**
 * The Facts section of the detail pane (docs/design/knowledge.md section 3): one always-editable `Input` per fact
 * (save on blur and Enter, Esc restores, the PerProjectValues pattern), a per-row More actions menu (Retire / Restore,
 * Remove), and "Add a fact" (an empty new input is dropped on blur). Every save sends the full fact list with ids.
 */
export function KnowledgeFacts({
  node,
  showRetired,
  onSave,
  announce
}: {
  node: KnowledgeNode
  showRetired: boolean
  /** Saves the full fact list; resolves to the refusal message or null. */
  onSave: (facts: KnowledgeFactInput[]) => Promise<string | null>
  announce: (text: string) => void
}): ReactElement {
  const uid = useId()
  const facts = factsInOrder(node.facts, showRetired)
  const [adding, setAdding] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)
  const full = node.facts.length >= KNOWLEDGE_NODE_FACTS_MAX
  /** Focus "Add a fact" (after a save, Esc or a removal that unmounted the focused row). */
  const focusAdd = (): void => {
    requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>('[data-testid=knowledge-fact-add]')?.focus())
  }
  return (
    <section ref={sectionRef} className="knowledge-section" aria-labelledby={`${uid}-h`} data-testid="knowledge-facts">
      <h3 id={`${uid}-h`} className="knowledge-section-title">
        Facts <span className="knowledge-group-n">{node.facts.filter((f) => !f.retired).length}</span>
      </h3>
      {facts.length === 0 && !adding && <p className="panel-note">No facts yet.</p>}
      <ul className="knowledge-fact-list">
        {facts.map((f, i) => (
          <FactRow key={f.id} fact={f} index={i + 1} node={node} onSave={onSave} announce={announce} onRemoved={focusAdd} />
        ))}
        {adding && (
          <li className="knowledge-fact" data-testid="knowledge-fact" data-id="new">
            <NewFact
              onDone={(saved, refocus) => {
                setAdding(false)
                if (saved) announce(`Saved ${node.name}.`)
                // An empty blur drops the row and lets focus travel on; Esc and a save return to "Add a fact".
                if (refocus) focusAdd()
              }}
              onSave={(text) => onSave(withNewFact(node.facts, text))}
            />
          </li>
        )}
      </ul>
      <div className="knowledge-section-actions">
        <Button size="sm" icon={Plus} testId="knowledge-fact-add" disabled={full || adding} onClick={() => setAdding(true)}>
          Add a fact
        </Button>
        {full &&<span className="knowledge-quiet">{KNOWLEDGE_NODE_FACTS_MAX} facts is the most an item can keep.</span>}
      </div>
    </section>
  )
}

function FactRow({
  fact,
  index,
  node,
  onSave,
  announce,
  onRemoved
}: {
  fact: KnowledgeFact
  index: number
  node: KnowledgeNode
  onSave: (facts: KnowledgeFactInput[]) => Promise<string | null>
  announce: (text: string) => void
  /** Called after this row's fact was removed (the row unmounts, so the section moves focus). */
  onRemoved: () => void
}): ReactElement {
  const uid = useId()
  const [draft, setDraft] = useState(fact.text)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  useEffect(() => {
    setDraft(fact.text)
  }, [fact.text])
  const commit = async (fromKey: boolean): Promise<void> => {
    const next = draft.replace(/\s+$/, '')
    if (busy.current) return
    if (next === fact.text) {
      setError(null)
      return
    }
    if (!next.trim()) {
      setError('A fact needs some text. Remove it from More actions instead.')
      return
    }
    busy.current = true
    try {
      const problem = await onSave(withFactText(node.facts, fact.id, next))
      if (problem) {
        setError(problem)
        if (fromKey) document.getElementById(`${uid}-in`)?.focus()
      } else {
        setError(null)
        announce(`Saved ${node.name}.`)
      }
    } finally {
      busy.current = false
    }
  }
  const act = async (facts: KnowledgeFactInput[], done: string, removed = false): Promise<void> => {
    const problem = await onSave(facts)
    if (problem) setError(problem)
    else {
      announce(done)
      if (removed) onRemoved()
    }
  }
  return (
    <li className="knowledge-fact" data-testid="knowledge-fact" data-id={fact.id} data-retired={fact.retired ? 'true' : 'false'}>
      <div className="knowledge-fact-main">
        <label htmlFor={`${uid}-in`} className="sr-only">
          Fact {index}
        </label>
        <Input
          id={`${uid}-in`}
          value={draft}
          maxLength={KNOWLEDGE_FACT_MAX_CHARS}
          invalid={!!error}
          aria-describedby={error ? `${uid}-err` : undefined}
          autoComplete="off"
          data-testid="knowledge-fact-input"
          onChange={(v) => {
            setDraft(v)
            setError(null)
          }}
          onBlur={() => void commit(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commit(true)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setDraft(fact.text)
              setError(null)
            }
          }}
        />
        {fact.retired && <Badge tone="neutral">Retired</Badge>}
        <Popover
          trigger={<Icon icon={MoreHorizontal} size="sm" />}
          triggerClassName="icon-btn size-sm"
          triggerLabel={`More actions for fact ${index}`}
          triggerTitle={`More actions for fact ${index}`}
          triggerTestId="knowledge-fact-more"
          label={`Actions for fact ${index}`}
          role="menu"
          placement="bottom-end"
        >
          {({ close }) => (
            <div className="knowledge-menu" role="presentation" onKeyDown={onMenuKey}>
              <button
                type="button"
                role="menuitem"
                className="knowledge-menuitem"
                data-testid="knowledge-fact-retire"
                onClick={() => {
                  close()
                  void act(withFactRetired(node.facts, fact.id, !fact.retired), fact.retired ? 'Restored the fact.' : 'Retired the fact.')
                }}
              >
                <Icon icon={fact.retired ? ArchiveRestore : Archive} size="sm" />
                {fact.retired ? 'Restore' : 'Retire'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="knowledge-menuitem danger"
                data-testid="knowledge-fact-remove"
                onClick={() => {
                  close()
                  void act(withoutFact(node.facts, fact.id), 'Removed the fact.', true)
                }}
              >
                <Icon icon={Trash2} size="sm" />
                Remove
              </button>
            </div>
          )}
        </Popover>
      </div>
      {error && (
        <span id={`${uid}-err`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
          {error}
        </span>
      )}
    </li>
  )
}

/** The empty new-fact input: saved on blur and Enter when it has text, dropped silently when empty, Esc drops it. */
function NewFact({ onSave, onDone }: { onSave: (text: string) => Promise<string | null>; onDone: (saved: boolean, refocus: boolean) => void }): ReactElement {
  const uid = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  useEffect(() => {
    document.getElementById(`${uid}-in`)?.focus()
  }, [uid])
  const commit = async (fromKey: boolean): Promise<void> => {
    if (busy.current) return
    const text = draft.replace(/\s+$/, '')
    if (!text.trim()) {
      onDone(false, fromKey)
      return
    }
    busy.current = true
    try {
      const problem = await onSave(text)
      if (problem) {
        setError(problem)
        if (fromKey) document.getElementById(`${uid}-in`)?.focus()
      } else onDone(true, true)
    } finally {
      busy.current = false
    }
  }
  return (
    <div className="knowledge-fact-main">
      <label htmlFor={`${uid}-in`} className="sr-only">
        New fact
      </label>
      <Input
        id={`${uid}-in`}
        value={draft}
        maxLength={KNOWLEDGE_FACT_MAX_CHARS}
        invalid={!!error}
        aria-describedby={error ? `${uid}-err` : undefined}
        placeholder="A fact about this item"
        autoComplete="off"
        data-testid="knowledge-fact-input"
        onChange={(v) => {
          setDraft(v)
          setError(null)
        }}
        onBlur={() => void commit(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDone(false, true)
          }
        }}
      />
      {error && (
        <span id={`${uid}-err`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
          {error}
        </span>
      )}
    </div>
  )
}
