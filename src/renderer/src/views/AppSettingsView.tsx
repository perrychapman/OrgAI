import type { ReactElement } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { AppSettings, AppSettingsInfo, PermissionMode } from '@shared/types'
import { CLAUDE_MODEL_OPTIONS, DEFAULT_KEEP_RUNS, DEFAULT_MAX_AUTO_CONTINUES, PERMISSION_MODE_OPTIONS } from '@shared/types'
import { MAX_AUTO_CONTINUES_LIMIT } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { CopyButton } from '../components/ui/CopyButton'
import { SaveIndicator } from '../components/layout/SaveIndicator'
import ConnectionsPanel from '../components/connections/ConnectionsPanel'

/** Same debounce the project store uses for project saves. */
const SAVE_DELAY_MS = 350

export default function AppSettingsView(): ReactElement {
  const [info, setInfo] = useState<AppSettingsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<AppSettings | null>(null)
  const appInfo = useAppStore((s) => s.appInfo)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  useEffect(() => {
    void loadAppInfo()
  }, [loadAppInfo])

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
      useAppStore.getState().setSaveStatus({ state: 'saved', at: Date.now() })
      setError(null)
      if (!pending.current) setInfo(result)
      // The auth pill depends on the global provider auth.
      const auth = await window.orgai.auth.status()
      useAppStore.setState({ auth })
    } catch (e) {
      setError((e as Error).message)
      useAppStore.getState().setSaveStatus({ state: 'error', at: Date.now(), message: (e as Error).message })
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
    useAppStore.getState().setSaveStatus({ state: 'saving' })
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
        <SaveIndicator />
      </div>
      <div style={{ padding: 'var(--space-6)', overflow: 'auto', flex: 1, minHeight: 0 }}>
        <div className="settings-col">
          <ConnectionsPanel />

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
            <label>Unattended execution</label>
            <label className={`check ${info.defaultAutoContinue ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={info.defaultAutoContinue} onChange={(e) => patch({ defaultAutoContinue: e.target.checked })} /> Keep the
              orchestrator going until the plan is complete
            </label>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
              <span>Max automatic continues per run</span>
              <input
                className="input"
                type="number"
                min={0}
                max={MAX_AUTO_CONTINUES_LIMIT}
                style={{ width: 90 }}
                value={info.defaultMaxAutoContinues}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  patch({ defaultMaxAutoContinues: Number.isFinite(v) ? Math.min(MAX_AUTO_CONTINUES_LIMIT, Math.max(0, Math.floor(v))) : DEFAULT_MAX_AUTO_CONTINUES })
                }}
              />
            </div>
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
          <p className="muted">These apply when a project is created. Existing projects keep their own settings.</p>

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
          {appInfo && (
            <section data-testid="about-block" aria-labelledby="about-title">
              <div className="side-section-title" id="about-title" style={{ margin: '18px 0 10px' }}>
                About
              </div>
              {appInfo.mockAdapter && (
                <p>
                  <Badge tone="accent">Mock adapter available</Badge>
                </p>
              )}
              <dl className="about-list">
                <dt>Version</dt>
                <dd>{appInfo.version}</dd>
                <dt>Platform</dt>
                <dd>
                  {appInfo.platform} · {appInfo.packaged ? 'packaged' : 'development'}
                </dd>
                {(
                  [
                    ['Data folder', appInfo.dataDir],
                    ['Logs folder', appInfo.logsDir]
                  ] as const
                ).map(([name, path]) => (
                  <Fragment key={name}>
                    <dt>{name}</dt>
                    <dd className="about-path">
                      <span className="mono" title={path}>
                        {path}
                      </span>
                      <CopyButton text={path} label={`Copy ${name.toLowerCase()} path`} />
                      <Button size="sm" onClick={() => void window.orgai.app.openPath(path).then((err) => err && setError(err))}>
                        Open
                      </Button>
                    </dd>
                  </Fragment>
                ))}
              </dl>
              <p className="muted">Projects, settings and run history are stored in the data folder.</p>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
