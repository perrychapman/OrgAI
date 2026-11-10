import { kitRoleSpend } from '../../lib/roleStaffing'
import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { CircleAlert, CircleDot, Equal, KeyRound, TriangleAlert } from 'lucide-react'
import { cleanIpcError } from '../../lib/ipcError'
import { clampLabel } from '../../lib/clampLabel'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { kitApi, type KitAction, type KitApplyResult, type KitImportPreview, type KitPreviewItem, type KitRoleElevatedTool } from '../../lib/kitApi'
import {
  choicesFromRows,
  defaultChoices,
  hasChoice,
  importButtonLabel,
  mergeChoices,
  replacedNames,
  selectOptions,
  statusLabel,
  summarize,
  summaryLine,
  kitTypeLabel
} from '../../lib/kit'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useConfirm } from '../ui/ConfirmDialog'
import { ClampText } from '../proposals/ClampText'

const ELEVATED_LABEL: Record<KitRoleElevatedTool, string> = {
  Bash: 'Runs commands',
  Edit: 'Edits files',
  Write: 'Writes files',
  NotebookEdit: 'Edits notebooks',
  canSpawn: 'Adds agents',
  mcp: 'Uses services'
}

/** A digest refusal: main says the file no longer matches the preview. */
function isStale(message: string): boolean {
  return /^The kit file changed since the preview\./.test(message)
}

function focusLater(selector: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus()))
}

