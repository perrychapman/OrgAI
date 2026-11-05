import type { ReactElement, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FolderConfigFile, FolderConfigReview, Project } from '@shared/types'
import { FOLDER_CONFIG_FILE_TEXT_MAX } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { SettingsCard } from './SettingsCard'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { showHidden } from '../../lib/hiddenChars'
import {
  FOLDER_TRUST_FRAMING,
  FOLDER_TRUST_OPEN_EVENT,
  FOLDER_TRUST_STALE,
  MASKED_BADGE,
  MASKED_BADGE_TITLE,
  canAccept,
  canRevoke,
  filesSummary,
  folderTrustSentence,
  folderTrustState,
  hiddenBadgeText,
  isLongText,
  itemBadges,
  reviewSections,
  takeFolderTrustRequest,
  type ReviewSectionKey
} from '../../lib/folderTrust'
import type { FolderTrustReviewState } from './useFolderTrustReview'

/** Plain text only: hidden characters are written out, long text is clamped behind a toggle. */
function TrustText({ text, label }: { text: string; label: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const id = useId()
  const shown = showHidden(text)
  const long = isLongText(shown)
  return (
    <>
      <pre id={id} className={`trust-text${long && !open ? ' clamped' : ''}`}>
        {shown}
      </pre>
      {long && (
        <button type="button" className="btn ghost sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show all'}
          <span className="sr-only"> of {label}</span>
        </button>
      )}
    </>
  )
}

function Badges({ item }: { item: { masked?: boolean; hiddenChar?: string } }): ReactElement | null {
  const b = itemBadges(item)
  if (!b.masked && !b.hidden) return null
  return (
    <>
      {b.masked && (
        <Badge tone="info" title={MASKED_BADGE_TITLE} testId="folder-trust-badge-masked">
          {MASKED_BADGE}
        </Badge>
      )}
      {b.hidden && (
        <Badge tone="attention" title="This text holds a character that cannot be seen. It is written out below." testId="folder-trust-badge-hidden">
          {hiddenBadgeText(b.hidden)}
        </Badge>
      )}
    </>
  )
}

function Item({ testId, head, source, badges, data, children }: { testId: string; head: ReactNode; source?: string; badges?: ReactNode; data?: Record<string, string>; children?: ReactNode }): ReactElement {
  const attrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(data ?? {})) attrs[`data-${k}`] = v
  return (
    <li className="trust-item" data-testid={testId} {...attrs}>
      <div className="trust-item-head">
        <span className="trust-item-name">{head}</span>
        {badges}
        {source && <span className="trust-source">{showHidden(source)}</span>}
      </div>
      {children}
    </li>
  )
}

function FileRow({ file }: { file: FolderConfigFile }): ReactElement {
  const [open, setOpen] = useState(false)
  const id = useId()
  const path = showHidden(file.path)
  return (
    <Item
      testId="folder-trust-file"
      data={{ digested: String(file.digested) }}
      head={<span className="trust-mono">{path}</span>}
      badges={
        <>
          <Badge tone={file.digested ? 'neutral' : 'attention'}>{file.digested ? 'Checked for changes' : 'Not checked'}</Badge>
          <Badges item={file} />
        </>
      }
    >
      <p className="trust-meta">
        {file.kind === 'link' ? `Link to ${showHidden(file.linkTarget ?? '')}` : file.kind === 'other' ? 'Not a regular file' : `${file.sizeBytes.toLocaleString('en-GB')} bytes`}
        {file.truncated && ` · Only the first ${Math.round(FOLDER_CONFIG_FILE_TEXT_MAX / 1024)} KB of text is shown.`}
      </p>
      {file.text !== undefined && (
        <>
          <button type="button" className="btn ghost sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide text' : 'Show text'}
            <span className="sr-only"> of {path}</span>
          </button>
          <div id={id} hidden={!open}>
            {open && <TrustText text={file.text} label={path} />}
          </div>
        </>
      )}
    </Item>
  )
}

