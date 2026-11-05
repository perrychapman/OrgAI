import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CliShimResult, CliShimStatus } from '@shared/types'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { useAppStore } from '../../store/useAppStore'
import {
  CLI_SHIM_ACCESS_OFF_NOTE,
  CLI_SHIM_PATH_HINT_ID,
  TERMINAL_ACCESS_TRUST,
  askTerminalAccessAfter,
  cliShimDescribedBy,
  cliShimFocusAfter,
  cliShimLine,
  cliShimNotice,
  cliShimView,
  hasCliShimApi,
  singleFlight
} from '../../lib/cliShim'

const ROW_ID = 'cli-shim-row'

/** The platform from app:info, else a guess from the user agent (only picks the PATH hint wording). */
function guessPlatform(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Windows/i.test(ua)) return 'win32'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin'
  return 'linux'
}

/**
 * App settings > General > Advanced settings > Terminal: install, update or remove the orgai command shim
 * (cli-spec 7(3)). Main owns the file; this row only shows the status and asks. Hidden when the API is missing.
 * Installing never turns Terminal access on by itself (review H2): while it is off, the row asks after an install and
 * turns it on through `onTurnOnTerminalAccess` only when the user confirms.
 */
export function CliShimRow({
  terminalAccessOn = false,
  onTurnOnTerminalAccess
}: {
  /** AppSettings.terminalServer as shown by the Terminal access switch. */
  terminalAccessOn?: boolean
  /** Turn Terminal access on (the same save as the switch). Without it the row never offers to. */
  onTurnOnTerminalAccess?: () => void
} = {}): ReactElement | null {
  const api = typeof window === 'undefined' ? undefined : window.orgai?.app
  const available = hasCliShimApi(api)
  const platform = useAppStore((s) => s.appInfo?.platform) ?? guessPlatform()
  const [status, setStatus] = useState<CliShimStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  const flight = useRef(singleFlight<CliShimResult>())
  const pendingFocus = useRef<'remove' | 'install' | 'status' | null>(null)
  const installRef = useRef<HTMLSpanElement>(null)
  const removeRef = useRef<HTMLSpanElement>(null)
  const statusRef = useRef<HTMLSpanElement>(null)
  const seq = useRef(0)
  const accessOn = useRef(terminalAccessOn)
  accessOn.current = terminalAccessOn
  const { confirm, dialog } = useConfirm()

  const refresh = useCallback(async () => {
    if (!available || !api) return
    const mine = ++seq.current
    try {
      const s = await api.cliShimStatus()
      if (mine !== seq.current) return
      if (s) {
        setStatus(s)
        setLoadFailed(false)
      } else {
        setLoadFailed(true)
      }
    } catch {
      // Never rejects by contract; keep the last status if it does, and say so when there is none (live region).
      if (mine === seq.current) setLoadFailed(true)
    }
  }, [api, available])

  useEffect(() => {
    if (!available) return
    void refresh()
    const onFocus = (): void => {
      if (!flight.current.busy()) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [available, refresh])

  const view = status ? cliShimView(status, platform) : null

  useEffect(() => {
    const target = pendingFocus.current
    if (!target || busy) return
    pendingFocus.current = null
    const wrap = target === 'remove' ? removeRef.current : target === 'install' ? installRef.current : null
    const btn = wrap?.querySelector('button')
    if (btn) btn.focus()
    else statusRef.current?.focus()
  }, [busy, status])

  /** After an install while Terminal access is off: ask, never turn it on silently (review H2). */
  const offerTerminalAccess = async (installNotice: string): Promise<void> => {
    if (!onTurnOnTerminalAccess) {
      setNotice({ text: `${installNotice} ${CLI_SHIM_ACCESS_OFF_NOTE}`, ok: true })
      return
    }
    const yes = await confirm({
      title: 'Turn on Terminal access?',
      body: (
        <>
          <p>The orgai command works only while Terminal access is on.</p>
          <p>{TERMINAL_ACCESS_TRUST}</p>
        </>
      ),
      confirmLabel: 'Turn on Terminal access',
      confirmTestId: 'cli-shim-terminal-confirm'
    })
    if (yes && !accessOn.current) {
      onTurnOnTerminalAccess()
      setNotice({ text: `${installNotice} Terminal access is on.`, ok: true })
    } else if (!yes) {
      setNotice({ text: `${installNotice} ${CLI_SHIM_ACCESS_OFF_NOTE}`, ok: true })
    }
  }

  const act = (action: 'install' | 'update' | 'remove'): void => {
    if (!api) return
    const p = flight.current.run(() => (action === 'remove' ? api.uninstallCliShim() : api.installCliShim()))
    if (!p) return
    setBusy(true)
    setNotice(null)
    let ask: string | null = null
    void p
      .then(async (result) => {
        const text = cliShimNotice(result)
        setNotice({ text, ok: result?.ok === true })
        seq.current++
        const next = result?.status ?? status
        if (next) {
          setStatus(next)
          setLoadFailed(false)
          pendingFocus.current = cliShimFocusAfter(action, cliShimView(next, platform))
        }
        if (askTerminalAccessAfter(action, result, accessOn.current)) ask = text
      })
      .catch(() => setNotice({ text: cliShimNotice(null), ok: false }))
      .finally(() => {
        setBusy(false)
        void refresh()
        if (ask !== null) void offerTerminalAccess(ask)
      })
  }

  if (!available) return null
  const state = status?.state ?? (loadFailed ? 'error' : 'loading')
  const line = cliShimLine(view, loadFailed)
  const describedBy = cliShimDescribedBy(settingDescId(ROW_ID), view)

  return (
    <div className="cli-shim" data-testid="cli-shim-row" aria-busy={busy || undefined}>
      <SettingRow
        id={ROW_ID}
        title="orgai command"
        description={
          <>
            Use OrgAI from a terminal on this computer. The command needs Terminal access; OrgAI asks before turning it on.
            {/* A live region: "Checking…" turning into the status (or a load failure) is announced (review Low). */}
            <span className="cli-shim-status" data-testid="cli-shim-status" data-state={state} ref={statusRef} tabIndex={-1} role="status">
              {line}
            </span>
          </>
        }
        control={
          view && (view.primary || view.remove) ? (
            <>
              {view.primary && (
                <span ref={installRef} className="cli-shim-btn">
                  <Button
                    variant="primary"
                    size="sm"
                    testId="cli-shim-install"
                    inert={busy}
                    ariaDescribedBy={describedBy}
                    onClick={() => act(view.primary?.action ?? 'install')}
                  >
                    {view.primary.label}
                  </Button>
                </span>
              )}
              {view.remove && (
                <span ref={removeRef} className="cli-shim-btn">
                  <Button
                    size="sm"
                    testId="cli-shim-remove"
                    inert={busy}
                    ariaLabel="Remove orgai command"
                    ariaDescribedBy={describedBy}
                    onClick={() => act('remove')}
                  >
                    Remove
                  </Button>
                </span>
              )}
            </>
          ) : null
        }
      />
      {view?.pathHint && (
        <code className="cli-shim-path-hint" id={CLI_SHIM_PATH_HINT_ID} data-testid="cli-shim-path-hint">
          {view.pathHint}
        </code>
      )}
      <span className={`cli-shim-notice${notice && !notice.ok ? ' is-error' : ''}`} role="status" data-testid="cli-shim-notice">
        {notice?.text ?? ''}
      </span>
      {dialog}
    </div>
  )
}
