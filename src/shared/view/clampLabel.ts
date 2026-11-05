import { HIDDEN_OR_CONTROL_RUN } from './hiddenChars'

/** Clamp an agent- or registry-provided label to `max` characters (adds an ellipsis). Plain text only; hidden characters become a space. */
export function clampLabel(s: string, max = 80): string {
  const t = String(s ?? '')
    .replace(HIDDEN_OR_CONTROL_RUN, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t
}
