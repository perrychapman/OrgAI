import type { CSSProperties, ReactElement } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { AppearanceSettings, AppSettings, AppSettingsInfo, CanvasEdgeStyle, CanvasPattern, PermissionMode, ThemeMode } from '@shared/types'
import type { ConnectionId } from '@shared/types'
import { CLAUDE_MODEL_OPTIONS, CONNECTION_IDS, PERMISSION_MODE_OPTIONS } from '@shared/types'
import { DEFAULT_APPEARANCE, MAX_AUTO_CONTINUES_LIMIT } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { setAppearance, normalizeHex } from '../lib/theme'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { CopyButton } from '../components/ui/CopyButton'
import { Input } from '../components/ui/Input'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Select } from '../components/ui/Select'
import { Icon } from '../components/ui/Icon'
import { SettingRow, settingDescId } from '../components/ui/SettingRow'
import { Switch } from '../components/ui/Switch'
import { SaveIndicator } from '../components/layout/SaveIndicator'
import type { SettingsNavItem } from '../components/settings/SettingsNav'
import { ClampedNumber } from '../components/settings/ClampedNumber'
import { SettingsPage } from '../components/settings/SettingsPage'
import { SettingsCard } from '../components/settings/SettingsCard'
import { SettingsGroup, SettingsSection } from '../components/settings/SettingsSection'
import { CONNECTION_NAME, DEFAULT_CONNECTION_COPY, SETTINGS_COPY } from '../lib/settingsCopy'
import { connectionUsable } from '../lib/projectsForm'
import { APP_SETTINGS_PANES, APP_SETTINGS_SECTIONS, appPaneForSection, focusPaneHeading, takeAppSettingsSection } from '../lib/settingsTarget'
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
/** Short select names; the chosen mode's description shows as the row hint. Matches the project page. */
const PERMISSION_SHORT: Record<PermissionMode, string> = {
  auto: 'Unattended',
  acceptEdits: 'Auto-accept edits',
  default: 'Ask for risky actions',
  dontAsk: 'Never ask',
  plan: 'Plan only',
  bypassPermissions: 'Bypass all prompts'
}
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
  const [customRequested, setCustomRequested] = useState(false)
  const focusHex = useRef(false)
  const [highlightUsage, setHighlightUsage] = useState(false)
  // Set by a deep link; the first render that has the page loaded moves focus to the pane heading.
  const pendingFocus = useRef<{ usage: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<AppSettings | null>(null)
  const appInfo = useAppStore((s) => s.appInfo)
  const mcpFocus = useAppStore((st) => st.mcpFocus)
  const [pane, setPane] = useState<string>(() => (useAppStore.getState().mcpFocus?.kind === 'library' ? APP_SETTINGS_PANES.mcpLibrary : APP_SETTINGS_PANES.general))
  // A jump from elsewhere ("App settings > Connections") opens the pane that holds its section.
  useEffect(() => {
    const target = takeAppSettingsSection()
    const next = target ? appPaneForSection(target) : undefined
    if (next) {
      setPane(next)
      pendingFocus.current = { usage: target === APP_SETTINGS_SECTIONS.usage }
    }
  }, [])
  // "Open in library" lands on the MCP library pane; the section there then scrolls to the entry.
  useEffect(() => {
    if (mcpFocus?.kind === 'library') setPane(APP_SETTINGS_PANES.mcpLibrary)
  }, [mcpFocus])
  const ready = info !== null
  useEffect(() => {
    const pf = pendingFocus.current
    if (!pf || !ready) return
    pendingFocus.current = null
    focusPaneHeading({ preventScroll: pf.usage })
    if (pf.usage) {
      document.getElementById(APP_SETTINGS_SECTIONS.usage)?.scrollIntoView({ block: 'center' })
      setHighlightUsage(true)
    }
  }, [ready, pane])
  // The usage row's highlight is brief; the attribute is cleared so it never lingers or replays.
  useEffect(() => {
    if (!highlightUsage) return
    const t = setTimeout(() => setHighlightUsage(false), 2200)
    return () => clearTimeout(t)
  }, [highlightUsage])
  // The Custom swatch revealed the hex field: move focus into it.
  useEffect(() => {
    if (!focusHex.current) return
    focusHex.current = false
    document.getElementById('accent-hex')?.focus()
  })
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const connections = useAppStore((s) => s.connections)
  const loadConnections = useAppStore((s) => s.loadConnections)
  useEffect(() => {
    void loadAppInfo()
    void loadConnections()
  }, [loadAppInfo, loadConnections])

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

  // The hex field stays hidden unless asked for or the current accent is not a preset.
  const isPreset = ACCENT_SWATCHES.some((sw) => sw.hex === appearance.accent)
  const customOpen = customRequested || !isPreset
  const openCustom = (): void => {
    const el = document.getElementById('accent-hex')
    if (el) el.focus()
    else focusHex.current = true
    setCustomRequested(true)
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
    setCustomRequested(false)
    patchAppearance({ accent: hex })
  }

  const modelOptions = (value: string, allowInherit: boolean): { value: string; label: string }[] => {
    const list = CLAUDE_MODEL_OPTIONS.filter((m) => allowInherit || m.value !== 'inherit').map((m) => ({ value: m.value, label: m.label }))
    return CLAUDE_MODEL_OPTIONS.some((m) => m.value === value) ? list : [...list, { value, label: value }]
  }

  const modelHint = (value: string): string | undefined => CLAUDE_MODEL_OPTIONS.find((m) => m.value === value)?.hint

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
              <SettingsGroup title="Theme">
                <SettingsCard>
                  <SettingRow
                    title="Theme"
                    description="System follows your operating system."
                    width="select"
                    control={<SegmentedControl label="Theme" value={appearance.theme} options={THEME_OPTIONS} onChange={(theme) => patchAppearance({ theme })} />}
                  />
                  <SettingRow
                    title="Accent colour"
                    id="accent-title"
                    width="select"
                    control={
                      <div className="accent-swatches" role="group" aria-label="Accent colour presets">
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
                        <button
                          type="button"
                          className="accent-swatch custom"
                          aria-label="Custom colour"
                          title="Custom colour"
                          aria-pressed={!isPreset}
                          aria-expanded={customOpen}
                          aria-controls="accent-hex"
                          onClick={openCustom}
                        >
                          <Icon icon={Plus} size="sm" />
                        </button>
                      </div>
                    }
                    hint={
                      customOpen ? (
                        <span className="accent-custom">
                          <label htmlFor="accent-hex" className="accent-custom-label">
                            Hex
                          </label>
                          <Input
                            id="accent-hex"
                            aria-label="Custom accent hex"
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
                          {!hexOk && (
                            <span className="field-error" id="accent-hex-error" aria-live="polite">
                              Use a hex colour like #7c5cff.
                            </span>
                          )}
                        </span>
                      ) : undefined
                    }
                  />
                  <SettingRow
                    title="Motion"
                    description="Reduce animation across the app."
                    width="select"
                    control={<SegmentedControl label="Motion" value={appearance.reduceMotion} options={MOTION_OPTIONS} onChange={(reduceMotion) => patchAppearance({ reduceMotion })} />}
                  />
                </SettingsCard>
              </SettingsGroup>
              <SettingsGroup title="Canvas">
                <SettingsCard>
                  <SettingRow
                    title="Pattern"
                    width="select"
                    control={<SegmentedControl label="Canvas pattern" value={appearance.canvas.pattern} options={PATTERN_OPTIONS} onChange={(pattern) => patchAppearance({}, { pattern })} />}
                  />
                  <SettingRow
                    title="Connection lines"
                    width="select"
                    control={<SegmentedControl label="Connection lines" value={appearance.canvas.edges} options={EDGE_OPTIONS} onChange={(edges) => patchAppearance({}, { edges })} />}
                  />
                  <SettingRow
                    title="Tint with the accent"
                    control={<Switch checked={appearance.canvas.tint} label="Tint the canvas with the accent" onChange={(tint) => patchAppearance({}, { tint })} />}
                  />
                  <SettingRow
                    title="Minimap"
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
        {pane === 'connections' && <ConnectionsPanel />}
        {pane === 'mcp-library' && <McpLibrarySection />}
        {pane === 'defaults' && (
          <SettingsSection id={APP_SETTINGS_SECTIONS.defaults} title="Defaults" description="For new projects. Existing ones keep their own.">
            <SettingsGroup title="Connection">
              <SettingsCard>
                <SettingRow
                  id="default-connection-row"
                  title={DEFAULT_CONNECTION_COPY.label}
                  description={DEFAULT_CONNECTION_COPY.description}
                  width="select"
                  control={
                    <Select
                      label={DEFAULT_CONNECTION_COPY.label}
                      describedBy={settingDescId('default-connection-row')}
                      value={info.defaultConnection ?? 'anthropic'}
                      options={CONNECTION_IDS.map((id) => {
                        const usable = id === 'anthropic' || connectionUsable(connections?.find((c) => c.connection.id === id))
                        return {
                          value: id,
                          label: `${CONNECTION_NAME[id]}${usable ? '' : ' (Not connected)'}`,
                          disabled: !usable && id !== (info.defaultConnection ?? 'anthropic')
                        }
                      })}
                      onChange={(v) => {
                        const defaultConnection = v as ConnectionId
                        patch({ defaultConnection }, true)
                        useAppStore.setState({ defaultConnection })
                      }}
                    />
                  }
                />
              </SettingsCard>
            </SettingsGroup>
            <SettingsGroup title="Models">
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
              </SettingsCard>
            </SettingsGroup>
            <SettingsGroup title="Safety">
              <SettingsCard>
                <SettingRow
                  id="default-mode-row"
                  title={SETTINGS_COPY.permissionMode.label}
                  description={PERMISSION_MODE_OPTIONS.find((o) => o.value === info.defaultPermissionMode)?.label.replace(/^[^:]*: /, '')}
                  width="select"
                  control={
                    <Select
                      label={SETTINGS_COPY.permissionMode.label}
                      describedBy={settingDescId('default-mode-row')}
                      value={info.defaultPermissionMode}
                      options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: PERMISSION_SHORT[o.value] }))}
                      onChange={(v) => patch({ defaultPermissionMode: v as PermissionMode })}
                    />
                  }
                />
                <SettingRow
                  id="default-cost-row"
                  title={SETTINGS_COPY.costCap.label}
                  description={SETTINGS_COPY.costCap.description}
                  width="number"
                  control={
                    <Input
                      aria-label={SETTINGS_COPY.costCap.label}
                      aria-describedby={settingDescId('default-cost-row')}
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
                  title={SETTINGS_COPY.keepRuns.label}
                  width="number"
                  control={<ClampedNumber label={SETTINGS_COPY.keepRuns.label} min={1} max={5000} value={info.defaultKeepRuns} onCommit={(defaultKeepRuns) => patch({ defaultKeepRuns })} />}
                />
              </SettingsCard>
            </SettingsGroup>
            <SettingsGroup title="Behaviour">
              <SettingsCard>
                <SettingRow
                  id="default-auto-row"
                  title={SETTINGS_COPY.autoContinue.label}
                  description={SETTINGS_COPY.autoContinue.description}
                  control={
                    <Switch
                      checked={info.defaultAutoContinue}
                      label={SETTINGS_COPY.autoContinue.label}
                      describedBy={settingDescId('default-auto-row')}
                      onChange={(defaultAutoContinue) => patch({ defaultAutoContinue })}
                    />
                  }
                />
                <SettingRow
                  title={SETTINGS_COPY.maxAutoContinues.label}
                  width="number"
                  control={
                    <ClampedNumber
                      label={SETTINGS_COPY.maxAutoContinues.label}
                      min={0}
                      max={MAX_AUTO_CONTINUES_LIMIT}
                      value={info.defaultMaxAutoContinues}
                      onCommit={(defaultMaxAutoContinues) => patch({ defaultMaxAutoContinues })}
                    />
                  }
                />
                <SettingRow
                  id="default-iso-row"
                  title={SETTINGS_COPY.isolateWriters.label}
                  description={SETTINGS_COPY.isolateWriters.description}
                  control={
                    <Switch
                      checked={info.defaultIsolateWriters}
                      label={SETTINGS_COPY.isolateWriters.label}
                      describedBy={settingDescId('default-iso-row')}
                      onChange={(defaultIsolateWriters) => patch({ defaultIsolateWriters })}
                    />
                  }
                />
                <SettingRow
                  id="default-sonnet-row"
                  title={SETTINGS_COPY.preferSonnet.label}
                  description={SETTINGS_COPY.preferSonnet.description}
                  control={
                    <Switch
                      checked={info.defaultPreferSonnetNearLimit}
                      label={SETTINGS_COPY.preferSonnet.label}
                      describedBy={settingDescId('default-sonnet-row')}
                      onChange={(defaultPreferSonnetNearLimit) => patch({ defaultPreferSonnetNearLimit })}
                    />
                  }
                />
                <div id={APP_SETTINGS_SECTIONS.usage} className="settings-highlightable" data-highlight={highlightUsage || undefined}>
                  <SettingRow
                    id="default-opus-row"
                    title={SETTINGS_COPY.opusThreshold.label}
                    description={SETTINGS_COPY.opusThreshold.description}
                    width="number"
                    control={
                      <Input
                        id="default-opus-threshold"
                        aria-label={`${SETTINGS_COPY.opusThreshold.label} (%)`}
                        aria-describedby={settingDescId('default-opus-row')}
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
                </div>
              </SettingsCard>
            </SettingsGroup>
          </SettingsSection>
        )}
        {pane === 'about' && appInfo && (
          <SettingsSection id={APP_SETTINGS_SECTIONS.about} title="About" testId="about-block">
            <SettingsCard>
              <dl className="about-list">
                <dt>Version</dt>
                <dd>
                  {appInfo.version}
                  {appInfo.mockAdapter && (
                    <span title="This build can run scripted projects without a connection.">
                      {' '}
                      <Badge tone="accent">Mock adapter</Badge>
                    </span>
                  )}
                </dd>
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
          </SettingsSection>
        )}
      </SettingsPage>
    </>
  )
}
