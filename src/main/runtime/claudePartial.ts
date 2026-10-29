import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk'

type StreamEvent = SDKPartialAssistantMessage['event']

interface Block {
  index: number
  text: string
  /** content_block_stop arrived; the completed assistant message replaces it next. */
  stopped: boolean
  lastEmit: number
  timer?: ReturnType<typeof setTimeout>
  /** Something non-empty was sent to the renderer and must be cleared later. */
  shown: boolean
}

/**
 * Accumulates the text block an agent is currently streaming (from stream_event messages) and reports it
 * through `emit`, throttled per agent. Never produces transcript entries: the completed assistant message
 * stays the source of truth and clears the partial text when it lands.
 */
export class PartialText {
  private blocks = new Map<string, Block>()

  constructor(
    private emit: (agentId: string, text: string) => void,
    private intervalMs = 120
  ) {}

  onEvent(agentId: string, event: StreamEvent): void {
    switch (event.type) {
      case 'content_block_start': {
        if (event.content_block.type !== 'text') return
        const prev = this.blocks.get(agentId)
        if (prev?.timer) clearTimeout(prev.timer)
        this.blocks.set(agentId, { index: event.index, text: event.content_block.text ?? '', stopped: false, lastEmit: 0, shown: prev?.shown ?? false })
        return
      }
      case 'content_block_delta': {
        const b = this.blocks.get(agentId)
        if (!b || b.index !== event.index || b.stopped || event.delta.type !== 'text_delta') return
        b.text += event.delta.text
        this.schedule(agentId, b)
        return
      }
      case 'content_block_stop': {
        const b = this.blocks.get(agentId)
        if (!b || b.index !== event.index || b.stopped) return
        b.stopped = true
        this.flush(agentId, b)
        return
      }
      default:
        return
    }
  }

  /**
   * The completed assistant message arrived. Clears a finished block; a block still streaming belongs
   * to a later content block and is kept. `force` clears regardless (turn ended, agent finished).
   */
  clear(agentId: string, force = false): void {
    const b = this.blocks.get(agentId)
    if (!b || (!force && !b.stopped)) return
    if (b.timer) clearTimeout(b.timer)
    this.blocks.delete(agentId)
    if (b.shown) this.emit(agentId, '')
  }

  clearAll(): void {
    for (const id of [...this.blocks.keys()]) this.clear(id, true)
  }

  private schedule(agentId: string, b: Block): void {
    const wait = b.lastEmit + this.intervalMs - Date.now()
    if (wait <= 0) {
      this.flush(agentId, b)
    } else if (!b.timer) {
      b.timer = setTimeout(() => {
        b.timer = undefined
        if (this.blocks.get(agentId) === b) this.flush(agentId, b)
      }, wait)
    }
  }

  private flush(agentId: string, b: Block): void {
    if (b.timer) {
      clearTimeout(b.timer)
      b.timer = undefined
    }
    b.lastEmit = Date.now()
    if (!b.text && !b.shown) return
    b.shown = true
    this.emit(agentId, b.text)
  }
}