function SectionList({ review, k }: { review: FolderConfigReview; k: ReviewSectionKey }): ReactElement {
  switch (k) {
    case 'commands':
      return (
        <ul className="trust-list">
          {review.commands.map((c, i) => (
            <Item key={i} testId="folder-trust-command" head={`${c.kind === 'hook' ? 'Hook' : 'Helper'}: ${showHidden(c.label)}`} source={c.source} badges={<Badges item={c} />}>
              <TrustText text={c.command} label={c.label} />
            </Item>
          ))}
        </ul>
      )
    case 'mcpServers':
      return (
        <ul className="trust-list">
          {review.mcpServers.map((m, i) => (
            <Item key={i} testId="folder-trust-mcp" head={showHidden(m.name)} source={m.source} badges={<Badges item={m} />}>
              <TrustText text={m.target} label={m.name} />
            </Item>
          ))}
        </ul>
      )
    case 'env':
      return (
        <ul className="trust-list">
          {review.env.map((e, i) => (
            <Item
              key={i}
              testId="folder-trust-env"
              data={{ routing: String(e.routing === true) }}
              head={<span className="trust-mono">{showHidden(e.name)}</span>}
              source={e.source}
              badges={
                <>
                  {e.routing && (
                    <Badge tone="attention" title="This name changes where requests go or which model or account is used.">
                      Redirects requests
                    </Badge>
                  )}
                  <Badges item={e} />
                </>
              }
            >
              <TrustText text={e.value} label={e.name} />
            </Item>
          ))}
        </ul>
      )
    case 'otherSettings':
      return (
        <ul className="trust-list">
          {review.otherSettings.map((s, i) => (
            <Item key={i} testId="folder-trust-setting" head={<span className="trust-mono">{showHidden(s.key)}</span>} source={s.source} badges={<Badges item={s} />}>
              <TrustText text={s.value} label={s.key} />
            </Item>
          ))}
        </ul>
      )
    case 'allowRules':
      return (
        <ul className="trust-list">
          {review.allowRules.map((r, i) => (
            <Item
              key={i}
              testId="folder-trust-rule"
              data={{ refused: String(!!r.refused) }}
              head={<span className="trust-mono">{showHidden(r.rule)}</span>}
              source={r.source}
              badges={
                <>
                  {r.refused && <Badge tone="danger">Refused</Badge>}
                  <Badges item={r} />
                </>
              }
            >
              {r.refused && <p className="trust-meta">OrgAI will not use this rule: {showHidden(r.refused)}</p>}
            </Item>
          ))}
        </ul>
      )
    default:
      return (
        <ul className="trust-list">
          {review.files.map((f, i) => (
            <FileRow key={i} file={f} />
          ))}
        </ul>
      )
  }
}

type Message = { kind: 'stale' } | { kind: 'error'; text: string } | null

function ReviewBody({ review, message, messageRef }: { review: FolderConfigReview | null; message: Message; messageRef: RefObject<HTMLParagraphElement | null> }): ReactElement {
  if (!review) return <p className="trust-meta">Reading the folder…</p>
  const sections = reviewSections(review)
  return (
    <>
      {message && (
        <p ref={messageRef} tabIndex={-1} className="trust-message" data-testid={message.kind === 'stale' ? 'folder-trust-stale' : 'folder-trust-error'}>
          {message.kind === 'stale' ? FOLDER_TRUST_STALE : message.text}
        </p>
      )}
      {review.unreviewable && (
        <Banner tone="warning" title="This can't be allowed" testId="folder-trust-unreviewable">
          {review.unreviewable}
        </Banner>
      )}
      {review.truncated && (
        <p className="trust-meta" data-testid="folder-trust-truncated">
          This review is incomplete: a list or some text was cut. Anything that would run is never cut and then allowed.
        </p>
      )}
      {sections.length === 0 && <p className="trust-meta">Nothing in this folder would run or change what agents do.</p>}
      {sections.map((s) => (
        <section key={s.key} className="trust-section" aria-labelledby={`trust-h-${s.key}`}>
          <h3 id={`trust-h-${s.key}`} className="trust-h">
            {s.title} <span className="trust-count">({s.count})</span>
          </h3>
          {s.key === 'files' && <p className="trust-meta">{filesSummary(review)}</p>}
          <SectionList review={review} k={s.key} />
        </section>
      ))}
    </>
  )
}

