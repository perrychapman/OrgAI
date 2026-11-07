import type { ReactElement, ReactNode } from 'react'
import type { DocumentBlock, DocumentRun } from '@shared/types'
import { headingLevel, isSafeHref, isSafeImageDataUrl } from '../../lib/outputPreview'

function runNode(r: DocumentRun, i: number): ReactNode {
  let n: ReactNode = r.text
  if (r.code) n = <code>{n}</code>
  if (r.strike) n = <s>{n}</s>
  if (r.underline) n = <u>{n}</u>
  if (r.italic) n = <em>{n}</em>
  if (r.bold) n = <strong>{n}</strong>
  if (isSafeHref(r.href)) {
    n = (
      <a href={r.href.trim()} title={r.href.trim()} target="_blank" rel="noreferrer noopener">
        {n}
      </a>
    )
  }
  return <span key={i}>{n}</span>
}

function Runs({ runs }: { runs: readonly DocumentRun[] }): ReactElement {
  return <>{runs.map(runNode)}</>
}

function Block({ b }: { b: DocumentBlock }): ReactElement | null {
  switch (b.type) {
    case 'heading': {
      const Tag = `h${headingLevel(b.level)}` as 'h4' | 'h5' | 'h6'
      return (
        <Tag aria-level={Math.min(6, b.level + 3)}>
          <Runs runs={b.runs} />
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p>
          <Runs runs={b.runs} />
        </p>
      )
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      return (
        <Tag>
          {b.items.map((it, i) => (
            <li key={i}>
              <Runs runs={it} />
            </li>
          ))}
        </Tag>
      )
    }
    case 'table': {
      const head = Math.max(0, Math.min(b.headerRows ?? 0, b.rows.length))
      const row = (r: DocumentRun[][], th: boolean, i: number): ReactElement => (
        <tr key={i}>
          {r.map((c, j) => (th ? (
            <th key={j} scope="col">
              <Runs runs={c} />
            </th>
          ) : (
            <td key={j}>
              <Runs runs={c} />
            </td>
          )))}
        </tr>
      )
      return (
        <div className="output-doc-tablewrap">
          <table>
            {head > 0 && <thead>{b.rows.slice(0, head).map((r, i) => row(r, true, i))}</thead>}
            <tbody>{b.rows.slice(head).map((r, i) => row(r, false, i))}</tbody>
          </table>
        </div>
      )
    }
    case 'image':
      return isSafeImageDataUrl(b.dataUrl) ? <img src={b.dataUrl} alt={b.alt} /> : null
    case 'code':
      return <pre>{b.text}</pre>
    case 'rule':
      return <hr />
    case 'pageBreak':
      return <div role="separator" aria-label="Page break" className="output-doc-pagebreak" data-testid="output-doc-pagebreak" />
    default:
      return null
  }
}

export default function DocumentView({ preview }: { preview: { blocks: DocumentBlock[]; truncated?: true } }): ReactElement {
  return (
    <article className="output-doc" data-testid="output-doc">
      <p className="output-preview-note">Simplified preview. Open the file for the exact layout.</p>
      {preview.blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
      {preview.truncated && (
        <p className="output-preview-note" data-testid="output-doc-truncated">
          The preview stops here. Open the file to read the rest.
        </p>
      )}
    </article>
  )
}
