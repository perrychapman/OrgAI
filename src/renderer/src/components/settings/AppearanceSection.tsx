import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import type { AppearanceSettings, ThemeMode } from '@shared/types'
import { DEFAULT_APPEARANCE } from '@shared/defaults'
import { normalizeHex } from '../../lib/theme'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { SegmentedControl } from '../ui/SegmentedControl'
import { SettingRow } from '../ui/SettingRow'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

/** Accent choices; the first is the default. Any other colour can be typed as hex. */
export const ACCENT_SWATCHES: { name: string; hex: string }[] = [
  { name: 'Violet', hex: DEFAULT_APPEARANCE.accent },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Green', hex: '#22a559' },
  { name: 'Amber', hex: '#d98e04' },
  { name: 'Rose', hex: '#e5486a' }
]

const MODES: { value: ThemeMode; label: string; note: string }[] = [
  { value: 'dark', label: 'Dark', note: 'Default' },
  { value: 'light', label: 'Light', note: '' },
  { value: 'system', label: 'Match my computer', note: '' }
]

const MOTION_OPTIONS: { value: AppearanceSettings['reduceMotion']; label: string }[] = [
  { value: 'system', label: 'Match my computer' },
  { value: 'on', label: 'Always reduce' }
]

/**
 * App settings > Appearance (ui-overhaul Appearance board): colour mode as three picture cards (a native radio group),
 * the accent colour, motion and, beside them at wide widths, a small preview drawn with the live tokens. Every choice
 * applies at once through `onChange` (theme.ts applies it, the page saves it).
 */
export function AppearanceSection({ appearance, onChange }: { appearance: AppearanceSettings; onChange: (p: Partial<AppearanceSettings>) => void }): ReactElement {
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const [customRequested, setCustomRequested] = useState(false)
  const focusHex = useRef(false)
  // The Custom swatch revealed the hex field: move focus into it.
  useEffect(() => {
    if (!focusHex.current) return
    focusHex.current = false
    document.getElementById('accent-hex')?.focus()
  })
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
  /** Apply the typed colour on Enter or blur, not on every keystroke. */
  const commitHex = (): void => {
    const hex = normalizeHex(hexValue)
    if (hex && hex !== appearance.accent) onChange({ accent: hex })
    if (hex) setHexDraft(null)
  }
  const setAccent = (hex: string): void => {
    setHexDraft(null)
    setCustomRequested(false)
    onChange({ accent: hex })
  }
  // Radio group keys: arrows move and select (native radios do this; the cards are labels around them).
  return (
    <div className="appearance-layout">
      <div className="appearance-main">
        <SettingsSection id="appsettings-section-appearance" title="Colour mode" testId="appearance-section">
          <div className="settings-card appearance-modes-card">
            <div className="appearance-modes" role="radiogroup" aria-label="Colour mode" data-testid="theme-mode-cards">
              {MODES.map((m) => (
                <label key={m.value} className={`appearance-mode${appearance.theme === m.value ? ' is-on' : ''}`} data-mode={m.value}>
                  <input
                    type="radio"
                    className="appearance-mode-input"
                    name="theme-mode"
                    value={m.value}
                    checked={appearance.theme === m.value}
                    onChange={() => onChange({ theme: m.value })}
                  />
                  <span className="appearance-mode-art" aria-hidden="true">
                    <span className="appearance-mode-pane" />
                    <span className="appearance-mode-body">
                      <span className="appearance-mode-bar" />
                      <span className="appearance-mode-tiles">
                        <span />
                        <span />
                        <span />
                      </span>
                    </span>
                  </span>
                  <span className="appearance-mode-label">
                    <span className="appearance-mode-name">{m.label}</span>
                    {m.note && <span className="appearance-mode-note">{m.note}</span>}
                    {appearance.theme === m.value && <Check className="appearance-mode-check" size={14} aria-hidden="true" />}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </SettingsSection>
        <SettingsSection id="appsettings-section-look" title="Colour and motion">
          <SettingsCard>
            <SettingRow
              title="Accent colour"
              id="accent-title"
              description="Buttons, selection and the brand colour. Working, waiting and done keep their own colours."
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
              description="Reduced keeps state changes and drops ambient movement. Your computer's own reduce-motion setting always wins."
              width="select"
              control={<SegmentedControl label="Motion" value={appearance.reduceMotion} options={MOTION_OPTIONS} onChange={(reduceMotion) => onChange({ reduceMotion })} />}
            />
          </SettingsCard>
        </SettingsSection>
      </div>
      <aside className="appearance-preview" aria-label="Preview">
        <div className="settings-group-title" aria-hidden="true">
          Preview
        </div>
        <div className="appearance-preview-panel glass" data-testid="appearance-preview">
          <div className="appearance-preview-head">
            <span className="appearance-preview-avatar" aria-hidden="true">
              O
            </span>
            <span className="appearance-preview-who">
              <span className="appearance-preview-name">Orchestrator</span>
              <span className="appearance-preview-doing">Coordinating the team</span>
            </span>
          </div>
          <div className="appearance-preview-row is-working">
            <span className="appearance-preview-dot is-live" aria-hidden="true" />
            <span>Working</span>
          </div>
          <div className="appearance-preview-row is-waiting">
            <span className="appearance-preview-dot" aria-hidden="true" />
            <span>Waiting on you</span>
          </div>
          <div className="appearance-preview-row is-done">
            <span className="appearance-preview-dot" aria-hidden="true" />
            <span>Done</span>
          </div>
          <div className="appearance-preview-actions" aria-hidden="true">
            <span className="appearance-preview-btn is-primary">Approve</span>
            <span className="appearance-preview-btn">Not now</span>
          </div>
        </div>
        <p className="appearance-preview-note">The preview uses your current colour mode, accent and motion.</p>
      </aside>
    </div>
  )
}
