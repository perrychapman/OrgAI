import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useState } from 'react'
import type { VirtualProjectId } from '@shared/types'
import { START_PAGE_COPY } from '../../lib/assistants'
import { cleanIpcError } from '../../lib/ipcError'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Textarea } from '../ui/Textarea'
import AssistantModelLine from './AssistantModelLine'

export const INSTRUCTION_MAX_CHARS = 2000

/**
 * The start page shared by the MCP and Skill assistants: copy, one instruction field, optional extra controls, the model
 * line and Start. A seed (an instruction handed over by the caller) fills the field once. Errors show inline.
 */
export default function InstructionStartPage({
  id,
  testId,
  label,
  placeholder,
  modelKey,
  extras,
  onStart
}: {
  id: VirtualProjectId
  testId: string
  label: string
  placeholder: string
  modelKey: 'mcpAssistModel' | 'skillAssistModel'
  extras?: ReactNode
  onStart: (instruction: string) => Promise<void>
}): ReactElement {
  const copy = START_PAGE_COPY[id]
  const seed = useAppStore((s) => s.assistantSeed[id])
  const [text, setText] = useState(seed ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldId = useId()

  useEffect(() => {
    if (seed === undefined) return
    setText(seed)
    useAppStore.getState().clearAssistantSeed(id)
  }, [seed, id])

  const start = async (): Promise<void> => {
    const instruction = text.trim()
    if (!instruction || busy) return
    setBusy(true)
    setError(null)
    try {
      await onStart(instruction)
    } catch (e) {
      setError(cleanIpcError(e, 'Could not start the assistant.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="new-run" data-testid={testId}>
      <div className="new-run-inner">
        <EmptyState title={copy.title} description={copy.description} />
        <form
          className="assistant-form"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          {error && (
            <div role="alert">
              <Banner tone="danger" title="Could not start the assistant">
                {error}
              </Banner>
            </div>
          )}
          <div className="field">
            <label htmlFor={fieldId}>{label}</label>
            <Textarea
              id={fieldId}
              data-testid="assistant-instruction"
              autoFocus
              maxLength={INSTRUCTION_MAX_CHARS}
              rows={4}
              value={text}
              placeholder={placeholder}
              onChange={setText}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void start()
                }
              }}
            />
          </div>
          {extras}
          <AssistantModelLine modelKey={modelKey} />
          <div className="assistant-form-actions">
            <Button variant="primary" type="submit" testId="assistant-start" loading={busy} disabled={!text.trim()}>
              Start
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
