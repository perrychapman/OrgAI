import type { ReactElement } from 'react'
import { useState } from 'react'
import type { ProxyKind } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { cleanIpcError } from '../../lib/ipcError'
import { PROXY_KIND_OPTIONS, kindHint, takenNames, validateProxyForm } from '../../lib/proxyForm'
import type { ProxyFormValues } from '../../lib/proxyForm'
import { ProxyFields } from './ProxyFields'

/** What the dialog reports when it is done: the new proxy's id and name, and whether Test and connect succeeded. */
export interface ProxyAdded {
  id: string
  name: string
  connected: boolean
  detail?: string
}

/** The form state lives in the inner component, so it (and the typed key) is dropped whenever the dialog closes. */
function AddProxyForm({ taken, onClose, onAdded }: { taken: string[]; onClose: () => void; onAdded: (a: ProxyAdded) => void }): ReactElement {
  const setInfo = useAppStore((s) => s.setConnectionInfo)
  const loadModels = useAppStore((s) => s.loadModels)
  const [values, setValues] = useState<ProxyFormValues>({ name: '', kind: 'litellm', anthropicBaseUrl: '', openaiBaseUrl: '', modelsUrl: '' })
  const [apiKey, setApiKey] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const errors = validateProxyForm(values, taken)
  const shown = showErrors ? errors : {}

  const submit = async (): Promise<void> => {
    setShowErrors(true)
    setFailure(null)
    if (Object.keys(errors).length > 0) return
    setBusy(true)
    let id = ''
    try {
      const created = await window.orgai.connections.createProxy({
        name: values.name.trim(),
        kind: values.kind,
        anthropicBaseUrl: values.anthropicBaseUrl.trim(),
        ...(values.openaiBaseUrl.trim() ? { openaiBaseUrl: values.openaiBaseUrl.trim() } : {}),
        ...(values.modelsUrl.trim() ? { modelsUrl: values.modelsUrl.trim() } : {}),
        ...(apiKey ? { apiKey } : {})
      })
      id = created.connection.id
      setInfo(created)
    } catch (e) {
      // Main's message is shown plainly; nothing was created.
      setFailure(cleanIpcError(e))
      setBusy(false)
      return
    }
    setApiKey('')
    let added: ProxyAdded = { id, name: values.name.trim(), connected: false }
    try {
      const next = await window.orgai.connections.connect(id)
      setInfo(next)
      added = { ...added, connected: next.status.state === 'connected', detail: next.status.detail }
      if (next.status.state === 'connected') void loadModels(id, true)
    } catch (e) {
      added = { ...added, detail: cleanIpcError(e) }
    }
    setBusy(false)
    onAdded(added)
  }

  return (
    <form
      className="conn-auth proxy-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      noValidate
    >
      <div className="field">
        <label htmlFor="proxy-kind">Kind</label>
        <Select
          id="proxy-kind"
          value={values.kind}
          options={PROXY_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          describedBy="proxy-kind-hint"
          onChange={(v) => setValues((s) => ({ ...s, kind: v as ProxyKind }))}
        />
        <span className="hint" id="proxy-kind-hint">
          {kindHint(values.kind)}
        </span>
      </div>
      <ProxyFields autofocusName prefix="add-proxy" values={values} errors={shown} onChange={(p) => setValues((s) => ({ ...s, ...p }))} />
      <div className="field">
        <label htmlFor="add-proxy-key">API key (optional)</label>
        <Input
          id="add-proxy-key"
          data-testid="proxy-key"
          type="password"
          mono
          autoComplete="off"
          spellCheck={false}
          aria-label={`API key for ${values.name.trim() || 'the new proxy'}`}
          value={apiKey}
          onChange={setApiKey}
          aria-describedby="add-proxy-key-hint"
        />
        <span className="hint" id="add-proxy-key-hint">
          Stored encrypted on this machine. It is never shown again.
        </span>
      </div>
      {failure && (
        <Banner tone="danger" title="Could not add the proxy" testId="proxy-add-error">
          {failure}
        </Banner>
      )}
      <div className="proxy-form-foot">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={busy} testId="proxy-submit">
          Add proxy
        </Button>
      </div>
    </form>
  )
}

export default function AddProxyDialog({
  open,
  onClose,
  existingNames,
  onAdded
}: {
  open: boolean
  onClose: () => void
  existingNames: string[]
  onAdded: (a: ProxyAdded) => void
}): ReactElement {
  return (
    <Dialog open={open} onClose={onClose} title="Add proxy" description="Route Claude, GPT and other models through a gateway you run." size="md" testId="proxy-dialog">
      <AddProxyForm taken={takenNames(existingNames)} onClose={onClose} onAdded={onAdded} />
    </Dialog>
  )
}
