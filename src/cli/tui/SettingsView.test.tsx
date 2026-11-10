/**
 * /settings (cli-parity 3.7): Project, Tiers and App rows at 80 and 120 columns, edits through the commands'
 * validators (setPatch, permissionModeArg, planTierChange with the touched roles, parseSettingValue), the automatic
 * staffing spend confirmation, errors in place and read-only rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeConfig, fixtureProject, mountView, TIERS, tick } from './configTestUtil'
import { char, env, key } from './panes/testUtil'
import { settingRows } from './settingsModel'
import { SETTINGS_LIVE_NOTE, SettingsView, type SettingsViewProps } from './SettingsView'

const ENV = env({ color: false })
const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

async function settings(width: number, over: Partial<SettingsViewProps> = {}, api = fakeConfig()) {
  const onClose = vi.fn()
  const v = mountView(() => <SettingsView width={width} height={30} env={ENV} projectId="p1" api={api} onClose={onClose} {...over} />, ENV)
  mounted.push(v.r)
  await tick(60)
  const rows = settingRows({ project: api.stored, connections: await api.connections(), catalog: await api.models(), settings: await api.settings() })
  /** Move the selection to the row with this id. */
  const select = async (id: string): Promise<void> => {
    const at = rows.findIndex((r) => r.id === id)
    if (at < 0) throw new Error(`no row ${id}`)
    await v.keys(key('home'), ...Array.from({ length: at }, () => key('down')))
  }
  return { ...v, api, onClose, select }
}

const widest = (frame: string): number => Math.max(...frame.split('\n').map((l) => [...l].length))
const joined = (f: string): string => f.replace(/\s*│\n│\s*/g, ' ')

