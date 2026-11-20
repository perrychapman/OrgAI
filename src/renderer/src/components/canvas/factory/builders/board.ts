// Plan board (Factory Floor sections 1.1 and 4.6): a 6 m wide panel that leans back towards the north wall so it faces the
// overhead camera, with twelve step lamps in two rows. Origin at the board's footprint centre (25, -9.5) on the deck's top
// surface.
//
// Slice 3: board() carries the frame and the panel only. The twelve lamps are twelve instances of boardLamp() (one lens part
// with instanceColor, already tilted onto the panel normal) placed by the engine at the anchors `lamp.0` to `lamp.11`
// (rotY 0, translation only), so each step takes its own colour from boardLampColour().
import type { BufferGeometry } from 'three'
import { FACTORY_PALETTE } from '../../../../lib/factory/palette'
import { box, cyl, merge, place, quad } from './geo'
import { part } from './common'
import type { Anchor, FactoryTheme, FactoryTokenColours, ObjectKit } from './types'

const PANEL_W = 6
const PANEL_H = 1.5
const PANEL_T = 0.12
const PANEL_BOTTOM = 0.9
/** Rotation about +x in radians: the panel's top leans north (towards -z). */
const LEAN = -0.55
/** The panel's lower edge sits this far south of the origin so its top clears the north wall. */
const FRONT_Z = 0.8
const LAMP_R = 0.22
const LAMP_H = 0.07

export const BOARD_LAMPS = 12

/** Position of lamp i (0 to 11) in the board frame: two rows of six on the panel face. */
export function boardLampPosition(i: number): { x: number; y: number; z: number } {
  const col = i % 6
  const row = Math.floor(i / 6)
  const x = (col - 2.5) * 0.95
  const v = row === 0 ? 1.0 : 0.5
  const up = { y: Math.cos(LEAN), z: Math.sin(LEAN) }
  const normal = { y: -Math.sin(LEAN), z: Math.cos(LEAN) }
  const lift = PANEL_T / 2 + LAMP_H / 2
  return {
    x,
    y: PANEL_BOTTOM + v * up.y + lift * normal.y,
    z: FRONT_Z + v * up.z + lift * normal.z
  }
}

export function board(): ObjectKit {
  const frame: BufferGeometry[] = [
    box(0.12, PANEL_BOTTOM + 0.1, 0.12, -PANEL_W / 2 + 0.3, 0, FRONT_Z),
    box(0.12, PANEL_BOTTOM + 0.1, 0.12, PANEL_W / 2 - 0.3, 0, FRONT_Z),
    box(PANEL_W - 0.4, 0.1, 0.3, 0, 0, FRONT_Z)
  ]
  const panel: BufferGeometry[] = [place(box(PANEL_W, PANEL_H, PANEL_T, 0, 0, 0), 0, PANEL_BOTTOM, FRONT_Z, 0, LEAN)]
  const anchors: Record<string, Anchor> = { label: { x: 0, y: 2.7, z: 0, rotY: 0 } }
  for (let i = 0; i < BOARD_LAMPS; i++) {
    const p = boardLampPosition(i)
    anchors[`lamp.${i}`] = { x: p.x, y: p.y, z: p.z, rotY: 0 }
  }
  return {
    name: 'board',
    parts: [part('board.frame', merge(frame), 'console'), part('board.panel', merge(panel), 'boardPanel')],
    anchors
  }
}

/**
 * One plan-step lamp lens, origin at its centre (a `lamp.i` anchor), its axis along the panel normal: a 0.44 m domed disc,
 * 0.07 m thick, 10 sides (40 triangles), part 'boardLamp.lens', and (slice 4) a flat check mark lying on the lens face, part
 * 'lamp.mark' (4 triangles). Both have instanceColor and are unlit; 44 triangles in all.
 *
 * The check is two 0.06 m bars 4 mm above the lens face (a short leg down-left, a long leg up-right, as seen on the board).
 * The engine colours it with boardLampMarkColour: the dark panel colour on a done step and the lens's own colour on every
 * other state, so the check exists only on done lamps and the two unlit colours match exactly at any hall dimming. (An
 * earlier ring round the lens was dropped: the lamp pitch leaves 6 cm between rows, and a ring in the panel colour read as a
 * lighter halo on the lit panel.)
 */
export function boardLamp(): ObjectKit {
  // A cylinder's axis is +y; tilt it onto the panel normal (the same rotation the old merged lamps used).
  const tilt = Math.PI / 2 + LEAN
  const lens = place(cyl(LAMP_R * 0.78, LAMP_R, LAMP_H, 10, 0, -LAMP_H / 2, 0), 0, 0, 0, 0, tilt)
  // In the lens frame (before the tilt): +x is the board's east, +z is down the panel.
  const y = LAMP_H / 2 + 0.004
  const t = 0.06
  const short = quad(0.12, t, -0.065, y, 0.03, -Math.PI / 4)
  const long = quad(0.21, t, 0.035, y, -0.015, 0.82)
  const mark = place(merge([short, long]), 0, 0, 0, 0, tilt)
  return {
    name: 'boardLamp',
    parts: [
      part('boardLamp.lens', lens, 'lamp', { cast: false, receive: false, instanceColor: true }),
      part('lamp.mark', mark, 'lamp', { cast: false, receive: false, instanceColor: true })
    ]
  }
}

/**
 * Colour of the 'lamp.mark' check: the dark panel colour on a done step (a dark check on the pale mint lens, 12:1 or more),
 * and the lens's own colour on every other state, so the check is invisible there. Both are unlit, so they match at any dimming.
 */
export function boardLampMarkColour(
  theme: FactoryTheme,
  state: 'pending' | 'active' | 'done' | 'blocked' | 'skipped',
  tokens: FactoryTokenColours
): string {
  return state === 'done' ? FACTORY_PALETTE[theme].roles.boardPanel : boardLampColour(theme, state, tokens)
}

function mix(a: string, b: string, t: number): string {
  const n = (h: string): number[] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
  const x = n(a)
  const y = n(b)
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

/**
 * Lens colour per step state. The lens is the only part of the lamp that changes, so each state differs from the next by
 * more than hue:
 *   pending, skipped   the off colour (dark theme: `lampOff` as is; light theme: `lampOff` sunk 45 percent towards the panel);
 *   active             the success token, full strength;
 *   done               the success token mixed 62 percent towards white (a pale mint), clearly lighter than active;
 *   blocked            the warning token (amber).
 * Active and done share a hue family by design (both are "going well"); lightness separates them in both themes (checked in
 * the tests). Slice 4 adds the shape cue: a done lamp also shows a dark check (the 'lamp.mark' part, boardLampMarkColour).
 */
export function boardLampColour(
  theme: FactoryTheme,
  state: 'pending' | 'active' | 'done' | 'blocked' | 'skipped',
  tokens: FactoryTokenColours
): string {
  switch (state) {
    case 'active':
      return tokens.success
    case 'done':
      return mix(tokens.success, '#ffffff', 0.62)
    case 'blocked':
      return tokens.warning
    default: {
      // The board panel is dark in both themes, but the light theme's off colour is a mid grey (it is tuned for the stack
      // light on a pale plate) and would be brighter than a lit lens in the light success token. Sink it towards the panel
      // there so every lit state stays lighter than an off lens.
      const p = FACTORY_PALETTE[theme]
      return theme === 'light' ? mix(p.lampOff, p.roles.boardPanel, 0.45) : p.lampOff
    }
  }
}
