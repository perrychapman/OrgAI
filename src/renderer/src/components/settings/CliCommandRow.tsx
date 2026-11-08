import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CliCommandResult, CliCommandStatus } from '@shared/types'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import {
  CLI_COMMAND_CHECKING,
  CLI_COMMAND_LOAD_FAILED,
  cleanBlock,
  cleanShown,
  cliCommandNotice,
  cliCommandView,
  hasCliCommandApi,
  singleFlight
} from '../../lib/cliCommand'

const ROW_ID = 'cli-command-row'

/**
 * App settings > General > Advanced settings > Terminal: install the orgai command with npm (5.3). Main runs npm and
 * owns every file; this row shows the status, the command, npm's output and the old-shim cleanup. Hidden when the API
 * is missing.
 */
export function CliCommandRow(): ReactElement | null {
  const api = typeof window === 'undefined' ? undefined : window.orgai?.app
  const available = hasCliCommandApi(api)
  const [status, setStatus] = useState<CliCommandStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null)
  const [result, setResult] = useState<CliCommandResult | null>(null)
  const flight = useRef(singleFlight<CliCommandResult>())
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    if (!available || !api) return
    const mine = ++seq.current
    try {
      const s = await api.cliCommandStatus()
      if (mine !== seq.current) return
      setStatus(s)
      setLoadFailed(false)
    } catch {
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

  // An install started before this row mounted (or in another window) keeps running: poll until main says it ended.
  const mainInstalling = status?.installing === true
  useEffect(() => {
    if (!available || !mainInstalling) return
    const t = setInterval(() => {
      if (!flight.current.busy()) void refresh()
    }, 2000)
    return () => clearInterval(t)
  }, [available, mainInstalling, refresh])

  const act = (kind: 'install' | 'remove'): void => {
    if (!api) return
    const p = flight.current.run(() => (kind === 'install' ? api.installCliCommand() : api.removeOldCliShim()))
    if (!p) return
    setBusy(kind)
    setResult(null)
    void p
      .then((r) => {
        seq.current++
        setResult(r)
        if (r?.status) setStatus(r.status)
      })
      .catch(() => setResult({ ok: false, message: '', status: status as CliCommandStatus }))
      .finally(() => {
        setBusy(null)
        void refresh()
      })
  }

  if (!available) return null
  const view = status ? cliCommandView(status) : null
  const state = status?.state ?? (loadFailed ? 'error' : 'loading')
  const line = view ? view.line : loadFailed ? CLI_COMMAND_LOAD_FAILED : CLI_COMMAND_CHECKING
  // The command comes from main (the tag follows the app version); nothing is shown or copied before it arrives.
  const command = status?.command
  const installing = busy === 'install' || mainInstalling
  const output = cleanBlock(result?.output)
  const hint = cleanShown(result?.hint)
  // After a successful install the old shim cleanup is offered again, with the new winner shown by the status line.
  const offerRemove = !!view?.removeOld

  return (
    <div className="cli-shim" data-testid="cli-command-row" aria-busy={busy !== null || undefined}>
      <SettingRow
        id={ROW_ID}
        title="orgai command"
        description={
          <>
            Install the orgai command for your terminal with npm. It is a separate app from OrgAI and keeps its own projects and settings.
            <span className="cli-shim-status" data-testid="cli-command-status" data-state={state} role="status">
              {line}
            </span>
            {view?.removeByHand && (
              <span className="cli-shim-notice" data-testid="cli-command-old-by-hand">
                {view.removeByHand}
              </span>
            )}
            {view?.runs && (
              <span className="cli-shim-notice" data-testid="cli-command-runs">
                A terminal runs {view.runs}
              </span>
            )}
          </>
        }
        control={
          view ? (
            <>
              {installing ? (
                <Button size="sm" testId="cli-command-cancel" onClick={() => void api?.cancelCliInstall()}>
                  Cancel
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  testId="cli-command-install"
                  inert={busy !== null || installing || !!view.installBlockedReason}
                  ariaDescribedBy={settingDescId(ROW_ID)}
                  onClick={() => act('install')}
                >
                  {view.installLabel}
                </Button>
              )}
              {offerRemove && (
                <Button size="sm" testId="cli-command-remove-old" inert={busy !== null} ariaLabel="Remove the old orgai command" onClick={() => act('remove')}>
                  Remove the old orgai command
                </Button>
              )}
            </>
          ) : null
        }
      />
      {command && (
        <div className="cli-command-copy">
          <code className="cli-shim-path-hint" data-testid="cli-command-text">
            {command}
          </code>
          <CopyButton text={command} label="Copy command" />
        </div>
      )}
      {view?.installBlockedReason && (
        <span className="cli-shim-notice" data-testid="cli-command-no-npm">
          {view.installBlockedReason}
        </span>
      )}
      <span className={`cli-shim-notice${result && !result.ok ? ' is-error' : ''}`} role="status" data-testid="cli-command-notice">
        {result ? cliCommandNotice(result) : ''}
      </span>
      {hint && (
        <span className="cli-shim-notice" data-testid="cli-command-hint">
          {hint}
        </span>
      )}
      {output && (
        <pre className="cli-shim-path-hint cli-command-output" data-testid="cli-command-output">
          {output}
        </pre>
      )}
    </div>
  )
}
