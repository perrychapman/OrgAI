/**
 * Label, one-line description and optional long rationale for the settings that exist on both settings pages (the
 * project's own value and the App settings default for new projects). Both pages read from this table so the wording
 * is identical. Rules: `description` is at most 12 words and never names internal tools (set_plan, ask_user,
 * mark_blocked); a row whose label already says it all has none; anything longer goes in `more`, which `SettingRow`
 * shows behind "Learn more". The permission-mode row shows the selected mode's own sentence instead of a description.
 */
export interface SettingCopy {
  label: string
  description?: string
  /** Long explanation, shown behind a "Learn more" disclosure. */
  more?: string
}

export const SETTINGS_COPY = {
  permissionMode: {
    label: 'Permission mode',
    more: 'Unattended lets Claude decide each call and asks only when it is unsure. Saved permission rules never ask. Other modes show approval cards in the live view.'
  },
  costCap: {
    label: 'Estimated-cost cap per run',
    description: 'Stops a run above this USD cost. Blank: no cap.',
    more: 'Measured at API prices. On a subscription this is a safety cap, not money you are billed.'
  },
  keepRuns: {
    label: 'Runs to keep',
    description: 'Older finished runs are deleted.',
    more: 'Cleanup happens when a run ends. Runs still in progress are never deleted.'
  },
  isolateWriters: {
    label: 'Isolate writers in worktrees',
    description: 'Writers work in their own git copy.',
    more: 'When a report finishes, the harness commits its changes and merges them into the main checkout. Conflicts go back to the orchestrator. Needs a git repository.'
  },
  autoContinue: {
    label: 'Keep going until the plan is complete',
    description: 'Re-prompts when plan steps remain.',
    more: 'It does not nudge while reports are running, a card waits for you or the run is stopping. It stops for real decisions and when you interrupt a turn, until you reply.'
  },
  maxAutoContinues: {
    label: 'Max automatic continues per run'
  },
  preferSonnet: {
    label: 'Prefer Sonnet near the Opus limit',
    description: 'Starts reports on Sonnet above the Opus threshold.',
    more: 'Applies when the Opus weekly window (or the seven-day window, on plans without one) is at or above the threshold set in App settings. Agents already running are not changed.'
  },
  opusThreshold: {
    label: 'Opus weekly threshold',
    description: 'Percent of the weekly window.',
    more: 'Used by every project that turns on "Prefer Sonnet near the Opus limit".'
  }
} as const satisfies Record<string, SettingCopy>

export type SettingCopyKey = keyof typeof SETTINGS_COPY
