import type { CSSProperties } from 'react'
import atlas from '../../../assets/pocket-office/atlas.json'
import tilesNeutral from '../../../assets/pocket-office/tiles-neutral.png'
import tilesGreen from '../../../assets/pocket-office/tiles-green.png'
import propsNeutral from '../../../assets/pocket-office/props-neutral.png'
import propsGreen from '../../../assets/pocket-office/props-green.png'
import workersNeutral from '../../../assets/pocket-office/workers-neutral.png'
import workersGreen from '../../../assets/pocket-office/workers-green.png'
import tilesColor from '../../../assets/pocket-office/tiles-color.png'
import propsColor from '../../../assets/pocket-office/props-color.png'
import workersColor from '../../../assets/pocket-office/workers-color.png'

/** Shared art lookups for the Pocket Office scene files (static layer, sprites, bubbles). */
export type OfficePalette = 'color' | 'neutral' | 'green'
export type Frame = { x: number; y: number; w: number; h: number }

export interface OfficeAgent {
  id: string; name: string; status: string; statusLabel?: string; activity?: string; context?: string
  departmentId: string; departmentName: string; departmentLeadId: string; central: boolean
}

export const tileFrames = atlas.sheets.tiles.frames as Record<string, Frame>
export const propFrames = atlas.sheets.props.frames as Record<string, Frame>
export const workerFrames = atlas.sheets.workers.frames as Record<string, Frame>
export const silhouettes = [...new Set(Object.keys(atlas.sheets.workers.frames).map(name => name.split('.')[1]))]
/** Where a worker's feet are inside a 16 x 24 frame. */
export const WORKER_FEET = atlas.workerFeet as [number, number]
export const WORKER_SIZE = { width: 16, height: 24 }

const props = atlas.props as Record<string, { depthAnchor: number[]; footprint: number[][] } | undefined>
/** Pixel offset from a prop's top-left to the line it is depth-sorted on. */
export function depthOffset(name: string): number { return props[name]?.depthAnchor[1] ?? 28 }

export function sheetsFor(palette: OfficePalette): { tiles: string; props: string; workers: string } {
  return palette === 'green' ? { tiles: tilesGreen, props: propsGreen, workers: workersGreen }
    : palette === 'neutral' ? { tiles: tilesNeutral, props: propsNeutral, workers: workersNeutral }
      : { tiles: tilesColor, props: propsColor, workers: workersColor }
}

/** Background crop of a sheet frame; position and size are left to the caller. */
export function frameBackground(frame: Frame, url: string): CSSProperties {
  return { width: frame.w, height: frame.h, backgroundImage: `url(${url})`, backgroundPosition: `-${frame.x}px -${frame.y}px` }
}

/** `background-position` of a frame, written by the clock (same value `frameBackground` renders). */
export function framePosition(frame: Frame): string {
  return `-${frame.x}px -${frame.y}px`
}

/** Top of a 16 x 24 sprite whose feet stand on anchor row `anchorY` (pixels): the single formula the render and the clock share. */
export function spriteTop(anchorY: number): number {
  return anchorY + 8 - WORKER_FEET[1]
}

export function workerFrameName(silhouette: string, direction: string, pose: string): string {
  return `worker.${silhouette}.${direction}.${pose}`
}
