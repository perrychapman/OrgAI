import type { ReactElement, ReactNode } from 'react'
import type { DocumentBlock, DocumentRun } from '@shared/types'
import { isSafeImageDataUrl, safeDocHref } from '../../lib/outputPreview'

/** A heading's level shifted down so the document never competes with the detail's own headings: h1 -> h4, capped at h6. */
export function docHeadingTag(level: number): 'h4' | 'h5' | 'h6' {
  const n = Math.min(Math.max(Math.round(level) + 3, 4), 6)
  return `h${n}` as 'h4' | 'h5' | 'h6'
}

function Runs({ runs }: { runs: readonly DocumentRun[] }): ReactElement {
  return (
    <>
      {runs.map((r, i) => {
        let node: ReactNode = r.text
        if (r.code) node = <code>{node}</code>
        if (r.strike) node = <s>{node}</s>
        if (r.underline) node = <u>{node}</u>
        if (r.italic) node = <em>{node}</em>
        if (r.bold) node = <strong>{node}</strong>
        const href = r.href ? safeDocHref(r.href) : null
        if (href) {
          node = (
            <a href={href} title={href} target="_blank" rel="noreferrer noopener">
              {node}
            </a>
          )
        }
        return <span key={i}>{node}</span>
      })}
    </>
  )
}

function Block({ block }: { block: DocumentBlock }): ReactElement | null {
  switch (block.type) {
    case 'heading': {
      const Tag = docHeadingTag(block.level)
      return (
        <Tag className="output-doc-heading">
          <Runs runs={block.runs} />
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p>
          <Runs runs={block.runs} />
        </p>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag>
          {block.items.map((item, i) => (
            <li key={i}>
              <Runs runs={item} />
            </li>
          ))}
        </Tag>
      )
    }
    case 'table': {
      const head = Math.max(0, Math.min(block.headerRows ?? 0, block.rows.length))
      const cell = (row: DocumentRun[][], r: number, th: boolean): ReactElement[] =>
        row.map((c, j) =>
          th ? (
            <th key={j} scope="col">
              <Runs runs={c} />
            </th>
          ) : (
            <td key={`${r}-${j}`}>
              <Runs runs={c} />
            </td>
          )
        )
      return (
        <div className="output-doc-table-wrap">
          <table className="output-doc-table">
            {head > 0 && (
              <thead>
                {block.rows.slice(0, head).map((row, r) => (
                  <tr key={r}>{cell(row, r, true)}</tr>
                ))}
              </thead>
            )}
            <tbody>
              {block.rows.slice(head).map((row, r) => (
                <tr key={r}>{cell(row, r, false)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'image':
      return isSafeImageDataUrl(block.dataUrl) ? <img className="output-doc-image" src={block.dataUrl} alt={block.alt} /> : null
    case 'code':
      return (
        <pre className="output-doc-code">
          <code>{block.text}</code>
        </pre>
      )
    case 'rule':
      return <hr />
    case 'pageBreak':
      return (
        <div className="output-doc-pagebreak" role="separator" aria-label="Page break" data-testid="output-doc-pagebreak">
          <span aria-hidden="true">Page break</span>
        </div>
      )
    default:
      return null
  }
}

/** A simplified Word-style preview built from blocks (never HTML). */
export default function DocumentView({ blocks, truncated, title }: { blocks: DocumentBlock[]; truncated?: boolean; title: string }): ReactElement {
  return (
    <div className="output-doc" data-testid="output-doc">
      <p className="output-preview-lead">Simplified preview. Open the file for the exact layout.</p>
      <div className="output-scroll output-doc-body" role="region" aria-label={`${title} text`} tabIndex={0}>
        {blocks.map((b, i) => (
          <Block key={i} block={b} />
        ))}
        {truncated && (
          <p className="output-preview-note" data-testid="output-doc-truncated">
            The preview stops here. Open the file to read the rest.
          </p>
        )}
      </div>
    </div>
  )
}
