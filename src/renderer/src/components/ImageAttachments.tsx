import type { ReactElement } from 'react'
import { useState } from 'react'
import { X } from 'lucide-react'
import { Icon } from './ui/Icon'
import type { ImageAttachment, ImageMediaType } from '@shared/types'
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES } from '@shared/defaults'

export const dataUrl = (img: ImageAttachment): string => `data:${img.mediaType};base64,${img.data}`

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

/** Converts image files to attachments, honoring type, size and count limits. Returns a notice when something was skipped. */
export async function filesToImages(
  files: File[],
  existing: number
): Promise<{ images: ImageAttachment[]; notice: string | null }> {
  const images: ImageAttachment[] = []
  const problems = new Set<string>()
  for (const file of files) {
    if (existing + images.length >= MAX_IMAGES_PER_MESSAGE) {
      problems.add(`Only ${MAX_IMAGES_PER_MESSAGE} images fit in one message.`)
      break
    }
    if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      problems.add('Only PNG, JPEG, GIF and WebP images are supported.')
      continue
    }
    if (file.size > MAX_IMAGE_BYTES) {
      problems.add(`Images must be under ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`)
      continue
    }
    try {
      const data = await readAsBase64(file)
      images.push({ mediaType: file.type as ImageMediaType, data, name: file.name || undefined })
    } catch {
      problems.add('An image could not be read.')
    }
  }
  return { images, notice: problems.size ? [...problems].join(' ') : null }
}

/** Composer strip: thumbnails with remove buttons. */
export function ComposerImages({ images, onRemove }: { images: ImageAttachment[]; onRemove: (index: number) => void }): ReactElement | null {
  if (images.length === 0) return null
  return (
    <ul className="attach-strip" aria-label="Attached images">
      {images.map((img, i) => (
        <li key={i} className="attach-item">
          <img className="attach-thumb" src={dataUrl(img)} alt={img.name ?? `Attached image ${i + 1}`} />
          <button type="button" className="attach-remove" aria-label={`Remove image ${i + 1}`} onClick={() => onRemove(i)}>
            <Icon icon={X} size="xs" />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Transcript thumbnails; a thumbnail button toggles an in-flow larger view. */
export function TranscriptImages({ images }: { images: ImageAttachment[] }): ReactElement | null {
  const [open, setOpen] = useState<number | null>(null)
  if (images.length === 0) return null
  return (
    <div className="entry-images">
      <div className="entry-thumbs">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            className={`entry-thumb ${open === i ? 'on' : ''}`}
            aria-pressed={open === i}
            aria-label={`${open === i ? 'Collapse' : 'Expand'} image ${i + 1}`}
            onClick={() => setOpen(open === i ? null : i)}
          >
            <img src={dataUrl(img)} alt={img.name ?? `Image ${i + 1}`} />
          </button>
        ))}
      </div>
      {open !== null && images[open] && <img className="entry-image-large" src={dataUrl(images[open])} alt={images[open].name ?? `Image ${open + 1}`} />}
    </div>
  )
}
