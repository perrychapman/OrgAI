import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Archive, ArchiveRestore, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { KnowledgeGraph, KnowledgeNode } from '@shared/types'
import { normalizeKnowledgeKey } from '@shared/knowledge'
import { keyWords, relatedRows } from '../../lib/knowledge'
import { relationCandidates, relationsInUse } from '../../lib/knowledgeList'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { cleanIpcError } from '../../lib/ipcError'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Popover } from '../ui/Popover'
import { SegmentedControl } from '../ui/SegmentedControl'
import type { KnowledgeWrites } from './knowledgeWrites'
import { onMenuKey } from './menuKeys'

type Direction = 'out' | 'in'

/**
 * The Related section of the detail pane (docs/design/knowledge.md section 3): one row per relation from
 * `relatedRows` with the neighbour as a link that selects it, a per-row More actions menu (Retire / Restore, Remove
 * after a confirm) and the inline "Add a relation" form (item search with a listbox, relation text with a datalist,
 * direction, Save / Cancel).
 */
export function KnowledgeRelated({
  node,
  graph,
  showRetired,
  writes,
  onSelect,
  onError,
  announce
}: {
  node: KnowledgeNode
  graph: KnowledgeGraph
  showRetired: boolean
  writes: KnowledgeWrites
  onSelect: (id: string) => void
  onError: (message: string) => void
  announce: (text: string) => void
}): ReactElement {
  const uid = useId()
  const { confirm, dialog } = useConfirm()
  const rows = relatedRows(graph, node.id, showRetired)
  const [adding, setAdding] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)
  const focusAdd = (): void => {
    requestAnimationFrame(() => sectionRef.current?.querySelector<HTMLElement>('[data-testid=knowledge-relation-add]')?.focus())
  }
  const run = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    try {
      await fn()
      announce(done)
    } catch (e) {
      onError(cleanIpcError(e))
    }
  }
  return (
    <section ref={sectionRef} className="knowledge-section" aria-labelledby={`${uid}-h`} data-testid="knowledge-related">
      <h3 id={`${uid}-h`} className="knowledge-section-title">
        Related <span className="knowledge-group-n">{rows.filter((r) => !r.edge.retired).length}</span>
      </h3>
      {rows.length === 0 && !adding && <p className="panel-note">No relations yet.</p>}
      <ul className="knowledge-relation-list">
        {rows.map((r) => {
          const other = r.other
          const link = other ? (
            <button type="button" className="link-btn knowledge-relation-link" data-testid="knowledge-relation-link" data-target={other.id} onClick={() => onSelect(other.id)}>
              {other.name}
            </button>
          ) : (
            <span>(removed)</span>
          )
          return (
            <li key={r.edge.id} className="knowledge-relation" data-testid="knowledge-relation" data-id={r.edge.id} data-retired={r.edge.retired ? 'true' : 'false'}>
              <div className="knowledge-relation-main">
                <span className="knowledge-relation-text">
                  {r.outgoing ? (
                    <>
                      {keyWords(r.edge.relation)} {link}
                    </>
                  ) : (
                    <>
                      {link} {keyWords(r.edge.relation)}
                    </>
                  )}
                </span>
                {r.edge.retired && <Badge tone="neutral">Retired</Badge>}
                <Popover
                  trigger={<Icon icon={MoreHorizontal} size="sm" />}
                  triggerClassName="icon-btn size-sm"
                  triggerLabel={`More actions for ${r.text}`}
                  triggerTitle="More actions"
                  triggerTestId="knowledge-relation-more"
                  label={`Actions for ${r.text}`}
                  role="menu"
                  placement="bottom-end"
                >
                  {({ close }) => (
                    <div className="knowledge-menu" role="presentation" onKeyDown={onMenuKey}>
                      <button
                        type="button"
                        role="menuitem"
                        className="knowledge-menuitem"
                        data-testid="knowledge-relation-retire"
                        onClick={() => {
                          close()
                          const retired = !r.edge.retired
                          void run(() => writes.saveEdge({ edgeId: r.edge.id, from: r.edge.from, to: r.edge.to, relation: r.edge.relation, retired }), retired ? 'Retired the relation.' : 'Restored the relation.')
                        }}
                      >
                        <Icon icon={r.edge.retired ? ArchiveRestore : Archive} size="sm" />
                        {r.edge.retired ? 'Restore' : 'Retire'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="knowledge-menuitem danger"
                        data-testid="knowledge-relation-remove"
                        onClick={() => {
                          close()
                          void (async () => {
                            if (!(await confirm({ title: 'Remove this relation?', body: 'Agents and you can no longer see it.', confirmLabel: 'Remove', danger: true }))) return
                            await run(() => writes.removeEdge(r.edge.id), 'Removed the relation.')
                            focusAdd()
                          })()
                        }}
                      >
                        <Icon icon={Trash2} size="sm" />
                        Remove
                      </button>
                    </div>
                  )}
                </Popover>
              </div>
              {r.edge.note && <span className="knowledge-relation-note">{r.edge.note}</span>}
            </li>
          )
        })}
      </ul>
      {adding ? (
        <AddRelationForm
          node={node}
          graph={graph}
          writes={writes}
          onDone={(saved) => {
            setAdding(false)
            if (saved) announce(`Saved ${node.name}.`)
            focusAdd()
          }}
        />
      ) : (
        <div className="knowledge-section-actions">
          <Button size="sm" icon={Plus} testId="knowledge-relation-add" onClick={() => setAdding(true)}>
            Add a relation
          </Button>
        </div>
      )}
      {dialog}
    </section>
  )
}

