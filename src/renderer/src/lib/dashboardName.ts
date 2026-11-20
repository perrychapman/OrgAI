import { cleanDisplayName } from '@shared/displayName'

/**
 * Save AppSettings.displayName through settings:set (docs/design/dashboard-overhaul.md 4.1): read, merge, write, serialised
 * like saveSchedulesPaused. `null` or an empty name clears it: main merges `{...stored, ...payload}`, so the payload
 * carries an own `displayName: undefined` (a missing key would keep the stored name).
 *
 * The name is never put in an error, log or console line. A refused name (hidden characters, over 40) throws
 * `REFUSED`; a result that does not hold what was asked throws `NOT_SAVED`.
 */
export const NAME_NOT_SAVED = 'The name was not saved.'
export const NAME_REFUSED = 'Use up to 40 letters, numbers or spaces.'

let nameQueue: Promise<unknown> = Promise.resolve()

export function saveDisplayName(name: string | null): Promise<void> {
  const wanted = name === null ? undefined : cleanDisplayName(name)
  const refused = name !== null && name.trim() !== '' && wanted === undefined
  const run = async (): Promise<void> => {
    if (refused) throw new Error(NAME_REFUSED)
    const info = await window.orgai.settings.get()
    const { dataDir: _dataDir, appVersion: _appVersion, ...settings } = info
    const saved = await window.orgai.settings.set({ ...settings, displayName: wanted })
    // Main keeps only what its normaliser accepts: trust the saved value only.
    if (saved?.displayName !== wanted) throw new Error(NAME_NOT_SAVED)
  }
  const result = nameQueue.then(run, run)
  nameQueue = result.catch(() => undefined)
  return result
}
