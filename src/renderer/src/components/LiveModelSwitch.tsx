import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
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
  const region = useRef<HTMLElement>(null)
  const wasOpen = useRef(false)
  const editorHeading = useRef<HTMLParagraphElement>(null)
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
    if (open) editorHeading.current?.focus()
    else if (wasOpen.current) region.current?.querySelector<HTMLButtonElement>('[data-testid="live-model-change"]')?.focus()
    wasOpen.current = open
  }, [open])

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
        if (result.run.modelSelection?.model === model && result.run.modelSelection.connection === connection) {
          setOpen(false)
          setStatus(result.reason || 'Model selected for the next message. Send to continue this conversation.')
        } else setError(`${result.reason || 'The model could not be changed.'} ${connection !== run.connection ? 'End this session, then apply the selection and send your next message to continue.' : 'Wait until the current reply ends, or interrupt it, then retry. You can also choose another model.'}`)
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
    <section ref={region} className="live-model-switch" data-testid="live-model-switch" aria-label="Conversation model">
      <div className="live-model-switch__summary">
        <span data-testid="live-model-current">{applied ? `${['paused', 'error', 'finished'].includes(run.status) ? 'Next message:' : 'Using'} ${liveModelLabel(applied.model, applied.connection)}` : 'Current model unavailable'}</span>
        {!open && <Button size="sm" onClick={startEditing} testId="live-model-change">Change model</Button>}
      </div>
      {open && <div className="live-model-switch__editor">
        <p ref={editorHeading} tabIndex={-1}>Use the selected model for the next message in this conversation. Other agents and defaults stay the same.</p>
        {connection && connection !== (applied?.connection ?? run.connection) && <span>Changing connections starts a new session with a transcript handoff. Earlier conversation stays here; provider session memory does not transfer.</span>}
        <div data-testid="live-model-connection">
          <label htmlFor={connectionId}>Connection</label>
          <Select id={connectionId} value={connection} disabled={busy || !connections} onChange={(value) => { setConnection(value as ConnectionId); setModel(''); setError('') }} options={[
            { value: '', label: 'Choose a connection', disabled: true },
            ...(connection && !connected.some((item) => item.connection.id === connection) ? [{ value: connection, label: `${connectionLabel(connection)} (unavailable)`, disabled: true }] : []),
            ...connected.map((item) => ({ value: item.connection.id, label: connectionLabel(item.connection.id) }))
          ]} />
        </div>
        <ModelSelect label="Model" value={model} groups={[{ options: choices }]} placeholder="Choose a model" disabled={busy || !models || !choices.length} onChange={(value) => { setModel(value); setError('') }} testId="live-model-choice" />
        {model && !unchanged && <span data-testid="live-model-pending">Selection not applied yet.</span>}
        {models && choices.length === 0 && <span>No models available on this connection.</span>}
        {(catalogError || (connections && connected.length === 0)) && <Button size="sm" onClick={() => setReload((n) => n + 1)}>Retry loading</Button>}
        <div className="live-model-switch__actions">
          <Button size="sm" variant="primary" loading={busy} disabled={!connection || !connected.some((item) => item.connection.id === connection) || !model || !choices.some((item) => item.value === model) || unchanged} onClick={() => void apply()} testId="live-model-apply">Apply model</Button>
          <Button size="sm" disabled={busy || run.status !== 'running'} testId="live-model-interrupt" onClick={() => {
            setBusy(true)
            void window.orgai.runs.interrupt(run.id).then(() => {
              setError('')
              setStatus('Reply interrupted. Apply your selected model when the conversation is idle.')
            }, (e: unknown) => setError(`Could not interrupt: ${message(e)}`)).finally(() => {
              setBusy(false)
              editorHeading.current?.focus()
            })
          }}>Interrupt current reply</Button>
          {connection && connection !== run.connection && <Button size="sm" disabled={busy || !['starting', 'running', 'idle'].includes(run.status)} testId="live-model-end-session" onClick={() => {
            setBusy(true)
            void window.orgai.runs.stop(run.id).then(() => {
              setError('')
              setStatus('Session ended. Apply the selected model, then send your next message to continue with a transcript handoff.')
            }, (e: unknown) => setError(`Could not end session: ${message(e)}`)).finally(() => {
              setBusy(false)
              editorHeading.current?.focus()
            })
          }}>End session to change connection</Button>}
          <Button size="sm" disabled={busy} onClick={() => { setOpen(false); setError('') }} testId="live-model-cancel">Cancel</Button>
        </div>
      </div>}
      <div role="status" data-testid="live-model-status"><span className="live-model-switch__error" data-testid="live-model-error">{error || catalogError}</span>{!error && !catalogError && (status || (open && connections && connected.length === 0 ? 'No connection is connected. Connect one in App settings, then retry loading.' : ''))}</div>
    </section>
  )
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Please try again.'
}
