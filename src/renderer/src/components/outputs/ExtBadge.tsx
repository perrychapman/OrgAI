import type { ReactElement } from 'react'
import { extBadgeText } from '../../lib/outputs'
import { Badge } from '../ui/Badge'

/** The file's extension (".docx") as a small badge beside the title; nothing when the file has none. */
export default function ExtBadge({ fileName }: { fileName: string }): ReactElement | null {
  const text = extBadgeText(fileName)
  if (!text) return null
  return (
    <Badge testId="output-ext" title={`File type ${text}`}>
      {text}
    </Badge>
  )
}
