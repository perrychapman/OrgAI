/**
 * The app's one date format for "when" lines (ux-review-knowledge L1, engagement-3 L8): day-month-year as
 * "4 Nov 2026" everywhere, never the locale's "Nov 4, 2026". Times are 24-hour, local.
 */

const DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }

const valid = (ms: number | undefined): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0

/** "4 Nov 2026"; '' for a missing or unusable time. */
export function formatDate(ms: number | undefined): string {
  return valid(ms) ? new Date(ms).toLocaleDateString('en-GB', DAY) : ''
}

/** "4 Nov 2026 11:46" (local time, 24-hour); '' for a missing or unusable time. */
export function formatDateTime(ms: number | undefined): string {
  if (!valid(ms)) return ''
  const d = new Date(ms)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${formatDate(ms)} ${time}`
}

/** The full local date and time for a `title` attribute; '' when unusable. */
export function formatFullDateTime(ms: number | undefined): string {
  return valid(ms) ? new Date(ms).toLocaleString() : ''
}
