import type { ReactElement } from 'react'
import { lazy, Suspense, useMemo, useState } from 'react'
import type { OutputKind } from '@shared/types'
import { Markdown } from '../Markdown'
import { SegmentedControl } from '../ui/SegmentedControl'
import { parseCsv, prettyJson } from '../../lib/outputPreview'

// Mermaid is large: its code loads only when a diagram is opened.
const MermaidView = lazy(() => import('./MermaidView'))

type MdView = 'rendered' | 'source'

function Pre({ text, title, testId, what }: { text: string; title: string; testId: string; what: string }): ReactElement {
  return (
    <pre className="output-scroll output-pre" data-testid={testId} role="region" aria-label={`${title} ${what}`} tabIndex={0}>
      {text}
    </pre>
  )
}

function CsvTable({ rows, more, title }: { rows: string[][]; more: boolean; title: string }): ReactElement {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0)
  const [head, ...body] = rows
  return (
    <>
      <div className="output-scroll output-sheet-region" role="region" aria-label={`${title} table`} tabIndex={0}>
        <table className="output-sheet-table output-csv-table" data-testid="output-csv-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} scope="col">
                  {head[c] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c}>{r[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && (
        <p className="output-preview-note" data-testid="output-sheet-more-rows">
          More rows not shown.
        </p>
      )}
    </>
  )
}

/** Markdown, CSV, JSON, plain text and Mermaid source, by the output's kind. */
export default function TextPreview({ kind, text, truncated, title }: { kind: OutputKind; text: string; truncated?: boolean; title: string }): ReactElement {
  const [mdView, setMdView] = useState<MdView>('rendered')
  const csv = useMemo(() => (kind === 'csv' ? parseCsv(text) : null), [kind, text])
  const json = useMemo(() => (kind === 'json' ? prettyJson(text) : null), [kind, text])

  if (kind === 'mermaid') {
    return (
      <Suspense
        fallback={
          <p className="output-preview-note" role="status">
            Loading preview…
          </p>
        }
      >
        <MermaidView text={text} title={title} truncated={truncated} />
      </Suspense>
    )
  }

  let body: ReactElement
  if (kind === 'markdown') {
    body = (
      <>
        <div className="output-toolbar" data-testid="output-md-view">
          <SegmentedControl<MdView>
            label="View"
            value={mdView}
            onChange={setMdView}
            options={[
              { value: 'rendered', label: 'Rendered' },
              { value: 'source', label: 'Source' }
            ]}
          />
        </div>
        {mdView === 'rendered' ? (
          <div className="output-scroll output-md" data-testid="output-md-rendered" role="region" aria-label={`${title} text`} tabIndex={0}>
            <Markdown text={text} />
          </div>
        ) : (
          <Pre text={text} title={title} testId="output-source" what="source" />
        )}
      </>
    )
  } else if (kind === 'csv' && csv) {
    body = <CsvTable rows={csv.rows} more={csv.more} title={title} />
  } else if (kind === 'json' && json !== null) {
    body = <Pre text={json} title={title} testId="output-text" what="text" />
  } else {
    body = <Pre text={text} title={title} testId="output-text" what="text" />
  }

  return (
    <div className="output-text" data-testid="output-text-view" data-kind={kind}>
      {body}
      {truncated && (
        <p className="output-preview-note" data-testid="output-text-truncated">
          The preview stops here. Open the file to read the rest.
        </p>
      )}
    </div>
  )
}
