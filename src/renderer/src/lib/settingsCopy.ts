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
    more: "Unattended lets the model's safety check decide each call and asks only when it is unsure. Saved permission rules never ask. Other modes show approval cards in the live view."
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
  /** Legacy row only (Permissions > Advanced, shown while autoContinue is false); see config-review spec 4.2. */
  autoContinue: {
    label: 'Keep going until the plan is complete',
    description: 'Re-prompts when plan steps remain.',
    more: 'It does not nudge while reports are running, a card waits for you or the run is stopping. It stops for real decisions and when you interrupt a turn, until you reply.'
  },
  maxAutoContinues: {
    label: 'Max automatic continues per run',
    description: 'Stops nudging a run after this many.'
  },
  planGuard: {
    label: 'Plan guard',
    description: 'Uses the everyday tier when the weekly window passes 80%.'
  },
  windowShare: {
    label: 'Stop at a share of the five-hour window (%)',
    description: 'Stops a run that uses more than this share.'
  },
  maxSubagentDepth: {
    label: 'Max subagent depth',
    description: '1 means reports cannot create subagents.'
  },
  maxConcurrentSubagents: {
    label: 'Max concurrent subagents',
    description: 'Reports that may run at once.'
  },
  reviewMerges: {
    label: "Review each report's changes before merge",
    description: 'You merge, hold or discard each diff.'
  },
  runMessaging: {
    label: 'Let runs message each other',
    description: 'Orchestrators can exchange short notes.'
  },
  teamAssistant: {
    label: 'Team assistant'
  },
  /** @deprecated Replaced by planGuard (config-review spec 5); deleted after the pane work. */
  preferEveryday: {
    label: 'Use the everyday tier near the limit',
    description: 'Starts reports on the everyday tier when the plan window nears its limit.',
    more: 'Applies when the plan window for the deep tier (or the seven-day window, on plans without one) is at or above the threshold set in App settings. Agents already running are not changed.'
  },
  /** @deprecated The weekly threshold row is gone (fixed at 80); deleted after the pane work. */
  opusThreshold: {
    label: 'Weekly usage threshold',
    description: 'Percent of the weekly window.',
    more: 'Used by every project that turns on "Use the everyday tier near the limit".'
  }
} as const satisfies Record<string, SettingCopy>

export type SettingCopyKey = keyof typeof SETTINGS_COPY

/** Connection names as shown in the project picker, the Connections pane and the connection lines. */
export const CONNECTION_NAME = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' } as const

/** @deprecated The Default connection select is gone (config-review spec 3); deleted after the pane work. */
export const DEFAULT_CONNECTION_COPY = {
  label: 'Default connection',
  description: 'New projects only. Change an existing project in its Settings > Connection.'
} as const

/** Plan guard line on a subscription project's Limits pane (planGuardOf; config-review spec 4.3). */
export const PLAN_GUARD_LINE = {
  auto: 'Plan guard: automatic. Stops near your five-hour limit and uses the everyday tier when the weekly window passes 80%.',
  on: 'Plan guard: on. Uses the everyday tier when the weekly window passes 80%.',
  off: 'Plan guard: off.'
} as const

/** Team assistant select (Permissions > Advanced): option labels and the selected option's description. */
export const TEAM_ASSISTANT_COPY = {
  off: { label: 'Off', description: 'Never looks for missing tools or skills.' },
  free: { label: 'Free checks', description: 'Checks your runs without the model.' },
  ai: { label: 'AI suggestions', description: 'Also asks the model; sends the names of found tools and skills.' }
} as const

/** Worktree isolation row description by its automatic state (Permissions > Advanced). */
export const ISOLATE_WRITERS_STATE = {
  auto: 'Automatic: git repository found.',
  noGit: 'Off: not a git repository.',
  off: 'Off for this project.'
} as const