/** The kit preview: one row per item with a choice, then the apply (engagement-2 section 8). */
export default function KitImportDialog({
  preview: initial,
  onClose,
  onApplied
}: {
  preview: KitImportPreview
  onClose: () => void
  onApplied: (result: KitApplyResult) => void
}): ReactElement {
  const [preview, setPreview] = useState(initial)
  const [choices, setChoices] = useState<Record<string, KitAction>>(() => defaultChoices(initial.items))
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, dialog } = useConfirm()
  const summary = summarize(preview.items, choices)

  const again = async (): Promise<void> => {
    const api = kitApi()
    if (!api || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.previewImport({ path: preview.path })
      setPreview(next)
      setChoices((c) => mergeChoices(c, next.items))
      setStale(false)
      focusLater('[data-testid=kit-preview-wrap]')
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    const api = kitApi()
    if (!api || busy || summary.total === 0) return
    const replaced = replacedNames(preview.items, choices)
    const ok = await confirm({
      title: replaced.length > 0 ? `Replace ${replaced.length} of your ${replaced.length === 1 ? 'item' : 'items'}?` : `${importButtonLabel(summary.total)}?`,
      body: (
        <>
          {replaced.length > 0 && (
            <p>
              Your version of {replaced.map((n) => clampLabel(showHidden(n), 60)).join(', ')} will be replaced by the one in the kit.
            </p>
          )}
          <p>Imported items cannot be undone.</p>
        </>
      ),
      confirmLabel: replaced.length > 0 ? 'Replace and import' : 'Import',
      danger: replaced.length > 0
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.applyImport({ path: preview.path, digest: preview.digest, choices: choicesFromRows(preview.items, choices) })
      onApplied(result)
    } catch (e) {
      const message = cleanIpcError(e)
      if (isStale(message)) {
        setStale(true)
        focusLater('[data-testid=kit-preview-again]')
      } else setError(message)
    } finally {
      setBusy(false)
    }
  }

  const fileName = clampLabel(showHidden(preview.fileName), 80)
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="lg"
        title={`Import ${fileName}`}
        description="Kits from other people can run programs on this computer. Check each custom server and preset before you import it."
        testId="kit-import-dialog"
        footer={
          <>
            <span className="kit-count" role="status" aria-live="polite" data-testid="kit-import-summary">
              {summaryLine(summary)}
            </span>
            <Button autoFocusDialog onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={summary.total === 0 || stale} loading={busy} testId="kit-import-apply" onClick={() => void apply()}>
              {importButtonLabel(summary.total)}
            </Button>
          </>
        }
      >
        <div className="kit-import">
          {stale && (
            <Banner
              tone="warning"
              title="The kit file changed. Preview it again."
              actions={
                <Button size="sm" loading={busy} testId="kit-preview-again" onClick={() => void again()}>
                  Preview again
                </Button>
              }
            />
          )}
          {error && (
            <Banner tone="danger" title="Could not import the kit" testId="kit-import-error">
              {error}
            </Banner>
          )}
          {preview.notes.length > 0 && (
            <ul className="kit-file-notes muted" data-testid="kit-file-notes">
              {preview.notes.map((n, i) => (
                <li key={i}>{showHidden(n)}</li>
              ))}
            </ul>
          )}
          {preview.items.length === 0 ? (
            <p className="muted">This kit has nothing in it.</p>
          ) : (
            <div className="kit-preview-wrap" role="region" tabIndex={-1} aria-label="Items in this kit" data-testid="kit-preview-wrap">
              <table className="kit-preview" data-testid="kit-preview">
                <caption className="sr-only">Items in this kit</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Type</th>
                    <th scope="col">Status</th>
                    <th scope="col">What to do</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((it) => (
                    <PreviewRow key={it.key} item={it} choice={choices[it.key]} onChoice={(a) => setChoices((c) => ({ ...c, [it.key]: a }))} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Dialog>
      {dialog}
    </>
  )
}

function PreviewRow({ item, choice, onChoice }: { item: KitPreviewItem; choice: KitAction | undefined; onChoice: (a: KitAction) => void }): ReactElement {
  const name = clampLabel(showHidden(item.name), 80)
  const refused = item.status === 'refused'
  const selectId = useId()
  return (
    <tr className={`kit-row${refused ? ' is-refused' : ''}`} data-testid="kit-row" data-kind={item.kind}>
      <td className="kit-cell-item" data-label="Item">
        <div className="kit-item-name">
          <span className="kit-item-title">{name}</span>
          {item.secretSlots && item.secretSlots.length > 0 && (
            <Badge tone="attention" icon={KeyRound} testId="kit-needs-secret">
              Needs a secret
            </Badge>
          )}
          {item.perProjectSecrets && <Badge tone="neutral">Each project enters its own</Badge>}
        </div>
        {item.description && <p className="kit-item-desc muted">{clampLabel(showHidden(item.description), 200)}</p>}
        <ItemDetail item={item} />
        {item.notes.length > 0 && (
          <ul className="kit-item-notes muted">
            {item.notes.map((n, i) => (
              <li key={i}>{clampLabel(showHidden(n), 200)}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="kit-cell-type" data-label="Type">
        {kitTypeLabel(item.kind)}
      </td>
      <td className="kit-cell-status" data-label="Status">
        <span data-testid="kit-status-cell" data-status={item.status}>
          <StatusBadge item={item} />
        </span>
        {item.status === 'different' && item.conflict && <p className="kit-item-desc muted">{clampLabel(showHidden(item.conflict), 200)}</p>}
      </td>
      <td className="kit-cell-action" data-label="What to do">
        {hasChoice(item) ? (
          <select
            id={selectId}
            className="select"
            aria-label={`What to do with ${name}`}
            data-testid="kit-action"
            value={choice ?? item.action}
            onChange={(e) => onChoice(e.target.value as KitAction)}
          >
            {selectOptions(item).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : item.status === 'same' ? (
          <span className="muted">Nothing to do</span>
        ) : null}
      </td>
    </tr>
  )
}

function StatusBadge({ item }: { item: KitPreviewItem }): ReactElement {
  const text = clampLabel(showHidden(statusLabel(item)), 160)
  if (item.status === 'new') return <Badge tone="accent" icon={CircleDot}>{text}</Badge>
  if (item.status === 'same') return <Badge tone="neutral" icon={Equal}>{text}</Badge>
  if (item.status === 'different') return <Badge tone="attention" icon={TriangleAlert}>{text}</Badge>
  return <Badge tone="danger" icon={CircleAlert}>{text}</Badge>
}

/** What the item runs or carries: full commands, scripts, template roles. Untrusted text, shown as text nodes. */
function ItemDetail({ item }: { item: KitPreviewItem }): ReactElement | null {
  if ((item.kind === 'server' || item.kind === 'preset') && item.command) {
    return (
      <details className="kit-disclosure" data-testid="kit-item-command">
        <summary>
          Show what it runs<span className="sr-only"> for {clampLabel(showHidden(item.name), 60)}</span>
        </summary>
        <div className="kit-disclosure-body">
          {hasHidden(item.command) && (
            <Badge tone="danger" icon={TriangleAlert} testId="kit-command-hidden">
              Contains hidden characters
            </Badge>
          )}
          <pre className="kit-command">{showHidden(item.command)}</pre>
          {item.secretSlots && item.secretSlots.length > 0 && <p className="muted">Secret values you will enter: {item.secretSlots.map((s) => showHidden(s)).join(', ')}</p>}
        </div>
      </details>
    )
  }
  if (item.kind === 'skill' && item.scripts && item.scripts.length > 0) {
    return (
      <p className="kit-warn" data-testid="kit-skill-scripts">
        <TriangleAlert size={14} aria-hidden="true" /> Has scripts the skill may ask agents to run: {item.scripts.map((s) => showHidden(s)).join(', ')}
      </p>
    )
  }
  if (item.kind === 'template') {
    if (item.roles && item.roles.length > 0) {
      return (
        <ul className="kit-roles" aria-label={`Roles in ${clampLabel(showHidden(item.name), 60)}`} data-testid="kit-template-roles">
          {item.roles.map((r, i) => (
            <li key={`${r.slug}-${i}`} className="kit-role">
              <span className="kit-role-name">{clampLabel(showHidden(r.name), 60)}</span>
              {kitRoleSpend(r, {}) && (
                <span className="muted" data-testid="kit-role-spend">
                  {clampLabel(showHidden(kitRoleSpend(r, {})!.text), 80)}
                </span>
              )}
              {r.elevatedTools.map((t) => (
                <Badge key={t} tone="attention">
                  {ELEVATED_LABEL[t] ?? showHidden(String(t))}
                </Badge>
              ))}
              <details className="kit-disclosure">
                <summary>
                  Show prompt<span className="sr-only"> for {clampLabel(showHidden(r.name), 60)}</span>
                </summary>
                <div className="kit-disclosure-body">
                  {hasHidden(r.prompt) && (
                    <Badge tone="danger" icon={TriangleAlert}>
                      Contains hidden characters
                    </Badge>
                  )}
                  {r.prompt ? <ClampText text={r.prompt} label={`${clampLabel(showHidden(r.name), 60)} prompt`} /> : <p className="muted">Empty prompt.</p>}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )
    }
    if (item.roleNames && item.roleNames.length > 0) {
      return <p className="kit-item-desc muted">Roles: {item.roleNames.map((n) => clampLabel(showHidden(n), 40)).join(', ')}</p>
    }
  }
  return null
}
