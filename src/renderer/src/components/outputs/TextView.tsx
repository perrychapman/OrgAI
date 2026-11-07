import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import type { RunOutput } from '@shared/types'
import { parseCsv } from '../../lib/outputPreview'
import { Markdown } from '../Markdown'
import { SegmentedControl } from '../ui/SegmentedControl'
import MermaidView from './MermaidView'

const CSV_ROWS_MAX = 500

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function Pre({ text, testId, label }: { text: string; testId: string; label: string }): ReactElement {
  return (
    <pre className="output-pre" data-testid={testId} role="region" aria-label={label} tabIndex={0}>
      {text}
    </pre>
  )
}

function CsvTable({ rows, label }: { rows: string[][]; label: string }): ReactElement {
  const [head, ...body] = rows
  const shown = body.slice(0, CSV_ROWS_MAX)
  return (
    <>
      <div className="output-sheet-scroll" role="region" aria-label={label} tabIndex={0}>
        <table className="output-sheet-table output-csv" data-testid="output-csv-table">
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={i} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body.length > CSV_ROWS_MAX && (
        <p className="output-preview-note" data-testid="output-csv-more">
          More rows not shown.
        </p>
      )}
    </>
  )
}

export default function TextView({
  text,
  truncated,
  output
}: {
  text: string
  truncated: boolean
  output: RunOutput
  labelledBy?: string
}): ReactElement {
  const [mdView, setMdView] = useState<'rendered' | 'source'>('rendered')
  const csv = useMemo(() => (output.kind === 'csv' && !truncated ? parseCsv(text) : null), [output.kind, text, truncated])
  const json = useMemo(() => (output.kind === 'json' && !truncated ? prettyJson(text) : text), [output.kind, text, truncated])
  const label = `${output.title} text`
  let body: ReactElement
  if (output.kind === 'markdown') {
    body = (
      <>
        <SegmentedControl
          label="View"
          value={mdView}
          onChange={setMdView}
          options={[
            { value: 'rendered', label: 'Rendered' },
            { value: 'source', label: 'Source' }
          ]}
        />
        {mdView === 'rendered' ? (
          <div className="output-md" data-testid="output-md-rendered" role="region" aria-label={label} tabIndex={0}>
            <Markdown text={text} />
          </div>
        ) : (
          <Pre text={text} testId="output-source" label={`${output.title} source`} />
        )}
      </>
    )
  } else if (output.kind === 'mermaid') {
    body = <MermaidView text={text} output={output} />
  } else if (csv) {
    body = <CsvTable rows={csv} label={`${output.title} rows`} />
  } else {
    body = <Pre text={json} testId="output-text" label={label} />
  }
  return (
    <div className="output-text" data-testid="output-text-view">
      {body}
      {truncated && (
        <p className="output-preview-note" data-testid="output-text-truncated">
          The preview stops here. Open the file to read the rest.
        </p>
      )}
    </div>
  )
}
