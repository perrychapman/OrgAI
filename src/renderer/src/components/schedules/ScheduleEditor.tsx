import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PermissionMode, Schedule } from '@shared/types'
import { SCHEDULE_NAME_MAX_CHARS, SCHEDULE_PERMISSION_MODES, SCHEDULE_PROMPT_MAX_CHARS, isVirtualProjectId } from '@shared/types'
import { describeScheduleTiming } from '@shared/schedule'
import { formatDateTime, formatFullDateTime } from '@shared/view/dates'
import {
  SCHEDULE_APPROVAL_NOTE,
  SCHEDULE_UNATTENDED_NOTE,
  TIMING_PRESETS,
  formNextRuns,
  formProblems,
  formTiming,
  formToSaveInput,
  newScheduleForm,
  scheduleToForm,
  type FormField,
  type ScheduleForm,
  type TimingPreset
} from '@shared/view/schedules'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { CHAT_CHANGES_SWITCH } from '../../lib/chatPermissions'
import { adapterOfModel, isWideningMode, newRunPermissionChoices, permissionModeHelp, permissionModeName, wideningConfirmOptions, type RunModel } from '../../lib/runSettings'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { Checkbox } from '../ui/Checkbox'
import { Switch } from '../ui/Switch'
import { useConfirm } from '../ui/ConfirmDialog'
import { StartModelControl } from '../runSettings/StartModelControl'

/** Weekday checkboxes, Monday first like a work week (values are Date.getDay()). */
const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' }
]
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const FIELD_TEST_ID: Record<FormField, string> = {
  name: 'schedule-field-name',
  prompt: 'schedule-field-prompt',
  project: 'schedule-field-project',
  folder: 'schedule-field-folder',
  timing: 'schedule-field-preset',
  budget: 'schedule-field-budget'
}

/**
 * Create or edit one schedule (docs/design/schedules.md section 5) in the shared Dialog. Problems show after the first
 * Save attempt (timing problems show at once, the next runs depend on them); Save focuses the first invalid field.
 * A permission mode wider than the target's own mode is confirmed first, like the New run page. Saving never runs it.
 */
