/**
 * The hidden input of a dialog (configUi.tsx): a secret is shown as dots and never as typed (Unicode and ASCII),
 * no line of the dialog carries a character of it, a long one keeps its end after the ellipsis, the length
 * limit is 4000 for a secret and 400 otherwise (typed or pasted), and Enter submits the real text.
 */
import { describe, expect, it } from 'vitest'
import { dialogKey, dialogLines, type Dialog } from './configUi'
import { textWidth } from './panes/text'
import { char, env, key } from './panes/testUtil'
import type { InputEvent, TuiEnv } from './types'

type InputDialog = Extract<Dialog, { kind: 'input' }>

const UNICODE: TuiEnv = env({ color: false })
const ASCII: TuiEnv = env({ color: false, unicode: false })

const VALUE = 's3cret-token-value'

const input = (over: Partial<InputDialog> = {}): InputDialog => ({
  kind: 'input',
  title: 'Value of DOCS_TOKEN for Docs',
  text: '',
  hint: 'Typed text is hidden. Enter saves it, Esc cancels. Leave it empty to delete the stored value.',
  onSubmit: () => {},
  ...over
})

/** Type `s` one character at a time, the way the view's key handler does. */
const typed = (d: InputDialog, s: string): InputDialog => {
  let cur = d
  for (const c of s) {
    const r = dialogKey(cur, char(c), 10)
    if (r.next === undefined) return cur
    cur = r.next as InputDialog
  }
  return cur
}

/** The dialog's lines as plain text (its segments joined), at `width`. */
const linesOf = (d: Dialog, width: number, e: TuiEnv = UNICODE): string[] => dialogLines(d, width, 12, e).map((l) => l.segs.map((s) => s.text).join(''))

const maskLine = (lines: string[], mask: string): string => lines.find((l) => l.includes(mask)) ?? ''

describe('the secret input dialog', () => {
  it('shows one dot per character typed, and never the text itself', () => {
    const d = typed(input({ secret: true }), VALUE)
    expect(d.text).toBe(VALUE)
    const lines = linesOf(d, 60)
    expect(lines.some((l) => l.includes(VALUE))).toBe(false)
    expect(lines.some((l) => l.includes('•'.repeat(VALUE.length)))).toBe(true)
    // Not even a piece of it leaks into another line.
    expect(lines.join('\n')).not.toContain('cret')
    expect(lines.join('\n')).not.toContain('token')
  })

  it('shows stars in an ASCII-only terminal (no Unicode)', () => {
    const d = typed(input({ secret: true }), VALUE)
    const lines = linesOf(d, 60, ASCII)
    expect(lines.some((l) => l.includes('*'.repeat(VALUE.length)))).toBe(true)
    expect(lines.join('\n')).not.toContain(VALUE)
    expect(maskLine(lines, '*')).toContain('_')
  })

  it('keeps the mask in step with what was typed, backspacing included', () => {
    const one = typed(input({ secret: true }), 'abc')
    expect(maskLine(linesOf(one, 60), '•')).toContain('•••')
    const back = dialogKey(one, key('backspace'), 10).next as InputDialog
    expect(back.text).toBe('ab')
    expect(maskLine(linesOf(back, 60), '•')).toContain('••')
  })

  it('a secret longer than the line shows its end after the ellipsis, still masked', () => {
    const d = typed(input({ secret: true }), 'a'.repeat(60))
    const line = maskLine(linesOf(d, 20), '•')
    expect(line).toContain('…')
    expect(line).not.toContain('a')
    // Only the last 15 characters of the mask fit the line ('> ' + '…' + 15 + the cursor = 19 at 20 columns).
    expect((line.match(/•/g) ?? []).length).toBe(15)
    expect(textWidth(line)).toBeLessThanOrEqual(20)
  })

  it('an ordinary input still shows the text it was given', () => {
    const d = typed(input(), VALUE)
    expect(linesOf(d, 60).some((l) => l.includes(VALUE))).toBe(true)
  })

  it('the limit is 4000 for a secret and 400 otherwise, typed or pasted', () => {
    const paste: InputEvent = { type: 'paste', text: 'x'.repeat(5000) }
    expect((dialogKey(input({ secret: true }), paste, 10).next as InputDialog).text).toHaveLength(4000)
    expect((dialogKey(input(), paste, 10).next as InputDialog).text).toHaveLength(400)
    expect(typed(input({ secret: true }), 'k'.repeat(4200)).text).toHaveLength(4000)
    expect(typed(input(), 'k'.repeat(4200)).text).toHaveLength(400)
    // What an ordinary input drops, a secret keeps.
    expect(typed(input({ secret: true }), 'k'.repeat(500)).text).toHaveLength(500)
  })

  it('Enter submits the real text, not the mask', () => {
    let submitted = ''
    const d = typed(input({ secret: true, onSubmit: (text) => { submitted = text } }), VALUE)
    const r = dialogKey(d, key('enter'), 10)
    expect(r.next).toBeUndefined()
    r.then?.()
    expect(submitted).toBe(VALUE)
  })
})

describe('a pasted secret', () => {
  it('drops the line break a paste often ends with, instead of saving a space with the value', () => {
    const paste = (text: string): InputEvent => ({ type: 'paste', text }) as InputEvent
    const secret = dialogKey(input({ secret: true }), paste('tok-123\n'), 10).next as InputDialog
    expect(secret.text).toBe('tok-123')
    // A setting that is not a secret keeps the old rule (a line break reads as a space).
    const plain = dialogKey(input(), paste('two\nwords'), 10).next as InputDialog
    expect(plain.text).toBe('two words')
  })
})

