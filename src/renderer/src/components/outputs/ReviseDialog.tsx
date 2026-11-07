// "Ask the team to revise <title>" (docs/design/outputs-2.md 11.4). Usable inside a detail (the shell mounts it from
// ctx.openRevise) and outside one (a transcript row, a project row menu, the diagram error pane). Refusals from main stay
// in the dialog; success closes it and the caller returns focus to its opener.
import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { OutputReviseOptions, OutputReviseResult, OutputVersion, RunOutput } from '@shared/types'
import { OUTPUT_REVISE_TEXT_MAX } from '@shared/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Textarea'
import { showHidden } from '../../lib/hiddenChars'
import { useAppStore } from '../../store/useAppStore'
import {
  FORMAT_WARNING,
  SELECT_FIRST_TEXT,
  consequenceLine,
  defaultTarget,
  formatWarningApplies,
  placeholderFor,
  targetOfValue,
  targetOptions,
  validateInstruction,
  type ReviseScope
} from '../../lib/outputRevise'
import { useOutputDetail, type ReviseInit } from './outputDetailContext'
import '../../styles/outputs-revise.css'

export { canRevise } from '../../lib/outputRevise'

export interface ReviseDialogProps {
  output: RunOutput
  /** The version the user is looking at (default: current). */
  version?: number
  init?: ReviseInit
  /** Unsaved editor changes block Send and offer "Save your edits first" through onSaveFirst. */
  dirty?: boolean
  onSaveFirst?: () => Promise<boolean>
  /** Closed; `result` is the successful answer (the dialog shows refusals itself and stays open). */
  onClose(result: OutputReviseResult | null): void
}

