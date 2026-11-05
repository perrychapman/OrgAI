import type { ConnectorDef } from '@shared/types'

/** First letter(s) for the logo tile. */
export function connectorInitial(def: Pick<ConnectorDef, 'name'>): string {
  const words = def.name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : words[0][0].toUpperCase()
}

/** A stable hue (0-359) per connector id, for the initial tile. */
export function connectorHue(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}
