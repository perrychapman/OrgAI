/**
 * TUI React contexts (cli-spec 5.3(1) focus model). React only, never Ink: the TUI reads raw stdin itself
 * (input/keys.ts), and the shell dispatches each InputEvent through one InputBus to the focused target only, so a
 * character typed in the Composer can never reach the Decision Tray.
 */
import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import type { FocusTarget, InputEvent, InputHandler, TuiEnv } from './types'

/** Safe defaults: inline, ASCII, no colour (the shell always provides the real env). */
export const DEFAULT_TUI_ENV: TuiEnv = {
  bufferMode: 'inline',
  screenReader: false,
  color: false,
  dumbTerminal: false,
  bracketedPaste: false,
  unicode: false
}

export const TuiEnvContext = createContext<TuiEnv>(DEFAULT_TUI_ENV)

export function useTuiEnv(): TuiEnv {
  return useContext(TuiEnvContext)
}

interface Registration {
  handler: InputHandler
}

/** Routes input events to the handler registered for the focused target. The newest registration per target wins. */
export class InputBus {
  private readonly stacks = new Map<FocusTarget, Registration[]>()

  register(target: FocusTarget, handler: InputHandler): () => void {
    const reg: Registration = { handler }
    const stack = this.stacks.get(target) ?? []
    stack.push(reg)
    this.stacks.set(target, stack)
    let done = false
    return () => {
      if (done) return
      done = true
      const list = this.stacks.get(target)
      if (!list) return
      const i = list.indexOf(reg)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) this.stacks.delete(target)
    }
  }

  /** Calls only the focused target's newest handler; false when none is registered or it did not consume. */
  dispatch(e: InputEvent, focus: FocusTarget): boolean {
    const list = this.stacks.get(focus)
    const top = list?.[list.length - 1]
    if (!top) return false
    return top.handler(e) === true
  }

  /** Whether any handler is registered for the target. */
  has(target: FocusTarget): boolean {
    return (this.stacks.get(target)?.length ?? 0) > 0
  }
}

export const InputBusContext = createContext<InputBus | null>(null)

/**
 * Registers `handler` for `target` while mounted and `active`. Registration happens in a layout effect (before the
 * frame is shown) and always calls the latest `handler` through a ref, so re-renders never re-register.
 */
export function useFocusHandler(target: FocusTarget, handler: InputHandler, active = true): void {
  const bus = useContext(InputBusContext)
  const ref = useRef(handler)
  ref.current = handler
  useLayoutEffect(() => {
    if (!bus || !active) return undefined
    return bus.register(target, (e) => ref.current(e))
  }, [bus, target, active])
}