/**
 * Settings > Permissions: the folder's own agent settings (hooks, env, MCP servers, allow rules). Agents ignore them until
 * the user reads the review and allows it. Hidden when the project carries no gate.
 */
export function FolderTrustSection({ project, trust }: { project: Project; trust: FolderTrustReviewState }): ReactElement | null {
  const { review, refresh, setReview } = trust
  const replaceProject = useAppStore((s) => s.replaceProject)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const [live, setLive] = useState('')
  const messageRef = useRef<HTMLParagraphElement>(null)
  const [messageTick, setMessageTick] = useState(0)
  const rowId = useId()

  const openDialog = useCallback(() => {
    setMessage(null)
    setLive('')
    setOpen(true)
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (takeFolderTrustRequest(project.id)) openDialog()
    const onRequest = (): void => {
      if (takeFolderTrustRequest(project.id)) openDialog()
    }
    window.addEventListener(FOLDER_TRUST_OPEN_EVENT, onRequest)
    return () => window.removeEventListener(FOLDER_TRUST_OPEN_EVENT, onRequest)
  }, [project.id, openDialog])

  useEffect(() => {
    if (messageTick > 0) messageRef.current?.focus()
  }, [messageTick])

  const fail = async (sentDigest: string, error: unknown): Promise<void> => {
    const sentence = cleanIpcError(error)
    const fresh = await refresh()
    setMessage(fresh && fresh.digest !== sentDigest ? { kind: 'stale' } : { kind: 'error', text: sentence })
    setMessageTick((t) => t + 1)
    setLive('That did not go through.')
  }

  const decide = async (trustIt: boolean): Promise<void> => {
    if (!review || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await window.orgai.folderConfig.setTrust({ projectId: project.id, trust: trustIt, digest: review.digest })
      replaceProject(res.project)
      setReview(res.review)
      setLive(trustIt ? 'Allowed. Agents use this folder\'s own settings from the next run.' : 'Stopped. Agents ignore this folder\'s own settings from the next run.')
    } catch (e) {
      await fail(review.digest, e)
    } finally {
      setBusy(false)
    }
  }

  const state = folderTrustState(project, review)
  if (state === 'none') return null
  const sentence = folderTrustSentence(state, project.folderConfigTrust?.decidedAt)

  return (
    <>
      <div data-testid="folder-trust-section">
        <SettingsCard>
          <SettingRow
            id={rowId}
            title="This folder's own agent settings"
            description={
              <span data-testid="folder-trust-status" data-state={state}>
                {sentence}
              </span>
            }
            control={
              <Button testId="folder-trust-review-open" ariaDescribedBy={settingDescId(rowId)} onClick={openDialog}>
                Review
              </Button>
            }
          />
        </SettingsCard>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="This folder's own agent settings"
        size="lg"
        testId="folder-trust-dialog"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Close</Button>
            {canRevoke(review) && (
              <Button variant="danger" loading={busy} testId="folder-trust-revoke" onClick={() => void decide(false)}>
                Stop using these settings
              </Button>
            )}
            {canAccept(review) && (
              <Button variant="primary" loading={busy} testId="folder-trust-accept" onClick={() => void decide(true)}>
                Allow these settings
              </Button>
            )}
          </>
        }
      >
        <div className="trust-dialog">
          <p className="trust-framing" data-autofocus tabIndex={-1}>
            {FOLDER_TRUST_FRAMING}
          </p>
          <p className="trust-state" data-testid="folder-trust-dialog-status" data-state={state}>
            {sentence}
          </p>
          <div className="sr-only" role="status" data-testid="folder-trust-live">
            {live}
          </div>
          <ReviewBody review={review} message={message} messageRef={messageRef} />
        </div>
      </Dialog>
    </>
  )
}
