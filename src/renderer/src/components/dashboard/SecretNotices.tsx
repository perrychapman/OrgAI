import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { McpLibraryInfo, SecretsStatusResult } from '@shared/types'
import { START_OVER_WARNING, secretNotices, type KeyNames, type SecretNotice } from '@shared/view/secretNotices'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'

/** Moves focus to the topbar heading when no notice is left to hold it. */
function focusHeading(): void {
  const h = document.querySelector<HTMLElement>('main .topbar h1')
  if (!h) return
  h.tabIndex = -1
  h.focus({ preventScroll: true })
}

const TESTID: Record<SecretNotice['kind'], string> = {
  removed: 'secret-notice-removed',
  vault: 'secret-notice-vault',
  'legacy-corrupt': 'secret-notice-legacy-corrupt'
}

/**
 * The secure storage's quiet notices on the Dashboard (cli-standalone.md 5.5): secrets an older OrgAI removed (Restore /
 * Keep removed), a vault that will not open (Try again / Start over) and a damaged secrets.json. The Dashboard is the
 * first page the app opens on, which is why they live here rather than in App settings. Reads secrets:status on mount
 * and when the window gets focus; shows nothing when there is nothing to say or the status cannot be read. After an
 * action the notice goes (or says what failed) and focus lands on the next notice's first button, else the page heading.
 */
export function SecretNotices(): ReactElement | null {
  const projects = useAppStore((s) => s.projects)
  const [status, setStatus] = useState<SecretsStatusResult | null>(null)
  const [library, setLibrary] = useState<McpLibraryInfo[]>([])
  const [busy, setBusy] = useState<SecretNotice['kind'] | null>(null)
  const [errors, setErrors] = useState<Partial<Record<SecretNotice['kind'], string>>>({})
  const root = useRef<HTMLDivElement>(null)
  const { confirm, dialog } = useConfirm()

  const refresh = useCallback(async (): Promise<SecretsStatusResult | null> => {
    try {
      const s = await window.orgai.secrets.status()
      setStatus(s)
      return s
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const removedCount = status?.softDeletes.filter((d) => d.by === 'legacy').length ?? 0
  useEffect(() => {
    if (!removedCount) return
    let live = true
    window.orgai.mcpLibrary
      .list()
      .then((l) => live && setLibrary(l))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [removedCount])

  const names = useMemo<KeyNames>(() => {
    const servers = new Map<string, string>()
    for (const p of projects) for (const m of p.mcpServers ?? []) servers.set(`${p.id}:${m.id}`, m.name)
    const lib = new Map(library.map((l) => [l.entry.id, l.entry.name]))
    return { server: (p, s) => servers.get(`${p}:${s}`), library: (id) => lib.get(id) }
  }, [projects, library])

  const notices = useMemo(() => (status ? secretNotices(status, names) : []), [status, names])

  /**
   * After an action: refetch, then (once the new notices are committed) focus the first button of what remains, else the
   * heading. An effect rather than animation frames: frames are paused in a window that is not visible, and the old
   * notice is gone by then, so focus would be left on the body.
   */
  const focusedFor = useRef(0)
  const [settled, setSettled] = useState(0)
  const settle = async (): Promise<void> => {
    await refresh()
    setSettled((n) => n + 1)
  }
  useEffect(() => {
    if (settled === focusedFor.current) return
    focusedFor.current = settled
    const first = notices[0]
    const target = first ? root.current?.querySelector<HTMLElement>(`[data-testid=${TESTID[first.kind]}] button`) : null
    if (target) target.focus()
    else focusHeading()
  }, [notices, settled])

  // A refusal that points at "the notice on the Dashboard" is read inside that notice: say what happened instead.
  const fail = (kind: SecretNotice['kind'], e: unknown): void => {
    const text = cleanIpcError(e)
      .replace(/\s*(Open )?the (notice on the )?Dashboard( notice)?[^.]*\./gi, '')
      .trim()
    setErrors((m) => ({ ...m, [kind]: text || 'Secure storage is still closed.' }))
  }

  const run = async (n: SecretNotice, action: () => Promise<string | null>): Promise<void> => {
    setBusy(n.kind)
    setErrors((m) => ({ ...m, [n.kind]: undefined }))
    try {
      const problem = await action()
      if (problem) setErrors((m) => ({ ...m, [n.kind]: problem }))
      else await settle()
      if (problem) await refresh()
    } catch (e) {
      fail(n.kind, e)
    } finally {
      setBusy(null)
    }
  }

  const restore = (n: SecretNotice): Promise<void> =>
    run(n, async () => {
      let failed = 0
      let reason = ''
      for (const key of n.keys ?? []) {
        const r = await window.orgai.secrets.undelete({ key })
        if (!r.restored) {
          failed++
          reason ||= r.reason ?? ''
        }
      }
      if (!failed) return null
      return `${failed} could not be restored${reason ? `: ${reason.replace(/[.\s]+$/, '')}` : ''}.`
    })

  const keep = (n: SecretNotice): Promise<void> =>
    run(n, async () => {
      await window.orgai.secrets.confirmDelete({ keys: n.keys ?? [] })
      return null
    })

  const retry = (n: SecretNotice): Promise<void> =>
    run(n, async () => {
      const r = await window.orgai.secrets.init({})
      return r.status.state === 'open' ? null : 'Secure storage is still closed. Fix the cause above, then try again.'
    })

  const startOver = async (n: SecretNotice): Promise<void> => {
    const ok = await confirm({
      title: 'Start secure storage over?',
      body: START_OVER_WARNING,
      confirmLabel: 'Start over',
      danger: true,
      confirmTestId: 'secret-start-over-confirm'
    })
    if (!ok) return
    await run(n, async () => {
      await window.orgai.secrets.reset({ confirm: true })
      return null
    })
  }

  if (!notices.length) return dialog
  return (
    <div className="dash-secret-notices" ref={root} data-testid="secret-notices">
      {notices.map((n) => (
        <Banner
          key={n.kind}
          tone={n.tone}
          title={n.title}
          label={n.title}
          testId={TESTID[n.kind]}
          actions={
            <>
              {n.actions.includes('restore') && (
                <Button size="sm" variant="primary" loading={busy === n.kind} onClick={() => void restore(n)} testId="secret-restore">
                  Restore
                </Button>
              )}
              {n.actions.includes('keep') && (
                <Button size="sm" disabled={busy === n.kind} onClick={() => void keep(n)} testId="secret-keep-removed">
                  Keep removed
                </Button>
              )}
              {n.actions.includes('retry') && (
                <Button size="sm" variant="primary" loading={busy === n.kind} onClick={() => void retry(n)} testId="secret-retry">
                  Try again
                </Button>
              )}
              {n.actions.includes('reset') && (
                <Button size="sm" disabled={busy === n.kind} onClick={() => void startOver(n)} testId="secret-start-over">
                  Start over…
                </Button>
              )}
            </>
          }
        >
          <p>{n.body}</p>
          {errors[n.kind] && (
            <p className="invalid-text" role="alert" data-testid="secret-notice-error">
              {errors[n.kind]}
            </p>
          )}
        </Banner>
      ))}
      {dialog}
    </div>
  )
}
