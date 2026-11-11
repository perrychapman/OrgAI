/**
 * `--image <path>` of `orgai exec` / `orgai resume --exec` (cli-parity 3.5). The user's own process reads the file, so
 * no agent gate applies; it still refuses anything that is not a regular file and anything over the composer's limit
 * before reading it, then runs the desktop's validator (`sanitizeImages`: magic bytes decide the type) so a bad file
 * is named here instead of being dropped quietly by the host.
 */
import { open, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from '../shared/defaults'
import type { ImageAttachment } from '../shared/types'
import { sanitizeImages } from '../main/runtime/attachments'
import { CliError, EXIT } from './types'

const MB = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`
const usage = (message: string): CliError => new CliError(message, EXIT.usage)

/** Read and validate each path; throws a usage error naming the first bad file. */
export async function loadImages(paths: readonly string[], cwd: string): Promise<ImageAttachment[]> {
  if (paths.length > MAX_IMAGES_PER_MESSAGE) throw usage(`--image: at most ${MAX_IMAGES_PER_MESSAGE} images per message (got ${paths.length}).`)
  const out: ImageAttachment[] = []
  for (const p of paths) {
    const file = resolve(cwd, p)
    let size: number
    try {
      const st = await stat(file)
      if (!st.isFile()) throw usage(`--image ${p}: not a regular file.`)
      size = st.size
    } catch (e) {
      if (e instanceof CliError) throw e
      throw usage(`--image ${p}: cannot read the file (${(e as NodeJS.ErrnoException).code ?? 'error'}).`)
    }
    if (size === 0) throw usage(`--image ${p}: the file is empty.`)
    if (size > MAX_IMAGE_BYTES) throw usage(`--image ${p}: larger than ${MB(MAX_IMAGE_BYTES)} (${(size / 1024 / 1024).toFixed(1)} MB).`)
    let buf: Buffer
    try {
      const fh = await open(file, 'r')
      try {
        // Read at most one byte past the limit so a file that grew after the stat is still refused.
        const b = Buffer.alloc(Math.min(size, MAX_IMAGE_BYTES) + 1)
        const { bytesRead } = await fh.read(b, 0, b.length, 0)
        buf = b.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
    } catch (e) {
      throw usage(`--image ${p}: cannot read the file (${(e as NodeJS.ErrnoException).code ?? 'error'}).`)
    }
    if (buf.length > MAX_IMAGE_BYTES) throw usage(`--image ${p}: larger than ${MB(MAX_IMAGE_BYTES)}.`)
    let problem: string | undefined
    const ok = sanitizeImages([{ mediaType: 'image/png', data: buf.toString('base64'), name: basename(file) }], (m) => {
      if (m.startsWith('Dropped')) problem = m.replace(/^Dropped image 1 \([^)]*\): /, '')
    })
    if (ok.length === 0) throw usage(`--image ${p}: ${problem ?? 'not a supported image'} (PNG, JPEG, GIF or WebP).`)
    out.push(ok[0])
  }
  return out
}
