import type { ReactElement, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Copy, FolderOpen, RefreshCw } from 'lucide-react'
import type { ProjectPathCheck, RepoSourceParse, RepoTools } from '@shared/types'
import { REPO_DESTINATION_MAX_CHARS, REPO_SOURCE_MAX_CHARS } from '@shared/types'
import { examplePath } from '../../lib/platform'
import { cancelRepoClone, clearRepoFailure, forgetRepoClone, startRepoClone, useRepoSession } from '../../lib/repoCloneSession'
import {
  CLONE_KEPT_NOTE,
  FRESH_ANNOUNCER,
  GIT_MISSING_REASON,
  cancelledNotice,
  cloneActionLabel,
  cloneBlocker,
  cloneTarget,
  destinationFieldProblem,
  effectiveMode,
  forkAvailability,
  forkPreview,
  forkResultLines,
  isDestinationRefusal,
  nextAnnouncement,
  progressLine,
  repoConfigLines,
  targetProblem,
  writeLastCloneParent,
  type RepoFields
} from '../../lib/repoStart'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'

/** Kept between mounts so reopening the panel does not flash "checking" over what was just known. */
let lastTools: RepoTools | null = null

function focusSoon(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus())
}

/**
 * The From GitHub part of the New project form: repository, clone or fork, destination, the clone step and its result.
 * The form owns the field values (a parked draft must keep them), the checkPath answer and the one polite status region
 * (`announce`). `adopted` says the form is using the finished clone; `children` are the form's lines about that folder.
 */
