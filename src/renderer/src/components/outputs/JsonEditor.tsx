// JSON: a text area, a Format button (2 spaces) and a validity line. Invalid JSON blocks Save (the session reads the status).
import type { ReactElement } from 'react'
import { useId } from 'react'
import { Button } from '../ui/Button'
import { formatJson, type JsonStatus } from '../../lib/outputEdit'
import { TextAreaEditor } from './TextEditor'

export default function JsonEditor({ value, onChange, title, status }: { value: string; onChange(text: string): void; title: string; status: JsonStatus }): ReactElement {
  const lineId = useId()
  const formatted = formatJson(value)
  return (
    <div className="output-edit-json">
      <div className="output-edit-tools" role="group" aria-label="JSON tools">
        <Button size="sm" testId="output-json-format" inert={formatted === null || formatted === value} onClick={() => formatted !== null && onChange(formatted)}>
          Format
        </Button>
        <p id={lineId} className="output-edit-validity" data-testid="output-json-status" data-valid={status.ok ? 'true' : 'false'}>
          {status.line}
        </p>
      </div>
      <TextAreaEditor value={value} onChange={onChange} label={`${title} JSON`} describedBy={lineId} autoFocus />
    </div>
  )
}
