import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'
import { Pause, RotateCcw, Square } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/Button'
import { modelDisplayName, useAssistantModel } from '../lib/assistantModels'

/** Wraps one control and points its aria-describedby at a helper text; the primitives take no such prop. */
function Described({ text, children }: { text: string; children: ReactNode }): ReactElement {
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.setAttribute('aria-describedby', id)
  })
  return (
    <span className="run-act" ref={ref}>
      {children}
      <span id={id} className="sr-only">
        {text}
      </span>
    </span>
  )
}

/**
 * The viewed run's actions, at the trailing edge of the run strip: Interrupt turn and End session while the session is
 * open (a gap before the destructive one), Org retrospective once a work run has ended. The words collapse to icons
 * in a narrow strip (the label stays the accessible name); End session is destructive and always keeps its words. It carries no status: the active tab is the run's status.
 */
export default function RunActions({ runId }: { runId: string }): ReactElement | null {
  const summary = useAppStore((s) => s.runs[runId]?.summary)
  const interrupt = useAppStore((s) => s.interrupt)
  const stopRun = useAppStore((s) => s.stopRun)
  const startRetro = useAppStore((s) => s.startRetro)
  const mock = useAppStore((s) => !!s.appInfo?.mockAdapter)
  const setupModel = useAssistantModel('setupModel')
  if (!summary) return null
  const sessionOpen = summary.status === 'running' || summary.status === 'idle' || summary.status === 'starting'
  const canRetro = !sessionOpen && summary.kind === 'work' && (summary.status === 'finished' || summary.status === 'error')
  if (!sessionOpen && !canRetro) return null
  const interruptHelp = 'Stops the current turn. The session stays open.'
  const endHelp = 'Ends the session and stops all of its agents.'
  const retroHelp = `Have the Architect (${modelDisplayName(setupModel)}, set in App settings > Defaults) review this run and revise the org chart where roles struggled. Starts a session (${mock ? 'mock, no tokens' : 'spends tokens'}).`
  return (
    <div className="run-actions" role="group" aria-label="Run actions">
      {sessionOpen && (
        <>
          <Described text={interruptHelp}>
            <Button size="sm" icon={Pause} ariaLabel="Interrupt turn" onClick={() => void interrupt()} disabled={summary.status !== 'running'} title={interruptHelp}>
              <span className="run-act-label run-act-collapse">Interrupt turn</span>
            </Button>
          </Described>
          <span className="run-act-end">
            <Described text={endHelp}>
              <Button size="sm" variant="danger" icon={Square} ariaLabel="End session" onClick={() => void stopRun()} title={endHelp}>
                <span className="run-act-label">End session</span>
              </Button>
            </Described>
          </span>
        </>
      )}
      {canRetro && (
        <Described text={retroHelp}>
          <Button size="sm" icon={RotateCcw} ariaLabel="Org retrospective" title={retroHelp} onClick={() => void startRetro(summary.id)}>
            <span className="run-act-label run-act-collapse">Org retrospective</span>
          </Button>
        </Described>
      )}
    </div>
  )
}
