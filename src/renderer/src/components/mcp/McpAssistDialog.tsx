import type { ReactElement } from 'react'
import { useState } from 'react'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Textarea } from '../ui/Textarea'
import { errMessage } from './mcpHelpers'
import { modelDisplayName, useAssistantModel } from '../../lib/assistantModels'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { useAppStore } from '../../store/useAppStore'

/** "Configure with AI": one instruction field that starts an assistant run. `onStart` does the starting. */
export default function McpAssistDialog({
  open,
  onClose,
  onStart,
  title,
  description,
  placeholder
}: {
  open: boolean
  onClose: () => void
  onStart: (instruction: string) => Promise<void>
  title: string
  description: string
  placeholder: string
}): ReactElement {
  const model = useAssistantModel('mcpAssistModel')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onStart(text.trim())
      setText('')
      onClose()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void start()}>
            Start assistant run
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not start the assistant">
          {error}
        </Banner>
      )}
      <div className="field mcp-field">
        <label htmlFor="mcp-assist-text">What should agents be able to do?</label>
        <Textarea id="mcp-assist-text" data-autofocus maxLength={2000} rows={4} value={text} placeholder={placeholder} onChange={setText} />
      </div>
      <p className="muted" data-testid="mcp-assist-model-hint">
        Runs on {modelDisplayName(model)}.{' '}
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            requestAppSettingsSection(APP_SETTINGS_SECTIONS.defaults)
            onClose()
            useAppStore.getState().setView('appSettings')
            // Already on App settings (the library pane): tell the mounted page to switch panes.
            window.dispatchEvent(new Event('orgai:settings-section'))
          }}
        >
          Change in App settings &gt; Defaults
        </button>
      </p>
    </Dialog>
  )
}
