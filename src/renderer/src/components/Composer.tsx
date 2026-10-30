import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { ImageAttachment } from '@shared/types'
import { MAX_IMAGES_PER_MESSAGE } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { ComposerImages, filesToImages } from './ImageAttachments'
import { Button } from './ui/Button'

interface Props {
  /** Key of the draft in the store: a run id, or newRunDraftKey(projectId). */
  draftKey: string
  /** Says what the primary button does ("Replying to Orchestrator", "New run: 2 open runs keep going"). */
  modeLabel: string
  primaryLabel: string
  placeholder: string
  /** Segmented control or other mode switch shown beside the mode label. */
  modeSwitch?: ReactNode
  /** Notices above the field (continued-by link, blocked session). */
  notices?: ReactNode
  /** Take focus on mount. */
  autoFocus?: boolean
  /** Take focus whenever this number changes (and is not 0). */
  focusToken?: number
  /** Send the message. Throw to keep the draft; `onFail` may claim the error. */
  onSubmit: (text: string, images: ImageAttachment[] | undefined) => Promise<void>
  /** Return true when the error was handled elsewhere; otherwise it shows as a notice. */
  onFail?: (err: unknown) => boolean
}

/**
 * The message box shared by the run page and the New run page. Its text and images live in the store under
 * `draftKey`, so a half-typed task survives switching tabs, runs and projects and never lands in the wrong run.
 */
export default function Composer({ draftKey, modeLabel, primaryLabel, placeholder, modeSwitch, notices, autoFocus, focusToken, onSubmit, onFail }: Props): ReactElement {
  const draft = useAppStore((s) => s.composerDrafts[draftKey])
  const setDraft = useAppStore((s) => s.setComposerDraft)
  const text = draft?.text ?? ''
  const images = draft?.images ?? []
  const [notice, setNotice] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const labelId = useId()
  const canSend = (text.trim().length > 0 || images.length > 0) && !busy

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  useEffect(() => {
    if (focusToken) ref.current?.focus()
  }, [focusToken])
  useEffect(() => setNotice(null), [draftKey])

  const addImages = async (files: File[]): Promise<void> => {
    const current = useAppStore.getState().composerDrafts[draftKey]
    const { images: added, notice: n } = await filesToImages(files, current?.images.length ?? 0)
    if (added.length > 0) setDraft(draftKey, { text: useAppStore.getState().composerDrafts[draftKey]?.text ?? '', images: [...(current?.images ?? []), ...added].slice(0, MAX_IMAGES_PER_MESSAGE) })
    setNotice(n)
  }

  const submit = async (): Promise<void> => {
    if (!canSend) return
    const sending = images
    const sentText = text
    setDraft(draftKey, { text: '', images: [] })
    setNotice(null)
    setBusy(true)
    try {
      await onSubmit(sentText.trim(), sending.length > 0 ? sending : undefined)
    } catch (err) {
      // Keep the draft and attachments so nothing is lost on failure.
      const now = useAppStore.getState().composerDrafts[draftKey]
      setDraft(draftKey, { text: now?.text || sentText, images: now && now.images.length > 0 ? now.images : sending })
      if (!onFail?.(err)) setNotice(err instanceof Error ? err.message : 'Could not send the message.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`composer ${dragOver ? 'drag' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(e) => {
        setDragOver(false)
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
        if (files.length === 0) return
        e.preventDefault()
        void addImages(files)
      }}
    >
      <div className="composer-field">
        <div className="composer-mode">
          <span className="composer-mode-label" id={labelId}>
            {modeLabel}
          </span>
          {modeSwitch}
        </div>
        {notices}
        {notice && (
          <div className="composer-notice" role="status">
            {notice}
          </div>
        )}
        <ComposerImages
          images={images}
          onRemove={(i) => setDraft(draftKey, { text, images: images.filter((_, j) => j !== i) })}
        />
        <textarea
          ref={ref}
          className="textarea"
          aria-labelledby={labelId}
          value={text}
          onChange={(e) => setDraft(draftKey, { text: e.target.value, images })}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.items)
              .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f)
            if (files.length === 0) return
            if (!e.clipboardData.getData('text/plain')) e.preventDefault()
            void addImages(files)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={placeholder}
        />
        <div className="composer-help">Enter to send · Shift+Enter for a new line</div>
      </div>
      <Button variant="primary" disabled={!canSend} onClick={() => void submit()}>
        {primaryLabel}
      </Button>
    </div>
  )
}
