/** Raw key and bracketed-paste parser (W4-T4). Stateful across chunks. Stub until W4-T4 lands. */
import type { InputEvent } from '../types'

export class KeyParser {
  private readonly bracketedPaste: boolean
  constructor(opts: { bracketedPaste: boolean }) {
    this.bracketedPaste = opts.bracketedPaste
  }

  feed(chunk: string): InputEvent[] {
    void [chunk, this.bracketedPaste]
    throw new Error('not implemented (Wave 4)')
  }

  /** Emits a lone ESC after the escape timeout. */
  flush(): InputEvent[] {
    throw new Error('not implemented (Wave 4)')
  }
}

/** Alt+D, F2, Ctrl+. (and Shift+Tab from the Composer) focus the Decision Tray. */
export function isTrayFocusKey(e: InputEvent): boolean {
  void e
  throw new Error('not implemented (Wave 4)')
}
