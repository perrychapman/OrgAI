import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBus } from './context'
import { TranscriptPane, dividerLine, groupToolRows, rowLines } from './TranscriptPane'
import { ESC_RE, Providers, env, key, press, withInkColor } from './panes/testUtil'
import { textWidth } from './panes/text'
import type { BufferMode, PartialRow, TranscriptPaneProps, TranscriptRow, TuiEnv } from './types'

const r = (key: string, over: Partial<TranscriptRow> = {}): TranscriptRow => ({
  key,
  runId: 'r1',
  agentId: 'root',
  agentLabel: 'orchestrator',
  kind: 'text',
  text: `text of ${key}`,
  ...over
})

const numbered = (n: number, from = 0): TranscriptRow[] => Array.from({ length: n }, (_, i) => r(`k${from + i}`, { text: `line ${from + i}` }))

type Props = TranscriptPaneProps & { mode: BufferMode }

function mount(props: Partial<Props> = {}, e: TuiEnv = env()) {
  const bus = new InputBus()
  let current: Props = { width: 60, height: 10, focused: false, rows: [], partials: [], mode: 'fullscreen', ...props }
  const tree = (p: Props) => (
    <Providers env={e} bus={bus}>
      <TranscriptPane {...p} />
    </Providers>
  )
  const out = render(tree(current))
  const rerender = (p: Partial<Props>): void => {
    current = { ...current, ...p }
    out.rerender(tree(current))
  }
  return { ...out, bus, rerender }
}

const lines = (frame: string | undefined): string[] => (frame ?? '').replace(/^(?:[ \t]*\n)+/, '').split('\n')

