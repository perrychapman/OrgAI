/** The TUI shell (W4-T5): composes panes, tray, composer and palette over one InputBus. Stub until W4-T5 lands. */
import { Text } from 'ink'
import type { TerminalController, TuiEnv, TuiHostConnection, TuiLaunch, TuiSessionApi } from './types'

export function App(props: {
  session: TuiSessionApi
  terminal: TerminalController
  env: TuiEnv
  launch: TuiLaunch
  conn: TuiHostConnection
  onExit(code: number): void
}) {
  void props
  return <Text>App (not implemented, Wave 4)</Text>
}
