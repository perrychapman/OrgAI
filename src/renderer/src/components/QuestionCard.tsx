import type { ReactElement } from 'react'
import { useState } from 'react'
import type { QuestionAnswer, UserQuestion } from '@shared/types'
import DecisionCard from './DecisionCard'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Textarea } from './ui/Textarea'

interface Props {
  runId: string
  question: UserQuestion
  /** Display name of the asking agent (the Architect for setup runs). */
  who: string
  onAnswer: (answer: QuestionAnswer) => void
}

/** A multiple-choice question from an agent (ask_user). Blocks the agent until submitted. */
export default function QuestionCard({ runId, question, who, onAnswer }: Props): ReactElement {
  const [selected, setSelected] = useState<string[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const toggle = (label: string): void => {
    if (question.allowMultiple) {
      setSelected((s) => (s.includes(label) ? s.filter((l) => l !== label) : [...s, label]))
    } else {
      setSelected((s) => (s[0] === label ? [] : [label]))
    }
  }

  const canSubmit = !busy && (selected.length > 0 || (question.allowFreeText && text.trim().length > 0))

  const submit = (): void => {
    if (!canSubmit) return
    setBusy(true)
    const note = question.allowFreeText ? text.trim() : ''
    onAnswer(note ? { selected, text: note } : { selected })
  }

  return (
    <DecisionCard
      kind="question"
      runId={runId}
      title={question.question}
      who={who}
      helper={
        <>
          {who} is waiting for your answer. {question.allowMultiple ? 'Pick one or more.' : 'Pick one.'}
        </>
      }
      primary={
        <Button variant="primary" size="sm" disabled={!canSubmit} onClick={submit}>
          {busy ? 'Sending…' : 'Submit'}
        </Button>
      }
    >
      <div className="stack-3">
        <div className="question-options" role={question.allowMultiple ? 'group' : 'radiogroup'} aria-label={question.question}>
          {question.options.map((o) => {
            const checked = selected.includes(o.label)
            if (question.allowMultiple) {
              return (
                <div key={o.label} className={`question-option${checked ? ' selected' : ''}`}>
                  <Checkbox checked={checked} disabled={busy} onChange={() => toggle(o.label)} label={o.label} description={o.description} />
                </div>
              )
            }
            return (
              <label key={o.label} className={`question-option${checked ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name={`q-${question.id}`}
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggle(o.label)}
                  onClick={() => {
                    // Clicking the chosen radio again clears it; onChange does not fire for that.
                    if (checked) toggle(o.label)
                  }}
                />
                <span>
                  <span className="question-label">{o.label}</span>
                  {o.description && <span className="question-desc">{o.description}</span>}
                </span>
              </label>
            )
          })}
        </div>
        {question.allowFreeText && (
          <Textarea
            value={text}
            disabled={busy}
            rows={2}
            aria-label="Your answer in your own words"
            onChange={setText}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
            }}
            placeholder={selected.length ? 'Anything to add? (optional)' : 'Or answer in your own words'}
          />
        )}
      </div>
    </DecisionCard>
  )
}
