import type { ReactElement } from 'react'
import DiagramViewer from './diagram/DiagramViewer'
import '../../styles/outputs-diagram.css'

/**
 * A Mermaid diagram drawn in the window (docs/design/outputs-2.md section 8). The viewer lives in ./diagram; this stays the
 * lazy-loaded entry TextPreview imports, so Mermaid's code loads only when a diagram is opened.
 */
export default function MermaidView({ text, title, truncated }: { text: string; title: string; truncated?: boolean }): ReactElement {
  return <DiagramViewer text={text} title={title} truncated={truncated} />
}
