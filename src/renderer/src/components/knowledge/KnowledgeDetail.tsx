import type { KeyboardEvent, ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react'
import type { EngagementNote, KnowledgeGraph, KnowledgeInferredLink, KnowledgeNode } from '@shared/types'
import { KNOWLEDGE_NAME_MAX_CHARS, KNOWLEDGE_SUMMARY_MAX_CHARS } from '@shared/types'
import { normalizeKnowledgeKey } from '@shared/knowledge'
import type { KnowledgeItem, RunFacts } from '../../lib/knowledge'
import { historyLines, itemOrigin, itemRetired, keyWords, kindLabel, splitHistoryLine } from '../../lib/knowledge'
import { aliasesText, kindsInUse, parseAliases } from '../../lib/knowledgeList'
import { cleanIpcError } from '../../lib/ipcError'
import { formatFullDateTime } from '../../lib/dates'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { InlineField } from './InlineField'
import { KnowledgeFacts } from './KnowledgeFacts'
import { KnowledgeNotesLinks } from './KnowledgeNotesLinks'
import { KnowledgePossible } from './KnowledgePossible'
import { KnowledgeRelated } from './KnowledgeRelated'
import type { KnowledgeWrites } from './knowledgeWrites'

export const DETAIL_HEADING_ID = 'knowledge-detail-heading'

/** What the pane shows: an item, the inline "Add an item" form, or nothing. */
export type DetailMode = { kind: 'item'; item: KnowledgeItem } | { kind: 'create' } | { kind: 'empty' }

/**
 * The detail pane body (docs/design/knowledge.md section 3): header with the inline-editable name, kind, aliases and
 * summary; Facts, Related, Notes and History; the Retire / Restore and Delete footer. A note shows its title, excerpt
 * and "Edit note". Agent items are read-only until a field is activated; "Recorded by" is never overwritten (main
 * keeps `source`). Every write goes through `writes`; the pane never applies a result itself.
 */
export function KnowledgeDetail({
  mode,
  graph,
  notes,
  runs,
  showRetired,
  writes,
  onSelect,
  onOpenRun,
  onEditNote,
  onRetire,
  onDelete,
  onCreated,
  onCancelCreate,
  onEscape,
  onError,
  announce,
  inferredLinks,
  inferredFailed,
  inferredPartialNote,
  onRetryInferred,
  onDismissLink
}: {
  mode: DetailMode
  graph: KnowledgeGraph
  notes: readonly EngagementNote[]
  runs: RunFacts
  showRetired: boolean
  writes: KnowledgeWrites
  /** Select (and show) another item: a relation's neighbour, a linked note. */
  onSelect: (id: string) => void
  onOpenRun: (runId: string) => void
  onEditNote: (noteId: string) => void
  onRetire: (item: KnowledgeItem, retired: boolean) => void
  onDelete: (item: KnowledgeItem) => void
  onCreated: (node: KnowledgeNode) => void
  onCancelCreate: () => void
  /** Esc on the heading: back to the row. */
  onEscape: () => void
  onError: (message: string) => void
  announce: (text: string) => void
  /** Possible connections: the latest inferred links (null before the first answer), whether the read failed, Retry and Dismiss. */
  inferredLinks: readonly KnowledgeInferredLink[] | null
  inferredFailed: boolean
  inferredPartialNote: string | null
  onRetryInferred: () => void
  onDismissLink: (linkId: string) => Promise<void>
}): ReactElement {
  const onHeadingKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && e.target === e.currentTarget) {
      e.preventDefault()
      onEscape()
    }
  }
  if (mode.kind === 'empty') {
    return (
      <div className="knowledge-detail-body" data-testid="knowledge-detail-body" id="knowledge-detail-body" tabIndex={-1}>
        <p className="panel-note" data-testid="knowledge-detail-empty">
          Select an item to see its facts, relations and history.
        </p>
      </div>
    )
  }
  if (mode.kind === 'create') {
    return (
      <div className="knowledge-detail-body" data-testid="knowledge-detail-body" data-id="new" id="knowledge-detail-body" tabIndex={-1}>
        <h2 id={DETAIL_HEADING_ID} className="knowledge-detail-name" data-testid="knowledge-detail-name" tabIndex={-1} onKeyDown={onHeadingKey}>
          New item
        </h2>
        <CreateForm graph={graph} writes={writes} onCreated={onCreated} onCancel={onCancelCreate} />
      </div>
    )
  }
  const item = mode.item
  const retired = itemRetired(item)
  const name = item.type === 'node' ? item.node.name : item.note.title
  const footer = (
    <div className="knowledge-detail-actions" data-testid="knowledge-detail-actions">
      {retired ? (
        <Button size="sm" icon={ArchiveRestore} testId="knowledge-restore" onClick={() => onRetire(item, false)}>
          Restore
        </Button>
      ) : (
        <Button size="sm" icon={Archive} testId="knowledge-retire" onClick={() => onRetire(item, true)}>
          Retire
        </Button>
      )}
      <Button size="sm" variant="ghost" className="danger-text" icon={Trash2} testId="knowledge-delete" onClick={() => onDelete(item)}>
        Delete…
      </Button>
    </div>
  )
  const history = (
    <section className="knowledge-section" aria-labelledby="knowledge-history-h" data-testid="knowledge-history">
      <h3 id="knowledge-history-h" className="knowledge-section-title">
        History
      </h3>
      {historyLines(item, runs).map((line, i) => {
        const split = splitHistoryLine(line, runs)
        return (
          <p key={i} className="knowledge-history-line" data-testid="knowledge-history-line" title={formatFullDateTime(line.at) || undefined}>
            {split ? (
              <>
                {split.before}
                <button type="button" className="link-btn" data-testid="knowledge-history-run" data-run={line.runId} onClick={() => line.runId && onOpenRun(line.runId)}>
                  {split.link}
                </button>
                {split.after}
              </>
            ) : (
              line.text
            )}
          </p>
        )
      })}
    </section>
  )
  const badges = (
    <span className="knowledge-detail-badges">
      <Badge tone="neutral">{kindLabel(item.type === 'node' ? item.node.kind : 'note')}</Badge>
      {itemOrigin(item) === 'agent' && <Badge tone="neutral">Agent</Badge>}
      {retired && <Badge tone="neutral">Retired</Badge>}
    </span>
  )

  if (item.type === 'note') {
    const note = item.note
    return (
      <div className="knowledge-detail-body" data-testid="knowledge-detail-body" data-id={item.id} id="knowledge-detail-body" tabIndex={-1}>
        <header className="knowledge-detail-head">
          <h2 id={DETAIL_HEADING_ID} className="knowledge-detail-name" data-testid="knowledge-detail-name" tabIndex={-1} onKeyDown={onHeadingKey}>
            {name}
          </h2>
          {badges}
        </header>
        {note.excerpt && <p className="knowledge-detail-excerpt">{note.excerpt}</p>}
        <p className="knowledge-quiet">
          {note.chars.toLocaleString()} {note.chars === 1 ? 'character' : 'characters'}
        </p>
        <div className="knowledge-section-actions">
          <Button size="sm" icon={Pencil} testId="knowledge-note-edit" onClick={() => onEditNote(note.id)}>
            Edit note
          </Button>
        </div>
        {history}
        {footer}
      </div>
    )
  }

  const node = item.node
  const patch = async (fields: Partial<Parameters<KnowledgeWrites['saveNode']>[0]>): Promise<string | null> => {
    try {
      await writes.saveNode({ nodeId: node.id, kind: node.kind, name: node.name, ...fields })
      return null
    } catch (e) {
      return cleanIpcError(e)
    }
  }
  const saved = async (fields: Partial<Parameters<KnowledgeWrites['saveNode']>[0]>): Promise<string | null> => {
    const problem = await patch(fields)
    if (!problem) announce(`Saved ${node.name}.`)
    return problem
  }
  const kinds = kindsInUse(graph.nodes)
  return (
    <div className="knowledge-detail-body" data-testid="knowledge-detail-body" data-id={item.id} id="knowledge-detail-body" tabIndex={-1}>
      <header className="knowledge-detail-head">
        <h2 id={DETAIL_HEADING_ID} className="knowledge-detail-name" data-testid="knowledge-detail-name" tabIndex={-1} onKeyDown={onHeadingKey}>
          <InlineField label="Edit name" value={node.name} maxLength={KNOWLEDGE_NAME_MAX_CHARS} inputTestId="knowledge-name-input" restTestId="knowledge-name" onSave={(v) => (v ? saved({ name: v }) : Promise.resolve('Give the item a name.'))} />
        </h2>
        {badges}
      </header>
      <dl className="knowledge-detail-fields">
        <dt>Kind</dt>
        <dd>
          <InlineField
            label="Edit kind"
            value={node.kind}
            display={kindLabel(node.kind)}
            options={kinds}
            inputTestId="knowledge-kind-input"
            restTestId="knowledge-kind"
            onSave={(v) => {
              const key = normalizeKnowledgeKey(v)
              if (!key) return Promise.resolve('Use letters, digits, spaces and hyphens, at most 40 characters.')
              return key === node.kind ? Promise.resolve(null) : saved({ kind: key })
            }}
          />
        </dd>
        <dt>Aliases</dt>
        <dd>
          <InlineField label="Edit aliases" value={aliasesText(node.aliases)} placeholder="Add aliases, comma-separated" inputTestId="knowledge-aliases-input" restTestId="knowledge-aliases" onSave={(v) => saved({ aliases: parseAliases(v) })} />
        </dd>
        <dt>Summary</dt>
        <dd>
          <InlineField label="Edit summary" value={node.summary ?? ''} placeholder="Add a summary" multiline rows={3} maxLength={KNOWLEDGE_SUMMARY_MAX_CHARS} inputTestId="knowledge-summary-input" restTestId="knowledge-summary" className="knowledge-summary" onSave={(v) => saved({ summary: v })} />
        </dd>
      </dl>
      <KnowledgeFacts node={node} showRetired={showRetired} onSave={(facts) => patch({ facts })} announce={announce} />
      <KnowledgeRelated node={node} graph={graph} showRetired={showRetired} writes={writes} onSelect={onSelect} onError={onError} announce={announce} />
      {!node.retired && (
        <KnowledgePossible node={node} graph={graph} links={inferredLinks} failed={inferredFailed} partialNote={inferredPartialNote} writes={writes} onSelect={onSelect} onRetry={onRetryInferred} onDismiss={onDismissLink} announce={announce} />
      )}
      <KnowledgeNotesLinks node={node} notes={notes} onOpenNote={onSelect} onSaveNoteIds={(noteIds) => patch({ noteIds })} announce={announce} />
      {history}
      {footer}
    </div>
  )
}

