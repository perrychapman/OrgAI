import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { ConnectionId, ConnectionInfo, ProviderModel, RunSummary } from '@shared/types'
import { Button } from './ui/Button'
import { ModelSelect } from './ui/ModelSelect'
import { Select } from './ui/Select'
import { connectionLabel } from '../lib/connectionLabel'
import { liveModelLabel, liveModelOptions } from '../lib/liveModelSwitch'
import '../styles/live-model-switch.css'

/** The selection affects only the root of this conversation, at a safe boundary. */
export function LiveModelSwitch({ run, onRunChanged }: { run: RunSummary; onRunChanged: (run: RunSummary) => void }): ReactElement {
  const connectionId = useId()
  const [open, setOpen] = useState(false)
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null)
  const [connection, setConnection] = useState<ConnectionId | ''>('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<ProviderModel[] | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const applied = run.modelSelection

  useEffect(() => {
    if (!open) return
    let active = true
    setCatalogError('')
    void window.orgai.connections.list().then((list) => {
      if (active) setConnections(list)
    }, (e: unknown) => {
      if (active) setCatalogError(`Could not load connections: ${message(e)}`)
    })
    return () => { active = false }
  }, [open, reload])

  useEffect(() => {
    if (!open || !connection) return
    let active = true
    setModels(null)
    setCatalogError('')
    void window.orgai.models.list({ connection }).then((list) => {
      if (active) setModels(list)
    }, (e: unknown) => {
      if (active) setCatalogError(`Could not load models: ${message(e)}`)
    })
    return () => { active = false }
  }, [open, connection, reload])

  const startEditing = (): void => {
    setConnection(applied?.connection ?? run.connection ?? '')
    setModel(applied?.model ?? '')
    setError('')
    setStatus('')
    setOpen(true)
  }
  const apply = async (): Promise<void> => {
    if (!connection || !model || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.orgai.runs.switchModel({ runId: run.id, connection, model })
      onRunChanged(result.run)
      if (!result.applied) {
        setError(`${result.reason || 'The model could not be changed.'} Try again or choose another model.`)
      } else {
        setOpen(false)
        setStatus(`Model changed to ${liveModelLabel(model, connection)} for the next message.`)
      }
    } catch (e: unknown) {
      setError(`Could not change model: ${message(e)} Try again or choose another model.`)
    } finally {
      setBusy(false)
    }
  }
  const choices = connection && models ? liveModelOptions(models, connection) : []
  const connected = (connections ?? []).filter((item) => item.status.state === 'connected')
  const unchanged = applied?.connection === connection && applied.model === model

  return (
    <section className="live-model-switch" data-testid="live-model-switch" aria-label="Conversation model">
      <div className="live-model-switch__summary">
        <span data-testid="live-model-current">{applied ? `Using ${liveModelLabel(applied.model, applied.connection)}` : 'Current model unavailable'}</span>
        {!open && <Button size="sm" onClick={startEditing} testId="live-model-change">Change model</Button>}
      </div>
      {open && <div className="live-model-switch__editor">
        <span>Use the selected model for the next message in this conversation. Other agents and defaults stay the same.</span>
        <div data-testid="live-model-connection">
          <label htmlFor={connectionId}>Connection</label>
          <Select id={connectionId} value={connection} disabled={busy || !connections} onChange={(value) => { setConnection(value as ConnectionId); setModel(''); setError('') }} options={[
            { value: '', label: 'Choose a connection', disabled: true },
            ...(connection && !connected.some((item) => item.connection.id === connection) ? [{ value: connection, label: `${connectionLabel(connection)} (unavailable)`, disabled: true }] : []),
            ...connected.map((item) => ({ value: item.connection.id, label: connectionLabel(item.connection.id) }))
          ]} />
        </div>
        <ModelSelect label="Model" value={model} groups={[{ options: choices }]} placeholder="Choose a model" disabled={busy || !models || !choices.length} onChange={(value) => { setModel(value); setError('') }} testId="live-model-choice" />
        {models && choices.length === 0 && <span>No models available on this connection.</span>}
        {catalogError && <div className="live-model-switch__error">{catalogError} <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry loading</Button></div>}
        <div className="live-model-switch__actions">
          <Button size="sm" variant="primary" loading={busy} disabled={!connection || !model || !choices.some((item) => item.value === model) || unchanged} onClick={() => void apply()} testId="live-model-apply">Apply model</Button>
          <Button size="sm" disabled={busy} onClick={() => { setOpen(false); setError('') }} testId="live-model-cancel">Cancel</Button>
        </div>
      </div>}
      <div role="status" data-testid="live-model-status"><span className="live-model-switch__error" data-testid="live-model-error">{error}</span>{!error && status}</div>
    </section>
  )
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Please try again.'
}
