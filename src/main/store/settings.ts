import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, PermissionMode, ProviderAuth } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan']

/** Merge whatever is on disk (or sent by the renderer) over the defaults, dropping anything malformed. */
export function normalizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const d = DEFAULT_APP_SETTINGS
  const r = raw ?? {}
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  const auth = (v: unknown): ProviderAuth => {
    const a = v as Partial<{ kind: string; envVar: string }> | undefined
    if (a?.kind === 'apiKey') return { kind: 'apiKey', envVar: str(a.envVar, 'ANTHROPIC_API_KEY') }
    if (a?.kind === 'subscription') return { kind: 'subscription' }
    return { ...d.providerAuth }
  }
  const budget = r.defaultMaxBudgetUsd
  const keep = Number(r.defaultKeepRuns)
  const threshold = Number(r.opusGuardThreshold)
  return {
    defaultPermissionMode: PERMISSION_MODES.includes(r.defaultPermissionMode as PermissionMode)
      ? (r.defaultPermissionMode as PermissionMode)
      : d.defaultPermissionMode,
    defaultMaxBudgetUsd: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : d.defaultMaxBudgetUsd,
    defaultKeepRuns: Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : d.defaultKeepRuns,
    defaultIsolateWriters: typeof r.defaultIsolateWriters === 'boolean' ? r.defaultIsolateWriters : d.defaultIsolateWriters,
    defaultRootModel: str(r.defaultRootModel, d.defaultRootModel),
    defaultReportModel: str(r.defaultReportModel, d.defaultReportModel),
    providerAuth: auth(r.providerAuth),
    notifications: typeof r.notifications === 'boolean' ? r.notifications : d.notifications,
    opusGuardThreshold:
      r.opusGuardThreshold != null && Number.isFinite(threshold) && threshold >= 1 && threshold <= 100 ? threshold : d.opusGuardThreshold,
    defaultPreferSonnetNearLimit:
      typeof r.defaultPreferSonnetNearLimit === 'boolean' ? r.defaultPreferSonnetNearLimit : d.defaultPreferSonnetNearLimit
  }
}

/** Global app settings, stored as settings.json next to projects.json. */
export class SettingsStore {
  private file: string
  private settings: AppSettings = normalizeSettings(null)

  constructor(readonly dataDir: string) {
    this.file = join(dataDir, 'settings.json')
    // Exists up front so "Open folder" works before anything has been saved.
    mkdirSync(dataDir, { recursive: true })
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { settings?: Partial<AppSettings> }
        this.settings = normalizeSettings(parsed.settings)
      }
    } catch (e) {
      console.error('Failed to read settings.json, using defaults:', e)
      this.settings = normalizeSettings(null)
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, settings: this.settings }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  get(): AppSettings {
    return { ...this.settings, providerAuth: { ...this.settings.providerAuth } }
  }

  set(next: Partial<AppSettings>): AppSettings {
    this.settings = normalizeSettings(next)
    this.persist()
    return this.get()
  }
}
