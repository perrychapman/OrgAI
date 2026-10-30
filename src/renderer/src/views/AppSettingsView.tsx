import type { CSSProperties, ReactElement } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { AppearanceSettings, AppSettings, AppSettingsInfo, CanvasEdgeStyle, CanvasPattern, PermissionMode, ThemeMode } from '@shared/types'
import { CLAUDE_MODEL_OPTIONS, DEFAULT_KEEP_RUNS, DEFAULT_MAX_AUTO_CONTINUES, PERMISSION_MODE_OPTIONS } from '@shared/types'
import { DEFAULT_APPEARANCE, MAX_AUTO_CONTINUES_LIMIT } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { setAppearance, normalizeHex } from '../lib/theme'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { CopyButton } from '../components/ui/CopyButton'
import { Input } from '../components/ui/Input'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Select } from '../components/ui/Select'
import { SettingRow } from '../components/ui/SettingRow'
import { Switch } from '../components/ui/Switch'
import { SaveIndicator } from '../components/layout/SaveIndicator'
import type { SettingsNavItem } from '../components/settings/SettingsNav'
import { SettingsPage } from '../components/settings/SettingsPage'
import { SettingsCard } from '../components/settings/SettingsCard'
import { SettingsGroup, SettingsSection } from '../components/settings/SettingsSection'
import { APP_SETTINGS_PANES, APP_SETTINGS_SECTIONS, appPaneForSection, takeAppSettingsSection } from '../lib/settingsTarget'
import ConnectionsPanel from '../components/connections/ConnectionsPanel'
import McpLibrarySection from '../components/mcp/McpLibrarySection'

/** Same debounce the project store uses for project saves. */
const SAVE_DELAY_MS = 350

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' }
]
const PATTERN_OPTIONS: { value: CanvasPattern; label: string }[] = [
  { value: 'dots', label: 'Dots' },
  { value: 'grid', label: 'Grid' },
  { value: 'none', label: 'None' }
]
const EDGE_OPTIONS: { value: CanvasEdgeStyle; label: string }[] = [
  { value: 'curved', label: 'Curved' },
  { value: 'orthogonal', label: 'Right-angle' },
  { value: 'straight', label: 'Straight' }
]
const MOTION_OPTIONS: { value: AppearanceSettings['reduceMotion']; label: string }[] = [
  { value: 'system', label: 'Follow system' },
  { value: 'on', label: 'Always reduce' }
]
/** Accent choices; the first is the default. Any other color can be typed as hex. */
const ACCENT_SWATCHES: { name: string; hex: string }[] = [
  { name: 'Violet', hex: DEFAULT_APPEARANCE.accent },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Green', hex: '#22a559' },
  { name: 'Amber', hex: '#d98e04' },
  { name: 'Rose', hex: '#e5486a' }
]

/** Panes in nav order; each holds the sections whose ids are mapped in lib/settingsTarget. */
const PANES: SettingsNavItem[] = [
  { id: APP_SETTINGS_PANES.general, label: 'General' },
  { id: APP_SETTINGS_PANES.connections, label: 'Connections' },
  { id: APP_SETTINGS_PANES.mcpLibrary, label: 'MCP library' },
  { id: APP_SETTINGS_PANES.defaults, label: 'Defaults' },
  { id: APP_SETTINGS_PANES.about, label: 'About' }
]

function stripInfo(info: AppSettingsInfo): AppSettings {
  const { dataDir: _dataDir, appVersion: _appVersion, ...settings } = info
  return settings
}