export default function ReviseDialog(props: ReviseDialogProps): ReactElement {
  const { output, init, dirty, onSaveFirst, onClose } = props
  const ctx = useOutputDetail()
  const current = output.version ?? 1
  const viewed = props.version ?? current
  const selection = init?.selection !== undefined ? init.selection : (ctx?.selection ?? null)
  const noteIds = init?.noteIds ?? []
  const uid = useId()

  const firstScope: ReviseScope = init?.scope === 'notes' && noteIds.length > 0 ? 'notes' : init?.scope === 'selection' && selection ? 'selection' : 'whole'
  const [scope, setScope] = useState<ReviseScope>(firstScope)
  const [text, setText] = useState(init?.instruction ?? '')
  const [options, setOptions] = useState<OutputReviseOptions | null>(null)
  const [optionsFailed, setOptionsFailed] = useState(false)
  const [versions, setVersions] = useState<OutputVersion[] | null>(null)
  const [target, setTarget] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const api = window.orgai?.outputs
    if (!api) {
      setOptionsFailed(true)
      return
    }
    const ref = { projectId: output.projectId, outputId: output.id }
    api.reviseOptions(ref).then(
      (o) => {
        if (!alive.current) return
        setOptions(o)
        setTarget((t) => t || defaultTarget(targetOptions(o)))
      },
      () => alive.current && setOptionsFailed(true)
    )
    api.versions(ref).then(
      (v) => alive.current && setVersions(v),
      () => undefined
    )
  }, [output.projectId, output.id])

  const targets = useMemo(() => targetOptions(options), [options])
  const noTargets = options !== null && targets.length === 0
  const warn = formatWarningApplies(output.kind, versions)
  const title = showHidden(output.title)
  const savingFirst = useRef(false)

  const send = async (): Promise<void> => {
    if (sending || dirty) return
    const problem = validateInstruction(scope, text, noteIds.length)
    if (problem) {
      setError(problem)
      return
    }
    const api = window.orgai?.outputs
    if (!api || !target) return
    setError('')
    setSending(true)
    try {
      const res = await api.revise({
        projectId: output.projectId,
        outputId: output.id,
        version: viewed,
        scope,
        ...(scope === 'selection' && selection ? { anchor: selection.anchor } : {}),
        ...(scope === 'notes' ? { noteIds } : {}),
        instruction: text.trim(),
        target: targetOfValue(target)
      })
      if (!alive.current) return
      if ('refused' in res) {
        setError(res.refused)
        setSending(false)
        return
      }
      useAppStore.getState().addPendingRevision({
        requestId: res.requestId,
        runId: res.runId,
        projectId: output.projectId,
        outputId: output.id,
        title: output.title,
        version: viewed,
        at: Date.now()
      })
      onClose(res)
    } catch (e) {
      if (!alive.current) return
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : 'The request could not be sent.')
      setSending(false)
    }
  }

  const saveFirst = async (): Promise<void> => {
    if (!onSaveFirst || savingFirst.current) return
    savingFirst.current = true
    try {
      await onSaveFirst()
    } finally {
      savingFirst.current = false
    }
  }

  const textId = `${uid}-text`
  const hintId = `${uid}-hint`
  const required = scope !== 'notes'
  const sendBlocked = sending || !!dirty || !target || noTargets
  return (
    <Dialog
      open
      onClose={() => onClose(null)}
      title={`Ask the team to revise ${title}`}
      size="md"
      testId="output-revise-dialog"
      footer={
        <>
          <Button onClick={() => onClose(null)}>Cancel</Button>
          <Button variant="primary" testId="output-revise-send" loading={sending} disabled={sendBlocked} onClick={() => void send()}>
            Send to the team
          </Button>
        </>
      }
    >
      <div className="revise-body">
        <fieldset className="revise-scope" role="radiogroup" data-testid="output-revise-scope">
          <legend>What to change</legend>
          <label className="revise-radio">
            <input type="radio" name={`${uid}-scope`} checked={scope === 'whole'} onChange={() => setScope('whole')} data-testid="output-revise-whole" />
            <span>The whole output</span>
          </label>
          <label className="revise-radio">
            <input
              type="radio"
              name={`${uid}-scope`}
              checked={scope === 'selection'}
              disabled={!selection}
              onChange={() => setScope('selection')}
              data-testid="output-revise-selection"
              aria-describedby={`${uid}-sel`}
            />
            <span>The part I selected</span>
          </label>
          <p className="revise-sub" id={`${uid}-sel`}>
            {selection ? showHidden(selection.description) : SELECT_FIRST_TEXT}
          </p>
          {selection && scope === 'selection' && selection.anchor.type === 'region' && selection.anchor.labels && selection.anchor.labels.length > 0 && (
            <p className="revise-sub">Covers: {selection.anchor.labels.map(showHidden).join(', ')}</p>
          )}
          {noteIds.length > 0 && (
            <label className="revise-radio">
              <input type="radio" name={`${uid}-scope`} checked={scope === 'notes'} onChange={() => setScope('notes')} data-testid="output-revise-notes" />
              <span>{noteIds.length === 1 ? 'The note I selected (1)' : `The notes I selected (${noteIds.length})`}</span>
            </label>
          )}
        </fieldset>

        <div className="revise-field">
          <label htmlFor={textId}>{required ? 'What should change' : 'What should change (optional)'}</label>
          <Textarea
            id={textId}
            rows={4}
            value={text}
            maxLength={OUTPUT_REVISE_TEXT_MAX}
            placeholder={placeholderFor(output.kind, scope)}
            onChange={setText}
            data-testid="output-revise-text"
            data-autofocus
            aria-describedby={hintId}
          />
          <span className="revise-sub" id={hintId}>
            {text.length > OUTPUT_REVISE_TEXT_MAX - 500 ? `${text.length} of ${OUTPUT_REVISE_TEXT_MAX.toLocaleString('en-US')} characters` : 'Your words go to the team as you wrote them.'}
          </span>
        </div>

        <div className="revise-field">
          <label htmlFor={`${uid}-target`}>Send to</label>
          {optionsFailed ? (
            <p className="revise-sub">OrgAI could not load where this can go. Close and try again.</p>
          ) : options === null ? (
            <p className="revise-sub">Loading…</p>
          ) : noTargets ? (
            <p className="revise-sub">No run can take this right now.</p>
          ) : (
            <div data-testid="output-revise-target">
              <Select id={`${uid}-target`} value={target} options={targets.map((t) => ({ value: t.value, label: t.label }))} onChange={setTarget} />
            </div>
          )}
          <span className="revise-sub">{consequenceLine(current)}</span>
          {viewed !== current && <span className="revise-sub">You are looking at version {viewed}. The team revises the current version, {current}.</span>}
        </div>

        {warn && (
          <p className="revise-warn" data-testid="output-revise-format-warning">
            {FORMAT_WARNING}
          </p>
        )}
        {dirty && (
          <div className="revise-save-first">
            <p>You have unsaved edits. Save them so the team starts from what you see.</p>
            <Button size="sm" testId="output-revise-save-first" onClick={() => void saveFirst()}>
              Save your edits first
            </Button>
          </div>
        )}
        {error && (
          <p className="revise-error" role="alert" data-testid="output-revise-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}
