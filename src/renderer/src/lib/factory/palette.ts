// Factory Floor palette (docs/design/factory-floor.md sections 4.3 and 10.1). Pure: no three, no DOM, sRGB hex strings.
// The builders (components/canvas/factory/builders/materials.ts and lighting.ts) turn these into materials and lights.
//
// Design rules this table keeps (checked by palette.test.ts):
//  - The clear colour equals --surface-0 of the app theme, so the stage edge does not frame the scene.
//  - Dark ("night shift"): a luminance staircase. Floor is the darkest lit surface; walls, plates, the gantry deck, the
//    booth, machines and robots step up from it. The robot is the lightest body in the hall.
//  - Light ("day shift") is designed, not inverted: the floor stays pale and every object is a mid or dark tone on it,
//    so the robot is a dark body with mid-grey limbs (limbs stay readable on the pale floor behind them).
//  - Floor paint (safety yellow) is never a state colour; lamps take the status tokens (--success, --warning,
//    --danger) at run time through instanceColor, so they are not in this table.
import type { AgentState } from '@shared/types'
import type { Lamp } from './types'

export type FactoryPaletteTheme = 'dark' | 'light'

/** One entry per material role the builders create (builders/materials.ts). Values are sRGB hex. */
export interface FactoryRoleColours {
  floor: string
  wall: string
  deck: string
  deckEdge: string
  rail: string
  booth: string
  boothTrim: string
  glass: string
  screen: string
  plate: string
  console: string
  machine: string
  machinePanel: string
  belt: string
  rollers: string
  dock: string
  dockSlot: string
  hazard: string
  bollard: string
  boardPanel: string
  pole: string
  robotBody: string
  robotJoint: string
  robotBase: string
  robotVisor: string
  robotWheel: string
  /** Far-LOD robot capsule: unlit, so a few pixels of it keep their contrast against the lit floor (slice 3). */
  robotFar: string
  crate: string
  /** Slice 4 carriers (section 4.3 "Crate, tote, capsule, part"): work-order tote, message capsule, tool part. */
  tote: string
  capsule: string
  part: string
  paint: string
  vacant: string
  blob: string
}

export interface FactoryPalette {
  /** Renderer clear colour: the app's --surface-0 in this theme. */
  clear: string
  /** Floor grid: 1 m faint line, 4 m strong line, over the `roles.floor` fill. */
  gridFaint: string
  gridStrong: string
  /** Unlit stack-light lamp. */
  lampOff: string
  roles: FactoryRoleColours
  light: {
    sky: string
    ground: string
    hemisphere: number
    key: string
    keyIntensity: number
    ambient: number
    /**
     * Multiplier on every light for the dimmed hall (section 1.4). Slice 4: the light theme's floor is lit to about 0.56
     * linear, so 0.7 (spec) took it from sRGB 197 to 168 (-15 percent) where dark's 0.55 takes 39 to 27 (-31 percent);
     * 0.45 and 0.38 give the light floor the same relative drop as the dark one (about -30 and -36 percent).
     */
    dimPaused: number
    dimEnded: number
  }
}

