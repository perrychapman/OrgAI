/**
 * What the terminal UI says when host.hello withheld 'decide' (cli-standalone-default.md 4.6): the line names where
 * approvals really are answered for the kind of host this terminal is talking to, never a window that does not exist.
 *
 * - desktop: the OrgAI window is open (or can be shown); answer there or raise Terminal access to Full control.
 * - headless-host: a hidden OrgAI app started by an older orgai, `--host daemon` or `orgai daemon start`. `orgai app`
 *   shows its window; stopping it lets orgai host itself (and answer its own approvals).
 * - inproc: another terminal runs the host: a workspace orgai (its owner holds 'decide') or a foreground
 *   `orgai daemon start --host inproc` (no approval UI at all), so the line does not promise an answer there.
 * - node: the background Node host (`orgai daemon start`); Terminal access applies.
 */
import type { HostKind } from '../../shared/types'

export const DESKTOP_DECISIONS_NOTICE = 'Approvals and questions are answered in the desktop app. To answer here: App settings > Terminal access > What terminals may do > Full control.'
export const HIDDEN_APP_DECISIONS_NOTICE =
  'A hidden OrgAI app is running the host, so approvals are answered in its window (`orgai app` shows it). To run orgai on its own: `orgai daemon stop`, then start orgai again.'
export const TERMINAL_HOST_DECISIONS_NOTICE =
  "OrgAI's host is running in another terminal (an orgai session, or `orgai daemon start --host inproc`), so this terminal can't answer approvals. Quit that orgai (or `orgai daemon stop`), then start orgai here to answer them."
export const NODE_HOST_DECISIONS_NOTICE =
  "The background host (`orgai daemon start`) doesn't let terminals answer approvals. `orgai daemon stop`, then start orgai so it runs its own host; or, while no host runs, `orgai terminal-access on --level full`."

/** The line for a host that withheld 'decide'; an unknown or missing kind reads as the desktop app (older hosts). */
export function decisionsNotice(hostKind: HostKind | undefined): string {
  switch (hostKind) {
    case 'headless-host':
      return HIDDEN_APP_DECISIONS_NOTICE
    case 'inproc':
      return TERMINAL_HOST_DECISIONS_NOTICE
    case 'node':
      return NODE_HOST_DECISIONS_NOTICE
    default:
      return DESKTOP_DECISIONS_NOTICE
  }
}

/** Every line decisionsNotice can return (the App keeps them out of the ordinary-notice slot). */
export const DECISIONS_NOTICES: ReadonlySet<string> = new Set([
  DESKTOP_DECISIONS_NOTICE,
  HIDDEN_APP_DECISIONS_NOTICE,
  TERMINAL_HOST_DECISIONS_NOTICE,
  NODE_HOST_DECISIONS_NOTICE
])