function AddRelationForm({ node, graph, writes, onDone }: { node: KnowledgeNode; graph: KnowledgeGraph; writes: KnowledgeWrites; onDone: (saved: boolean) => void }): ReactElement {
  const uid = useId()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<KnowledgeNode | null>(null)
  const [active, setActive] = useState(0)
  const [relation, setRelation] = useState('')
  const [direction, setDirection] = useState<Direction>('out')
  const [itemError, setItemError] = useState<string | null>(null)
  const [relationError, setRelationError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const candidates = picked ? [] : relationCandidates(graph.nodes, query, node.id)
  const relations = relationsInUse(graph.edges)
  useEffect(() => {
    document.getElementById(`${uid}-item`)?.focus()
  }, [uid])
  useEffect(() => {
    setActive(0)
  }, [query])
  const pick = (n: KnowledgeNode): void => {
    setPicked(n)
    setQuery(n.name)
    setItemError(null)
    document.getElementById(`${uid}-rel`)?.focus()
  }
  const save = async (): Promise<void> => {
    let bad = false
    if (!picked) {
      setItemError('Pick an item from the list.')
      bad = true
    }
    const key = normalizeKnowledgeKey(relation)
    if (!key) {
      setRelationError('Use letters, digits, spaces and hyphens, at most 40 characters.')
      bad = true
    }
    if (bad || !picked || !key) {
      document.getElementById(!picked ? `${uid}-item` : `${uid}-rel`)?.focus()
      return
    }
    setSaving(true)
    try {
      await writes.saveEdge(direction === 'out' ? { from: node.id, to: picked.id, relation: key } : { from: picked.id, to: node.id, relation: key })
      onDone(true)
    } catch (e) {
      setSaving(false)
      setRelationError(cleanIpcError(e))
      document.getElementById(`${uid}-rel`)?.focus()
    }
  }
  const listId = `${uid}-list`
  const optId = (n: KnowledgeNode): string => `${uid}-opt-${n.id}`
  return (
    <form
      className="knowledge-relation-form"
      data-testid="knowledge-relation-form"
      aria-label="Add a relation"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onDone(false)
        }
      }}
    >
      <div className="field">
        <label htmlFor={`${uid}-item`}>Item</label>
        <Input
          id={`${uid}-item`}
          value={query}
          role="combobox"
          aria-expanded={candidates.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={candidates[active] ? optId(candidates[active]) : undefined}
          invalid={!!itemError}
          aria-describedby={itemError ? `${uid}-item-err` : undefined}
          placeholder="Name or alias"
          autoComplete="off"
          spellCheck={false}
          data-testid="knowledge-relation-search"
          onChange={(v) => {
            setQuery(v)
            setPicked(null)
            setItemError(null)
          }}
          onKeyDown={(e) => {
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
              if (n) pick(n)
            }
          }}
        />
        {candidates.length > 0 && (
          <ul id={listId} role="listbox" aria-label="Matching items" className="knowledge-picker" data-testid="knowledge-relation-options">
            {candidates.map((n, i) => (
              <li
                key={n.id}
                id={optId(n)}
                role="option"
                aria-selected={i === active}
                className="knowledge-picker-opt"
                data-testid="knowledge-relation-option"
                data-id={n.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(n)}
              >
                <span className="knowledge-picker-name">{n.name}</span>
                <span className="knowledge-picker-kind">{keyWords(n.kind)}</span>
              </li>
            ))}
          </ul>
        )}
        {itemError && (
          <span id={`${uid}-item-err`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
            {itemError}
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${uid}-rel`}>Relation</label>
        <Input
          id={`${uid}-rel`}
          value={relation}
          list={relations.length ? `${uid}-rels` : undefined}
          invalid={!!relationError}
          aria-describedby={relationError ? `${uid}-rel-err` : undefined}
          placeholder="works at"
          autoComplete="off"
          spellCheck={false}
          data-testid="knowledge-relation-text"
          onChange={(v) => {
            setRelation(v)
            setRelationError(null)
          }}
        />
        {relations.length > 0 && (
          <datalist id={`${uid}-rels`}>
            {relations.map((r) => (
              <option key={r} value={keyWords(r)} />
            ))}
          </datalist>
        )}
        {relationError && (
          <span id={`${uid}-rel-err`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
            {relationError}
          </span>
        )}
      </div>
      <div className="field" data-testid="knowledge-relation-direction">
        <span className="field-label">Direction</span>
        <SegmentedControl<Direction>
          label="Direction"
          value={direction}
          options={[
            { value: 'out', label: 'This item → other' },
            { value: 'in', label: 'Other → this item' }
          ]}
          onChange={setDirection}
        />
      </div>
      <div className="knowledge-section-actions">
        <Button type="submit" variant="primary" size="sm" loading={saving} testId="knowledge-relation-save">
          Save
        </Button>
        <Button size="sm" testId="knowledge-relation-cancel" onClick={() => onDone(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
