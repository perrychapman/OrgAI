import type { CSSProperties, ReactElement } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { devBuildLabel, isDevBuild } from '../lib/buildChannel'
import type { AppearanceSettings, AppSettings, AppSettingsInfo, ModelPriceOverride, PermissionMode, ThemeMode } from '@shared/types'
import { PERMISSION_MODE_OPTIONS } from '@shared/types'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { setAppearance, normalizeHex } from '../lib/theme'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { CopyButton } from '../components/ui/CopyButton'
import { Input } from '../components/ui/Input'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Icon } from '../components/ui/Icon'
import { SettingRow, settingDescId } from '../components/ui/SettingRow'
import { Switch } from '../components/ui/Switch'
import { SaveIndicator } from '../components/layout/SaveIndicator'
import type { SettingsNavItem } from '../components/settings/SettingsNav'
import { SettingsAdvanced, openSettingsAdvanced } from '../components/settings/SettingsAdvanced'
import { SettingsPage } from '../components/settings/SettingsPage'
import { SettingsCard } from '../components/settings/SettingsCard'
import { SettingsGroup, SettingsSection } from '../components/settings/SettingsSection'
import { PERMISSION_MODE_SHORT, SETTINGS_COPY } from '../lib/settingsCopy'
import { connectionLabel } from '../lib/connectionLabel'
import { PERMISSION_MODE_TRADEOFF } from '../lib/permissionCopy'
import { modelSettingGroups, modelSources } from '../lib/assistantModels'
import { ModelSelect } from '../components/ui/ModelSelect'
import { ADVANCED_SECTIONS, APP_SETTINGS_PANES, APP_SETTINGS_SECTIONS, appPaneForSection, focusPaneHeading, takeAppSettingsSection, clearTeamOrigin } from '../lib/settingsTarget'
import { scrollWithin } from '../lib/scrollWithin'
import ConnectionsPanel from '../components/connections/ConnectionsPanel'
import { ModelPricesSection } from '../components/settings/ModelPricesSection'
import { ConnectorGallery } from '../components/connectors/ConnectorGallery'
import PresetsSection from '../components/connectors/PresetsSection'
import McpLibrarySection from '../components/mcp/McpLibrarySection'
import SkillLibrarySection from '../components/skills/SkillLibrarySection'
import TemplatesSection from '../components/templates/TemplatesSection'
import KitSection from '../components/kit/KitSection'
import { CanvasSection } from '../components/settings/CanvasSection'
import { CliCommandRow } from '../components/settings/CliCommandRow'
import { Select } from '../components/ui/Select'
import { mergePendingSettings } from '../lib/settingsMerge'
import { focusCheckedPreset } from '../components/canvas/CanvasPresetGroup'
import { askOrgAI } from '../lib/menuActions'
import AppNavigateBanner from '../components/AppNavigateBanner'

