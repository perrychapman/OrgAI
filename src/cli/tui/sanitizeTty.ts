/**
 * Per-stream stateful TTY sanitizer (cli-spec 5.2). Agent and tool text reaches the terminal only through it: escape
 * sequences (CSI, OSC, DCS, APC, PM, SOS), C0 / C1 controls other than newline and tab, and bidi / invisible
 * characters are removed, with the parser state carried across chunks so a sequence split between two writes is
 * still caught. One TtySanitizer per stream (StreamSanitizers keys them, e.g. by `${runId}:${agentId}`).
 *
 * Wave 2 contracts stub: the signatures are final; W2-T6 implements the bodies (the stubs pass text through).
 */

export class TtySanitizer {
  protected readonly tabWidth: number

  constructor(opts: { tabWidth?: number } = {}) {
    this.tabWidth = opts.tabWidth ?? 8
  }

  /** Sanitize one chunk; an unfinished sequence at the end is held for the next write. */
  write(chunk: string): string {
    return chunk
  }

  /** End of stream: drop any held partial sequence and return what is safe to print. */
  flush(): string {
    return ''
  }

  /** Forget the parser state (a new stream on the same key). */
  reset(): void {}
}

/** Sanitize a complete string (a fresh TtySanitizer, written and flushed). */
export function sanitizeTty(s: string): string {
  const t = new TtySanitizer()
  return t.write(s) + t.flush()
}

/** One TtySanitizer per stream key. */
export class StreamSanitizers {
  private readonly byKey = new Map<string, TtySanitizer>()

  for(key: string): TtySanitizer {
    let s = this.byKey.get(key)
    if (!s) {
      s = new TtySanitizer()
      this.byKey.set(key, s)
    }
    return s
  }

  drop(key: string): void {
    this.byKey.delete(key)
  }

  clear(): void {
    this.byKey.clear()
  }
}

/** A diff made safe for a pager (`less -R` must never see agent-written escapes); keeps newlines. */
export function sanitizeDiffForPager(diff: string): string {
  return diff
}
