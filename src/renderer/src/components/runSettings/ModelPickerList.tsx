import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import type { ConnectionId, ConnectionInfo, ProviderModel } from '@shared/types'
import { Button } from '../ui/Button'
import { connectionLabel } from '../../lib/connectionLabel'
import { filterLiveModels, modelKey } from '../../lib/liveModelSwitch'
import '../../styles/live-model-switch.css'

/** The catalog a model picker lists: every connected connection's models, loaded while `open`. */
export interface ModelCatalog {
  connections: ConnectionInfo[]
  models: ProviderModel[]
  loading: boolean
  /** Plain-language reason when a connection or catalog could not be loaded; empty when fine. */
  error: string
  /** Load again (the "Retry loading" button). */
  retry: () => void
}

const messageOf = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Please try again.')

/**
 * Loads connections and their model catalogs each time a picker opens, and again on retry. Shared by the live model
 * switch and the start page's model chip so both list exactly the same choices.
 */
export function useModelCatalog(open: boolean): ModelCatalog {
  const [connections, setConnections] = useState<ConnectionInfo[]>([])
  const [models, setModels] = useState<ProviderModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setModels([])
    setConnections([])
    setError('')
    void window.orgai.connections
      .list()
      .then(async (list) => {
        if (!active) return
        setConnections(list)
        const connected = list.filter((item) => item.status.state === 'connected')
        const results = await Promise.allSettled(connected.map((item) => window.orgai.models.list({ connection: item.connection.id })))
        if (!active) return
        setModels(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])))
        const failed = results.flatMap((result, index) => (result.status === 'rejected' ? [connectionLabel(connected[index].connection.id)] : []))
        if (failed.length) setError(`Could not load models from ${failed.join(', ')}. Retry loading to see those models.`)
      })
      .catch((e: unknown) => {
        if (active) setError(`Could not load connections: ${messageOf(e)}`)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, reload])
  const retry = useCallback(() => setReload((n) => n + 1), [])
  return { connections, models, loading, error, retry }
}

/**
 * Focus the search box once the popover is really open. The popover mounts its children after the native toggle and the
 * positioning pass, so a plain autoFocus would run too early. Returns the cleanup for a ref callback.
 */
export function focusSearchWhenOpen(node: HTMLInputElement, valid: () => boolean = () => true): () => void {
  const frame = requestAnimationFrame(() => {
    if (valid() && node.isConnected && node.closest(':popover-open')) node.focus()
  })
  return () => cancelAnimationFrame(frame)
}

/**
 * Search box plus the radio list of models grouped by connection (friendly label, exact id under it), with the loading,
 * empty and retry states. It holds no selection logic: the caller owns `choice` (a modelKey) and what choosing means.
 * Test ids: `${testIdPrefix}-search`, `-list`, `-choice` (value = model id, data-connection, data-adapter).
 */
export function ModelPickerList({
  testIdPrefix,
  catalog,
  query,
  onQuery,
  choice,
  onChoose,
  current,
  currentWord = 'Current',
  currentText,
  disabled,
  searchRef,
  onEscape
}: {
  testIdPrefix: string
  catalog: ModelCatalog
  query: string
  onQuery: (value: string) => void
  /** modelKey(connection, model) of the checked radio; '' when none. */
  choice: string
  onChoose: (model: ProviderModel) => void
  /** The selection the list marks ("Current", "Default"); null when unknown. */
  current: { model: string; connection: ConnectionId } | null
  currentWord?: string
  /** The words for `current` in the line above the list ("Opus · Anthropic"). */
  currentText: string
  disabled?: boolean
  searchRef?: (node: HTMLInputElement | null) => void | (() => void)
  /** Escape in the search box (the popover's close). */
  onEscape: () => void
}): ReactElement {
  const id = useId()
  const { connections, models, loading, error, retry } = catalog
  const available = filterLiveModels(models, query, connectionLabel)
  const groups = [...new Set(available.map((model) => model.connection))]
  const isCurrent = (model: string, connection: ConnectionId): boolean => !!current && current.model === model && current.connection === connection
  const suffix =
    current && !loading
      ? !connections.some((item) => item.connection.id === current.connection && item.status.state === 'connected')
        ? ' (connection unavailable)'
        : !models.some((model) => model.id === current.model && model.connection === current.connection)
          ? ' (not in the available catalog)'
          : ''
      : ''
  return (
    <>
      <label htmlFor={`${id}-search`}>Search models</label>
      <input
        ref={searchRef}
        id={`${id}-search`}
        className="input"
        type="search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onEscape()
          }
        }}
        data-testid={`${testIdPrefix}-search`}
      />
      <p className="live-model-switch__current">
        {currentWord}: {currentText}
        {suffix}
      </p>
      <div className="live-model-switch__list" data-testid={`${testIdPrefix}-list`} aria-busy={loading}>
        {loading ? (
          <p>Loading models…</p>
        ) : (
          groups.map((connection) => (
            <fieldset key={connection}>
              <legend>
                {connectionLabel(connection)} <span className="live-model-switch__id">{connection}</span>
              </legend>
              {available
                .filter((model) => model.connection === connection)
                .map((model) => (
                  <label className="live-model-switch__option" key={modelKey(connection, model.id)}>
                    <input
                      type="radio"
                      name={`${id}-model`}
                      value={model.id}
                      checked={choice === modelKey(connection, model.id)}
                      disabled={disabled}
                      data-testid={`${testIdPrefix}-choice`}
                      data-connection={connection}
                      data-adapter={model.adapter}
                      onChange={() => onChoose(model)}
                    />
                    <span>
                      <span>
                        {model.label || model.id}
                        {isCurrent(model.id, connection) ? ` · ${currentWord}` : ''}
                      </span>
                      {model.label && model.label !== model.id && <span className="live-model-switch__id">{model.id}</span>}
                    </span>
                  </label>
                ))}
            </fieldset>
          ))
        )}
        {!loading && !available.length && (
          <p>
            {query
              ? 'No models match your search.'
              : connections.some((item) => item.status.state === 'connected')
                ? 'No models available on connected connections.'
                : 'No connection is connected. Connect one in App settings, then retry loading.'}
          </p>
        )}
      </div>
      {error && <p className="live-model-switch__error">{error}</p>}
      {(error || (!loading && !models.length)) && (
        <Button size="sm" disabled={disabled || loading} onClick={retry}>
          Retry loading
        </Button>
      )}
    </>
  )
}
