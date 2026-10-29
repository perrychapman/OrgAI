import type { ReactElement } from 'react'
import { useState } from 'react'
import type { QuestionAnswer, UserQuestion } from '@shared/types'

interface Props {
  question: UserQuestion
  onAnswer: (answer: QuestionAnswer) => void
}

/** A multiple-choice question from the Architect (ask_user). Blocks the Architect until submitted. */
export default function QuestionCard({ question, onAnswer }: Props): ReactElement {
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
    <div className="proposal kind-question">
      <div className="proposal-head">
        <span className="chip">Question</span>
        <strong>{question.question}</strong>
      </div>
      <div className="question-options">
        {question.options.map((o) => {
          const checked = selected.includes(o.label)
          return (
            <label key={o.label} className={`question-option${checked ? ' selected' : ''}`}>
              <input
                type={question.allowMultiple ? 'checkbox' : 'radio'}
                name={`q-${question.id}`}
                checked={checked}
                disabled={busy}
                onChange={() => toggle(o.label)}
                onClick={() => {
                  // Clicking the chosen radio again clears it; onChange does not fire for that.
                  if (!question.allowMultiple && checked) toggle(o.label)
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
        <textarea
          className="textarea"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
          }}
          placeholder={selected.length ? 'Anything to add? (optional)' : 'Or answer in your own words'}
          style={{ marginTop: 8 }}
        />
      )}
      <div className="proposal-note">
        {question.allowMultiple ? 'Pick one or more.' : 'Pick one.'} The Architect waits for your answer.
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" onClick={submit} disabled={!canSubmit}>
          {busy ? 'Sending…' : 'Submit'}
        </button>
      </div>
    </div>
  )
}
