/** True when an image attachment can be displayed as an embedded raster image. */
export function isEmbeddedRaster(mediaType: string, data: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType) && data.length > 0
}
