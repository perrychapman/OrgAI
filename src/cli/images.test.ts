import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from '../shared/defaults'
import { loadImages } from './images'
import { EXIT } from './types'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-img-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const bad = (p: string[], re: RegExp) => expect(loadImages(p, dir)).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringMatching(re) })

describe('loadImages', () => {
  it('reads a PNG relative to the cwd and sniffs its type from the bytes', async () => {
    writeFileSync(join(dir, 'shot.bin'), PNG)
    const [img] = await loadImages(['shot.bin'], dir)
    expect(img).toMatchObject({ mediaType: 'image/png', name: 'shot.bin' })
    expect(Buffer.from(img.data, 'base64').equals(PNG)).toBe(true)
  })

  it('names the file for a missing, non-regular, empty, wrong-type or oversized input', async () => {
    mkdirSync(join(dir, 'folder'))
    writeFileSync(join(dir, 'empty.png'), '')
    writeFileSync(join(dir, 'notes.png'), 'just text')
    writeFileSync(join(dir, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))
    await bad(['nope.png'], /--image nope\.png: cannot read the file \(ENOENT\)/)
    await bad(['folder'], /--image folder: not a regular file/)
    await bad(['empty.png'], /--image empty\.png: the file is empty/)
    await bad(['notes.png'], /--image notes\.png: .*not a supported image/)
    await bad(['big.png'], /--image big\.png: larger than 5 MB/)
  })

  it('follows a symlink to a regular file but never a symlink to a folder', async () => {
    writeFileSync(join(dir, 'a.png'), PNG)
    symlinkSync(join(dir, 'a.png'), join(dir, 'link.png'))
    mkdirSync(join(dir, 'd'))
    symlinkSync(join(dir, 'd'), join(dir, 'dlink'))
    expect(await loadImages(['link.png'], dir)).toHaveLength(1)
    await bad(['dlink'], /not a regular file/)
  })

  it('caps the count', async () => {
    await bad(Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => `${i}.png`), /at most 10 images/)
  })
})
