// The edit session of one output and its sticky bar (docs/design/outputs-2.md section 9): unsaved state, Save (Ctrl/Cmd+S),
// Discard changes, Close editor and the stale-save choices. The session keeps the store's per-output draft in step and tells
// the detail shell about unsaved changes (setDirty) and how to save (registerSave), so its guard can run them.
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RunOutput } from '@shared/types'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { useAppStore } from '../../store/useAppStore'
import {
  compareLabel,
  discardBody,
  isDirty,
  saveAnywayLabel,
  saveBlockedReason,
  saveOutcome
} from '../../lib/outputEdit'
import { useOutputDetail } from './outputDetailContext'

export interface EditSession {
  text: string
  setText(text: string): void
  /** The saved text the edits are measured against. */
  base: string
  dirty: boolean
  saving: boolean
  /** Set by a save that found a newer version. */
  stale: { currentVersion: number } | null
  /** A refusal of main, shown as a line. */
  error: string
  /** A draft from earlier in this session was restored. */
  restored: boolean
  /** Bumps on Discard, so an editor holding its own model remounts from the base text. */
  resetKey: number
  /** Why Save cannot run right now (a visible line), or null. */
  blocked: string | null
  save(forceNew?: boolean): Promise<boolean>
  discard(): Promise<void>
  /** Leave the editor; asks first when dirty. */
  close(): Promise<void>
  compareWithCurrent(): Promise<void>
  onKeyDown(e: KeyboardEvent): void
  /** The session's confirm dialog (Discard); the owner of the session renders it once, outside the bar. */
  dialog: ReactElement
}

export interface EditSessionOptions {
  output: RunOutput
  /** The saved text (the source of the version being edited). */
  baseText: string
  /** Extra Save blockers from the editor kind (invalid JSON, active content in an SVG). */
  block?: (text: string) => { jsonOk?: boolean; svgRefused?: boolean; svgInvalid?: boolean }
  /** Where Close leads (the host returns to the preview). */
  onClose?: () => void
  /** Restore a draft kept earlier in the session. */
  restoreDraft?: boolean
}

/** One output's edit session. Needs a detail context (the shell); without one it still edits but cannot save. */
export function useEditSession({ output, baseText, block, onClose, restoreDraft = true }: EditSessionOptions): EditSession {
  const ctx = useOutputDetail()
  const { confirm, dialog } = useConfirm()
  const draft = useAppStore((s) => s.outputDrafts[output.id])
  const setOutputDraft = useAppStore((s) => s.setOutputDraft)
  const kept = restoreDraft && draft && draft.text !== baseText ? draft : null
  const [base, setBase] = useState(baseText)
  const [text, setTextState] = useState(kept ? kept.text : baseText)
  const baseVersion = useRef(kept ? kept.baseVersion : (ctx?.version ?? output.version ?? 1))
  const [restored] = useState(kept !== null)
  const [saving, setSaving] = useState(false)
  const [stale, setStale] = useState<{ currentVersion: number } | null>(null)
  const [error, setError] = useState('')
  const [resetKey, setResetKey] = useState(0)
  const dirty = isDirty(base, text)

  const textRef = useRef(text)
  textRef.current = text
  const baseRef = useRef(base)
  baseRef.current = base
  const savingRef = useRef(false)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const blockedRef = useRef<string | null>(null)

  const setText = useCallback(
    (t: string): void => {
      textRef.current = t
      setTextState(t)
      setError('')
      const d = isDirty(baseRef.current, t)
      if (d) setOutputDraft(output.id, { baseVersion: baseVersion.current, text: t })
      else setOutputDraft(output.id, null)
    },
    [output.id, setOutputDraft]
  )

  // A new version of the same output arrived while nothing was edited: follow it. While editing nothing resets; Save says so.
  useEffect(() => {
    if (baseText === baseRef.current) return
    if (!isDirty(baseRef.current, textRef.current)) {
      setBase(baseText)
      setTextState(baseText)
      baseVersion.current = ctxRef.current?.version ?? baseVersion.current
    }
  }, [baseText])

  const flags = dirty && block ? block(text) : {}
  const blocked = saveBlockedReason({ dirty, jsonOk: flags.jsonOk, svgRefused: flags.svgRefused, svgInvalid: flags.svgInvalid })
  blockedRef.current = blocked

  const save = useCallback(
    async (forceNew?: boolean): Promise<boolean> => {
      const api = window.orgai?.outputs
      const c = ctxRef.current
      if (!api || !c || savingRef.current) return false
      if (blockedRef.current) return false
      savingRef.current = true
      setSaving(true)
      setError('')
      try {
        const sent = textRef.current
        const r = saveOutcome(await api.saveEdit({ projectId: output.projectId, outputId: output.id, baseVersion: baseVersion.current, text: sent, forceNew: forceNew === true ? true : undefined }))
        if (r.kind === 'saved') {
          setStale(null)
          setBase(sent)
          baseRef.current = sent
          baseVersion.current = r.version
          if (textRef.current !== sent) {
            setOutputDraft(output.id, { baseVersion: r.version, text: textRef.current })
            c.setDirty(true)
            c.announce(`${r.text} Newer changes are not saved.`)
            c.reloadVersions()
            return false
          }
          setOutputDraft(output.id, null)
          c.setDirty(false)
          c.announce(r.text)
          c.reloadVersions()
          // The host's guard reads the dirty flag, which was just cleared.
          await Promise.resolve()
          onClose?.()
          return true
        }
        if (r.kind === 'stale') {
          setStale({ currentVersion: r.currentVersion })
          c.announce(r.text)
          return false
        }
        setError(r.text)
        c.announce(r.text)
        return false
      } catch {
        const msg = 'OrgAI could not save the changes. Try again.'
        setError(msg)
        c.announce(msg)
        return false
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [output.id, output.projectId, onClose, setOutputDraft]
  )

  // Tell the shell about unsaved changes and how to save them.
  useEffect(() => {
    ctx?.setDirty(dirty)
  }, [ctx, dirty])
  const saveRef = useRef(save)
  saveRef.current = save
  const registerSave = ctx?.registerSave
  useEffect(() => {
    registerSave?.(() => saveRef.current())
    return () => {
      registerSave?.(null)
      ctxRef.current?.setDirty(false)
    }
  }, [registerSave])

  const discard = useCallback(async (): Promise<void> => {
    if (isDirty(baseRef.current, textRef.current)) {
      const ok = await confirm({ title: 'Discard changes?', body: discardBody(output.title), confirmLabel: 'Discard changes', danger: true, confirmTestId: 'output-discard-confirm' })
      if (!ok) return
    }
    setTextState(baseRef.current)
    setStale(null)
    setError('')
    setOutputDraft(output.id, null)
    setResetKey((k) => k + 1)
  }, [confirm, output.id, output.title, setOutputDraft])

  const close = useCallback(async (): Promise<void> => {
    const c = ctxRef.current
    if (c && isDirty(baseRef.current, textRef.current)) {
      if (!(await c.guard())) return
      // "Don't save" ends here with the changes dropped; Save already cleared the draft.
      setOutputDraft(output.id, null)
    }
    onClose?.()
  }, [onClose, output.id, setOutputDraft])

  const compareWithCurrent = useCallback(async (): Promise<void> => {
    const c = ctxRef.current
    if (!c || !stale) return
    // The draft stays in the store; the guard would otherwise ask to save what the user wants to compare against.
    c.setDirty(false)
    const went = await c.setMode('compare', { a: baseVersion.current, b: stale.currentVersion })
    if (!went) c.setDirty(true)
  }, [stale])

  const onKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!blockedRef.current) void saveRef.current()
      }
    },
    []
  )

  return { text, setText, base, dirty, saving, stale, error, restored, resetKey, blocked, save, discard, close, compareWithCurrent, onKeyDown, dialog }
}