/** Same debounce the project store uses for project saves. */
const SAVE_DELAY_MS = 350
const MAKER_NAME = 'Cybrid Software LLC'
const MAKER_URL = 'https://cybridsoftware.com'

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' }
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
  { id: APP_SETTINGS_PANES.mcpLibrary, label: 'Connectors' },
  { id: APP_SETTINGS_PANES.skillLibrary, label: 'Skill library' },
  { id: APP_SETTINGS_PANES.kit, label: 'Templates and kit' },
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
  // Set by a deep link; the first render that has the page loaded moves focus to the pane heading or the target.
  const pendingFocus = useRef<{ section?: string } | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<AppSettings | null>(null)
  /** The fields the queued save changed; a settings:changed from elsewhere keeps only these from `pending`. */
  const pendingKeys = useRef<Set<keyof AppSettings>>(new Set())
  const appInfo = useAppStore((s) => s.appInfo)
  const mcpFocus = useAppStore((st) => st.mcpFocus)
  const [pane, setPane] = useState<string>(() => (useAppStore.getState().mcpFocus?.kind === 'library' ? APP_SETTINGS_PANES.mcpLibrary : APP_SETTINGS_PANES.general))
  // Leaving App settings for good drops the "Back to Team" way back.
  // Deferred and checked against the view so StrictMode's simulated remount (dev) keeps it.
  useEffect(
    () => () => {
      setTimeout(() => {
        if (useAppStore.getState().view !== 'appSettings') clearTeamOrigin()
      }, 0)
    },
    []
  )
  // A jump from elsewhere ("App settings > Connections") opens the pane that holds its section.
  useEffect(() => {
    const take = (): void => {
      const target = takeAppSettingsSection()
      if (target) {
        // A removed id (the old Defaults pane or its rows) opens General.
        setPane(appPaneForSection(target) ?? APP_SETTINGS_PANES.general)
        pendingFocus.current = { section: ADVANCED_SECTIONS[target] || target === APP_SETTINGS_SECTIONS.canvas ? target : undefined }
        setFocusTick((t) => t + 1)
      }
    }
    take()
    // A jump requested while this page is already open (the MCP assistant dialog's model link).
    window.addEventListener('orgai:settings-section', take)
    return () => window.removeEventListener('orgai:settings-section', take)
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
    if (!pf.section) {
      focusPaneHeading()
      return
    }
    // A target inside a pane's Advanced opens it first (never moving focus), then lands on the section or group heading.
    const advancedPane = ADVANCED_SECTIONS[pf.section]
    if (advancedPane) openSettingsAdvanced(advancedPane)
    focusPaneHeading({ preventScroll: true })
    // Scroll only the settings scroller: scrollIntoView also shifted <html> and the app shell for a target near the end (N1).
    const land = (): void => scrollWithin(document.getElementById(pf.section!), 'start')
    land()
    // Panels above it load after the first paint and push it down, so the scroll is repeated once they settle.
    setTimeout(land, 350)
    setTimeout(land, 900)
    if (pf.section === APP_SETTINGS_SECTIONS.canvas) {
      // The canvas section lands on its checked style option.
      focusCheckedPreset(document.getElementById(pf.section))
      return
    }
    const title = document.getElementById(pf.section)?.querySelector('.settings-section-title, .settings-group-title')
    title?.setAttribute('tabindex', '-1')
    ;(title as HTMLElement | null)?.focus({ preventScroll: true })
  }, [ready, pane, focusTick])
  // The Custom swatch revealed the hex field: move focus into it.
  useEffect(() => {
    if (!focusHex.current) return
    focusHex.current = false
    document.getElementById('accent-hex')?.focus()
  })
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const connections = useAppStore((s) => s.connections)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const loadModels = useAppStore((s) => s.loadModels)
  // The effective default (connections:list isDefault); never the raw setting.
  const defaultConn = useAppStore((s) => s.defaultConnection) ?? 'anthropic'
  const loadDefaultConnection = useAppStore((s) => s.loadDefaultConnection)
  const defaultCatalog = useAppStore((s) => s.models[defaultConn])
  useEffect(() => {
    void loadAppInfo()
    void loadConnections()
    void loadDefaultConnection()
  }, [loadAppInfo, loadConnections, loadDefaultConnection])
  useEffect(() => {
    if (!defaultCatalog) void loadModels(defaultConn)
  }, [defaultCatalog, defaultConn, loadModels])
  // Every enabled connection's catalog feeds the model pickers.
  const allModels = useAppStore((s) => s.models)
  const enabledKey = (connections ?? []).map((c) => `${c.connection.id}:${c.connection.enabled}`).join()
  useEffect(() => {
    for (const c of connections ?? []) {
      if (c.connection.enabled && !useAppStore.getState().models[c.connection.id]) void loadModels(c.connection.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledKey, loadModels])
  const sources = modelSources(connections, allModels)
  const resolveOn = sources.find((x) => x.id === defaultConn)

  useEffect(() => {
    window.orgai.settings
      .get()
      .then(setInfo)
      .catch((e: Error) => setError(e.message))
    // Another window or the sidebar mirror changed a setting: follow it unless we have an unsaved edit.
    return window.orgai.onSettingsChanged((s) => {
      if (!pending.current) setInfo(s)
      else {
        const merged = mergePendingSettings(pending.current, s, pendingKeys.current)
        pending.current = merged
        setInfo({ ...merged, dataDir: s.dataDir, appVersion: s.appVersion })
      }
    })
  }, [])

  const flush = async (): Promise<void> => {
    const next = pending.current
    pending.current = null
    pendingKeys.current = new Set()
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
    const next: AppSettings = { ...(pending.current ?? stripInfo(info)), ...p }
    setInfo({ ...next, dataDir: info.dataDir, appVersion: info.appVersion })
    useAppStore.getState().setSaveStatus({ state: 'saving' })
    pending.current = next
    for (const key of Object.keys(p) as (keyof AppSettings)[]) pendingKeys.current.add(key)
    if (timer.current) clearTimeout(timer.current)
    if (immediate) void flush()
    else timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  /** Save the price overrides now (with any queued edit); rejects with the save error so the Model prices form shows it. */
  const saveModelPrices = async (modelPrices: ModelPriceOverride[]): Promise<void> => {
    const base = pending.current ?? stripInfo(info)
    pending.current = null
    pendingKeys.current = new Set()
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const result = await useAppStore.getState().trackSave(() => window.orgai.settings.set({ ...base, modelPrices }))
    setInfo(result)
    setError(null)
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

  /** Tiers (with what each resolves to on the effective default connection), then the exact models. */
  const modelSelect = (label: string, rowId: string, value: string, allowInherit: boolean, onChange: (v: string) => void): ReactElement => (
    <ModelSelect
      label={label}
      hideLabel
      value={value}
      groups={modelSettingGroups(value, sources, allowInherit, resolveOn)}
      onChange={onChange}
      testId={`${rowId}-select`}
    />
  )

  return (
    <>
      <div className="topbar">
        <h1>App settings</h1>
        <div className="spacer" />
        <SaveIndicator />
      </div>
      <AppNavigateBanner />
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
              </SettingsCard>
            </SettingsSection>
            <CanvasSection canvas={appearance.canvas} onChange={(canvas) => patchAppearance({}, canvas)} />
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
            <SettingsSection
              id={APP_SETTINGS_SECTIONS.newProjects}
              title="New projects"
              description="Starting values for new projects. Existing projects keep their own."
              testId="new-projects-section"
            >
              <SettingsCard>
                <SettingRow
                  id="default-mode-row"
                  title={SETTINGS_COPY.permissionMode.label}
                  description={PERMISSION_MODE_TRADEOFF[info.defaultPermissionMode]}
                  width="select"
                  control={
                    <select
                      className="select"
                      aria-label={SETTINGS_COPY.permissionMode.label}
                      aria-describedby={settingDescId('default-mode-row')}
                      value={info.defaultPermissionMode}
                      data-testid="default-mode-select"
                      onChange={(e) => patch({ defaultPermissionMode: e.target.value as PermissionMode })}
                    >
                      {PERMISSION_MODE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {PERMISSION_MODE_SHORT[o.value]}
                        </option>
                      ))}
                    </select>
                  }
                />
              </SettingsCard>
            </SettingsSection>
            <SettingsAdvanced paneKey="app-general">
              <SettingsGroup title="Motion">
                <SettingsCard>
                  <SettingRow
                    title="Motion"
                    description="Reduce animation across the app."
                    width="select"
                    control={<SegmentedControl label="Motion" value={appearance.reduceMotion} options={MOTION_OPTIONS} onChange={(reduceMotion) => patchAppearance({ reduceMotion })} />}
                  />
                </SettingsCard>
              </SettingsGroup>
              <SettingsGroup title="Assistant models (used now by every project)" id={APP_SETTINGS_SECTIONS.assistantModels}>
                <SettingsCard>
                  <SettingRow
                    id="setup-model-row"
                    title="Setup model"
                    description="Plans and revises org charts and reviews finished runs."
                    width="select"
                    control={modelSelect('Setup model', 'setup-model-row', info.setupModel, false, (setupModel) => patch({ setupModel }))}
                  />
                  <SettingRow
                    id="mcp-assist-model-row"
                    title="MCP assistant model"
                    description="Writes and tests connectors with you."
                    width="select"
                    control={modelSelect('MCP assistant model', 'mcp-assist-model-row', info.mcpAssistModel, false, (mcpAssistModel) => patch({ mcpAssistModel }))}
                  />
                  <SettingRow
                    id="skill-assist-model-row"
                    title="Skill assistant model"
                    description="Writes and revises skills."
                    width="select"
                    control={modelSelect('Skill assistant model', 'skill-assist-model-row', info.skillAssistModel ?? 'deep', false, (skillAssistModel) => patch({ skillAssistModel }))}
                  />
                  <SettingRow
                    id="quick-run-model-row"
                    title="Chat model"
                    description="Answers in Chat."
                    width="select"
                    control={modelSelect('Chat model', 'quick-run-model-row', info.quickRunModel ?? 'everyday', false, (quickRunModel) => patch({ quickRunModel }))}
                  />
                </SettingsCard>
                <p className="muted" data-testid="assistant-models-note">
                  Chat and the MCP and Skill assistants run on {connectionLabel(defaultConn)}, the default connection. Setup uses each project's connection.
                </p>
              </SettingsGroup>
              <SettingsGroup title="New projects (advanced)">
                <SettingsCard>
                  <SettingRow
                    id="default-root-model-row"
                    title="Orchestrator starting tier"
                    description="Leads each new project's runs."
                    width="select"
                    control={modelSelect('Orchestrator starting tier', 'default-root-model-row', info.defaultRootModel, false, (defaultRootModel) => patch({ defaultRootModel }))}
                  />
                  <SettingRow
                    id="default-report-model-row"
                    title="Report starting tier"
                    description="Used by the roles that report to the orchestrator."
                    width="select"
                    control={modelSelect('Report starting tier', 'default-report-model-row', info.defaultReportModel, true, (defaultReportModel) => patch({ defaultReportModel }))}
                  />
                </SettingsCard>
              </SettingsGroup>
              <SettingsGroup title="Terminal">
                <SettingsCard>
                  <CliCommandRow />
                </SettingsCard>
              </SettingsGroup>
            </SettingsAdvanced>
          </>
        )}
        {pane === 'connections' && (
          <>
            <ConnectionsPanel />
            <SettingsAdvanced paneKey="app-connections">
              <SettingsSection id={APP_SETTINGS_SECTIONS.costs} title="Costs" description="Where cost estimates come from.">
                <SettingsCard>
                  <SettingRow
                    id="community-prices-row"
                    title="Community price list"
                    description="Fetches a public price list for models without a built-in price. Your prices below win."
                    control={
                      <Switch
                        checked={info.communityPrices !== false}
                        label="Community price list"
                        testId="community-prices-switch"
                        describedBy={settingDescId('community-prices-row')}
                        onChange={(communityPrices) => patch({ communityPrices }, true)}
                      />
                    }
                  />
                </SettingsCard>
              </SettingsSection>
              <ModelPricesSection overrides={info.modelPrices ?? []} onSave={saveModelPrices} />
            </SettingsAdvanced>
          </>
        )}
        {pane === 'mcp-library' && (
          <>
            <ConnectorGallery />
            <PresetsSection />
            <McpLibrarySection />
          </>
        )}
        {pane === 'skill-library' && <SkillLibrarySection />}
        {pane === 'kit' && <TemplatesSection />}
        {pane === 'kit' && <KitSection />}
        {pane === 'about' && appInfo && (
          <SettingsSection id={APP_SETTINGS_SECTIONS.about} title="About" testId="about-block">
            <SettingsCard>
              <dl className="about-list">
                <dt>Version</dt>
                <dd>
                  {appInfo.version}
                  {isDevBuild(appInfo.version) && (
                    <span title={devBuildLabel(appInfo.version)}>
                      {' '}
                      <Badge tone="info">Dev build</Badge>
                    </span>
                  )}
                  {appInfo.mockAdapter && (
                    <span title="This build can run scripted projects without a connection.">
                      {' '}
                      <Badge tone="accent">Mock adapter</Badge>
                    </span>
                  )}
                </dd>
                <dt>Made by</dt>
                <dd>
                  <a className="connector-link" href={MAKER_URL} target="_blank" rel="noreferrer noopener" data-testid="about-maker">
                    {MAKER_NAME}
                  </a>
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
              <p className="about-ask">
                <span className="muted">Not sure where something is?</span>{' '}
                <Button size="sm" testId="ask-orgai-button" onClick={() => void askOrgAI()}>
                  Ask OrgAI about itself
                </Button>
              </p>
            </SettingsCard>
          </SettingsSection>
        )}
      </SettingsPage>
    </>
  )
}
