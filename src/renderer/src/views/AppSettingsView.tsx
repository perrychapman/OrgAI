import type { ReactElement } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { devBuildLabel, isDevBuild } from '../lib/buildChannel'
import type { AppearanceSettings, AppSettings, AppSettingsInfo, ModelPriceOverride, PermissionMode, Project } from '@shared/types'
import { PERMISSION_MODE_OPTIONS, isVirtualProjectId } from '@shared/types'
import { DEFAULT_APPEARANCE, projectKindOf } from '@shared/defaults'
import { cleanDisplayName, DISPLAY_NAME_MAX_CHARS } from '@shared/displayName'
import { NAME_NOT_SAVED, NAME_REFUSED, saveDisplayName } from '../lib/dashboardName'
import { useAppStore } from '../store/useAppStore'
import { setAppearance } from '../lib/theme'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { CopyButton } from '../components/ui/CopyButton'
import { Input } from '../components/ui/Input'
import { SettingRow, settingDescId } from '../components/ui/SettingRow'
import { Switch } from '../components/ui/Switch'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { SaveIndicator } from '../components/layout/SaveIndicator'
import type { SettingsNavGroup } from '../components/settings/SettingsNav'
import { ProjectSettingsPanes } from '../components/settings/ProjectSettingsPanes'
import { AppearanceSection } from '../components/settings/AppearanceSection'
import { SettingsSearch } from '../components/settings/SettingsSearch'
import { APP_MENU_PANES, APPEARANCE_PANE, appSettingsPaneFor, projectMenuPanes } from '../lib/settingsMenu'
import { openKeyboardShortcuts } from '../lib/menuActions'
import { SettingsAdvanced, openSettingsAdvanced } from '../components/settings/SettingsAdvanced'
import { SettingsPage } from '../components/settings/SettingsPage'
import { SettingsCard } from '../components/settings/SettingsCard'
import { SettingsGroup, SettingsSection } from '../components/settings/SettingsSection'
import { SETTINGS_COPY } from '../lib/settingsCopy'
import { permissionTitle } from '../lib/permissionWords'
import { connectionLabel } from '../lib/connectionLabel'
import { PERMISSION_MODE_TRADEOFF } from '../lib/permissionCopy'
import { modelSettingGroups, modelSources } from '../lib/assistantModels'
import { ModelSelect } from '../components/ui/ModelSelect'
import {
  ADVANCED_SECTIONS,
  APP_SETTINGS_PANES,
  APP_SETTINGS_SECTIONS,
  PROJECT_SECTION_EVENT,
  focusPaneHeading,
  normalizeProjectPane,
  takeAppSettingsSection,
  clearTeamOrigin,
  type ProjectSettingsPane
} from '../lib/settingsTarget'
import { scrollWithin } from '../lib/scrollWithin'
import ConnectionsPanel from '../components/connections/ConnectionsPanel'
import { ModelPricesSection } from '../components/settings/ModelPricesSection'
import ToolsPane from '../components/connectors/ToolsPane'
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
import { UpdatesSection } from '../components/updates/UpdatesSection'

/** Same debounce the project store uses for project saves. */
const SAVE_DELAY_MS = 350
const MAKER_NAME = 'Cybrid Software LLC'
const MAKER_URL = 'https://cybridsoftware.com'

/** Panes with a gallery and a detail panel use the wide column. */
const WIDE_PANES = new Set<string>([APP_SETTINGS_PANES.connections, APP_SETTINGS_PANES.mcpLibrary, APP_SETTINGS_PANES.skillLibrary, APP_SETTINGS_PANES.kit])

/**
 * The project whose panes the one Settings view shows in its Project group: the embedding project tab's project, else
 * the project the user last selected (none for Chat and the other virtual projects, or before any project exists).
 */
function useMenuProject(embedded: Project | undefined): Project | undefined {
  const selected = useAppStore((s) => (s.selectedProjectId && !isVirtualProjectId(s.selectedProjectId) ? s.projects.find((p) => p.id === s.selectedProjectId) : undefined))
  return embedded ?? selected
}

/**
 * About board "Report a problem", "Details for support" and "Licences". Report opens the project's new-issue page in
 * the browser (version and platform only; nothing is sent until you submit there); support details are copied (no
 * project content); the licences file opens in the system viewer.
 */
