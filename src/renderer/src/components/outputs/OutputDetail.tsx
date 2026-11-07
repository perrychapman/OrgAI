// The shown output (docs/design/outputs.md section 4, outputs-2.md sections 7 and 9-12): head with the version select,
// tabs Preview / Versions / Notes, the action toolbar and the body. It owns the shared state (version, mode, tab, dirty
// guard, selection, live text) and provides it to everything below and to the Larger view (OutputViewer).
// Shared by the run side tab and the project tab.
import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, MessageSquareQuote, Pencil, SquarePen } from 'lucide-react'
import type { OutputReviseResult, RunOutput } from '@shared/types'
import { useAppStore, useRunIndexes } from '../../store/useAppStore'
import { canOpenOutput, canReviseFallback, currentProvenance, editBlockedReason, externalAppName, isEditableKind, outputMetaLine, provenanceLine } from '../../lib/outputs'
import { cleanIpcError } from '../../lib/ipcError'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { HIDDEN_SHOWN_TITLE } from '../../lib/teamFound'
import { runTag } from '../../lib/runLabels'
import { oldVersionText, versionOptionLabel } from '../../lib/outputVersions'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Tabs, panelDomId, tabDomId, type TabItem } from '../ui/Tabs'
import ExtBadge from './ExtBadge'
import { ClampText } from '../proposals/ClampText'
import OutputActions from './OutputActions'
import OutputPreview from './OutputPreview'
import OutputViewer from './OutputViewer'
import OutputEditor from './OutputEditor'
import ComparePanel from './ComparePanel'
import VersionsPanel, { restoreVersion } from './VersionsPanel'
import NotesPanel from './NotesPanel'
import NoteTools from './NoteTools'
import RevisionStatus from './RevisionStatus'
import ReviseDialog from './ReviseDialog'
import ExternalEditStatus, { useExternalEdit, type ExternalEdit } from './ExternalEditStatus'
import { useOutputNotes, useOutputVersions } from './useOutputData'
import {
  OutputDetailContext,
  useOutputDetail,
  type OutputDetailMode,
  type OutputDetailTab,
  type OutputDetailValue,
  type OutputSelection,
  type RegionTool,
  type ReviseInit
} from './outputDetailContext'
import '../../styles/outputs.css'
import '../../styles/outputs-versions.css'

export interface OutputDetailProps {
  output: RunOutput
  /** Called after Remove from list / Delete file succeeded (the surface moves focus to the next row). */
  onRemoved?: (id: string) => void
  /** Notice line text (open / reveal refusals, save, remove); the surface renders it in its polite region. */
  onNotice?: (text: string) => void
  /** Focus the heading on mount (the default). */
  autoFocus?: boolean
  /** The run side tab's panel is narrower than the wide split: say once ever (a saved flag) how to get more room. */
  narrowHint?: boolean
}

/** localStorage flag: the narrow-panel hint was shown once (it never comes back). */
export const WIDE_HINT_KEY = 'orgai.outputsWideHint'
export const WIDE_HINT_TEXT = 'Drag the panel edge or use Larger view'

/** True the first time only (the flag is saved when the hint is first shown, so it never nags). */
export function takeWideHint(): boolean {
  try {
    if (localStorage.getItem(WIDE_HINT_KEY)) return false
    localStorage.setItem(WIDE_HINT_KEY, '1')
    return true
  } catch {
    return false
  }
}

/** After a run link opened the run (the surface may unmount): land focus on the composer, else the selected run tab, else the topbar h1. */
export function settleRunFocus(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body) return
      const composer = document.querySelector<HTMLTextAreaElement>('.composer textarea')
      if (composer && !composer.disabled) {
        composer.focus({ preventScroll: true })
        return
      }
      const tab = document.querySelector<HTMLElement>('.run-tab[aria-selected=true]')
      if (tab) {
        tab.focus({ preventScroll: true })
        return
      }
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  )
}

/** The shown output's unsaved-changes guard, for a surface that is about to move away (selection, prev / next). True = fine to leave. */
let activeGuard: (() => Promise<boolean>) | null = null
export function confirmLeaveOutput(): Promise<boolean> {
  return activeGuard ? activeGuard() : Promise.resolve(true)
}

