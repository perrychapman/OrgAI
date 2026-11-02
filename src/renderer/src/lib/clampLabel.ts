/** Bidi, zero-width and control characters (same set as decisionTitle.ts); a label never carries them. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏؜﻿‪-‮⁦-⁩]+/g

/** Clamp an agent- or registry-provided label to `max` characters (adds an ellipsis). Plain text only; hidden characters become a space. */
export function clampLabel(s: string, max = 80): string {
  const t = String(s ?? '')
    .replace(CONTROL, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t
}