/** The inline "Add an item" form: name and kind, saved through saveNode without a nodeId. */
function CreateForm({ graph, writes, onCreated, onCancel }: { graph: KnowledgeGraph; writes: KnowledgeWrites; onCreated: (node: KnowledgeNode) => void; onCancel: () => void }): ReactElement {
  const uid = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [kindError, setKindError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const kinds = kindsInUse(graph.nodes)
  useEffect(() => {
    document.getElementById(`${uid}-name`)?.focus()
  }, [uid])
  const save = async (): Promise<void> => {
    const n = name.replace(/\s+/g, ' ').trim()
    const key = normalizeKnowledgeKey(kind)
    if (!n) {
      setNameError('Give the item a name.')
      document.getElementById(`${uid}-name`)?.focus()
      return
    }
    if (!key) {
      setKindError('Use letters, digits, spaces and hyphens, at most 40 characters.')
      document.getElementById(`${uid}-kind`)?.focus()
      return
    }
    setSaving(true)
    try {
      onCreated(await writes.saveNode({ kind: key, name: n }))
    } catch (e) {
      setSaving(false)
      setNameError(cleanIpcError(e))
      document.getElementById(`${uid}-name`)?.focus()
    }
  }
  return (
    <form
      className="knowledge-create"
      data-testid="knowledge-create"
      aria-label="Add an item"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    >
      <div className="field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <Input
          id={`${uid}-name`}
          value={name}
          maxLength={KNOWLEDGE_NAME_MAX_CHARS}
          invalid={!!nameError}
          aria-describedby={nameError ? `${uid}-name-err` : undefined}
          autoComplete="off"
          data-testid="knowledge-name-input"
          onChange={(v) => {
            setName(v)
            setNameError(null)
          }}
        />
        {nameError && (
          <span id={`${uid}-name-err`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
            {nameError}
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${uid}-kind`}>Kind</label>
        <Input
          id={`${uid}-kind`}
          value={kind}
          list={`${uid}-kinds`}
          invalid={!!kindError}
          aria-describedby={kindError ? `${uid}-kind-err` : undefined}
          placeholder="person, organisation, system…"
          autoComplete="off"
          spellCheck={false}
          data-testid="knowledge-kind-input"
          onChange={(v) => {
            setKind(v)
            setKindError(null)
          }}
        />
        <datalist id={`${uid}-kinds`}>
          {kinds.map((k) => (
            <option key={k} value={keyWords(k)} />
          ))}
        </datalist>
        {kindError && (
          <span id={`${uid}-kind-err`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
            {kindError}
          </span>
        )}
      </div>
      <div className="knowledge-section-actions">
        <Button type="submit" variant="primary" size="sm" loading={saving} testId="knowledge-create-save">
          Save
        </Button>
        <Button size="sm" testId="knowledge-create-cancel" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