export interface EditorBarProps {
  session: EditSession
  title: string
  /** Extra controls at the start of the bar (Format, Edit as text...). */
  children?: ReactNode
  /** Hide Close editor (an embedded viewer that is not in edit mode). */
  noClose?: boolean
}

export function EditorBar({ session, title, children, noClose }: EditorBarProps): ReactElement {
  const reasonId = useId()
  const s = session
  const showReason = s.dirty && s.blocked
  return (
    <div className="output-edit-bar" data-testid="output-edit-bar" data-dirty={s.dirty ? 'true' : 'false'} role="group" aria-label={`Editing ${title}`}>
      {s.stale && (
        <div className="output-edit-stale" data-testid="output-edit-stale" role="group" aria-label="A newer version exists">
          <p>{`Version ${s.stale.currentVersion} was made while you were editing. Your changes are still here.`}</p>
          <div className="output-edit-stale-actions">
            <Button size="sm" variant="primary" testId="output-save-anyway" loading={s.saving} onClick={() => void s.save(true)}>
              {saveAnywayLabel(s.stale.currentVersion)}
            </Button>
            <Button size="sm" testId="output-compare-stale" onClick={() => void s.compareWithCurrent()}>
              {compareLabel(s.stale.currentVersion)}
            </Button>
            <Button size="sm" variant="ghost" testId="output-discard-stale" onClick={() => void s.discard()}>
              Discard changes
            </Button>
          </div>
        </div>
      )}
      {s.error && (
        <p className="output-edit-error" data-testid="output-edit-error">
          {s.error}
        </p>
      )}
      {showReason && (
        <p id={reasonId} className="output-edit-reason" data-testid="output-edit-reason">
          {s.blocked}
        </p>
      )}
      <div className="output-edit-row">
        <span className="output-edit-dirty" data-testid="output-edit-dirty" data-dirty={s.dirty ? 'true' : 'false'}>
          {s.dirty ? 'Unsaved changes' : 'No changes'}
        </span>
        {children}
        <span className="output-edit-spacer" />
        <Button size="sm" variant="ghost" testId="output-discard" inert={!s.dirty} onClick={() => void s.discard()}>
          Discard changes
        </Button>
        {!noClose && (
          <Button size="sm" testId="output-edit-close" onClick={() => void s.close()}>
            Close editor
          </Button>
        )}
        <Button size="sm" variant="primary" testId="output-save" loading={s.saving} inert={s.blocked !== null} ariaDescribedBy={showReason ? reasonId : undefined} title="Save (Ctrl+S)" onClick={() => void s.save()}>
          Save
        </Button>
      </div>
    </div>
  )
}
