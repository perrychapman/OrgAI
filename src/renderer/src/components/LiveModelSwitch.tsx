import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ConnectionId, RunSummary } from '@shared/types'
import { resolveModelSetting } from '@shared/defaults'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { Popover } from './ui/Popover'
import { useConfirm } from './ui/ConfirmDialog'
import { ModelPickerList, focusSearchWhenOpen, useModelCatalog } from './runSettings/ModelPickerList'
import { connectionLabel } from '../lib/connectionLabel'
import { useAppStore } from '../store/useAppStore'
import { LIVE_MODEL_HELP_ASSISTANT, LIVE_MODEL_HELP_TEAM } from '../lib/runSettings'
import { liveModelLabel, modelKey, modelSessionEnded, needsModelHandoff, performModelSwitch } from '../lib/liveModelSwitch'
import '../styles/live-model-switch.css'
import '../styles/run-settings.css'

/**
 * The live run's model picker. `className` adds a class to the wrapper; `inRow` drops the standalone bar padding and
 * background so the chip can sit inside a RunSettingsRow.
 */
export function LiveModelSwitch({ run, onRunChanged, className, inRow }: { run: RunSummary; onRunChanged: (run: RunSummary) => void; className?: string; inRow?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const catalog = useModelCatalog(open)
  const { models, loading } = catalog
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState('')
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [requiresHandoff, setRequiresHandoff] = useState(false)
  const epoch = useRef(0)
  const region = useRef<HTMLSpanElement>(null)
  const confirming = useRef(false)
  const reopening = useRef(false)
  const focusSearch = useCallback((node: HTMLInputElement | null) => {
    if (!node) return
    const operation = epoch.current
    // Presence mounts children after the native toggle and positioning pass.
    return focusSearchWhenOpen(node, () => epoch.current === operation)
  }, [])
  useEffect(() => () => { epoch.current++ }, [])
  const { confirm, dialog } = useConfirm()
  const applied = run.modelSelection
  const cachedModels = useAppStore((state) => applied ? state.models[applied.connection] : undefined)
  const refreshModels = useAppStore((state) => state.loadModels)
  useEffect(() => { if (applied && !cachedModels) void refreshModels(applied.connection) }, [applied?.connection, cachedModels, refreshModels])
  const name = (connection: ConnectionId): string => connectionLabel(connection)
  const selected = models.find((model) => modelKey(model.connection, model.id) === choice)
  const connections = useAppStore((state) => state.connections)
  const knownModels = cachedModels ?? models
  // A run can hold a tier alias ("everyday", "deep") as its model: show the model that alias maps to, with the catalog's
  // friendly label, and keep the exact setting in the title (aria-label) so nothing is hidden.
  const resolvedId = applied
    ? (resolveModelSetting(applied.model, { connection: applied.connection, tierModels: connections?.find((c) => c.connection.id === applied.connection)?.connection.tierModels ?? {}, catalog: knownModels })?.model ?? applied.model)
    : ''
  const currentModel = knownModels.find((model) => applied && model.id === applied.model && model.connection === applied.connection)
    ?? knownModels.find((model) => applied && model.id === resolvedId && model.connection === applied.connection)
  const current = applied ? `${currentModel?.label || applied.model} · ${name(applied.connection)}` : 'Current model unavailable'
  const exactTitle = applied ? `${liveModelLabel(applied.model, applied.connection)}${resolvedId && resolvedId !== applied.model && resolvedId !== 'inherit' ? ` (${resolvedId})` : ''}` : current
  const nextMessage = modelSessionEnded(run)
  // Only a team run has other roles that could follow the lead's model.
  const teamRun = run.kind === 'work' && !run.quick && run.team !== 'single'
  const handoff = !!selected && !nextMessage && (requiresHandoff || needsModelHandoff(run, selected))
  const unchanged = !!selected && selected.id === applied?.model && selected.connection === applied.connection

  const apply = async (close: () => void): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    setError('')
    let stopped = false
    const operation = epoch.current
    const reopen = (): void => {
      if (epoch.current !== operation) return
      if (region.current?.querySelector('[data-testid="live-model-picker"]')?.matches(':popover-open')) return
      reopening.current = true
      region.current?.querySelector<HTMLButtonElement>('[data-testid="live-model-change"]')?.click()
    }
    try {
      const result = await performModelSwitch({
        run, selected, handoff: requiresHandoff, valid: () => epoch.current === operation, pause,
        stopped: () => { stopped = true },
        confirm: async () => {
          // A native modal dismisses sibling auto popovers. This deliberate transition
          // keeps the captured operation; ordinary Escape/light dismiss still cancels it.
          confirming.current = true
          const accepted = await confirm({ title: 'End this session and switch model?', body: 'Your conversation stays here. The new session receives a transcript handoff that may omit older or oversized text. Provider session memory and session-only permissions do not transfer. Your draft stays unsent. Send when you are ready to continue.', confirmLabel: 'End session and select model', confirmTestId: 'live-model-confirm' })
          confirming.current = false
          if (!accepted) reopen()
          return accepted
        },
        api: {
          read: () => window.orgai.runs.get(run.id), cards: () => window.orgai.runs.pendingCards(run.id),
          live: () => window.orgai.runs.listLive(), stop: () => window.orgai.runs.stop(run.id),
          interrupt: () => window.orgai.runs.interrupt(run.id),
          switch: () => window.orgai.runs.switchModel({ runId: run.id, expectedRunId: run.id, connection: selected.connection, model: selected.id })
        }
      })
      if (!result || epoch.current !== operation) return
      if (result.run.id !== run.id) throw new Error(result.reason || 'This conversation continued elsewhere. Open its latest session before changing models.')
      onRunChanged(result.run)
      if (!result.applied && !(modelSessionEnded(result.run) && result.run.modelSelection?.model === selected.id && result.run.modelSelection.connection === selected.connection)) {
        if (result.reason?.includes('transcript handoff')) setRequiresHandoff(true)
        throw new Error(result.reason || 'The model could not be changed.')
      }
      setAnnouncement(result.applied ? `Model changed to ${liveModelLabel(selected.id, selected.connection)}.` : 'Model selected for the next message. Your draft is unsent.')
      close()
      region.current?.querySelector<HTMLButtonElement>('[data-testid="live-model-change"]')?.focus()
    } catch (e: unknown) {
      if (epoch.current !== operation) return
      const record = await window.orgai.runs.get(run.id).catch(() => null)
      if (epoch.current !== operation) return
      if (record) { onRunChanged(record.summary); stopped ||= !modelSessionEnded(run) && modelSessionEnded(record.summary) }
      setError(`${stopped ? 'The session ended, but the model was not selected. ' : ''}${message(e)}`)
      if (handoff) reopen()
    } finally { setBusy(false) }
  }

  return <span ref={region} className={`live-model-switch${inRow ? ' live-model-switch--in-row' : ''}${className ? ` ${className}` : ''}`} data-testid="live-model-switch" aria-busy={busy}>
    <Popover placement="top-start" label="Choose conversation model" triggerTestId="live-model-change" testId="live-model-picker" className="live-model-switch__picker"
      triggerClassName="run-chip live-model-switch__trigger" triggerTitle={exactTitle}
      triggerLabel={`${busy ? 'Changing model. ' : ''}Conversation model: ${nextMessage ? 'Next message: ' : ''}${current}${applied ? ` (${applied.model})` : ''}`}
      trigger={<><span className="run-chip__label">Model:</span><span className="run-chip__value" data-testid="live-model-current">{busy ? 'Changing model…' : <>{nextMessage && 'Next message: '}{current}</>}</span><Icon icon={ChevronDown} size="xs" /></>}
      onOpenChange={(value) => { if (!value && !confirming.current) epoch.current++; setOpen(value); if (value) { if (reopening.current) { reopening.current = false; return }; setQuery(''); setChoice(applied ? modelKey(applied.connection, applied.model) : ''); setError(''); setRequiresHandoff(false) } }}>
      {({ close }) => <>
        <ModelPickerList testIdPrefix="live-model" catalog={catalog} query={query} onQuery={setQuery} choice={choice} disabled={busy} searchRef={focusSearch} onEscape={close}
          current={applied ?? null} currentText={current}
          onChoose={(model) => { setChoice(modelKey(model.connection, model.id)); setError(''); setRequiresHandoff(false) }} />
        <div className="live-model-switch__footer">
          <p data-testid="live-model-help">{teamRun ? LIVE_MODEL_HELP_TEAM : LIVE_MODEL_HELP_ASSISTANT}</p>
          {selected && !unchanged && <p data-testid="live-model-pending">{handoff ? 'Starts a new session with a transcript handoff. Your draft stays unsent.' : run.status === 'running' ? 'Interrupts the current reply, then switches when idle.' : nextMessage ? 'Your next message uses this selection.' : 'Selection not applied yet.'}</p>}
          <p className="live-model-switch__error" role="alert" data-testid="live-model-error">{error}</p>
          <div className="live-model-switch__actions">
            <Button size="sm" variant="primary" loading={busy} disabled={!selected || unchanged || loading} onClick={() => void apply(close)} testId="live-model-apply">{handoff ? 'Review switch' : nextMessage ? 'Use for next message' : run.status === 'running' ? 'Interrupt and switch' : 'Use model'}</Button>
            <Button size="sm" disabled={busy} onClick={close} testId="live-model-cancel">Cancel</Button>
          </div>
        </div>
      </>}
    </Popover>
    <span className="sr-only" role="status" data-testid="live-model-status">{announcement}</span>
    {dialog}
  </span>
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))
function message(error: unknown): string { return error instanceof Error && error.message ? error.message : 'Please try again.' }
