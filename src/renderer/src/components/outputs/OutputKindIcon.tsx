import type { ReactElement } from 'react'
import { Braces, File, FileBadge, FileSpreadsheet, FileText, FileType, Image, NotebookText, PenTool, Table, Workflow, type LucideIcon } from 'lucide-react'
import type { OutputKind } from '@shared/types'
import { Icon, type IconSize } from '../ui/Icon'

/** One lucide icon per output kind. Decorative: the kind label is always written next to it (never colour or shape alone). */
export const OUTPUT_KIND_ICON: Readonly<Record<OutputKind, LucideIcon>> = {
  docx: FileText,
  xlsx: FileSpreadsheet,
  mermaid: Workflow,
  markdown: NotebookText,
  text: FileType,
  csv: Table,
  json: Braces,
  svg: PenTool,
  image: Image,
  pdf: FileBadge,
  other: File
}

export default function OutputKindIcon({ kind, size = 'md' }: { kind: OutputKind; size?: IconSize }): ReactElement {
  return <Icon icon={OUTPUT_KIND_ICON[kind] ?? File} size={size} />
}
