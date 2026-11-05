/** Decision tray actions to exact cli-spec 5.3 payloads (W4-T2). Stub until W4-T2 lands. */
import type { DecisionCall, TrayCard } from './types'

export type TrayAction =
  | { kind: 'permission'; act: 'allow-once' | 'allow-session' | 'allow-project' }
  | { kind: 'permission'; act: 'deny'; message?: string }
  | { kind: 'rules'; act: 'grant-run' | 'grant-project' }
  | { kind: 'rules'; act: 'deny'; message?: string }
  | { kind: 'proposal'; act: 'approve'; secrets?: Record<string, string> }
  | { kind: 'proposal'; act: 'revise'; feedback: string }
  | { kind: 'proposal'; act: 'decline'; note?: string }
  | { kind: 'question'; act: 'answer'; selected: string[]; text?: string }
  | { kind: 'merge'; act: 'merge' | 'hold' | 'discard' }
  | { kind: 'mcpInstall'; act: 'allow-run' | 'save-project' | 'save-library'; secrets?: Record<string, string>; note?: string }
  | { kind: 'mcpInstall'; act: 'deny'; note?: string }

/** One key binding shown on a card. */
export interface TrayBinding {
  key: string
  label: string
  act: string
  /** Needs a second confirming key press bound to the same card key. */
  twoStep?: boolean
  /** The action takes a typed note. */
  text?: 'optional' | 'required'
}

export function bindingsFor(card: TrayCard): TrayBinding[] {
  void card
  throw new Error('not implemented (Wave 4)')
}

export function decisionFor(card: TrayCard, action: TrayAction): DecisionCall {
  void [card, action]
  throw new Error('not implemented (Wave 4)')
}

export function cardTitle(card: TrayCard): string {
  void card
  throw new Error('not implemented (Wave 4)')
}

export function cardDetailLines(card: TrayCard, width: number): string[] {
  void [card, width]
  throw new Error('not implemented (Wave 4)')
}

export function cardFullText(card: TrayCard): string {
  void card
  throw new Error('not implemented (Wave 4)')
}