export const FACTORY_PALETTE: Record<FactoryPaletteTheme, FactoryPalette> = {
  dark: {
    clear: '#0b0d12',
    gridFaint: '#2f3541',
    gridStrong: '#3b4252',
    lampOff: '#3a4150',
    roles: {
      floor: '#272c37',
      wall: '#444c5f',
      deck: '#5a6479',
      deckEdge: '#8995ad',
      rail: '#aab4c9',
      booth: '#7b87a3',
      boothTrim: '#2a3141',
      glass: '#7fb0d6',
      // Slice 4: the engine multiplies it by a 0.7 to 1.0 grey for the glow loop, so it starts brighter (was #a9c4f0) to
      // still read as a lit screen against the console casing at 0.7 (2.1:1 in linear light, was 1.8:1).
      screen: '#c0d6fb',
      plate: '#454d61',
      console: '#6e7a94',
      machine: '#707d9b',
      machinePanel: '#a3b0cb',
      belt: '#0f1217',
      // Close to the belt: bright rollers on a black belt read as a ladder (slice 2 screenshots).
      rollers: '#3a4150',
      dock: '#4e586c',
      dockSlot: '#181c24',
      hazard: '#f5c518',
      bollard: '#d7b21a',
      boardPanel: '#161a22',
      pole: '#1a1e27',
      robotBody: '#dce3f1',
      // Slice 4: a light sky blue, away from the machine's steel (2.5:1 against it, was 1.6:1) and well above the floor.
      robotJoint: '#86d4ee',
      robotBase: '#2a3040',
      robotVisor: '#0d1016',
      robotWheel: '#14171d',
      // Unlit and near white: at fit the far capsule is a few pixels wide and must beat the lit floor by 3:1 by itself.
      robotFar: '#f7f9ff',
      crate: '#a07a4a',
      tote: '#5b6b8c',
      capsule: '#d8dde8',
      part: '#9aa2b1',
      paint: '#b8932a',
      vacant: '#8995ad',
      blob: '#000000'
    },
    light: { sky: '#b4c4e0', ground: '#6a748b', hemisphere: 1.1, key: '#f4f7ff', keyIntensity: 1.7, ambient: 0.35, dimPaused: 0.55, dimEnded: 0.5 }
  },
  light: {
    clear: '#f4f5f9',
    gridFaint: '#c3c9d4',
    gridStrong: '#b4bcca',
    lampOff: '#737c90',
    roles: {
      floor: '#cfd4de',
      wall: '#9ba5b8',
      deck: '#8d98ad',
      deckEdge: '#4c566b',
      rail: '#39425a',
      booth: '#6f7c99',
      boothTrim: '#2e3648',
      glass: '#7fb0d6',
      screen: '#d8ecff',
      plate: '#a4adbf',
      console: '#5f6c86',
      // Lighter than the dark robot so a robot standing at its machine separates at fit (3:1, slice 2 screenshots).
      machine: '#8a96ad',
      machinePanel: '#3a455d',
      belt: '#2a2f3a',
      rollers: '#555d6b',
      dock: '#7e8aa3',
      dockSlot: '#4a5266',
      hazard: '#e0b000',
      bollard: '#c99a1a',
      boardPanel: '#2a303e',
      pole: '#2a2f3a',
      robotBody: '#34447f',
      // Slice 4: a near-black navy limb (5.7:1 against the machine, was 1.1:1; 11:1 against the pale floor). The light robot
      // is a navy body with dark limbs; the raised hand reads as a dark mitten on the pale floor.
      robotJoint: '#161b2c',
      robotBase: '#1c2236',
      robotVisor: '#0d1016',
      robotWheel: '#1d2129',
      robotFar: '#232d63',
      crate: '#94693a',
      tote: '#6c7c9c',
      capsule: '#ffffff',
      part: '#7d8696',
      paint: '#c99a1a',
      vacant: '#5b667c',
      blob: '#000000'
    },
    light: { sky: '#ffffff', ground: '#b9bec8', hemisphere: 0.95, key: '#fff7ea', keyIntensity: 1.9, ambient: 0.25, dimPaused: 0.45, dimEnded: 0.38 }
  }
}

/**
 * The stack-light lamp an agent state lights (section 1.4): starting, thinking, tool and delegating are Running (bottom
 * lamp), waiting is Needs you (middle), error is Failed (top); idle, done and a team-mode role show no lamp.
 */
export function lampFor(state: AgentState | 'role'): Lamp {
  switch (state) {
    case 'starting':
    case 'thinking':
    case 'tool':
    case 'delegating':
      return 'running'
    case 'waiting':
      return 'needs-you'
    case 'error':
      return 'failed'
    default:
      return 'off'
  }
}

/** WCAG 2.x relative luminance of an sRGB hex colour (#rrggbb). */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** WCAG contrast ratio between two sRGB hex colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a)
  const y = relativeLuminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
