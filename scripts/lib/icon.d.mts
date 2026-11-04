export const MAC_INSET: number
export const ICNS_TYPES: Record<string, number>
export function renderIcon(size: number, options?: { inset?: boolean | number }): Buffer
export function encodePng(rgba: Buffer, size: number): Buffer
export function encodeIco(images: { size: number; png: Buffer }[]): Buffer
export function encodeIcns(images: { type: string; png: Buffer }[]): Buffer
