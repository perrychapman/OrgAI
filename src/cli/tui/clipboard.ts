/**
 * /copy support: what to copy (the last assistant message or the latest fenced code block, taken from the stored
 * transcript so no sidebar, gutter or bullet prefix is included) and how to put it on the clipboard (an OSC 52 escape
 * for the terminal, plus the platform tool as a fallback). Pure except `copyToClipboard`, whose I/O is injected.
 */
import { spawn } from 'node:child_process'
import type { TranscriptEntry } from '../../shared/types'
import { chainRuns } from './selectors'
import { sanitizeTty } from './sanitizeTty'
import type { TuiState } from './types'

/** Terminals commonly cap an OSC 52 payload near 100 KB of base64; larger text goes to the platform tool only. */
export const OSC52_MAX_BASE64 = 100_000

/** `ESC ] 52 ; c ; <base64> BEL`: asks the terminal to put the text on the system clipboard. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
}

/** The newest assistant text of the followed chain (harness notes, the user's messages and tool rows excluded). */
export function lastAssistantText(s: TuiState): string | undefined {
  const runs = chainRuns(s)
  for (let r = runs.length - 1; r >= 0; r--) {
    const entries: TranscriptEntry[] = runs[r].transcript
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.source === 'harness' || e.block.kind !== 'text') continue
      const text = sanitizeTty(e.block.text).trim()
      if (text) return text
    }
  }
  return undefined
}

/** The fenced code blocks of a Markdown text, in order (fence lines and the info string are not part of the code). */
export function fencedBlocks(text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (!open) continue
    const fence = open[1]
    const body: string[] = []
    let closed = false
    for (i++; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.length >= fence.length && t[0] === fence[0] && /^(`+|~+)$/.test(t)) {
        closed = true
        break
      }
      body.push(lines[i])
    }
    // An unclosed fence at the end of a message still holds code the model wrote.
    if (closed || body.length) out.push(body.join('\n'))
  }
  return out
}

/** The newest fenced code block in the newest assistant messages (looks back through up to 20 of them). */
export function latestCodeBlock(s: TuiState): string | undefined {
  const runs = chainRuns(s)
  let seen = 0
  for (let r = runs.length - 1; r >= 0; r--) {
    const entries = runs[r].transcript
    for (let i = entries.length - 1; i >= 0 && seen < 20; i--) {
      const e = entries[i]
      if (e.source === 'harness' || e.block.kind !== 'text') continue
      seen++
      const blocks = fencedBlocks(sanitizeTty(e.block.text))
      if (blocks.length) return blocks[blocks.length - 1]
    }
  }
  return undefined
}

export interface ClipboardDeps {
  /** Writes raw bytes to the terminal (the OSC 52 sequence). */
  write?: (s: string) => void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Runs `cmd args` with `input` on stdin; resolves true when it exited 0. */
  run?: (cmd: string, args: string[], input: string) => Promise<boolean>
}

/** The platform clipboard programs to try, in order. */
export function clipboardCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { cmd: string; args: string[] }[] {
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }]
  if (platform === 'win32') return [{ cmd: 'clip', args: [] }]
  const list: { cmd: string; args: string[] }[] = []
  if (env.WAYLAND_DISPLAY) list.push({ cmd: 'wl-copy', args: [] })
  list.push({ cmd: 'xclip', args: ['-selection', 'clipboard'] }, { cmd: 'xsel', args: ['--clipboard', '--input'] })
  if (!env.WAYLAND_DISPLAY) list.push({ cmd: 'wl-copy', args: [] })
  return list
}

function runWithInput(cmd: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      const timer = setTimeout(() => {
        child.kill()
        resolve(false)
      }, 3000)
      child.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
    } catch {
      resolve(false)
    }
  })
}

/**
 * Copies `text`: OSC 52 when the terminal write is available and the payload is small enough, and the first platform
 * tool that succeeds. Returns how it was copied (`osc52`, a tool name, or both), or undefined when nothing took it.
 * An OSC 52 write cannot be confirmed (terminals may ignore it), so it counts as "sent".
 */
export async function copyToClipboard(text: string, deps: ClipboardDeps = {}): Promise<string[]> {
  const via: string[] = []
  if (deps.write && Math.ceil((Buffer.byteLength(text, 'utf8') * 4) / 3) <= OSC52_MAX_BASE64) {
    deps.write(osc52(text))
    via.push('terminal')
  }
  const run = deps.run ?? runWithInput
  for (const c of clipboardCommands(deps.platform ?? process.platform, deps.env ?? process.env)) {
    if (await run(c.cmd, c.args, text)) {
      via.push(c.cmd)
      break
    }
  }
  return via
}
