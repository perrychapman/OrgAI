import type { KeyboardEvent, ReactElement } from 'react'
import { useId, useState } from 'react'
import { Copy, ExternalLink, FolderOpen, Link2, MessageSquareQuote, MoreHorizontal, Pencil, Save, Trash2, X } from 'lucide-react'
import { OUTPUT_DESCRIPTION_MAX_CHARS, OUTPUT_TITLE_MAX_CHARS, type OutputReviseResult, type RunOutput } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { canDeleteOutput, canOpenOutput, canReviseFallback, mergeOutput, previewCacheFor, previewKey } from '../../lib/outputs'
import { forgetBody } from '../../lib/outputVersions'
import { COPY_FAILED, SOURCE_COPIED } from '../../lib/diagramExport'
import { cleanIpcError } from '../../lib/ipcError'
import { HIDDEN_OR_CONTROL_RUN, showHidden } from '../../lib/hiddenChars'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Popover } from '../ui/Popover'
import { Textarea } from '../ui/Textarea'
import { useConfirm } from '../ui/ConfirmDialog'
import { useDeleteOutputs } from './DeleteOutputs'
import ReviseDialog from './ReviseDialog'
import { useOutputDetail } from './outputDetailContext'
import '../../styles/outputs.css'

/** Arrow keys, Home and End move between the menu's items (the Popover focuses the first one on open). */
function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)'))
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

/** A title for a sentence: no control, bidi or zero-width characters. */
const plainTitle = (s: string): string => s.replace(HIDDEN_OR_CONTROL_RUN, '').trim() || 'this output'

/** Kinds whose preview is the file's own text, so "Copy source" has something to copy. */
const SOURCE_KINDS: ReadonlySet<string> = new Set(['markdown', 'text', 'csv', 'json', 'mermaid', 'svg'])

export const OUTPUT_OPEN_HINT = 'OrgAI does not open this kind of file. Show it in its folder instead.'

