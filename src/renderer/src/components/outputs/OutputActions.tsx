import type { KeyboardEvent, ReactElement } from 'react'
import { useId } from 'react'
import { Copy, ExternalLink, FolderOpen, Link2, MoreHorizontal, Save, Trash2, X } from 'lucide-react'
import type { RunOutput } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { canDeleteOutput, canOpenOutput, previewCacheFor, previewKey } from '../../lib/outputs'
import { COPY_FAILED, SOURCE_COPIED } from '../../lib/diagramExport'
import { cleanIpcError } from '../../lib/ipcError'
import { HIDDEN_OR_CONTROL_RUN, showHidden } from '../../lib/hiddenChars'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { useConfirm } from '../ui/ConfirmDialog'
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

/**
 * The More actions menu of one output (docs/design/outputs.md section 5): Open, Show in folder, Save as, Copy path,
 * Remove from list and Delete file. Every answer goes to `onNotice` (the surface's polite `output-notice` line).
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
  const { confirm, dialog } = useConfirm()
  const title = plainTitle(output.title)
  const ref = { projectId: output.projectId, outputId: output.id }
  const notice = (text: string): void => onNotice?.(text)
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
  const copySource = (): void => {
    void run(async () => {
      // The cached preview holds the text; a miss fetches it (and caches it for the viewer).
      const cache = previewCacheFor(output.projectId)
      const key = previewKey(output)
      let p = cache.get(key)
      if (!p) {
        p = await window.orgai.outputs.preview(ref)
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
            {!missing && SOURCE_KINDS.has(output.kind) && item('output-copy-source', Copy, 'Copy source', () => { close(); copySource() })}
            {item('output-copy-path', Link2, 'Copy path', () => {
              close()
              void run(async () => {
                await navigator.clipboard.writeText(output.path)
                notice('Copied the path.')
              })
            })}
            {item('output-forget', X, 'Remove from list', () => {
              close()
              void run(async () => {
                // The index entry is gone for good: the contract has no way to bring it back (docs/design/outputs.md section 12).
                const ok = await confirm({
                  title: `Remove ${title} from the list?`,
                  body: `The file stays at ${showHidden(output.relPath)}. It leaves OrgAI's list and cannot be added back from here.`,
                  confirmLabel: 'Remove',
                  confirmTestId: 'output-forget-confirm'
                })
                if (ok) removed(await window.orgai.outputs.forget(ref), `Removed ${title} from the list.`)
              })
            })}
            {canDeleteOutput(output) &&
              item(
                'output-delete',
                Trash2,
                'Delete file…',
                () => {
                  close()
                  void run(async () => {
                    const ok = await confirm({
                      title: `Delete ${title}?`,
                      body: `This deletes ${showHidden(output.relPath)} from the project folder. It cannot be undone.`,
                      confirmLabel: 'Delete file',
                      danger: true,
                      confirmTestId: 'output-delete-confirm'
                    })
                    if (ok) removed(await window.orgai.outputs.delete(ref), `Deleted ${title}.`)
                  })
                },
                true
              )}
          </div>
        )}
      </Popover>
      {dialog}
    </>
  )
}