export function RepoStartPanel({
  uid,
  fields,
  onFields,
  check,
  existingProjectName,
  adopted,
  onForgetAdopted,
  announce,
  children
}: {
  uid: string
  fields: RepoFields
  onFields: (patch: Partial<RepoFields>) => void
  /** checkPath's answer for the target (or, once adopted, the cloned folder); null while unknown. */
  check: ProjectPathCheck | null
  existingProjectName?: string
  adopted: boolean
  onForgetAdopted: () => void
  announce: (text: string) => void
  children?: ReactNode
}): ReactElement {
  const ids = {
    source: `${uid}-repo-source`,
    sourceMsg: `${uid}-repo-source-msg`,
    forkReason: `${uid}-repo-fork-reason`,
    parent: `${uid}-repo-parent`,
    folder: `${uid}-repo-folder`,
    targetMsg: `${uid}-repo-target-msg`,
    destErr: `${uid}-repo-dest-err`,
    why: `${uid}-repo-why`,
    error: `${uid}-repo-error`,
    cancel: `${uid}-repo-cancel`,
    action: `${uid}-repo-action`,
    cloned: `${uid}-repo-cloned`
  }
  const session = useRepoSession()
  const running = session.status === 'running'

  // ---- Tools: when the panel opens and on Check again, never per keystroke (gh auth status reaches the network). ----
  const [tools, setTools] = useState<RepoTools | null>(lastTools)
  const [checking, setChecking] = useState(false)
  const toolsSeq = useRef(0)
  const loadTools = (say: boolean): void => {
    const seq = ++toolsSeq.current
    setChecking(true)
    void window.orgai.repos
      .tools()
      .then((t) => {
        if (seq !== toolsSeq.current) return
        lastTools = t
        setTools(t)
        setChecking(false)
        if (say) {
          const fork = forkAvailability(t, parse)
          announce(!t.git.available ? GIT_MISSING_REASON : fork.available ? (t.gh.login ? `Signed in to the GitHub CLI as ${t.gh.login}.` : 'Signed in to the GitHub CLI.') : (fork.reason ?? ''))
        }
      })
      .catch(() => {
        if (seq === toolsSeq.current) setChecking(false)
      })
  }
  useEffect(() => {
    loadTools(false)
    return () => {
      toolsSeq.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Live parse of the address. Stale answers are dropped. ----
  const [parsed, setParsed] = useState<{ text: string; result: RepoSourceParse } | null>(null)
  const sourceText = fields.source.trim()
  useEffect(() => {
    if (!sourceText) return undefined
    let live = true
    const t = setTimeout(() => {
      void window.orgai.repos.parseSource(sourceText).then((result) => {
        if (live) setParsed({ text: sourceText, result })
      })
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [sourceText])
  const parse = parsed && parsed.text === sourceText ? parsed.result : null

  // The folder name follows the repository until the user types one.
  useEffect(() => {
    if (fields.folderEdited) return
    if (!sourceText) {
      if (fields.folder) onFields({ folder: '' })
      return
    }
    if (parse?.ok && parse.suggestedFolder !== fields.folder) onFields({ folder: parse.suggestedFolder })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parse, sourceText, fields.folderEdited])

  const fork = forkAvailability(tools, parse)
  const mode = effectiveMode(fields.mode, fork)
  const blocker = cloneBlocker({ fields, parse, tools, check, existingProjectName })
  const target = cloneTarget(fields)
  const fieldProblem = destinationFieldProblem(fields)
  const checkProblem = target ? targetProblem(check) : null
  const refusal = session.status === 'failed' && !session.cancelled && isDestinationRefusal(session.message) ? session.message : null
  const failure = session.status === 'failed' && !session.cancelled && !refusal ? session.message : null
  const stopped = session.status === 'failed' && session.cancelled ? cancelledNotice(session.message) : null
  const destinationBad = !!(fieldProblem || checkProblem || refusal)

  const edit = (patch: Partial<RepoFields>): void => {
    clearRepoFailure()
    onFields(patch)
  }
  const browse = async (): Promise<void> => {
    const dir = await window.orgai.projects.pickDirectory()
    if (dir) edit({ parent: dir })
  }
  const start = (): void => {
    if (blocker || running || !target) return
    writeLastCloneParent(fields.parent)
    startRepoClone({ source: fields.source, mode, destination: target, display: parse?.ok ? parse.display : sourceText })
    focusSoon(ids.cancel)
  }
  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter') return
    // Enter here runs this step; it must never submit the form behind it.
    e.preventDefault()
    start()
  }

  // ---- Progress speaks at a sensible rate; a failure takes focus. ----
  const announcer = useRef(FRESH_ANNOUNCER)
  const progress = running ? session.progress : null
  useEffect(() => {
    if (!running) {
      announcer.current = FRESH_ANNOUNCER
      return
    }
    if (!progress) return
    const next = nextAnnouncement(announcer.current, progress)
    announcer.current = next.state
    if (next.text) announce(next.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, progress])
  const prevStatus = useRef(session.status)
  useEffect(() => {
    const was = prevStatus.current
    prevStatus.current = session.status
    if (was !== 'running' || session.status !== 'failed') return
    if (session.cancelled) {
      announce(cancelledNotice(session.message))
      focusSoon(ids.action)
    } else {
      focusSoon(isDestinationRefusal(session.message) ? ids.destErr : ids.error)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // ---- Finished: the clone's result replaces the controls. ----
  if (adopted && session.status === 'done') {
    const { result } = session
    return (
      <div className="repo-start" data-testid="repo-start-panel">
        <p id={ids.cloned} className="field-msg ok repo-cloned" tabIndex={-1} data-testid="repo-cloned-line">
          Cloned to <span className="repo-path">{result.path}</span>
          {result.branch ? `, branch ${result.branch}` : ''}. {CLONE_KEPT_NOTE}
        </p>
        {result.fork && (
          <div className="repo-lines" data-testid="repo-fork-result">
            {forkResultLines(result.fork).map((l) => (
              <span key={l.text} className={`field-msg${l.warn ? ' warn' : ''}`}>
                {l.text}
              </span>
            ))}
          </div>
        )}
        <div className="repo-lines" data-testid="repo-config-line">
          {repoConfigLines(result.repoConfig).map((l) => (
            <span key={l} className="hint repo-config">
              {l}
            </span>
          ))}
        </div>
        {children}
        <div>
          <button
            type="button"
            className="link-btn"
            data-testid="repo-clone-another"
            onClick={() => {
              forgetRepoClone()
              onForgetAdopted()
              focusSoon(ids.source)
            }}
          >
            Clone a different repository
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="repo-start" data-testid="repo-start-panel">
      <fieldset className="repo-lock" disabled={running}>
        <div className="field">
          <label htmlFor={ids.source}>Repository</label>
          <Input
            id={ids.source}
            mono
            value={fields.source}
            onChange={(source) => edit({ source })}
            onKeyDown={onEnter}
            maxLength={REPO_SOURCE_MAX_CHARS}
            placeholder="https://github.com/owner/repo or owner/repo"
            invalid={parse?.ok === false}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={parse?.ok === false ? ids.sourceMsg : undefined}
            data-testid="repo-source"
          />
          {parse?.ok === false && (
            <span id={ids.sourceMsg} className="field-msg error" data-testid="repo-source-error">
              {parse.problem}
            </span>
          )}
        </div>

        <fieldset className="import-choice repo-mode" data-testid="repo-mode">
          <legend className="sr-only">How to get the repository</legend>
          <label>
            <input type="radio" name={`${uid}-repo-mode`} value="clone" checked={mode === 'clone'} onChange={() => edit({ mode: 'clone' })} data-testid="repo-mode-clone" />
            Clone it
          </label>
          <label data-inert={fork.available ? undefined : 'true'}>
            <input
              type="radio"
              name={`${uid}-repo-mode`}
              value="fork"
              checked={mode === 'fork'}
              aria-disabled={fork.available ? undefined : 'true'}
              aria-describedby={fork.reason ? ids.forkReason : undefined}
              onChange={() => {
                // Inert, not disabled, so the keyboard reaches it and hears why. React puts the checked state back.
                if (fork.available) edit({ mode: 'fork' })
              }}
              data-testid="repo-mode-fork"
            />
            Fork to my GitHub account, then clone
          </label>
        </fieldset>

        {mode === 'fork' && (
          <div className="repo-lines repo-fork-preview" data-testid="repo-fork-preview">
            {forkPreview(tools, parse).map((l) => (
              <span key={l} className="field-msg">
                {l}
              </span>
            ))}
          </div>
        )}
        {tools && !tools.git.available && (
          <span className="field-msg error repo-git" data-testid="repo-git-missing">
            {GIT_MISSING_REASON}
          </span>
        )}
        {fork.reason && (
          <span id={ids.forkReason} className="field-msg repo-fork-reason" data-testid="repo-fork-reason">
            {fork.reason} {!fork.available && fork.canRecheck ? 'A plain clone still works without it.' : ''}
          </span>
        )}
        {(fork.canRecheck || fork.command || (tools && !tools.git.available)) && (
          <div className="repo-tools-row">
            {fork.command && (
              <span className="repo-command">
                <code data-testid="repo-gh-command">{fork.command}</code>
                <IconButton
                  icon={Copy}
                  size="sm"
                  label={`Copy ${fork.command}`}
                  testId="repo-gh-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(fork.command as string).then(
                      () => announce(`Copied ${fork.command}.`),
                      () => announce('Could not copy.')
                    )
                  }}
                />
              </span>
            )}
            <Button size="sm" icon={RefreshCw} loading={checking} onClick={() => loadTools(true)} testId="repo-tools-recheck">
              Check again
            </Button>
          </div>
        )}

        <div className="repo-dest">
          <div className="field repo-dest-parent">
            <label htmlFor={ids.parent}>Save in</label>
            <div className="row">
              <div className="grow">
                <Input
                  id={ids.parent}
                  mono
                  value={fields.parent}
                  onChange={(parent) => edit({ parent })}
                  onKeyDown={onEnter}
                  maxLength={REPO_DESTINATION_MAX_CHARS}
                  placeholder={examplePath('projects')}
                  invalid={destinationBad}
                  aria-describedby={`${ids.targetMsg}${refusal ? ` ${ids.destErr}` : ''}`}
                  data-testid="repo-parent"
                />
              </div>
              <Button icon={FolderOpen} onClick={() => void browse()} testId="repo-parent-browse">
                Browse
              </Button>
            </div>
          </div>
          <div className="field repo-dest-folder">
            <label htmlFor={ids.folder}>Folder name</label>
            <Input
              id={ids.folder}
              mono
              value={fields.folder}
              onChange={(folder) => edit({ folder, folderEdited: true })}
              onKeyDown={onEnter}
              maxLength={255}
              invalid={destinationBad}
              spellCheck={false}
              aria-describedby={`${ids.targetMsg}${refusal ? ` ${ids.destErr}` : ''}`}
              data-testid="repo-folder"
            />
          </div>
        </div>
        <div className="repo-lines repo-target" id={ids.targetMsg}>
          {target && !fieldProblem && (
            <span className="field-msg" data-testid="repo-target-line">
              Will clone into <span className="repo-path">{target}</span>
            </span>
          )}
          {(fieldProblem || checkProblem) && (
            <span className="field-msg error" data-testid="repo-destination-problem">
              {fieldProblem ?? checkProblem}
            </span>
          )}
          {existingProjectName && (
            <span className="field-msg warn" data-testid="already-project">
              This folder is already a project: {existingProjectName}.
            </span>
          )}
        </div>
        {refusal && (
          <span id={ids.destErr} className="field-msg error repo-error" tabIndex={-1} data-testid="repo-destination-error">
            {refusal}
          </span>
        )}
      </fieldset>

      {failure && (
        <p id={ids.error} className="field-msg error repo-error" tabIndex={-1} data-testid="repo-clone-error">
          {failure}
        </p>
      )}
      {stopped && (
        <p className="field-msg" data-testid="repo-clone-cancelled">
          {stopped}
        </p>
      )}
      {running ? (
        <div className="repo-progress-block" data-testid="repo-clone-progress">
          <span className="field-msg" data-testid="repo-clone-progress-label">
            {session.cancelling ? 'Stopping' : progressLine(session.progress)} ({session.display})
          </span>
          {session.progress?.percent !== undefined ? <progress className="repo-progress" max={100} value={session.progress.percent} aria-label="Clone progress" /> : <progress className="repo-progress" aria-label="Clone progress" />}
          <div>
            <Button
              id={ids.cancel}
              inert={session.cancelling}
              onClick={() => {
                announce('Stopping the clone.')
                cancelRepoClone()
              }}
              testId="repo-clone-cancel"
            >
              Cancel clone
            </Button>
          </div>
        </div>
      ) : (
        <div className="row repo-action">
          {blocker ? (
            <Button id={ids.action} variant="primary" inert ariaDescribedBy={ids.why} testId="repo-clone">
              {cloneActionLabel(mode)}
            </Button>
          ) : (
            <Button id={ids.action} variant="primary" onClick={start} testId="repo-clone">
              {cloneActionLabel(mode)}
            </Button>
          )}
          {blocker && (
            <span id={ids.why} className="hint" data-testid="repo-clone-why">
              {blocker}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