const OPEN_TITLE = 'Opens in the app your computer uses for this kind of file'

/** "Save your changes to <title> first?" with Save / Don't save / Cancel. */
function GuardDialog({ title, onChoose }: { title: string; onChoose(choice: 'save' | 'discard' | 'cancel'): void }): ReactElement {
  return (
    <Dialog
      open
      onClose={() => onChoose('cancel')}
      title={`Save your changes to ${title} first?`}
      size="sm"
      testId="output-guard-dialog"
      footer={
        <>
          <Button autoFocusDialog testId="output-guard-cancel" onClick={() => onChoose('cancel')}>
            Cancel
          </Button>
          <Button variant="danger" testId="output-guard-discard" onClick={() => onChoose('discard')}>
            Don't save
          </Button>
          <Button variant="primary" testId="output-guard-save" onClick={() => onChoose('save')}>
            Save
          </Button>
        </>
      }
    >
      <p>Your changes are not saved yet.</p>
    </Dialog>
  )
}

/** The version select beside the title (native select). */
function VersionSelect(): ReactElement | null {
  const ctx = useOutputDetail()
  if (!ctx) return null
  const list = ctx.versions
  if (!list || list.length < 2) {
    return (
      <span className="output-version-solo" data-testid="output-version-solo">
        v{ctx.version}
      </span>
    )
  }
  return (
    <>
      <label className="sr-only" htmlFor={`output-version-select-${ctx.surface}`}>
        Version
      </label>
      <select
        id={`output-version-select-${ctx.surface}`}
        className="select output-version-select"
        data-testid="output-version-select"
        value={ctx.version}
        onChange={(e) => ctx.setVersion(Number(e.target.value))}
      >
        {list.map((v) => (
          <option key={v.n} value={v.n}>
            {versionOptionLabel(v, ctx.currentVersion)}
          </option>
        ))}
      </select>
    </>
  )
}

/** Banner for an older version: back to the current one, or restore it. */
function OldVersionBanner(): ReactElement | null {
  const ctx = useOutputDetail()
  if (!ctx || ctx.isCurrent || ctx.mode === 'compare') return null
  return (
    <div className="output-old-version" data-testid="output-old-version" role="group" aria-label="Older version">
      <p>{oldVersionText(ctx.version, ctx.currentVersion)}</p>
      <div className="output-old-version-actions">
        <Button size="sm" testId="output-back-current" onClick={() => ctx.setVersion(null)}>
          Back to current
        </Button>
        <Button size="sm" variant="primary" testId="output-restore" onClick={() => void restoreVersion(ctx, ctx.version)}>
          Restore this version
        </Button>
      </div>
    </div>
  )
}