/** Rename: title and description, no file change and no new version. */
function RenameDialog({ output, onClose, onDone }: { output: RunOutput; onClose(): void; onDone(o: RunOutput): void }): ReactElement {
  const [title, setTitle] = useState(output.title)
  const [description, setDescription] = useState(output.description ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const o = await window.orgai.outputs.update({ projectId: output.projectId, outputId: output.id, title: title.trim(), description: description.trim() })
      onDone(o)
    } catch (e) {
      setError(cleanIpcError(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename output"
      description="This changes the name and description OrgAI shows. The file keeps its name."
      testId="output-rename-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" testId="output-rename-save" loading={busy} disabled={busy || title.trim() === ''} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="output-rename-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim()) void save()
        }}
      >
        <label htmlFor="output-rename-title">Name</label>
        <Input id="output-rename-title" data-testid="output-rename-title" value={title} maxLength={OUTPUT_TITLE_MAX_CHARS} onChange={setTitle} data-autofocus />
        <label htmlFor="output-rename-description">Description (optional)</label>
        <Textarea id="output-rename-description" data-testid="output-rename-description" value={description} maxLength={OUTPUT_DESCRIPTION_MAX_CHARS} rows={3} onChange={setDescription} />
        {error && (
          <p className="output-versions-error" role="alert" data-testid="output-rename-error">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/**
 * The More actions menu of one output (docs/design/outputs-2.md section 7): Open, Show in folder, Save as, Copy path,
 * Rename, Copy source, Ask the team to revise, Remove from list and Delete. Every answer goes to `onNotice`.
 */
export default function OutputActions({
  output,
  onRemoved,
  onNotice
}: {
  output: RunOutput
  onRemoved?: (id: string) => void
  onNotice?: (text: string) => void
}): ReactElement {
  const uid = useId()
  const ctx = useOutputDetail()
  const { confirm, dialog } = useConfirm()
  const { deleteOutputs, dialog: deleteDialog } = useDeleteOutputs()
  const [renaming, setRenaming] = useState(false)
  const [revising, setRevising] = useState(false)
  const title = plainTitle(output.title)
  const ref = { projectId: output.projectId, outputId: output.id }
  // One route per message: the surface's handler when there is one (it shows and speaks it), else the detail's output-live.
  const notice = (text: string): void => {
    if (onNotice) onNotice(text)
    else ctx?.announce(text)
  }
  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (e) {
      notice(cleanIpcError(e))
    }
  }
  const shell = (call: () => Promise<string>): Promise<void> =>
    run(async () => {
      const answer = await call()
      if (answer) notice(answer)
    })
  const removed = (list: RunOutput[], text: string): void => {
    useAppStore.getState().setOutputs(output.projectId, list)
    notice(text)
    onRemoved?.(output.id)
  }
  const open = canOpenOutput(output)
  const missing = output.missing === true
  const olderVersion = ctx && !ctx.isCurrent ? ctx.version : null
  const copySource = (): void => {
    void run(async () => {
      // The cached preview holds the text; a miss fetches it (and caches it for the viewer).
      const cache = previewCacheFor(output.projectId)
      const key = previewKey(output, olderVersion)
      let p = cache.get(key)
      if (!p) {
        p = await window.orgai.outputs.preview(olderVersion === null ? ref : { ...ref, version: olderVersion })
        cache.set(key, p)
      }
      if (p.kind !== 'text' && p.kind !== 'svg') {
        notice('There is no source to copy for this file.')
        return
      }
      try {
        await navigator.clipboard.writeText(p.text)
      } catch {
        notice(COPY_FAILED)
        return
      }
      notice(SOURCE_COPIED)
    })
  }

  const item = (testId: string, icon: typeof FolderOpen, label: string, onClick: () => void, danger?: boolean): ReactElement => (
    <button type="button" role="menuitem" className={`output-menuitem${danger ? ' danger' : ''}`} data-testid={testId} onClick={onClick}>
      <Icon icon={icon} size="sm" />
      {label}
    </button>
  )

  const revise = (): void => {
    if (ctx) ctx.openRevise()
    else setRevising(true)
  }
  const hintId = !open && !missing ? `${uid}-open-hint` : undefined
  return (
    <>
      {hintId && (
        <span id={hintId} className="sr-only">
          {OUTPUT_OPEN_HINT}
        </span>
      )}
      <Popover
        trigger={<Icon icon={MoreHorizontal} size="sm" />}
        triggerClassName="icon-btn size-sm"
        triggerLabel={`More actions for ${title}`}
        triggerTitle={`More actions for ${title}`}
        triggerTestId="output-more"
        triggerDescribedBy={hintId}
        label={`Actions for ${title}`}
        role="menu"
        placement="bottom-end"
        testId="output-actions"
      >
        {({ close }) => (
          <div className="output-menu" role="presentation" onKeyDown={onMenuKey}>
            {open && item('output-open', ExternalLink, 'Open', () => { close(); void shell(() => window.orgai.outputs.open(ref)) })}
            {!open && !missing && (
              <p className="output-menu-hint" data-testid="output-open-hint" aria-hidden="true">
                {OUTPUT_OPEN_HINT}
              </p>
            )}
            {!missing && item('output-reveal', FolderOpen, 'Show in folder', () => { close(); void shell(() => window.orgai.outputs.reveal(ref)) })}
            {!missing &&
              item('output-save-as', Save, 'Save as…', () => {
                close()
                void run(async () => {
                  const r = await window.orgai.outputs.saveAs(ref)
                  if ('path' in r) notice(`Saved a copy to ${r.path}.`)
                })
              })}
            {item('output-copy-path', Link2, 'Copy path', () => {
              close()
              void run(async () => {
                await navigator.clipboard.writeText(output.path)
                notice('Copied the path.')
              })
            })}
            {item('output-rename', Pencil, 'Rename…', () => { close(); setRenaming(true) })}
            {!missing && SOURCE_KINDS.has(output.kind) && item('output-copy-source', Copy, 'Copy source', () => { close(); copySource() })}
            {canReviseFallback(output) && item('output-revise-item', MessageSquareQuote, 'Ask the team to revise…', () => { close(); revise() })}
            {item('output-forget', X, 'Remove from list', () => {
              close()
              void run(async () => {
                const ok = await confirm({
                  title: `Remove ${title} from OrgAI?`,
                  body: forgetBody(showHidden(output.relPath)),
                  confirmLabel: 'Remove',
                  danger: true,
                  confirmTestId: 'output-forget-confirm'
                })
                if (ok) removed(await window.orgai.outputs.forget(ref), `Removed ${title} from the list.`)
              })
            })}
            {canDeleteOutput(output) &&
              item(
                'output-delete',
                Trash2,
                'Delete…',
                () => {
                  close()
                  void run(async () => {
                    const r = await deleteOutputs([output])
                    if (!r) return
                    if (r.problems.length) {
                      notice(r.problems[0])
                      return
                    }
                    removed(r.list ?? [], `Deleted ${title}.`)
                  })
                },
                true
              )}
          </div>
        )}
      </Popover>
      {renaming && (
        <RenameDialog
          output={output}
          onClose={() => setRenaming(false)}
          onDone={(o) => {
            const st = useAppStore.getState()
            st.setOutputs(output.projectId, mergeOutput(st.outputsByProject[output.projectId], o))
            setRenaming(false)
            notice('Renamed.')
          }}
        />
      )}
      {revising && !ctx && (
        <ReviseDialog
          output={output}
          onClose={(r: OutputReviseResult | null) => {
            setRevising(false)
            if (r && !('refused' in r)) notice('Sent to the team. They will add a new version.')
          }}
        />
      )}
      {dialog}
      {deleteDialog}
    </>
  )
}
