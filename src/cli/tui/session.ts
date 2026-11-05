/**
 * The TUI's host connection and session (W4-T1): scopes read / operate / decide, clientKind 'tui', 'configure' only
 * for onboarding. Stub until W4-T1 lands.
 */
import type { CliContext } from '../types'
import type { OpenTuiSessionOptions, TuiHostConnection, TuiSessionApi } from './types'

export async function connectTuiHost(ctx: CliContext): Promise<TuiHostConnection> {
  void ctx
  throw new Error('not implemented (Wave 4)')
}

export async function openTuiSession(conn: TuiHostConnection, opts: OpenTuiSessionOptions): Promise<TuiSessionApi> {
  void [conn, opts]
  throw new Error('not implemented (Wave 4)')
}
