import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { AppSettings, AppSettingsInfo, PermissionMode } from '@shared/types'
import { CLAUDE_MODEL_OPTIONS, DEFAULT_KEEP_RUNS, PERMISSION_MODE_OPTIONS } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import ProviderAuthPicker from '../components/ProviderAuthPicker'

/** Same debounce the project store uses for project saves. */
const SAVE_DELAY_MS = 350

export default function AppSettingsView(): ReactElement {
  const [info, setInfo] = useState<AppSettingsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<AppSettings | null>(null)

  useEffect(() => {
    window.orgai.settings
      .get()
      .then(setInfo)
      .catch((e: Error) => setError(e.message))
  }, [])

  const flush = async (): Promise<void> => {
    const next = pending.current
    pending.current = null
    timer.current = null
    if (!next) return
    try {
      const result = await window.orgai.settings.set(next)
      setSaved(true)
      setError(null)
      if (!pending.current) setInfo(result)
      // The auth pill depends on the global provider auth.
      const auth = await window.orgai.auth.status()
      useAppStore.setState({ auth })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Flush any pending save when leaving the view.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        void flush()
      }
    },
    []
  )

  if (!info) {
    return (
      <>
        <div className="topbar">
          <h1>Settings</h1>
        </div>
        <div style={{ padding: 24, color: error ? 'var(--danger)' : 'var(--text-faint)' }}>{error ?? 'Loading…'}</div>
      </>
    )
  }

  const patch = (p: Partial<AppSettings>): void => {
    const { dataDir: _dataDir, ...current } = info
    const next: AppSettings = { ...current, ...p }
    setInfo({ ...next, dataDir: info.dataDir })
    setSaved(false)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  const modelSelect = (value: string, onChange: (v: string) => void, allowInherit: boolean): ReactElement => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {CLAUDE_MODEL_OPTIONS.filter((m) => allowInherit || m.value !== 'inherit').map((m) => (
        <option key={m.value} value={m.value}>
          {m.label} · {m.hint}
        </option>
      ))}
      {!CLAUDE_MODEL_OPTIONS.some((m) => m.value === value) && <option value={value}>{value}</option>}
    </select>
  )

  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
        <div className="spacer" />
        <span className="hint" style={{ color: error ? 'var(--danger)' : 'var(--text-faint)', fontSize: 12 }}>
          {error ? `Save failed: ${error}` : saved ? 'Saved' : ''}
        </span>
      </div>
      <div style={{ padding: 24, overflow: 'auto' }}>
        <div style={{ maxWidth: 640 }}>
          <div className="side-section-title" style={{ margin: '0 0 10px' }}>
            Claude authentication
          </div>
          <ProviderAuthPicker name="app-provider-auth" value={info.providerAuth} onChange={(providerAuth) => patch({ providerAuth })} />
          <span className="hint" style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)', marginTop: -6, marginBottom: 18 }}>
            Used for the sidebar status and as the default for new projects. Each project can override it in its project settings.
          </span>

          <div className="side-section-title" style={{ margin: '0 0 10px' }}>
            Defaults for new projects
          </div>
          <div className="grid-2">
            <div className="field">
              <label>Orchestrator model</label>
              {modelSelect(info.defaultRootModel, (defaultRootModel) => patch({ defaultRootModel }), false)}
            </div>
            <div className="field">
              <label>Report model</label>
              {modelSelect(info.defaultReportModel, (defaultReportModel) => patch({ defaultReportModel }), true)}
            </div>
            <div className="field">
              <label>Permission mode</label>
              <select
                className="select"
                value={info.defaultPermissionMode}
                onChange={(e) => patch({ defaultPermissionMode: e.target.value as PermissionMode })}
              >
                {PERMISSION_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Estimated-cost cap per run (API-equivalent USD)</label>
              <input
                className="input"
                type="number"
                min={0}
                step={0.5}
                value={info.defaultMaxBudgetUsd ?? ''}
                onChange={(e) => patch({ defaultMaxBudgetUsd: e.target.value && Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                placeholder="No cap"
              />
            </div>
            <div className="field">
              <label>Runs to keep</label>
              <input
                className="input"
                type="number"
                min={1}
                max={5000}
                value={info.defaultKeepRuns}
                onChange={(e) => patch({ defaultKeepRuns: Math.max(1, Number(e.target.value) || DEFAULT_KEEP_RUNS) })}
              />
            </div>
          </div>
          <div className="field">
            <label>Parallel work</label>
            <label className={`check ${info.defaultIsolateWriters ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={info.defaultIsolateWriters} onChange={(e) => patch({ defaultIsolateWriters: e.target.checked })} /> Isolate
              writing reports in git worktrees
            </label>
          </div>
          <div className="field">
            <label>Subscription limits</label>
            <label className={`check ${info.defaultPreferSonnetNearLimit ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
              <input
                type="checkbox"
                checked={info.defaultPreferSonnetNearLimit}
                onChange={(e) => patch({ defaultPreferSonnetNearLimit: e.target.checked })}
              />{' '}
              Prefer Sonnet for new reports when the Opus weekly window is above the threshold
            </label>
          </div>
          <span className="hint" style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)', marginBottom: 18 }}>
            These apply when a project is created. Existing projects keep their own settings.
          </span>

          <div className="side-section-title" style={{ margin: '0 0 10px' }}>
            Usage
          </div>
          <div className="field">
            <label>Opus weekly threshold (%)</label>
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              style={{ maxWidth: 160 }}
              value={info.opusGuardThreshold}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 1 && v <= 100) patch({ opusGuardThreshold: v })
              }}
            />
            <span className="hint">
              Projects that prefer Sonnet near the limit spawn Opus reports on Sonnet once the Opus weekly window (or the seven-day window) reaches this.
            </span>
          </div>

          <div className="side-section-title" style={{ margin: '0 0 10px' }}>
            App
          </div>
          <div className="field">
            <label>Notifications</label>
            <label className={`check ${info.notifications !== false ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={info.notifications !== false} onChange={(e) => patch({ notifications: e.target.checked })} /> Notify me
              when a run needs attention or finishes
            </label>
          </div>
          <div className="field">
            <label>Data directory</label>
            <div className="row">
              <input className="input" value={info.dataDir} readOnly />
              <button
                className="btn"
                onClick={async () => {
                  const err = await window.orgai.app.openPath(info.dataDir)
                  if (err) setError(err)
                }}
              >
                Open folder
              </button>
            </div>
            <span className="hint">Projects, settings and run history are stored here.</span>
          </div>
        </div>
      </div>
    </>
  )
}