describe('TranscriptPane (full-screen)', () => {
  it('uses one speaker heading per turn and keeps compact tool activity to one line', () => {
    const rows = [r('intro', { text: 'I will check the project.' }), r('call', { kind: 'tool', toolUseId: 't', text: 'Ran a very long command '.repeat(8) }), r('out', { kind: 'result', toolUseId: 't', text: 'Raw JSON output' }), r('answer', { text: 'The check passed.' }), r('other', { agentId: 'reviewer', agentLabel: 'Reviewer', text: 'Review complete.' })]
    const t = mount({ rows, compact: true, height: 20, width: 60 })
    const frame = t.lastFrame() ?? ''
    expect(frame.split('orchestrator')).toHaveLength(2)
    expect(frame).not.toContain('orchestrator:')
    expect(frame).toContain('Reviewer')
    expect(frame).not.toContain('Raw JSON output')
    expect(lines(frame).filter(line => line.includes('Ran a very long'))).toHaveLength(1)
    expect(frame).toContain('The check passed.')
    t.rerender({ detailsExpanded: true })
    expect(t.lastFrame()).toContain('Raw JSON output')
    t.unmount()
  })

  it('anchors short conversations and streaming partials at the bottom of the viewport', () => {
    const t = mount({ height: 12, rows: [r('a')], partials: [{ key: 'p', runId: 'r1', agentId: 'root', agentLabel: 'orchestrator', text: 'streaming' }] })
    const frame = (t.lastFrame() ?? '').split('\n')
    expect(frame).toHaveLength(12)
    expect(frame.slice(0, 10).every(line => line.trim() === '')).toBe(true)
    expect(frame[10]).toBe('• orchestrator: text of a')
    expect(frame[11]).toBe('• orchestrator: streaming')
    t.rerender({ height: 6 })
    expect((t.lastFrame() ?? '').split('\n').at(-1)).toBe('• orchestrator: streaming')
    t.unmount()
  })

  it('formats headings, inline code and fenced code without printing Markdown fences', () => {
    const formatted = rowLines(r('md', { text: '# Result\n- Updated **authentication** in `auth.ts`\n```ts\nconst ok = true\n```' }), 80, env())
    expect(formatted.map(l => l.text).join('\n')).toContain('const ok = true')
    expect(formatted.map(l => l.text).join('\n')).not.toContain('```')
    expect(formatted.some(l => l.segs?.some(s => s.bold))).toBe(true)
    expect(formatted.some(l => l.segs?.some(s => s.text === 'auth.ts' && s.tone === 'code'))).toBe(true)
    for (const l of formatted) expect(textWidth(l.text)).toBeLessThanOrEqual(80)
  })

  it('keeps unmatched Markdown fences and incomplete parallel tools literal', () => {
    expect(rowLines(r('literal', { text: '```ts\nunfinished code' }), 80, env()).map(l => l.text).join('\n')).toContain('```ts')
    const rows = [r('a', { kind: 'tool' }), r('b', { kind: 'tool' }), r('a-result', { kind: 'result' })]
    expect(groupToolRows(rows)).toEqual(rows)
  })

  it('renders table records and references at narrow and wide widths in accessible modes', () => {
    const text = 'Safety controls\n\n| Protection | What it does |\n|---|---|\n| **Permissions** | Asks before running commands. |\n| Sandbox | Limits writes to the project. |\n\nSee [source](/Users/me/project/src/permissions.ts:49).'
    for (const width of [24, 60, 120]) {
      for (const settings of [{}, { unicode: false, color: false }, { screenReader: true }]) {
        const output = rowLines(r('table', { text, agentLabel: undefined }), width, env(settings))
        const rendered = output.map(line => line.segs?.map(seg => seg.text).join('') ?? line.text).join('\n')
        expect(rendered).not.toContain('|')
        expect(rendered).not.toContain('**')
        expect(rendered).toContain('Permissions')
        expect(rendered).toContain('source [1]')
        expect(rendered).toContain('References')
        expect(rendered.replace(/\s+/g, '')).toContain('/Users/me/project/src/permissions.ts:49')
        for (const line of output) {
          expect(textWidth(line.text)).toBeLessThanOrEqual(width)
          expect(line.segs?.map(seg => seg.text).join('')).toBe(line.text)
        }
      }
    }
  })

  it('uses readable Markdown in fullscreen and inline transcript rendering', () => {
    for (const mode of ['fullscreen', 'inline'] as const) {
      const app = mount({ mode, width: 60, height: 30, rows: [r('formatted', {
        text: '| Name | Detail |\n|---|---|\n| Permission | Requires approval |\n\nSee [docs](/project/docs.md).'
      })] })
      const frame = app.lastFrame() ?? ''
      expect(frame).toContain('Name: Permission')
      expect(frame).toContain('Detail: Requires approval')
      expect(frame).toContain('See docs [1].')
      expect(frame).toContain('[1] /project/docs.md')
      expect(frame).not.toContain('|---|')
      app.unmount()
    }
  })

  it('expands grouped tool activity and always leaves failures visible', async () => {
    const rows = [r('t1', { kind: 'tool', text: 'Read one.ts' }), r('r1', { kind: 'result', text: 'Read complete' }), r('t2', { kind: 'tool', text: 'Read two.ts' }), r('r2', { kind: 'result', text: 'Read complete' }), r('fail', { kind: 'error', text: 'Check failed' })]
    expect(groupToolRows(rows)).toHaveLength(2)
    const app = mount({ rows, focused: true })
    expect(app.lastFrame()).toContain('2 tool calls completed')
    expect(app.lastFrame()).toContain('Check failed')
    press(app.bus, 'transcript', key('enter'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(app.lastFrame()).toContain('Read one.ts')
    expect(app.lastFrame()).toContain('Read two.ts')
    app.unmount()
  })

  it('styles each row kind', () => {
    const rows: TranscriptRow[] = [
      r('u', { kind: 'user', text: 'please fix the bug', agentLabel: undefined }),
      r('t', { kind: 'text', text: 'On it.' }),
      r('th', { kind: 'thinking', text: 'considering' }),
      r('tool', { kind: 'tool', text: 'Read src/a.ts' }),
      r('res', { kind: 'result', text: 'ok' }),
      r('err', { kind: 'error', text: 'boom' }),
      r('div', { kind: 'divider', text: 'Continued 3 min later' }),
      r('h', { kind: 'harness', text: 'Loaded skill review' })
    ]
    const t = mount({ rows, height: 20 })
    const out = lines(t.lastFrame())
    expect(out).toContain('› please fix the bug')
    expect(out).toContain('• orchestrator: On it.')
    expect(out).toContain('orchestrator (thinking): considering')
    expect(out).toContain('→ orchestrator: Read src/a.ts')
    expect(out).toContain('└─ ok')
    expect(out).toContain('✗ orchestrator: boom')
    const div = out.find((l) => l.includes('Continued 3 min later'))!
    expect(div.startsWith('── Continued 3 min later ─')).toBe(true)
    expect(textWidth(div)).toBe(60)
    expect(out).toContain('Loaded skill review')
    t.unmount()
  })

  it('keeps semantic tones scoped to labels, tools, results and prompt markers', () => {
    const user = rowLines(r('user', { kind: 'user', agentLabel: undefined, text: 'plain prompt' }), 80, env())[0]!.segs!
    expect(user.find((segment) => segment.text.includes('›'))?.tone).toBe('accent')
    expect(user.find((segment) => segment.text === 'plain prompt')?.tone).toBeUndefined()

    const assistant = rowLines(r('assistant', { text: 'plain prose' }), 80, env())[0]!.segs!
    expect(assistant.find((segment) => segment.text === 'orchestrator: ')?.tone).toBe('identity')
    expect(assistant.find((segment) => segment.text === 'orchestrator: ')?.bold).toBe(true)
    expect(assistant.find((segment) => segment.text === 'plain prose')?.tone).toBeUndefined()

    const tool = rowLines(r('tool', { kind: 'tool', text: 'Read src/app.ts' }), 80, env())[0]!.segs!
    expect(tool.find((segment) => segment.text === 'Read src/app.ts')?.tone).toBe('code')
    expect(tool.find((segment) => segment.text === 'orchestrator: ')?.tone).toBe('identity')

    const result = rowLines(r('result', { kind: 'result', text: 'output line' }), 80, env())[0]!.segs!
    expect(result.find((segment) => segment.text === 'output line')?.tone).toBe('muted')
    expect(result.find((segment) => segment.text === 'output line')?.dim).not.toBe(true)
  })

  it('wraps long and multi-line rows to the width, wide characters as two columns', () => {
    const rows = [r('a', { text: 'first line\nsecond line that is quite a bit longer than the pane' }), r('w', { text: '漢字'.repeat(20) })]
    const t = mount({ rows, width: 24, height: 20 })
    const out = lines(t.lastFrame())
    expect(out[0]).toBe('• orchestrator: first')
    expect(out[1]).toBe('  line')
    for (const l of out) expect(textWidth(l)).toBeLessThanOrEqual(24)
    t.unmount()
  })

  it('shows the omitted line and dim partials after the rows', () => {
    const partials: PartialRow[] = [{ key: 'p1', runId: 'r1', agentId: 'dev', agentLabel: 'dev-1', text: 'streaming…' }]
    const t = mount({ rows: [r('a')], partials, omitted: 1200 })
    const out = lines(t.lastFrame())
    expect(out[0]).toBe('1,200 earlier entries not shown')
    expect(out[1]).toBe('• orchestrator: text of a')
    expect(out[2]).toBe('• dev-1: streaming…')
    t.unmount()
  })

  it('keeps semantic label styling on colored streaming partials', async () => {
    await withInkColor(() => {
      const t = mount({ partials: [{ key: 'partial', runId: 'r1', agentId: 'dev', agentLabel: 'dev-1', text: 'streaming body' }] }, env())
      const frame = t.lastFrame() ?? ''
      expect(frame).toMatch(ESC_RE)
      expect(frame).toMatch(/\x1b\[1m(?:\x1b\[[0-9;]+m)*dev-1:/)
      expect(frame).toMatch(/dev-1: (?:\x1b\[[0-9;]+m)+streaming body/)
      t.unmount()
    })
  })

  it('stays pinned to the bottom, and holds its place with a "new rows below" line after scrolling up', () => {
    const t = mount({ rows: numbered(30), height: 5 })
    expect(lines(t.lastFrame()).at(-1)).toBe('• orchestrator: line 29')
    t.rerender({ rows: numbered(31) })
    expect(lines(t.lastFrame()).at(-1)).toBe('• orchestrator: line 30')
    // Not focused: keys are not consumed.
    expect(press(t.bus, 'transcript', key('pageup'))).toEqual([false])
    t.rerender({ focused: true })
    press(t.bus, 'transcript', key('up'), key('up'))
    t.rerender({})
    let out = lines(t.lastFrame())
    expect(out.at(-1)).toBe('More below; End to jump')
    const firstShown = out[0]
    t.rerender({ rows: numbered(34) })
    out = lines(t.lastFrame())
    expect(out[0]).toBe(firstShown)
    expect(out.at(-1)).toBe('3 new rows below; End to jump')
    // Rows trimmed at the front keep the view on the same row.
    t.rerender({ rows: numbered(30, 4) })
    expect(lines(t.lastFrame())[0]).toBe(firstShown)
    press(t.bus, 'transcript', key('end'))
    t.rerender({})
    out = lines(t.lastFrame())
    expect(out.at(-1)).toBe('• orchestrator: line 33')
    expect(out.join('\n')).not.toContain('End to jump')
    press(t.bus, 'transcript', key('home'))
    t.rerender({})
    expect(lines(t.lastFrame())[0]).toBe('• orchestrator: line 4')
    press(t.bus, 'transcript', ...Array.from({ length: 12 }, () => key('pagedown')))
    t.rerender({})
    expect(lines(t.lastFrame()).at(-1)).toBe('• orchestrator: line 33')
    t.unmount()
  })

  it('uses ASCII and no colour codes in screen-reader or colour-off mode', async () => {
    const rows = [r('tool', { kind: 'tool', text: 'Bash ls' }), r('err', { kind: 'error', text: 'bad' }), r('d', { kind: 'divider', text: 'x' })]
    await withInkColor(() => {
      const c = mount({ rows }, env())
      expect(c.lastFrame()).toMatch(ESC_RE)
      c.unmount()
      const plain = mount({ rows }, env({ color: false }))
      expect(plain.lastFrame()).not.toMatch(ESC_RE)
      plain.unmount()
      const sr = mount({ rows }, env({ screenReader: true, color: false }))
      const out = sr.lastFrame() ?? ''
      expect(out).toContain('orchestrator: tool: Bash ls')
      expect(out).toContain('orchestrator: error: bad')
      expect(out).toContain('-- x ---')
      expect(out).not.toMatch(/[→✗─]/)
      sr.unmount()
    })
  })

  it('uses turn markers, hanging indents, and one gap between meaningful user turns', () => {
    const rows: TranscriptRow[] = [
      r('u1', { kind: 'user', text: 'find the bug', agentLabel: undefined }),
      r('a1', { text: 'A compact answer with enough detail to wrap.' }),
      r('tool', { kind: 'tool', text: 'Read src/cli/tui/TranscriptPane.tsx and inspect the row layout.' }),
      r('res', { kind: 'result', text: 'The result has enough detail to wrap under its branch.' }),
      r('u2', { kind: 'user', text: 'now make the fix', agentLabel: undefined })
    ]
    const t = mount({ rows, width: 32, height: 20 })
    const out = lines(t.lastFrame())
    const assistant = out.findIndex((line) => line.startsWith('• orchestrator:'))
    const assistantIndent = '  '
    expect(out).toContain('› find the bug')
    expect(assistant).toBeGreaterThanOrEqual(0)
    expect(out[assistant + 1]?.startsWith(assistantIndent)).toBe(true)
    const tool = out.findIndex((line) => line.startsWith('→ orchestrator:'))
    const toolIndent = '  '
    expect(tool).toBeGreaterThanOrEqual(0)
    expect(out[tool + 1]?.startsWith(toolIndent)).toBe(true)
    const nextUser = out.findIndex((line) => line === '› now make the fix')
    expect(nextUser).toBeGreaterThan(1)
    expect(out[nextUser - 1]?.trim()).toBe('')
    expect(out[nextUser - 2]?.trim()).not.toBe('')
    t.unmount()
  })

  it('keeps row bodies visible when a label is wider than the pane', () => {
    const t = mount({ width: 1, height: 6, rows: [r('narrow', { agentLabel: 'a-very-long-agent', text: 'body' })] })
    expect(lines(t.lastFrame()).slice(0, 5)).toEqual(['•', 'b', 'o', 'd', 'y'])
    t.unmount()
  })

  it('survives width or height 0 and 1', () => {
    for (const [width, height] of [
      [0, 0],
      [1, 1],
      [0, 4],
      [4, 0],
      [1, 5]
    ]) {
      const t = mount({ width, height, rows: numbered(5), omitted: 2, focused: true })
      press(t.bus, 'transcript', key('up'), key('pageup'), key('home'), key('end'))
      t.unmount()
    }
    expect(dividerLine('long text here', 3, env())).toHaveLength(3)
    expect(dividerLine('x', 0, env())).toBe('')
  })
})

describe('TranscriptPane (inline)', () => {
  it('writes each row to scrollback once across re-renders and a resync with the same keys, never partials', () => {
    const t = mount({ mode: 'inline', rows: [r('a'), r('b')] })
    t.rerender({ rows: [r('a'), r('b')], partials: [{ key: 'p', runId: 'r1', agentId: 'x', agentLabel: 'x', text: 'PARTIAL' }] })
    t.rerender({ rows: [r('a'), r('b'), r('c')] })
    // A resync: a fresh array with the same keys plus one new row, and a trimmed front.
    t.rerender({ rows: [r('b'), r('c'), r('d')] })
    t.rerender({ rows: [r('b'), r('c'), r('d')] })
    // ink-testing-library renders in debug mode, where every frame carries all <Static> output written so far.
    const all = t.lastFrame() ?? ''
    for (const k of ['a', 'b', 'c', 'd']) {
      expect(all.split(`text of ${k}`).length - 1).toBe(1)
    }
    expect(t.frames.join('\n')).not.toContain('PARTIAL')
    t.unmount()
  })
})
