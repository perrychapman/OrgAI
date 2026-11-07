import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '../../ui/Button'
import { REFUSED_TEXT, errorLine, errorSentence } from '../../../lib/diagramView'

/**
 * The error pane (docs/design/outputs-2.md 8.8). It is a role=alert only on the transition into an error, then a plain region,
 * so typing in the source does not make it repeat. "Ask the team to fix it" is not built (it needs the revise contract).
 */
export function DiagramError({
  kind,
  message,
  onGoToLine
}: {
  kind: 'error' | 'refused'
  message: string
  onGoToLine: (line: number) => void
}): ReactElement {
  const line = kind === 'error' ? errorLine(message) : null
  // Mount means a transition into the error (the viewer mounts this only while there is one); later text changes stay quiet.
  const [alert, setAlert] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setAlert(false), 1500)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="diagram-error" data-testid="diagram-error" data-kind={kind} role={alert ? 'alert' : undefined}>
      <p className="diagram-error-text">{kind === 'refused' ? REFUSED_TEXT : errorSentence(message)}</p>
      {kind === 'error' && line !== null && <code className="diagram-error-code">{message}</code>}
      {kind === 'error' && line !== null && (
        <div>
          <Button size="sm" testId="diagram-goto-line" onClick={() => onGoToLine(line)}>
            Go to line {line}
          </Button>
        </div>
      )}
    </div>
  )
}