export default function ScheduleEditor({
  open,
  editing,
  onClose,
  onSaved
}: {
  open: boolean
  /** The schedule being edited; null = a new one. */
  editing: Schedule | null
  onClose: () => void
  onSaved: (saved: Schedule, created: boolean) => void
}): ReactElement {
  const allProjects = useAppStore((s) => s.projects)
  const projects = useMemo(() => allProjects.filter((p) => !isVirtualProjectId(p.id)), [allProjects])
  const selected = useAppStore((s) => s.selectedProjectId)
  const [form, setForm] = useState<ScheduleForm>(() => newScheduleForm({ now: Date.now() }))
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const { confirm, dialog: confirmDialog } = useConfirm()
  const bodyRef = useRef<HTMLDivElement>(null)
  const uid = useId()
  const id = (name: string): string => `${uid}-${name}`

  // A fresh form each time the dialog opens.
  useEffect(() => {
    if (!open) return
    const t = Date.now()
    setNow(t)
    const pid = selected && !isVirtualProjectId(selected) && projects.some((p) => p.id === selected) ? selected : projects[0]?.id
    setForm(editing ? scheduleToForm(editing, t) : newScheduleForm({ projectId: pid, now: t }))
    setTried(false)
    setSaveError(null)
    setPickError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  // The next runs stay current while the dialog is open.
  useEffect(() => {
    if (!open) return undefined
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [open])

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]): void => setForm((f) => ({ ...f, [key]: value }))
  const problems = formProblems(form, now)
  const shown = (field: FormField): string | undefined => (tried || field === 'timing' ? problems[field] : undefined)
  const timing = formTiming(form)
  const nextRuns = formNextRuns(form, now)
  const project = form.targetKind === 'team' ? projects.find((p) => p.id === form.projectId) : undefined
  const baselineMode: PermissionMode = project?.permissionMode ?? 'default'
  const modeChoices = newRunPermissionChoices().filter((m) => (SCHEDULE_PERMISSION_MODES as readonly string[]).includes(m))
  const mockProject = project?.provider.id === 'mock'
  const picked: RunModel | null = form.model
    ? { model: form.model.model, connection: form.model.connection, adapter: adapterOfModel(form.model.model, form.model.connection, undefined, mockProject), label: form.model.model }
    : null

  const browse = async (): Promise<void> => {
    setPickError(null)
    try {
      const dir = await window.orgai.projects.pickDirectory()
      if (dir) set('folder', dir)
    } catch (e) {
      setPickError(cleanIpcError(e, 'Could not open the folder chooser.'))
    }
  }

  const focusField = (field: FormField): void => {
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(`[data-testid="${FIELD_TEST_ID[field]}"]`)?.focus())
  }

  const save = async (): Promise<void> => {
    setTried(true)
    setSaveError(null)
    const t = Date.now()
    setNow(t)
    const result = formToSaveInput(form, t, editing ?? undefined)
    if (!result.ok) {
      if (result.field) focusField(result.field)
      else setSaveError(result.problem)
      return
    }
    const mode = form.permissionMode
    if (mode && mode !== editing?.permissionMode && isWideningMode(baselineMode, mode)) {
      const ok = await confirm(wideningConfirmOptions(baselineMode, mode))
      if (!ok) return
    }
    setSaving(true)
    try {
      const saved = await window.orgai.schedules.save(result.value)
      onSaved(saved, !editing)
    } catch (e) {
      setSaveError(cleanIpcError(e, 'The schedule could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  const err = (field: FormField): { invalid: boolean; describedBy?: string } => {
    const p = shown(field)
    return p ? { invalid: true, describedBy: id(`${field}-error`) } : { invalid: false }
  }
  const errorText = (field: FormField): ReactElement | null => {
    const p = shown(field)
    return p ? (
      <p className="field-error" id={id(`${field}-error`)} data-testid={`schedule-error-${field}`}>
        {p}
      </p>
    ) : null
  }

  const describedTiming = typeof timing === 'string' || problems.timing ? null : describeScheduleTiming(timing)

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={editing ? 'Edit schedule' : 'New schedule'}
        size="lg"
        testId="schedule-editor"
        footer={
          <>
            <Button onClick={onClose} testId="schedule-cancel">
              Cancel
            </Button>
            <Button variant="primary" loading={saving} disabled={saving} onClick={() => void save()} testId="schedule-save">
              {editing ? 'Save changes' : 'Save schedule'}
            </Button>
          </>
        }
      >
        <div className="schedule-form" ref={bodyRef}>
          <div className="field">
            <label htmlFor={id('name')}>Name</label>
            <Input id={id('name')} data-testid="schedule-field-name" value={form.name} maxLength={SCHEDULE_NAME_MAX_CHARS} onChange={(v) => set('name', v)} invalid={err('name').invalid} aria-describedby={err('name').describedBy} data-autofocus="" autoComplete="off" />
            {errorText('name')}
          </div>

          <div className="field">
            <label htmlFor={id('prompt')}>What to do</label>
            <Textarea
              id={id('prompt')}
              data-testid="schedule-field-prompt"
              rows={4}
              value={form.prompt}
              maxLength={SCHEDULE_PROMPT_MAX_CHARS}
              placeholder="For example: Review new pull requests and merge the ones that pass checks."
              onChange={(v) => set('prompt', v)}
              invalid={err('prompt').invalid}
              aria-describedby={err('prompt').describedBy ?? id('prompt-hint')}
            />
            <span className="hint" id={id('prompt-hint')}>
              Each run starts fresh with these instructions as its first message.
            </span>
            {errorText('prompt')}
          </div>

          <fieldset className="schedule-fieldset">
            <legend>Run as</legend>
            <div className="schedule-radios">
              <label className="schedule-radio">
                <input type="radio" name={id('target')} data-testid="schedule-field-target-team" checked={form.targetKind === 'team'} onChange={() => set('targetKind', 'team')} />
                Team run on a project
              </label>
              <label className="schedule-radio">
                <input type="radio" name={id('target')} data-testid="schedule-field-target-ask" checked={form.targetKind === 'ask'} onChange={() => set('targetKind', 'ask')} />
                Chat
              </label>
            </div>
            {form.targetKind === 'team' ? (
              <>
                <div className="field">
                  <label htmlFor={id('project')}>Project</label>
                  {projects.length === 0 ? (
                    <p className="hint" data-testid="schedule-no-projects">
                      There are no projects yet. Choose Chat, or create a project first.
                    </p>
                  ) : (
                    <select
                      id={id('project')}
                      className={`select${err('project').invalid ? ' is-invalid' : ''}`}
                      data-testid="schedule-field-project"
                      value={form.projectId}
                      aria-invalid={err('project').invalid || undefined}
                      aria-describedby={err('project').describedBy}
                      onChange={(e) => set('projectId', e.target.value)}
                    >
                      {!form.projectId && <option value="">Choose a project</option>}
                      {form.projectId && !projects.some((p) => p.id === form.projectId) && <option value={form.projectId}>A project that no longer exists</option>}
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {errorText('project')}
                </div>
                <Checkbox checked={form.single} onChange={(v) => set('single', v)} label="Run one assistant instead of the whole team" testId="schedule-field-single" />
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor={id('folder')}>Work in a folder (optional)</label>
                  <div className="schedule-folder">
                    <Input id={id('folder')} mono data-testid="schedule-field-folder" value={form.folder} placeholder="No folder (a scratch area per run)" title={form.folder || undefined} spellCheck={false} autoComplete="off" onChange={(v) => set('folder', v)} />
                    <Button size="sm" testId="schedule-field-folder-browse" onClick={() => void browse()}>
                      Browse
                    </Button>
                    {form.folder && (
                      <Button size="sm" variant="ghost" testId="schedule-field-folder-clear" onClick={() => set('folder', '')}>
                        Clear
                      </Button>
                    )}
                  </div>
                  {pickError && (
                    <p className="field-error" role="alert">
                      {pickError}
                    </p>
                  )}
                </div>
                <div className="schedule-switch-row">
                  <Switch checked={form.allowEdits} onChange={(v) => set('allowEdits', v)} label={CHAT_CHANGES_SWITCH} testId="schedule-field-allow-edits" />
                  <span aria-hidden="true">{CHAT_CHANGES_SWITCH}</span>
                </div>
              </>
            )}
          </fieldset>

          <fieldset className="schedule-fieldset">
            <legend>When</legend>
            <div className="schedule-when">
              <div className="field">
                <label htmlFor={id('preset')}>Repeat</label>
                <select
                  id={id('preset')}
                  className={`select${problems.timing ? ' is-invalid' : ''}`}
                  data-testid="schedule-field-preset"
                  value={form.preset}
                  aria-invalid={!!problems.timing || undefined}
                  aria-describedby={problems.timing ? id('timing-error') : id('next-runs')}
                  onChange={(e) => set('preset', e.target.value as TimingPreset)}
                >
                  {TIMING_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              {(form.preset === 'daily' || form.preset === 'weekdays' || form.preset === 'weekly') && (
                <div className="field">
                  <label htmlFor={id('time')}>At</label>
                  <Input id={id('time')} type="time" data-testid="schedule-field-time" value={form.time} onChange={(v) => set('time', v)} invalid={!!problems.timing} />
                </div>
              )}
              {form.preset === 'every' && (
                <>
                  <div className="field">
                    <label htmlFor={id('every')}>Every</label>
                    <Input id={id('every')} type="number" min={1} step={1} inputMode="numeric" data-testid="schedule-field-every" value={form.everyCount} onChange={(v) => set('everyCount', v)} invalid={!!problems.timing} />
                  </div>
                  <div className="field">
                    <label htmlFor={id('every-unit')}>Unit</label>
                    <select id={id('every-unit')} className="select" data-testid="schedule-field-every-unit" value={form.everyUnit} onChange={(e) => set('everyUnit', e.target.value as ScheduleForm['everyUnit'])}>
                      <option value="hours">hours</option>
                      <option value="minutes">minutes</option>
                    </select>
                  </div>
                </>
              )}
              {form.preset === 'once' && (
                <>
                  <div className="field">
                    <label htmlFor={id('once-date')}>On</label>
                    <Input id={id('once-date')} type="date" data-testid="schedule-field-once-date" value={form.onceDate} onChange={(v) => set('onceDate', v)} invalid={!!problems.timing} />
                  </div>
                  <div className="field">
                    <label htmlFor={id('once-time')}>At</label>
                    <Input id={id('once-time')} type="time" data-testid="schedule-field-once-time" value={form.onceTime} onChange={(v) => set('onceTime', v)} invalid={!!problems.timing} />
                  </div>
                </>
              )}
              {form.preset === 'custom' && (
                <div className="field schedule-cron">
                  <label htmlFor={id('cron')}>Cron expression</label>
                  <Input id={id('cron')} mono data-testid="schedule-field-cron" value={form.cron} spellCheck={false} autoComplete="off" onChange={(v) => set('cron', v)} invalid={!!problems.timing} aria-describedby={id('cron-hint')} />
                  <span className="hint" id={id('cron-hint')}>
                    Five fields in local time: minute, hour, day of month, month, day of week. At least 15 minutes apart.
                  </span>
                </div>
              )}
            </div>
            {form.preset === 'weekly' && (
              <fieldset className="schedule-days" data-testid="schedule-field-days">
                <legend>On these days</legend>
                {WEEKDAYS.map((d) => (
                  <label key={d.value} className="schedule-day">
                    <input
                      type="checkbox"
                      data-testid={`schedule-field-day-${d.value}`}
                      aria-label={WEEKDAY_NAMES[d.value]}
                      checked={form.days.includes(d.value)}
                      onChange={(e) => set('days', e.target.checked ? [...form.days, d.value] : form.days.filter((x) => x !== d.value))}
                    />
                    <span aria-hidden="true">{d.label}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {problems.timing ? (
              <p className="field-error" id={id('timing-error')} data-testid="schedule-error-timing">
                {problems.timing}
              </p>
            ) : (
              <div className="schedule-next" id={id('next-runs')} data-testid="schedule-next-runs">
                <p className="schedule-next-desc">{describedTiming}</p>
                {nextRuns.length > 0 ? (
                  <p className="hint">
                    Next runs:{' '}
                    {nextRuns.map((t, i) => (
                      <span key={t} title={formatFullDateTime(t)} data-testid="schedule-next-run">
                        {formatDateTime(t)}
                        {i < nextRuns.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </p>
                ) : (
                  <p className="hint">No upcoming runs.</p>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="schedule-fieldset">
            <legend>If OrgAI was closed at the time</legend>
            <div className="schedule-radios">
              <label className="schedule-radio">
                <input type="radio" name={id('missed')} data-testid="schedule-field-missed-run-once" checked={form.missed === 'run-once'} onChange={() => set('missed', 'run-once')} />
                Run once when OrgAI is next open
              </label>
              <label className="schedule-radio">
                <input type="radio" name={id('missed')} data-testid="schedule-field-missed-skip" checked={form.missed === 'skip'} onChange={() => set('missed', 'skip')} />
                Skip it
              </label>
            </div>
          </fieldset>

          <div className="schedule-grid">
            <div className="field" data-testid="schedule-field-model">
              <span className="field-label" id={id('model-label')}>
                Model (optional)
              </span>
              <div aria-labelledby={id('model-label')} role="group">
                <StartModelControl
                  picked={picked}
                  defaultModel={null}
                  ask={form.targetKind === 'ask'}
                  mockProject={mockProject}
                  onChange={(m) => set('model', m ? { model: m.model, connection: m.connection } : null)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor={id('permission')}>Permission mode</label>
              <select
                id={id('permission')}
                className="select"
                data-testid="schedule-field-permission"
                value={form.permissionMode}
                aria-describedby={id('permission-hint')}
                onChange={(e) => set('permissionMode', e.target.value as PermissionMode | '')}
              >
                <option value="">{form.targetKind === 'team' ? "The project's mode" : 'Chat default'}</option>
                {modeChoices.map((m) => (
                  <option key={m} value={m}>
                    {permissionModeName(m)}
                  </option>
                ))}
              </select>
              <span className="hint" id={id('permission-hint')}>
                {form.permissionMode ? `${permissionModeHelp(form.permissionMode)} ` : ''}
                {SCHEDULE_APPROVAL_NOTE}
              </span>
            </div>
            <div className="field">
              <label htmlFor={id('budget')}>Spend cap per run, USD (optional)</label>
              <Input
                id={id('budget')}
                type="number"
                min={0}
                step={0.5}
                inputMode="decimal"
                data-testid="schedule-field-budget"
                value={form.budget}
                placeholder="No cap of its own"
                onChange={(v) => set('budget', v)}
                invalid={err('budget').invalid}
                aria-describedby={err('budget').describedBy ?? id('budget-hint')}
              />
              <span className="hint" id={id('budget-hint')}>
                The run stops when it reaches the cap. Empty uses the project&apos;s own cap, if any.
              </span>
              {errorText('budget')}
            </div>
          </div>

          <p className="schedule-unattended" data-testid="schedule-unattended-note">
            {SCHEDULE_UNATTENDED_NOTE}
          </p>
          {saveError && (
            <p className="field-error" role="alert" data-testid="schedule-save-error">
              {saveError}
            </p>
          )}
        </div>
      </Dialog>
      {confirmDialog}
    </>
  )
}
