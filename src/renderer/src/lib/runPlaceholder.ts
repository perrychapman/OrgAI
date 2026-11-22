import type { RunSummary } from '@shared/types'

/**
 * A window learns of a run either from its record (runs:get) or from an event. An event for a run the store has not
 * loaded yet (a trailing run.usage after idle, while a just-opened run window is still loading) creates a placeholder whose
 * status is the default 'starting'. Once the record arrives, the record's run state wins unless a run.status event reached
 * this window since the placeholder was made: events and replies share one ordered channel, so a status event that arrived
 * first is at least as new as the record, and without one the record is the newest status there is. Without this the
 * window stayed on 'starting' while main said 'idle' (CI macOS, e2e/model-switch.mjs).
 */
export function adoptRecordRunState(placeholder: RunSummary, record: RunSummary, statusSeen: boolean): RunSummary {
  if (statusSeen) return placeholder
  const { status, endedAt, error, pausedUntil, pauseReason, autoResume, sessionId, endedBy, endedWhile } = record
  return {
    ...placeholder,
    status,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(pausedUntil !== undefined ? { pausedUntil } : {}),
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    ...(autoResume !== undefined ? { autoResume } : {}),
    ...(sessionId !== undefined && placeholder.sessionId === undefined ? { sessionId } : {}),
    ...(endedBy !== undefined ? { endedBy } : {}),
    ...(endedWhile !== undefined ? { endedWhile } : {})
  }
}