function SupportRows({ onError }: { onError: (e: string | null) => void }): ReactElement {
  const [copied, setCopied] = useState(false)
  const copyDetails = async (): Promise<void> => {
    try {
      const d = await window.orgai.about.supportDetails()
      await navigator.clipboard.writeText(d.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <>
      <SettingRow
        id="report-problem-row"
        title="Report a problem"
        description="Opens a new issue page in your browser with the version and system filled in. Nothing is sent until you submit it there."
        control={
          <Button size="sm" testId="about-report" onClick={() => void window.orgai.about.reportProblem().catch((e: Error) => onError(e.message))}>
            Report
          </Button>
        }
      />
      <SettingRow
        id="support-details-row"
        title="Details for support"
        description="Version, system and provider status. No project content."
        control={
          <Button size="sm" testId="about-support-copy" onClick={() => void copyDetails()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        }
      />
      <p className="sr-only" role="status" aria-live="polite">
        {copied ? 'Support details copied' : ''}
      </p>
      <SettingRow
        id="licences-row"
        title="Licences"
        description="Licences of Electron and Chromium, which OrgAI is built on."
        control={
          <Button
            size="sm"
            testId="about-licences"
            onClick={() =>
              void window.orgai.about
                .openLicences()
                .then((err) => onError(err || null))
                .catch((e: Error) => onError(e.message))
            }
          >
            View
          </Button>
        }
      />
    </>
  )
}

function stripInfo(info: AppSettingsInfo): AppSettings {
  const { dataDir: _dataDir, appVersion: _appVersion, ...settings } = info
  return settings
}

/**
 * "Your name" (docs/design/dashboard-overhaul.md 4.1): the Dashboard greeting's name. It saves on blur and Enter through
 * `saveDisplayName`, not the page's debounced patch, and shows an inline error under the field when that fails. While not
 * editing it follows the stored value (another window, the greeting's own field). The name is never put in a log or error.
 */
function DisplayNameRow({ stored, onSaved }: { stored: string | undefined; onSaved: (name: string | undefined) => void }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const commit = async (): Promise<void> => {
    if (draft === null) return
    const clean = cleanDisplayName(draft)
    if (draft.trim() !== '' && clean === undefined) {
      setError(NAME_REFUSED)
      return
    }
    if (clean === stored) {
      setDraft(null)
      setError(null)
      return
    }
    try {
      await saveDisplayName(clean ?? null)
      onSaved(clean)
      setDraft(null)
      setError(null)
    } catch {
      setError(`${NAME_NOT_SAVED} Try again.`)
    }
  }
  return (
    <SettingRow
      title="Your name"
      id="display-name-title"
      width="select"
      control={
        <Input
          data-testid="display-name-input"
          aria-labelledby="display-name-title"
          aria-describedby={error ? 'display-name-hint display-name-error' : 'display-name-hint'}
          value={draft ?? stored ?? ''}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          autoComplete="off"
          spellCheck={false}
          invalid={error !== null}
          onChange={(v) => {
            setDraft(v)
            setError(null)
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
          }}
        />
      }
      description={<span id="display-name-hint">Used for the greeting on Home. It stays on this computer. Leave it empty for no name.</span>}
      hint={
        error ? (
          <span className="field-error" id="display-name-error" role="alert" data-testid="display-name-error">
            {error}
          </span>
        ) : undefined
      }
    />
  )
}

/**
 * The one Settings view (ui-overhaul settings boards): App panes and the current project's panes in one menu, shown in
 * place. Rendered as the App settings view, and embedded (`project`) as a project's Settings tab, where it opens on the
 * project's remembered pane and leaves out its own topbar (the project's topbar is above it).
 */
export default function AppSettingsView({ project: embedded }: { project?: Project } = {}): ReactElement {
  const [info, setInfo] = useState<AppSettingsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const menuProject = useMenuProject(embedded)
  const [scope, setScope] = useState<'app' | 'project'>(embedded ? 'project' : 'app')
  const storedProjectPane = useAppStore((s) => (menuProject ? s.projectSettingsPane[menuProject.id] : undefined))
  const projectPane: ProjectSettingsPane = normalizeProjectPane(storedProjectPane)
  // A project pane chosen from elsewhere (a deep link sets the store's pane) shows that pane.
  const seenProjectPane = useRef(storedProjectPane)
  useEffect(() => {
    if (seenProjectPane.current === storedProjectPane) return
    seenProjectPane.current = storedProjectPane
    setScope('project')
  }, [storedProjectPane])
  useEffect(() => {
    const toProject = (): void => setScope('project')
    window.addEventListener(PROJECT_SECTION_EVENT, toProject)
    return () => window.removeEventListener(PROJECT_SECTION_EVENT, toProject)
  }, [])
  const showProject = scope === 'project' && !!menuProject
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
      if (embedded) return
      setTimeout(() => {
        if (useAppStore.getState().view !== 'appSettings') clearTeamOrigin()
      }, 0)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  // A jump from elsewhere ("App settings > Connections") opens the pane that holds its section.
  useEffect(() => {
    // Embedded in a project tab, App deep links are left for the App settings view they navigate to.
    if (embedded) return undefined
    const take = (): void => {
      const target = takeAppSettingsSection()
      if (target) {
        setScope('app')
        // A removed id (the old Defaults pane or its rows) opens General.
        setPane(appSettingsPaneFor(target) ?? APP_SETTINGS_PANES.general)
        pendingFocus.current = { section: ADVANCED_SECTIONS[target] || target === APP_SETTINGS_SECTIONS.canvas ? target : undefined }
        setFocusTick((t) => t + 1)
      }
    }
    take()
    // A jump requested while this page is already open (the MCP assistant dialog's model link).
    window.addEventListener('orgai:settings-section', take)
    return () => window.removeEventListener('orgai:settings-section', take)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // "Open in library" lands on the MCP library pane; the section there then scrolls to the entry.
  useEffect(() => {
    if (mcpFocus?.kind === 'library' && !embedded) {
      setScope('app')
      setPane(APP_SETTINGS_PANES.mcpLibrary)
    }
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
        {!embedded && (
          <div className="topbar">
            <h1>Settings</h1>
          </div>
        )}
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

  const defaultConnLabel = connectionLabel(defaultConn)
  // Main writes the login item only for a packaged Windows or macOS install (appBehaviour.ts); elsewhere the switch is off with a reason.
  const loginCapable = !!appInfo?.packaged && (appInfo.platform === 'win32' || appInfo.platform === 'darwin')
  const openPane = (id: string): void => setPane(id)

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

  const engagement = menuProject ? projectKindOf(menuProject) === 'engagement' : false
  const projectHeading = menuProject ? `${engagement ? 'Engagement' : 'Project'}: ${menuProject.name}` : ''
  const groups: SettingsNavGroup[] = [
    { key: 'app', heading: 'App', label: 'App settings sections', items: [...APP_MENU_PANES] },
    ...(menuProject ? [{ key: 'project', heading: projectHeading, label: `${projectHeading} settings sections`, items: projectMenuPanes(engagement) }] : [])
  ]
  // Only app panes render below when the project group is not showing.
  const appPane = showProject ? null : pane

  return (
    <>
      {!embedded && (
        <div className="topbar settings-topbar">
          <h1>Settings</h1>
          <SettingsSearch />
          <div className="spacer" />
          <span className="settings-autosave muted">Changes save as you make them</span>
          <SaveIndicator />
        </div>
      )}
      {!embedded && <AppNavigateBanner />}
      <SettingsPage
        idBase={embedded ? 'project-settings' : 'app-settings'}
        groups={groups}
        active={showProject ? { group: 'project', pane: projectPane } : { group: 'app', pane }}
        onSelect={(group, id) => {
          if (group === 'project' && menuProject) {
            setScope('project')
            seenProjectPane.current = id
            useAppStore.getState().setProjectSettingsPane(menuProject.id, id)
          } else {
            setScope('app')
            setPane(id)
          }
        }}
        scope={showProject ? projectHeading : 'App'}
        wide={!showProject && WIDE_PANES.has(pane)}
      >
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {showProject && menuProject && <ProjectSettingsPanes project={menuProject} pane={projectPane} />}
        {appPane === 'general' && (
          <>
            <SettingsSection id="app-settings-about-you" title="About you" testId="appsettings-section-about-you">
              <SettingsCard>
                <DisplayNameRow stored={info.displayName} onSaved={(displayName) => setInfo((i) => (i ? { ...i, displayName } : i))} />
              </SettingsCard>
            </SettingsSection>
            <SettingsSection id={APP_SETTINGS_SECTIONS.notifications} title="Notifications">
              <SettingsCard>
                <SettingRow
                  title="Notify me when a run needs attention or finishes"
                  description="A permission, a question or a review is waiting, or a run ended. Shown by your operating system while OrgAI is in the background."
                  control={
                    <Switch
                      checked={info.notifications !== false}
                      label="Notify me when a run needs attention or finishes"
                      testId="notifications-switch"
                      onChange={(notifications) => patch({ notifications }, true)}
                    />
                  }
                />
                {(
                  [
                    ['notifyNeedsMe', 'When a team needs me', 'A permission, a question or a review is waiting, a turn ends waiting for your reply, or a plan limit pauses a run.'],
                    ['notifyRunFinished', 'When a run finishes', undefined],
                    ['notifyScheduleFindings', 'When a schedule finds something', 'Quiet when there is nothing to report.']
                  ] as const
                ).map(([key, title, description]) => (
                  <SettingRow
                    key={key}
                    id={`notify-${key}-row`}
                    title={title}
                    description={info.notifications === false ? 'Turn on notifications above first.' : description}
                    control={
                      <Switch
                        checked={info.notifications !== false && info[key] !== false}
                        disabled={info.notifications === false}
                        label={title}
                        testId={`${key}-switch`}
                        describedBy={settingDescId(`notify-${key}-row`)}
                        onChange={(v) => patch({ [key]: v }, true)}
                      />
                    }
                  />
                ))}
                <SettingRow
                  id="play-sound-row"
                  title="Play a sound"
                  description="A short chime in OrgAI when a new decision starts waiting on you."
                  control={
                    <Switch
                      checked={info.playSound === true}
                      label="Play a sound"
                      testId="play-sound-switch"
                      describedBy={settingDescId('play-sound-row')}
                      onChange={(playSound) => patch({ playSound }, true)}
                    />
                  }
                />
              </SettingsCard>
            </SettingsSection>
            <SettingsSection id="appsettings-section-running" title="While OrgAI runs" testId="appsettings-section-running">
              <SettingsCard>
                <SettingRow
                  id="open-at-login-row"
                  title="Open OrgAI when I sign in"
                  description={loginCapable ? 'So schedules can run without you opening it.' : 'Only an installed OrgAI on Windows or macOS can open at sign-in.'}
                  control={
                    <Switch
                      disabled={!loginCapable}
                      checked={loginCapable && info.openAtLogin === true}
                      label="Open OrgAI when I sign in"
                      testId="open-at-login-switch"
                      describedBy={settingDescId('open-at-login-row')}
                      onChange={(openAtLogin) => patch({ openAtLogin }, true)}
                    />
                  }
                />
                <SettingRow
                  title="When I close the window"
                  description="Runs and schedules need OrgAI to keep running. Keep running hides the window while they are live; opening OrgAI again shows it. Quit still asks first while a run is working."
                  width="select"
                  control={
                    <SegmentedControl
                      label="When I close the window"
                      value={info.closeBehavior ?? 'quit'}
                      options={[
                        { value: 'keepRunning', label: 'Keep running' },
                        { value: 'quit', label: 'Quit' }
                      ]}
                      onChange={(closeBehavior) => patch({ closeBehavior }, true)}
                    />
                  }
                />
                <SettingRow
                  id="keep-awake-row"
                  title="Keep the computer awake during runs"
                  description="Only while a team is working."
                  control={
                    <Switch
                      checked={info.keepAwakeDuringRuns === true}
                      label="Keep the computer awake during runs"
                      testId="keep-awake-switch"
                      describedBy={settingDescId('keep-awake-row')}
                      onChange={(keepAwakeDuringRuns) => patch({ keepAwakeDuringRuns }, true)}
                    />
                  }
                />
              </SettingsCard>
            </SettingsSection>
            <SettingsSection
              id={APP_SETTINGS_SECTIONS.newProjects}
              title="New projects start with"
              description="Each project can change these. Existing projects keep their own."
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
                          {permissionTitle(o.value)}
                        </option>
                      ))}
                    </select>
                  }
                />
                <SettingRow
                  id="default-provider-row"
                  title="AI provider"
                  description="Chat, the helpers and new projects use the default provider."
                  control={
                    <span className="settings-inline-value">
                      <span data-testid="default-provider-name">{defaultConnLabel}</span>
                      <Button size="sm" testId="default-provider-change" onClick={() => openPane(APP_SETTINGS_PANES.connections)}>
                        Change
                      </Button>
                    </span>
                  }
                />
              </SettingsCard>
            </SettingsSection>
            <SettingsSection id="appsettings-section-this-computer" title="On this computer">
              <SettingsCard>
                <CliCommandRow />
                {appInfo && (
                  <SettingRow
                    id="data-folder-row"
                    title="Where OrgAI keeps its data"
                    description="Run history, settings and knowledge. Not your project files."
                    width="full"
                    control={
                      <span className="about-path">
                        <span className="mono settings-path" title={appInfo.dataDir}>
                          {appInfo.dataDir}
                        </span>
                        <CopyButton text={appInfo.dataDir} label="Copy data folder path" />
                        <Button size="sm" onClick={() => void window.orgai.app.openPath(appInfo.dataDir).then((err) => err && setError(err))}>
                          Open folder
                        </Button>
                      </span>
                    }
                  />
                )}
              </SettingsCard>
            </SettingsSection>
            <SettingsAdvanced paneKey="app-general">
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
                    title="Tools helper model"
                    description="Sets up and tests tools and services with you."
                    width="select"
                    control={modelSelect('Tools helper model', 'mcp-assist-model-row', info.mcpAssistModel, false, (mcpAssistModel) => patch({ mcpAssistModel }))}
                  />
                  <SettingRow
                    id="skill-assist-model-row"
                    title="Skills helper model"
                    description="Writes and revises skills."
                    width="select"
                    control={modelSelect('Skills helper model', 'skill-assist-model-row', info.skillAssistModel ?? 'deep', false, (skillAssistModel) => patch({ skillAssistModel }))}
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
                  Chat, the Tools helper and the Skills helper run on {defaultConnLabel}, the default provider. Setup uses each project's provider.
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
            </SettingsAdvanced>
          </>
        )}
        {appPane === APPEARANCE_PANE && (
          <>
            <AppearanceSection appearance={appearance} onChange={(p) => patchAppearance(p)} />
            <CanvasSection canvas={appearance.canvas} onChange={(canvas) => patchAppearance({}, canvas)} />
          </>
        )}
        {appPane === 'connections' && (
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
        {appPane === 'mcp-library' && <ToolsPane />}
        {appPane === 'skill-library' && <SkillLibrarySection />}
        {appPane === 'kit' && <TemplatesSection />}
        {appPane === 'kit' && <KitSection />}
        {appPane === 'about' && appInfo && (
          <UpdatesSection autoCheck={info.autoUpdateCheck !== false} onAutoCheckChange={(autoUpdateCheck) => patch({ autoUpdateCheck }, true)} />
        )}
        {appPane === 'about' && appInfo && (
          <SettingsSection id={APP_SETTINGS_SECTIONS.about} title="About OrgAI" testId="about-block">
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
            </SettingsCard>
          </SettingsSection>
        )}
        {appPane === 'about' && appInfo && (
          <SettingsSection id="appsettings-section-help" title="Help" testId="about-help">
            <SettingsCard>
              <SettingRow
                id="ask-orgai-row"
                title="Ask how OrgAI works"
                description="Chat answers from the built-in guide and can take you to the right place."
                control={
                  <Button size="sm" testId="ask-orgai-button" onClick={() => void askOrgAI()}>
                    Ask OrgAI about itself
                  </Button>
                }
              />
              <SettingRow
                id="shortcuts-row"
                title="Keyboard shortcuts"
                control={
                  <Button size="sm" testId="about-shortcuts" onClick={openKeyboardShortcuts}>
                    Show shortcuts
                  </Button>
                }
              />
              <SupportRows onError={setError} />
            </SettingsCard>
          </SettingsSection>
        )}
      </SettingsPage>
    </>
  )
}