/** The action toolbar (section 7). While the Larger view is open the panel keeps only its Larger view button (the focus return). */
function Toolbar({ edit, onOpenLarger, collapsed, onNotice, onRemoved }: { edit: ExternalEdit; onOpenLarger(): void; collapsed: boolean; onNotice?: (t: string) => void; onRemoved?: (id: string) => void }): ReactElement | null {
  const ctx = useOutputDetail()
  if (!ctx) return null
  const { output } = ctx
  const missing = output.missing === true
  const viewer = ctx.surface === 'viewer'
  const external = externalAppName(output.kind)
  const prefix = viewer ? 'output-dialog' : 'output-detail'
  const say = (t: string): void => {
    onNotice?.(t)
    ctx.announce(t)
  }
  const open = async (): Promise<void> => {
    try {
      const answer = await window.orgai.outputs.open({ projectId: output.projectId, outputId: output.id })
      if (answer) say(answer)
    } catch (e) {
      say(cleanIpcError(e))
    }
  }
  const expand = !viewer && !missing && (
    <Button
      key="expand"
      variant={output.kind === 'mermaid' || output.kind === 'pptx' ? 'primary' : 'secondary'}
      size="sm"
      icon={Maximize2}
      ariaLabel="Larger view"
      testId="output-detail-expand"
      onClick={onOpenLarger}
    >
      Larger view
    </Button>
  )
  if (collapsed) {
    return (
      <>
        <div className="output-detail-toolbar" role="group" aria-label="Output actions">
          {expand}
        </div>
      </>
    )
  }
  const blocked = editBlockedReason(output, ctx.isCurrent)
  const canEdit = isEditableKind(output.kind) && blocked === null && ctx.mode !== 'edit'
  const reviseLabel = ctx.isCurrent ? 'Ask the team to revise…' : 'Ask the team to revise the current version…'
  return (
    <>
      <div className="output-detail-toolbar" role="group" aria-label="Output actions">
        {canEdit && (
          <Button variant="secondary" size="sm" icon={Pencil} testId="output-edit" onClick={() => void ctx.setMode('edit')}>
            Edit
          </Button>
        )}
        {external && !missing && ctx.isCurrent && (
          <Button
            variant="secondary"
            size="sm"
            icon={SquarePen}
            testId="output-edit-external"
            title={`Opens the file in the app your computer uses for ${external === 'Excel' ? 'spreadsheet' : external === 'PowerPoint' ? 'presentation' : 'document'} files. When you save there, OrgAI keeps the change as a new version.`}
            onClick={() => {
              void edit.start().then((refusal) => {
                if (refusal) say(refusal)
              })
            }}
          >
            Edit in {external}
          </Button>
        )}
        {canOpenOutput(output) && !external && (
          <Button variant="secondary" size="sm" testId={`${prefix}-open`} title={OPEN_TITLE} onClick={() => void open()}>
            Open
          </Button>
        )}
        {canReviseFallback(output) && (
          <Button variant="secondary" size="sm" icon={MessageSquareQuote} testId="output-revise" onClick={() => ctx.openRevise()}>
            {reviseLabel}
          </Button>
        )}
        <NoteTools />
        {expand}
        <OutputActions output={output} onRemoved={onRemoved} onNotice={say} />
      </div>
      {blocked && (
        <p className="output-edit-reason" data-testid="output-edit-reason">
          {blocked}
        </p>
      )}
    </>
  )
}

/** The body: compare, the editor, or the chosen tab. */
function Body({ onCloseCompare, onCloseEditor, full, onToggleFull, onOpenLarge, context }: { onCloseCompare(): void; onCloseEditor(): void; full: boolean; onToggleFull(): void; onOpenLarge?: () => void; context: 'detail' | 'dialog' }): ReactElement | null {
  const ctx = useOutputDetail()
  if (!ctx) return null
  const { output } = ctx
  if (ctx.mode === 'compare') return <ComparePanel onClose={onCloseCompare} />
  if (ctx.mode === 'edit') return <OutputEditor onClose={onCloseEditor} />
  if (ctx.tab === 'versions') return <VersionsPanel />
  if (ctx.tab === 'notes' && ctx.surface === 'detail') return <NotesPanel variant="tab" />
  if (output.missing === true) return null
  return (
    <OutputPreview
      output={output}
      labelledBy="output-detail-heading"
      context={context}
      onOpenLarge={onOpenLarge}
      full={full}
      onToggleFull={onToggleFull}
      version={ctx.isCurrent ? null : ctx.version}
    />
  )
}

function DetailTabs({ idPrefix }: { idPrefix: string }): ReactElement | null {
  const ctx = useOutputDetail()
  if (!ctx) return null
  const versions = ctx.output.versionCount ?? ctx.versions?.length ?? 1
  const open = ctx.output.openNoteCount ?? 0
  const tabs: TabItem[] = [
    { id: 'preview', label: 'Preview', testId: 'output-tab-preview' },
    { id: 'versions', label: 'Versions', count: versions, countLabel: `${versions} ${versions === 1 ? 'version' : 'versions'}`, testId: 'output-tab-versions' }
  ]
  if (ctx.surface === 'detail') tabs.push({ id: 'notes', label: 'Notes', count: open, countLabel: `${open} open ${open === 1 ? 'note' : 'notes'}`, testId: 'output-tab-notes' })
  return (
    <div className="output-detail-tabs" data-testid="output-detail-tabs">
      <Tabs tabs={tabs} value={ctx.tab === 'notes' && ctx.surface === 'viewer' ? 'preview' : ctx.tab} onChange={(id) => ctx.setTab(id as OutputDetailTab)} label="Output views" idPrefix={idPrefix} compact />
    </div>
  )
}

