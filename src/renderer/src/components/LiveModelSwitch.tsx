import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ConnectionId, ConnectionInfo, ProviderModel, RunSummary } from '@shared/types'
import { Button } from './ui/Button'
import { Popover } from './ui/Popover'
import { useConfirm } from './ui/ConfirmDialog'
import { connectionLabel } from '../lib/connectionLabel'
import { useAppStore } from '../store/useAppStore'
import { filterLiveModels, liveModelLabel, modelKey, modelSessionEnded, needsModelHandoff, performModelSwitch } from '../lib/liveModelSwitch'
import '../styles/live-model-switch.css'

export function LiveModelSwitch({ run, onRunChanged }: { run: RunSummary; onRunChanged: (run: RunSummary) => void }): ReactElement {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [models, setModels] = useState<ProviderModel[]>([])
  const [loading, setLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState('')
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [requiresHandoff, setRequiresHandoff] = useState(false)
  const epoch = useRef(0)
  const region = useRef<HTMLSpanElement>(null)
  const confirming = useRef(false)
  const reopening = useRef(false)
  const focusSearch = useCallback((node: HTMLInputElement | null) => {
    if (!node) return
    const operation = epoch.current
    // Presence mounts children after the native toggle and positioning pass.
    const frame = requestAnimationFrame(() => {
      if (epoch.current === operation && node.isConnected && node.closest(':popover-open')) node.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => () => { epoch.current++ }, [])
  const { confirm, dialog } = useConfirm()
  const applied = run.modelSelection
  const cachedModels = useAppStore((state) => applied ? state.models[applied.connection] : undefined)
  const refreshModels = useAppStore((state) => state.loadModels)
  useEffect(() => { if (applied && !cachedModels) void refreshModels(applied.connection) }, [applied?.connection, cachedModels, refreshModels])
  const name = (connection: ConnectionId): string => connectionLabel(connection)
  const selected = models.find((model) => modelKey(model.connection, model.id) === choice)
  const currentModel = (cachedModels ?? models).find((model) => model.id === applied?.model && model.connection === applied.connection)
  const current = applied ? `${currentModel?.label || applied.model} · ${name(applied.connection)}` : 'Current model unavailable'
  const nextMessage = modelSessionEnded(run)
  const handoff = !!selected && !nextMessage && (requiresHandoff || needsModelHandoff(run, selected))
  const unchanged = !!selected && selected.id === applied?.model && selected.connection === applied.connection
  const available = filterLiveModels(models, query, name)
  const groups = [...new Set(available.map((model) => model.connection))]

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setModels([])
    setConnections([])
    setCatalogError('')
    void window.orgai.connections.list().then(async (list) => {
      if (!active) return
      setConnections(list)
      const connected = list.filter((item) => item.status.state === 'connected')
      const results = await Promise.allSettled(connected.map((item) => window.orgai.models.list({ connection: item.connection.id })))
      if (!active) return
      setModels(results.flatMap((result) => result.status === 'fulfilled' ? result.value : []))
      const failed = results.flatMap((result, index) => result.status === 'rejected' ? [name(connected[index].connection.id)] : [])
      if (failed.length) setCatalogError(`Could not load models from ${failed.join(', ')}. Retry loading to see those models.`)
    }).catch((e: unknown) => { if (active) setCatalogError(`Could not load connections: ${message(e)}`) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, reload])

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

  return <span ref={region} className="live-model-switch" data-testid="live-model-switch" aria-busy={busy}>
    <Popover placement="top-start" label="Choose conversation model" triggerTestId="live-model-change" testId="live-model-picker" className="live-model-switch__picker"
      triggerClassName="btn ghost sm live-model-switch__trigger" triggerTitle={applied ? liveModelLabel(applied.model, applied.connection) : current}
      triggerLabel={`${busy ? 'Changing model. ' : ''}Conversation model: ${nextMessage ? 'Next message: ' : ''}${current}${applied ? ` (${applied.model})` : ''}`}
      trigger={<span data-testid="live-model-current">{busy ? 'Changing model…' : <>{nextMessage && 'Next message: '}{current}</>}</span>}
      onOpenChange={(value) => { if (!value && !confirming.current) epoch.current++; setOpen(value); if (value) { setReload((n) => n + 1); if (reopening.current) { reopening.current = false; return }; setQuery(''); setChoice(applied ? modelKey(applied.connection, applied.model) : ''); setError(''); setRequiresHandoff(false) } }}>
      {({ close }) => <>
        <label htmlFor={`${id}-search`}>Search models</label>
        <input ref={focusSearch} id={`${id}-search`} className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }} data-testid="live-model-search" />
        <p className="live-model-switch__current">Current: {current}{applied && !loading && !connections.some((item) => item.connection.id === applied.connection && item.status.state === 'connected') ? ' (connection unavailable)' : applied && !loading && !models.some((model) => model.id === applied.model && model.connection === applied.connection) ? ' (not in the available catalog)' : ''}</p>
        <div className="live-model-switch__list" data-testid="live-model-list" aria-busy={loading}>
          {loading ? <p>Loading models…</p> : groups.map((connection) => <fieldset key={connection}>
            <legend>{name(connection)} <span className="live-model-switch__id">{connection}</span></legend>
            {available.filter((model) => model.connection === connection).map((model) => <label className="live-model-switch__option" key={modelKey(connection, model.id)}>
              <input type="radio" name={`${id}-model`} value={model.id} checked={choice === modelKey(connection, model.id)} disabled={busy} data-testid="live-model-choice" data-connection={connection} data-adapter={model.adapter} onChange={() => { setChoice(modelKey(connection, model.id)); setError(''); setRequiresHandoff(false) }} />
              <span><span>{model.label || model.id}{applied?.model === model.id && applied.connection === connection ? ' · Current' : ''}</span>{model.label && model.label !== model.id && <span className="live-model-switch__id">{model.id}</span>}</span>
            </label>)}
          </fieldset>)}
          {!loading && !available.length && <p>{query ? 'No models match your search.' : connections.some((item) => item.status.state === 'connected') ? 'No models available on connected connections.' : 'No connection is connected. Connect one in App settings, then retry loading.'}</p>}
        </div>
        {catalogError && <p className="live-model-switch__error">{catalogError}</p>}
        {(catalogError || (!loading && !models.length)) && <Button size="sm" disabled={busy || loading} onClick={() => setReload((n) => n + 1)}>Retry loading</Button>}
        <div className="live-model-switch__footer">
          <p>Applies to this conversation’s lead agent.</p>
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
