import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck } from 'lucide-react'
import type { McpTestResult } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Icon } from '../ui/Icon'

/** Inline, collapsible result of mcp.test, shown under the row. Takes focus only when `focusOnMount` is set. */
export default function TestResultPanel({
  serverName,
  result,
  focusOnMount
}: {
  serverName: string
  result: McpTestResult
  focusOnMount?: boolean
}): ReactElement {
  const [open, setOpen] = useState(true)
  const head = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusOnMount) head.current?.focus()
  }, [focusOnMount])
  const tools = result.tools ?? []
  const seconds = result.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)} s` : undefined
  const errorText = (result.error ?? 'The server did not respond.').trim()
  const lines = errorText.split('\n')
  const shown = lines.slice(-8).join('\n')
  return (
    <div className="mcp-test-result" role="region" aria-label={`Test result for ${serverName}`} data-testid="mcp-test-result" data-ok={result.ok}>
      <button ref={head} type="button" className="mcp-test-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
        {result.ok ? (
          <>
            <Badge tone="success" icon={CircleCheck}>
              {seconds ? `Connected in ${seconds}` : 'Connected'}
            </Badge>
            <span className="tabular">{tools.length === 1 ? '1 tool' : `${tools.length} tools`}</span>
          </>
        ) : (
          <span className="invalid-text">Test failed</span>
        )}
      </button>
      {open &&
        (result.ok ? (
          tools.length === 0 ? (
            <p className="muted">The server connected but reported no tools.</p>
          ) : (
            <ul className="mcp-tools mono">
              {tools.map((t) => (
                <li key={t} title={t}>
                  {t}
                </li>
              ))}
            </ul>
          )
        ) : (
          <Banner tone="danger" title="Test failed" actions={<CopyOutput text={errorText} />}>
            <div className="code-block mcp-output" tabIndex={0} aria-label="Test output">
              {shown}
            </div>
          </Banner>
        ))}
    </div>
  )
}

function CopyOutput({ text }: { text: string }): ReactElement {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => undefined)
      }}
    >
      {done ? 'Copied' : 'Copy output'}
    </button>
  )
}