export default function OutputDetail({ output, onRemoved, onNotice, autoFocus, narrowHint }: OutputDetailProps): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null)
  const [larger, setLarger] = useState(false)
  const [full, setFull] = useState(false)
  const toggleFull = useCallback(() => setFull((f) => !f), [])
  const closeLarger = (): void => {
    setLarger(false)
    setFull(false)
  }
  const [notice, setNotice] = useState('')

  const current = output.version ?? 1
  const ref = useMemo(() => ({ projectId: output.projectId, outputId: output.id }), [output.projectId, output.id])
  const versionsRead = useOutputVersions(ref)
  const notesRead = useOutputNotes(ref)

  // ---- shared state ----
  const [viewing, setViewing] = useState<number | null>(null)
  const version = viewing !== null && viewing !== current ? viewing : current
  const [tab, setTabState] = useState<OutputDetailTab>('preview')
  const [mode, setModeState] = useState<OutputDetailMode>('preview')
  const [compare, setCompare] = useState<{ a: number; b: number } | null>(null)
  const [dirty, setDirtyState] = useState(false)
  const [selection, setSelection] = useState<OutputSelection | null>(null)
  const [regionTool, setRegionTool] = useState<RegionTool>('off')
  const [shownNote, setShownNote] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const [revise, setRevise] = useState<ReviseInit | null>(null)
  const [guarding, setGuarding] = useState(false)
  const dirtyRef = useRef(false)
  const modeRef = useRef<OutputDetailMode>('preview')
  const saveRef = useRef<(() => Promise<boolean>) | null>(null)
  const guardResolve = useRef<((c: 'save' | 'discard' | 'cancel') => void) | null>(null)
  modeRef.current = mode
  const title = output.title.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, '').trim() || 'this output'

  const announce = useCallback((text: string): void => {
    setLive((prev) => (prev === text ? `${text} ` : text))
  }, [])
  const setDirty = useCallback((d: boolean): void => {
    dirtyRef.current = d
    setDirtyState(d)
  }, [])
  const registerSave = useCallback((save: (() => Promise<boolean>) | null): void => {
    saveRef.current = save
  }, [])

  const guard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true
    const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
      guardResolve.current?.('cancel')
      guardResolve.current = resolve
      setGuarding(true)
    })
    guardResolve.current = null
    setGuarding(false)
    if (choice === 'cancel') return false
    if (choice === 'discard') {
      useAppStore.getState().setOutputDraft(output.id, null)
      dirtyRef.current = false
      setDirtyState(false)
      return true
    }
    const saved = (await saveRef.current?.()) ?? false
    if (!saved) return false
    dirtyRef.current = false
    setDirtyState(false)
    return true
  }, [output.id])

  useEffect(() => {
    activeGuard = guard
    return () => {
      if (activeGuard === guard) activeGuard = null
      guardResolve.current?.('cancel')
    }
  }, [guard])

  const setMode = useCallback(
    async (next: OutputDetailMode, cmp?: { a: number; b: number }): Promise<boolean> => {
      if (modeRef.current === 'edit' && next !== 'edit' && !(await guard())) return false
      if (next === 'compare') setCompare(cmp ?? null)
      setModeState(next)
      setSelection(null)
      return true
    },
    [guard]
  )
  const setTab = useCallback(
    (next: OutputDetailTab): void => {
      void (async () => {
        if (modeRef.current !== 'preview' && !(await setMode('preview'))) return
        setTabState(next)
      })()
    },
    [setMode]
  )
  const setVersion = useCallback(
    (n: number | null): void => {
      void (async () => {
        if (modeRef.current !== 'preview' && !(await setMode('preview'))) return
        setViewing(n)
        setSelection(null)
      })()
    },
    [setMode]
  )

  const openRevise = useCallback((init?: ReviseInit): void => setRevise(init ?? {}), [])
  const showNote = useCallback((id: string | null): void => setShownNote(id), [])

  const value = useMemo<OutputDetailValue>(
    () => ({
      output,
      surface: 'detail',
      version,
      currentVersion: current,
      isCurrent: version === current,
      setVersion,
      versions: versionsRead.data,
      reloadVersions: versionsRead.reload,
      notes: notesRead.data,
      reloadNotes: notesRead.reload,
      tab,
      setTab,
      mode,
      compare,
      setMode,
      dirty,
      setDirty,
      registerSave,
      guard,
      selection,
      setSelection,
      regionTool,
      setRegionTool,
      shownNote,
      showNote,
      announce,
      openRevise
    }),
    [output, version, current, setVersion, versionsRead.data, versionsRead.reload, notesRead.data, notesRead.reload, tab, setTab, mode, compare, setMode, dirty, setDirty, registerSave, guard, selection, regionTool, shownNote, showNote, announce, openRevise]
  )

  const external = useExternalEdit(output, versionsRead.data, announce)

  // markOutputSeen: the user is looking at the current version.
  useEffect(() => {
    useAppStore.getState().markOutputSeen(output.id, current)
  }, [output.id, current])

  // Esc leaves Full window first (and the dialog stays open); a second Esc closes it as before. An open menu keeps its own Esc.
  // Opening the Larger view lands focus on the drawing's viewport (spec 14.3) once it is drawn, unless the user moved
  // focus first (the Dialog puts it on its first control; any other element means the user chose).
  useEffect(() => {
    if (!larger) return undefined
    let first: Element | null = null
    let tries = 0
    let raf = 0
    const tick = (): void => {
      const active = document.activeElement
      if (tries === 1) first = active
      else if (tries > 1 && active !== first) return
      const vp = document.querySelector<HTMLElement>('[data-testid=output-dialog] [data-testid=diagram-viewport]')
      if (vp) {
        vp.focus({ preventScroll: true })
        return
      }
      if (++tries < 180) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [larger])
  useEffect(() => {
    if (!larger || !full) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector(':popover-open')) return
      // A confirm opened from inside the Larger view (Delete, Remove) takes its own Esc first (spec 14.3).
      const t = e.target as Element | null
      const own = t?.closest('dialog, [role=dialog]')
      if (own && !own.querySelector('.output-dialog-body')) return
      e.preventDefault()
      e.stopPropagation()
      setFull(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [larger, full])

  const [hint] = useState(() => narrowHint === true && takeWideHint())
  const index = useRunIndexes().get(output.current?.runId ?? output.runId)
  useEffect(() => {
    if (autoFocus !== false) heading.current?.focus({ preventScroll: true })
    // Focus once per shown output, never on a refresh of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output.id])
  const missing = output.missing === true
  const tag = index !== undefined ? runTag(index) : undefined
  const agentCurrent = !output.current || output.current.source === 'agent'
  // provenanceLine puts the run tag between the role and the date; split around it so the tag can be the link.
  const marker = '\u0000'
  const [before, after] = (agentCurrent ? provenanceLine({ role: output.current?.role ?? output.role, createdAt: output.current?.at ?? output.updatedAt ?? output.createdAt }, marker) : '').split(marker)
  const openRun = (): void => {
    void useAppStore
      .getState()
      .focusRun(output.projectId, output.current?.runId ?? output.runId)
      .then(settleRunFocus)
      .catch((e) => say(cleanIpcError(e)))
  }
  const say = (text: string): void => {
    setNotice(text)
    onNotice?.(text)
  }
  const afterRemoved = (id: string): void => {
    closeLarger()
    onRemoved?.(id)
  }
  const openLarger = useCallback(() => setLarger(true), [])
  const closeCompare = useCallback(() => void setMode('preview'), [setMode])
  const closeEditor = useCallback(() => void setMode('preview'), [setMode])
  const onReviseClose = (r: OutputReviseResult | null): void => {
    setRevise(null)
    if (r && !('refused' in r)) announce('Sent to the team. They will add a new version.')
  }

  const meta = <p className="output-detail-meta" data-testid={larger ? 'output-dialog-meta' : 'output-detail-meta'}>{outputMetaLine(output)}</p>
  const versionRow = (
    <div className="output-version-row-head">
      <VersionSelect />
    </div>
  )
  const status = (
    <>
      <RevisionStatus />
      <ExternalEditStatus edit={external} output={output} onCompare={(a, b) => void setMode('compare', { a, b })} />
    </>
  )
  const tabsPrefix = `output-detail-${larger ? 'viewer' : 'detail'}`
  const panelId = panelDomId(tabsPrefix, tab === 'notes' && larger ? 'preview' : tab)
  const labelId = tabDomId(tabsPrefix, tab === 'notes' && larger ? 'preview' : tab)

  return (
    <OutputDetailContext.Provider value={value}>
      <section className="output-detail" data-testid="output-detail" data-id={output.id} data-kind={output.kind} data-version={version} aria-labelledby="output-detail-heading">
        <div className="output-detail-head">
          <h3 id="output-detail-heading" ref={heading} data-testid="output-detail-heading" tabIndex={-1} className="output-detail-heading">
            {showHidden(output.title)}
            {hasHidden(output.title) && (
              <Badge tone="attention" title={HIDDEN_SHOWN_TITLE}>
                Hidden characters shown
              </Badge>
            )}
            <ExtBadge fileName={output.fileName} />
          </h3>
          {!larger && !missing && versionRow}
        </div>
        {hint && !larger && (
          <p className="output-detail-hint" data-testid="output-wide-hint">
            {WIDE_HINT_TEXT}
          </p>
        )}
        {!larger && meta}
        {!larger && (
          <p className="output-detail-prov" data-testid="output-detail-prov">
            {agentCurrent && tag ? (
              <>
                {before}
                <button type="button" className="link-btn" data-testid="output-run-link" aria-label={`Open run ${tag}`} onClick={openRun}>
                  {tag}
                </button>
                {after}
              </>
            ) : (
              currentProvenance(output)
            )}
          </p>
        )}
        {output.description && !larger && <ClampText text={output.description} label={output.title} />}
        {missing && !larger && (
          <p className="output-missing" data-testid="output-missing">
            The file is gone from {output.relPath}. It was moved or deleted outside OrgAI.
          </p>
        )}
        {!larger && (
          <>
            {status}
            <OldVersionBanner />
          </>
        )}
        <Toolbar edit={external} onOpenLarger={openLarger} collapsed={larger} onNotice={say} onRemoved={afterRemoved} />
        {!larger && !missing && <DetailTabs idPrefix={tabsPrefix} />}
        {!larger && (
          <div className="output-detail-body" role="tabpanel" id={panelId} aria-labelledby={labelId}>
            <Body onCloseCompare={closeCompare} onCloseEditor={closeEditor} full={false} onToggleFull={toggleFull} onOpenLarge={openLarger} context="detail" />
          </div>
        )}
        {!larger && (
          <p className="sr-only" role="status" data-testid="output-live">
            {live}
          </p>
        )}
        {larger && <p className="output-detail-hint">Showing in the larger view.</p>}
      </section>
      {larger && (
        <OutputViewer
          value={value}
          onClose={closeLarger}
          full={full}
          live={live}
          notice={notice}
          head={
            <div className="output-viewer-head">
              {versionRow}
              {meta}
            </div>
          }
          tools={
            <ViewerTools edit={external} say={say} afterRemoved={afterRemoved} idPrefix={tabsPrefix} status={status} />
          }
          body={
            <div className="output-detail-body" role="tabpanel" id={panelId} aria-labelledby={labelId}>
              <Body onCloseCompare={closeCompare} onCloseEditor={closeEditor} full={full} onToggleFull={toggleFull} context="dialog" />
            </div>
          }
        />
      )}
      {guarding && <GuardDialog title={title} onChoose={(c) => guardResolve.current?.(c)} />}
      {revise && (
        <ReviseDialog
          output={output}
          version={version}
          init={revise}
          dirty={dirty}
          onSaveFirst={async () => (await saveRef.current?.()) ?? false}
          onClose={onReviseClose}
        />
      )}
    </OutputDetailContext.Provider>
  )
}

/** Banner, toolbar, status and tabs of the Larger view (they read the viewer's context from where they render). */
function ViewerTools({ edit, say, afterRemoved, idPrefix, status }: { edit: ExternalEdit; say(t: string): void; afterRemoved(id: string): void; idPrefix: string; status: ReactElement }): ReactElement {
  return (
    <div className="output-viewer-tools">
      {status}
      <OldVersionBanner />
      <Toolbar edit={edit} onOpenLarger={() => undefined} collapsed={false} onNotice={say} onRemoved={afterRemoved} />
      <DetailTabs idPrefix={`${idPrefix}`} />
    </div>
  )
}
