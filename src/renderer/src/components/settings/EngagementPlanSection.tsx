import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { EngagementDocumentInfo, Project } from '@shared/types'
import { ENGAGEMENT_DOCUMENT_MAX_CHARS } from '@shared/types'
import { isRunLive, useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { planRevisedLine } from '../../lib/engagementContext'
import { Markdown } from '../Markdown'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { useConfirm } from '../ui/ConfirmDialog'
import { Textarea } from '../ui/Textarea'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'

const REVIEW_PROMPT = 'Review the engagement plan with me and propose changes.'

function focusLater(selector: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus()))
}

/**
 * Project settings > General > Engagement plan (engagements only; engagement-2 spec 5). The plan is read in a capped
 * region, edited in a text field, and saved against the `updatedAt` the edit started from: a plan that changed
 * meanwhile (an approved interview proposal) is never overwritten silently.
 */
export function EngagementPlanSection({ project }: { project: Project }): ReactElement {
  const uid = useId()
  const startSetup = useAppStore((s) => s.startSetup)
  const setView = useAppStore((s) => s.setView)
  const setupLive = useAppStore((s) => Object.values(s.runs).some((r) => r.summary.projectId === project.id && r.summary.kind === 'setup' && isRunLive(r)))
  const { confirm, dialog } = useConfirm()
  const [info, setInfo] = useState<EngagementDocumentInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [draft, setDraft] = useState('')
  const [orig, setOrig] = useState('')
  const [base, setBase] = useState(0)
  const [stale, setStale] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const editor = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async (): Promise<EngagementDocumentInfo | null> => {
    try {
      const next = await window.orgai.engagement.document(project.id)
      setInfo(next)
      setLoadError(null)
      return next
    } catch (e) {
      setLoadError(cleanIpcError(e))
      return null
    }
  }, [project.id])

  useEffect(() => {
    setInfo(null)
    setMode('view')
    setStale(false)
    setSaveError(null)
    setStatus('')
    void load()
    const off = window.orgai.onEngagementChanged((ev) => {
      if (ev.projectId === project.id && ev.what === 'document') void load()
    })
    return off
  }, [project.id, load])

  const startEdit = (): void => {
    const text = info?.text ?? ''
    setDraft(text)
    setOrig(text)
    setBase(info?.updatedAt ?? 0)
    setStale(false)
    setSaveError(null)
    setStatus('')
    setMode('edit')
    focusLater(`#${CSS.escape(`${uid}-editor`)}`)
  }

  const dirty = mode === 'edit' && draft !== orig
  const cancel = async (): Promise<void> => {
    if (dirty && !(await confirm({ title: 'Discard your changes to the plan?', body: 'Your edits are not saved.', confirmLabel: 'Discard', danger: true }))) return
    setMode('view')
    setStale(false)
    setSaveError(null)
    focusLater('[data-testid=engagement-plan-edit], [data-testid=engagement-plan-write]')
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const next = await window.orgai.engagement.updateDocument({ projectId: project.id, text: draft, expectedUpdatedAt: base })
      setInfo(next)
      setMode('view')
      setStale(false)
      setStatus('Plan saved.')
      focusLater('[data-testid=engagement-plan-edit], [data-testid=engagement-plan-write]')
    } catch (e) {
      const current = await load()
      if (current && (current.updatedAt ?? 0) !== base) setStale(true)
      else setSaveError(cleanIpcError(e))
    } finally {
      setSaving(false)
    }
  }

  const loadNew = async (): Promise<void> => {
    if (draft !== orig && !(await confirm({ title: 'Replace your text with the new plan?', body: 'Copy your text first if you want to keep it.', confirmLabel: 'Load the new plan', danger: true }))) return
    const text = info?.text ?? ''
    setDraft(text)
    setOrig(text)
    setBase(info?.updatedAt ?? 0)
    setStale(false)
    focusLater(`#${CSS.escape(`${uid}-editor`)}`)
  }

  const interview = (prompt?: string): void => {
    setStarting(true)
    setStartError(null)
    startSetup(prompt)
      .then(() => setView('run'))
      .catch((e: unknown) => setStartError(cleanIpcError(e)))
      .finally(() => setStarting(false))
  }

  const has = !!info && info.text !== ''
  const over = draft.length > ENGAGEMENT_DOCUMENT_MAX_CHARS
  const count = `${draft.length.toLocaleString()} of ${ENGAGEMENT_DOCUMENT_MAX_CHARS.toLocaleString()}`
  const revised = info ? planRevisedLine(info) : null
  const busyId = `${uid}-busy`

  return (
    <SettingsSection
      id={PROJECT_SETTINGS_SECTIONS.engagementPlan}
      title="Engagement plan"
      testId="engagement-plan-section"
      description="What the team works from. Agents read it at the start of every run; a run already going keeps the version it started with."
    >
      <span role="status" aria-live="polite" className="plan-status" data-testid="engagement-plan-status">
        {status}
      </span>
      {loadError && (
        <Banner
          tone="danger"
          title="Could not read the plan"
          actions={
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Banner>
      )}
      {!loadError && info === null && <p className="settings-quiet">Looking…</p>}
      {info !== null && mode === 'view' && !has && (
        <SettingsCard>
          <p className="settings-card-note" data-testid="engagement-plan-empty">
            No plan yet. The setup interview writes one, or you can write it yourself.
          </p>
          <div className="plan-actions">
            <Button
              variant="primary"
              inert={setupLive || starting}
              ariaDescribedBy={setupLive ? busyId : undefined}
              testId="engagement-plan-interview"
              onClick={() => {
                if (!setupLive && !starting) interview()
              }}
            >
              {starting ? 'Starting…' : 'Start the setup interview'}
            </Button>
            <Button testId="engagement-plan-write" onClick={startEdit}>
              Write it yourself
            </Button>
          </div>
        </SettingsCard>
      )}
      {info !== null && mode === 'view' && has && (
        <SettingsCard>
          {revised && (
            <p className="settings-card-note" data-testid="engagement-plan-revised" title={revised.title}>
              {revised.text}
            </p>
          )}
          <div className="plan-view" role="region" aria-label="Engagement plan" tabIndex={0} data-testid="engagement-plan-view">
            <Markdown text={info.text} />
          </div>
          <div className="plan-actions">
            <Button
              inert={setupLive}
              ariaDescribedBy={setupLive ? busyId : undefined}
              testId="engagement-plan-edit"
              onClick={() => {
                if (!setupLive) startEdit()
              }}
            >
              Edit
            </Button>
            <Button
              inert={setupLive || starting}
              ariaDescribedBy={setupLive ? busyId : undefined}
              testId="engagement-plan-review"
              onClick={() => {
                if (!setupLive && !starting) interview(REVIEW_PROMPT)
              }}
            >
              {starting ? 'Starting…' : 'Review in the setup interview'}
            </Button>
          </div>
        </SettingsCard>
      )}
      {mode === 'view' && setupLive && info !== null && (
        <p id={busyId} className="settings-quiet" data-testid="engagement-plan-busy">
          The setup interview is running. Edit after it ends.
        </p>
      )}
      {startError && (
        <Banner tone="danger" title="Could not start the setup interview">
          {startError}
        </Banner>
      )}
      {mode === 'edit' && (
        <>
          {stale && (
            <Banner
              tone="warning"
              title="The plan changed while you were editing."
              testId="engagement-plan-stale"
              actions={
                <>
                  <CopyButton text={draft} label="Copy my text" />
                  <Button size="sm" onClick={() => void loadNew()}>
                    Load the new plan
                  </Button>
                </>
              }
            >
              Your text is still here. Copy it, or load the new plan to start from it.
            </Banner>
          )}
          <SettingsCard>
            <div className="field plan-editor-field">
              <label htmlFor={`${uid}-editor`} className="plan-editor-label">
                Engagement plan
              </label>
              <Textarea
                id={`${uid}-editor`}
                rows={10}
                value={draft}
                invalid={over || !!saveError}
                aria-describedby={`${uid}-count`}
                data-testid="engagement-plan-editor"
                onChange={(v) => {
                  setDraft(v)
                  setSaveError(null)
                }}
              />
              <span id={`${uid}-count`} className={`field-msg${over || saveError ? ' error' : ''}`}>
                {saveError ?? (over ? `Too long: ${count} characters.` : `${count} characters`)}
              </span>
            </div>
            <div className="plan-actions">
              <Button disabled={saving} onClick={() => void cancel()}>
                Cancel
              </Button>
              <Button variant="primary" disabled={over} loading={saving} testId="engagement-plan-save" onClick={() => void save()}>
                Save plan
              </Button>
            </div>
          </SettingsCard>
        </>
      )}
      {dialog}
    </SettingsSection>
  )
}