describe('Settings view', () => {
  it('shows the three groups with current values at 120 columns; read-only rows are marked', async () => {
    const v = await settings(120)
    const f = v.frame()
    expect(f).toContain('Settings of App')
    expect(f).toContain('Project')
    expect(f).toMatch(/> Staffing mode\s+fixed/)
    expect(f).toMatch(/Staffing goal\s+balanced/)
    expect(f).toMatch(/Permission mode\s+default/)
    expect(f).toMatch(/Budget cap\s+no cap/)
    expect(f).toMatch(/Subagent depth\s+auto \(/)
    expect(widest(f)).toBeLessThanOrEqual(120)
    await v.select('tiers:deep')
    const g = v.frame()
    expect(g).toContain('Tiers')
    expect(g).toMatch(/Connection\s+Anthropic \(read-only\)/)
    expect(g).toMatch(/> deep\s+claude-opus-5\s+discovered, 200k context/)
    await v.select('app:communityPrices')
    expect(v.frame()).toContain('App (orgai settings)')
    expect(v.frame()).toMatch(/> communityPrices\s+off/)
  })

  it('fits 80 columns: descriptions are cut first, values stay', async () => {
    const v = await settings(80)
    const f = v.frame()
    expect(widest(f)).toBeLessThanOrEqual(80)
    expect(f).toMatch(/Staffing mode\s+fixed/)
    expect(f).toMatch(/Review merges\s+off/)
    expect(f).toContain('Enter edit')
    await v.select('tiers:everyday')
    expect(v.frame()).toMatch(/everyday\s+claude-sonnet-5/)
    expect(widest(v.frame())).toBeLessThanOrEqual(80)
  })

  it('toggles an on/off project setting through projects set validation and projects:save', async () => {
    const v = await settings(100, { liveRun: true })
    await v.select('project:review-merges')
    await v.keys(key('enter'))
    expect(v.api.saves).toHaveLength(1)
    expect(v.api.saves[0].reviewMerges).toBe(true)
    const f = joined(v.frame())
    expect(f).toContain('Saved review merges.')
    expect(f).toContain(SETTINGS_LIVE_NOTE)
    expect(v.frame()).toMatch(/> Review merges\s+on/)
  })

  it('automatic staffing asks first with the same "may spend more" sentence as projects set', async () => {
    const v = await settings(100)
    await v.keys(key('enter'))
    // auto, fixed (current): pick auto.
    await v.keys(key('home'), key('enter'))
    const f = joined(v.frame())
    expect(f).toContain('May spend more: Automatic staffing lets each report run at a higher tier or effort')
    await v.keys(char('n'))
    expect(v.api.saves).toHaveLength(0)
    await v.keys(key('enter'), key('home'), key('enter'), char('y'))
    expect(v.api.saves).toHaveLength(1)
    expect(v.api.saves[0].staffing).toBeUndefined()
    expect(v.frame()).toMatch(/Staffing mode\s+auto/)
  })

  it('a bad value is refused in place with the command\'s own words', async () => {
    const v = await settings(100)
    await v.select('project:keep-runs')
    await v.keys(key('enter'))
    for (let i = 0; i < 4; i++) await v.keys(key('backspace'))
    await v.keys(char('0'), key('enter'))
    expect(joined(v.frame())).toContain('--keep-runs must be a whole number from 1 to 5000, or auto.')
    expect(v.api.saves).toHaveLength(0)
  })

  it('a tier change shows the roles it touches before y, then goes to connections:update', async () => {
    const v = await settings(100, {}, fakeConfig(fixtureProject()))
    await v.select('tiers:fast')
    await v.keys(key('enter'))
    expect(v.frame()).toContain('fast on Anthropic')
    // Catalog order: fable, opus, sonnet, haiku (current), legacy, then reset. Pick claude-legacy-1.
    await v.keys(key('down'), key('enter'))
    const f = joined(v.frame())
    expect(f).toContain(`fast: ${TIERS.fast} -> claude-legacy-1`)
    expect(f).toContain(`App / Intern (fast): ${TIERS.fast} -> claude-legacy-1`)
    expect(v.api.connectionUpdates).toHaveLength(0)
    await v.keys(char('y'))
    expect(v.api.connectionUpdates).toHaveLength(1)
    expect(v.api.connectionUpdates[0].tierModels.fast).toBe('claude-legacy-1')
    expect(joined(v.frame())).toContain('Anthropic: tiers saved (fast).')
  })

  it('edits an app setting with the orgai settings validator', async () => {
    const v = await settings(100)
    await v.select('app:communityPrices')
    await v.keys(key('enter'))
    expect(v.api.settingSets).toEqual([{ communityPrices: true }])
    await v.select('app:defaultKeepRuns')
    await v.keys(key('enter'), key('backspace'), key('backspace'), key('backspace'), char('x'), key('enter'))
    expect(joined(v.frame())).toContain('defaultKeepRuns: use a whole number')
    expect(v.api.settingSets).toHaveLength(1)
  })

  it('a read-only row says where it is changed; Esc closes; a read-only session refuses edits', async () => {
    const v = await settings(100)
    await v.select('tiers:connection')
    await v.keys(key('enter'))
    expect(joined(v.frame())).toContain('Connection is read-only here. Move the project with: orgai projects set --connection <id>')
    await v.keys(key('escape'))
    expect(v.onClose).toHaveBeenCalledTimes(1)
    const ro = await settings(100, { readOnly: 'Another orgai owns this data folder.' })
    await ro.keys(key('enter'))
    expect(joined(ro.frame())).toContain('Read-only: Another orgai owns this data folder.')
    expect(ro.api.saves).toHaveLength(0)
  })

  it('shows a host error in place, cleaned for the terminal', async () => {
    const api = fakeConfig()
    api.failSave = 'refused: \x1b]0;title\x07locked'
    const v = await settings(100, {}, api)
    await v.select('project:isolate-writers')
    await v.keys(key('enter'))
    const f = v.frame()
    expect(f).toContain('refused:')
    expect(f).toContain('locked')
    expect(f).not.toContain('\x07')
  })
})
