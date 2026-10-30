/** Clamp an agent- or registry-provided label to `max` characters (adds an ellipsis). Plain text only. */
export function clampLabel(s: string, max = 80): string {
  const t = String(s ?? '')
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t
}