export default function AppSettingsView(): ReactElement {
  const [info, setInfo] = useState<AppSettingsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<AppSettings | null>(null)
  const appInfo = useAppStore((s) => s.appInfo)
  const mcpFocus = useAppStore((st) => st.mcpFocus)
  const [pane, setPane] = useState<string>(() => (useAppStore.getState().mcpFocus?.kind === 'library' ? APP_SETTINGS_PANES.mcpLibrary : APP_SETTINGS_PANES.general))
  // A jump from elsewhere ("App settings > Connections") opens the pane that holds its section.
  useEffect(() => {
    const target = takeAppSettingsSection()
    const next = target ? appPaneForSection(target) : undefined
    if (next) setPane(next)
  }, [])
  // "Open in library" lands on the MCP library pane; the section there then scrolls to the entry.
  useEffect(() => {
    if (mcpFocus?.kind === 'library') setPane(APP_SETTINGS_PANES.mcpLibrary)
  }, [mcpFocus])
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  useEffect(() => {
    void loadAppInfo()
  }, [loadAppInfo])

  useEffect(() => {
    window.orgai.settings
      .get()
      .then(setInfo)
      .catch((e: Error) => setError(e.message))
    // Another window or the sidebar mirror changed a setting: follow it unless we have an unsaved edit.
    return window.orgai.onSettingsChanged((s) => {
      if (!pending.current) setInfo(s)
      else pending.current = { ...pending.current, notifications: s.notifications }
    })
  }, [])

  const flush = async (): Promise<void> => {
    const next = pending.current
    pending.current = null
    timer.current = null
    if (!next) return
    try {
      const result = await useAppStore.getState().trackSave(() => window.orgai.settings.set(next))
      setError(null)
      if (!pending.current) setInfo(result)
      // The auth pill depends on the global provider auth.
      const auth = await window.orgai.auth.status()
      useAppStore.setState({ auth })
    } catch (e) {
      setError((e as Error).message)
      void window.orgai.settings.get().then(setInfo).catch(() => undefined)
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
          <h1>App settings</h1>
        </div>
        <div className={`settings-loading${error ? ' is-error' : ''}`}>{error ?? 'Loading…'}</div>
      </>
    )
  }

  /** Queue a save. `immediate` skips the debounce (switches, segmented choices, the theme). */
  const patch = (p: Partial<AppSettings>, immediate = false): void => {
    const next: AppSettings = { ...stripInfo(info), ...p }
    setInfo({ ...next, dataDir: info.dataDir, appVersion: info.appVersion })
    useAppStore.getState().setSaveStatus({ state: 'saving' })
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    if (immediate) void flush()
    else timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  const appearance: AppearanceSettings = info.appearance ?? DEFAULT_APPEARANCE
  const patchAppearance = (p: Partial<AppearanceSettings>, canvas?: Partial<AppearanceSettings['canvas']>): void => {
    const next: AppearanceSettings = { ...appearance, ...p, canvas: { ...appearance.canvas, ...canvas } }
    setAppearance(next)
    patch({ appearance: next }, true)
  }

  const hexValue = hexDraft ?? appearance.accent
  const hexOk = normalizeHex(hexValue) !== null
  /** Apply the typed color on Enter or blur, not on every keystroke. */
  const commitHex = (): void => {
    const hex = normalizeHex(hexValue)
    if (hex && hex !== appearance.accent) patchAppearance({ accent: hex })
    if (hex) setHexDraft(null)
  }
  const setAccent = (hex: string): void => {
    setHexDraft(null)
    patchAppearance({ accent: hex })
  }

  const modelOptions = (value: string, allowInherit: boolean): { value: string; label: string }[] => {
    const list = CLAUDE_MODEL_OPTIONS.filter((m) => allowInherit || m.value !== 'inherit').map((m) => ({ value: m.value, label: `${m.label} · ${m.hint}` }))
    return CLAUDE_MODEL_OPTIONS.some((m) => m.value === value) ? list : [...list, { value, label: value }]
  }

  return (
    <>
      <div className="topbar">
        <h1>App settings</h1>
        <div className="spacer" />
        <SaveIndicator />
      </div>
      <SettingsPage idBase="app-settings" label="App settings sections" panes={PANES} active={pane} onSelect={setPane}>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {pane === 'general' && (
          <>
            <SettingsSection id={APP_SETTINGS_SECTIONS.appearance} title="Appearance" testId="appearance-section">
              <SettingsCard>
                <SettingRow
                  title="Theme"
                  description="System follows your operating system."
                  width="select"
                  control={<SegmentedControl label="Theme" value={appearance.theme} options={THEME_OPTIONS} onChange={(theme) => patchAppearance({ theme })} />}
                />
                <SettingRow
                  title="Accent color"
                  id="accent-title"
                  control={
                    <>
                      <div className="accent-swatches" role="group" aria-label="Accent color presets">
                        {ACCENT_SWATCHES.map((s) => (
                          <button
                            key={s.hex}
                            type="button"
                            className="accent-swatch"
                            style={{ '--swatch': s.hex } as CSSProperties}
                            aria-label={s.name}
                            title={s.name}
                            aria-pressed={appearance.accent === s.hex}
                            onClick={() => setAccent(s.hex)}
                          />
                        ))}
                      </div>
                      <Input
                        id="accent-hex"
                        aria-labelledby="accent-title"
                        mono
                        value={hexValue}
                        invalid={!hexOk}
                        aria-describedby={hexOk ? undefined : 'accent-hex-error'}
                        maxLength={7}
                        spellCheck={false}
                        onChange={setHexDraft}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitHex()
                        }}
                        onBlur={commitHex}
                      />
                    </>
                  }
                  hint={
                    !hexOk ? (
                      <span className="field-error" id="accent-hex-error" aria-live="polite">
                        Use a hex color like #7c5cff.
                      </span>
                    ) : undefined
                  }
                />
                <SettingRow
                  title="Motion"
                  width="select"
                  control={<SegmentedControl label="Motion" value={appearance.reduceMotion} options={MOTION_OPTIONS} onChange={(reduceMotion) => patchAppearance({ reduceMotion })} />}
                />
              </SettingsCard>
              <SettingsGroup title="Canvas">
                <SettingsCard>
                  <SettingRow
                    title="Canvas pattern"
                    width="select"
                    control={<SegmentedControl label="Canvas pattern" value={appearance.canvas.pattern} options={PATTERN_OPTIONS} onChange={(pattern) => patchAppearance({}, { pattern })} />}
                  />
                  <SettingRow
                    title="Connection lines"
                    width="select"
                    control={<SegmentedControl label="Connection lines" value={appearance.canvas.edges} options={EDGE_OPTIONS} onChange={(edges) => patchAppearance({}, { edges })} />}
                  />
                  <SettingRow
                    title="Tint the canvas with the accent"
                    control={<Switch checked={appearance.canvas.tint} label="Tint the canvas with the accent" onChange={(tint) => patchAppearance({}, { tint })} />}
                  />
                  <SettingRow
                    title="Show the minimap"
                    control={<Switch checked={appearance.canvas.minimap} label="Show the minimap" onChange={(minimap) => patchAppearance({}, { minimap })} />}
                  />
                </SettingsCard>
              </SettingsGroup>
            </SettingsSection>
            <SettingsSection id={APP_SETTINGS_SECTIONS.notifications} title="Notifications">
              <SettingsCard>
                <SettingRow
                  title="Notify me when a run needs attention or finishes"
                  description="Shown by your operating system while OrgAI is in the background."
                  control={
                    <Switch
                      checked={info.notifications !== false}
                      label="Notify me when a run needs attention or finishes"
                      testId="notifications-switch"
                      onChange={(notifications) => patch({ notifications }, true)}
                    />
                  }
                />
              </SettingsCard>
            </SettingsSection>
          </>
        )}
        {pane === 'connections' && (
          <div id={APP_SETTINGS_SECTIONS.connections}>
            <ConnectionsPanel />
          </div>
        )}
        {pane === 'mcp-library' && <McpLibrarySection />}
        {pane === 'defaults' && (
          <>
            <SettingsSection
              id={APP_SETTINGS_SECTIONS.defaults}
              title="Defaults for new projects"
              description="Used when you create a project. Existing projects keep their own settings."
            >
              <SettingsCard>
                <SettingRow
                  title="Orchestrator model"
                  width="select"
                  control={<Select label="Orchestrator model" value={info.defaultRootModel} options={modelOptions(info.defaultRootModel, false)} onChange={(defaultRootModel) => patch({ defaultRootModel })} />}
                />
                <SettingRow
                  title="Report model"
                  width="select"
                  control={<Select label="Report model" value={info.defaultReportModel} options={modelOptions(info.defaultReportModel, true)} onChange={(defaultReportModel) => patch({ defaultReportModel })} />}
                />
                <SettingRow
                  title="Permission mode"
                  width="select"
                  control={
                    <Select
                      label="Permission mode"
                      value={info.defaultPermissionMode}
                      options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      onChange={(v) => patch({ defaultPermissionMode: v as PermissionMode })}
                    />
                  }
                />
                <SettingRow
                  title="Estimated cost cap per run (API-equivalent USD)"
                  width="number"
                  control={
                    <Input
                      aria-label="Estimated cost cap per run"
                      type="number"
                      min={0}
                      step={0.5}
                      value={info.defaultMaxBudgetUsd ?? ''}
                      placeholder="No cap"
                      onChange={(v) => patch({ defaultMaxBudgetUsd: v && Number(v) > 0 ? Number(v) : undefined })}
                    />
                  }
                />
                <SettingRow
                  title="Runs to keep"
                  width="number"
                  control={
                    <Input
                      aria-label="Runs to keep"
                      type="number"
                      min={1}
                      max={5000}
                      value={info.defaultKeepRuns}
                      onChange={(v) => patch({ defaultKeepRuns: Math.max(1, Number(v) || DEFAULT_KEEP_RUNS) })}
                    />
                  }
                />
                <SettingRow
                  title="Isolate writing reports in git worktrees"
                  description="Each report that edits files works in its own copy of the repository."
                  control={<Switch checked={info.defaultIsolateWriters} label="Isolate writing reports in git worktrees" onChange={(defaultIsolateWriters) => patch({ defaultIsolateWriters })} />}
                />
                <SettingRow
                  title="Keep the orchestrator going until the plan is complete"
                  description="Re-prompts the orchestrator until its plan is done, up to the limit below."
                  control={
                    <Switch
                      checked={info.defaultAutoContinue}
                      label="Keep the orchestrator going until the plan is complete"
                      onChange={(defaultAutoContinue) => patch({ defaultAutoContinue })}
                    />
                  }
                />
                <SettingRow
                  title="Max automatic continues per run"
                  width="number"
                  control={
                    <Input
                      aria-label="Max automatic continues per run"
                      type="number"
                      min={0}
                      max={MAX_AUTO_CONTINUES_LIMIT}
                      value={info.defaultMaxAutoContinues}
                      onChange={(v) => {
                        const n = Number(v)
                        patch({ defaultMaxAutoContinues: Number.isFinite(n) ? Math.min(MAX_AUTO_CONTINUES_LIMIT, Math.max(0, Math.floor(n))) : DEFAULT_MAX_AUTO_CONTINUES })
                      }}
                    />
                  }
                />
                <SettingRow
                  title="Prefer Sonnet for new reports when the Opus weekly window is above the threshold"
                  description="Uses the weekly threshold under Usage."
                  control={
                    <Switch
                      checked={info.defaultPreferSonnetNearLimit}
                      label="Prefer Sonnet for new reports when the Opus weekly window is above the threshold"
                      onChange={(defaultPreferSonnetNearLimit) => patch({ defaultPreferSonnetNearLimit })}
                    />
                  }
                />
              </SettingsCard>
            </SettingsSection>
            <SettingsSection id={APP_SETTINGS_SECTIONS.usage} title="Usage">
              <SettingsCard>
                <SettingRow
                  title="Opus weekly threshold (%)"
                  description="Projects that prefer Sonnet near the limit switch Opus reports to Sonnet at this level."
                  width="number"
                  control={
                    <Input
                      aria-label="Opus weekly threshold (%)"
                      type="number"
                      min={1}
                      max={100}
                      value={info.opusGuardThreshold}
                      onChange={(v) => {
                        const n = Number(v)
                        if (Number.isFinite(n) && n >= 1 && n <= 100) patch({ opusGuardThreshold: n })
                      }}
                    />
                  }
                />
              </SettingsCard>
            </SettingsSection>
          </>
        )}
        {pane === 'about' && appInfo && (
          <SettingsSection id={APP_SETTINGS_SECTIONS.about} title="About" testId="about-block">
            {appInfo.mockAdapter && (
              <p>
                <Badge tone="accent">Mock adapter available</Badge>
              </p>
            )}
            <SettingsCard>
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
            </SettingsCard>
            <p className="muted">Projects, settings and run history are stored in the data folder.</p>
          </SettingsSection>
        )}
      </SettingsPage>
    </>
  )
}
