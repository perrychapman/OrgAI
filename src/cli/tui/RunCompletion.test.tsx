import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { AgentInstance, PendingCards, RunPlan, RunSummary, TranscriptEntry } from '../../shared/types'
import { summary } from '../testing/fakeContext'
import { DEFAULT_TUI_ENV, InputBus } from './context'
import { RunCompletion, completionLines } from './RunCompletion'
import { createInitialState } from './state'
import { Providers } from './panes/testUtil'
import type { TuiRun, TuiState } from './types'

const cards = (): PendingCards => ({ permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] })

function state(over: Partial<RunSummary> = {}, runOver: Partial<TuiRun> = {}): TuiState {
  const s = createInitialState('/work/repo')
  const run: TuiRun = {
    summary: summary('r1', { status: 'finished', endedAt: 6_000, ...over }),
    agents: {},
    transcript: [],
    partials: {},
    cards: cards(),
    recordLoaded: true,
    ...runOver
  }
  return { ...s, activeRunId: 'r1', activeChain: ['r1'], runs: { r1: run } }
}

function agent(files?: string[]): AgentInstance {
  return {
    id: 'worker', roleId: null, roleSlug: 'worker', name: 'Worker', parentId: 'root', spawnToolUseId: null,
    state: 'done', activity: 'Finished', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1_000,
    worktree: { path: '/tmp/worktree', branch: 'worker', status: 'review', ...(files ? { changedFiles: files } : {}) }
  }
}

function entry(id: string, block: TranscriptEntry['block']): TranscriptEntry {
  return { id, agentId: 'root', at: Number(id.replace(/\D/g, '')) || 1, block }
}

describe('RunCompletion', () => {
  it('does not invent a completion for a non-terminal active run', () => {
    expect(completionLines(state({ status: 'running', endedAt: undefined }))).toEqual([])
    expect(completionLines({ ...state(), activeRunId: undefined })).toEqual([])
  })

  it('summarizes truthful outcome, elapsed time, plan, files, checks and diff hint', () => {
    const plan: RunPlan = { goal: 'Ship it', steps: [{ id: 'p1', title: 'One', status: 'done' }, { id: 'p2', title: 'Two', status: 'done' }, { id: 'p3', title: 'Three', status: 'pending' }], status: 'active', autoContinues: 0, updatedAt: 1 }
    const transcript: TranscriptEntry[] = [
      entry('tool1', { kind: 'tool_use', id: 'call1', name: 'Bash', input: { command: 'npm test' } }),
      entry('result1', { kind: 'tool_result', toolUseId: 'call1', content: 'passed', isError: false }),
      entry('tool2', { kind: 'tool_use', id: 'call2', name: 'Bash', input: { command: 'git diff --check' } }),
      entry('result2', { kind: 'tool_result', toolUseId: 'call2', content: 'clean', isError: false })
    ]
    const lines = completionLines(state({ execOutcome: 'completed' }, { plan, agents: { worker: agent(['src/a.ts', 'src/b.ts']) }, transcript }))
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('Run finished')
    expect(lines[1]).toContain('Outcome: Completed')
    expect(lines[1]).toContain('Elapsed: 5s')
    expect(lines).toContain('Plan: 2/3 steps done')
    expect(lines.join('\n')).toContain('Changes: 2 files recorded (src/a.ts, src/b.ts)')
    expect(lines.join('\n')).toContain('npm test passed')
    expect(lines.join('\n')).toContain('/diff <branch|agent>')
  })

  it('reports errors and omits unpaired or non-check tool output', () => {
    const transcript: TranscriptEntry[] = [
      entry('orphan', { kind: 'tool_result', toolUseId: 'missing', content: 'npm test passed', isError: false }),
      entry('text', { kind: 'text', text: 'The checks look good.' })
    ]
    const lines = completionLines(state({ status: 'error', error: 'Command failed', endedAt: 3_000 }, { transcript }))
    expect(lines[0]).toBe('Run failed')
    expect(lines[1]).toContain('Failed: Command failed')
    expect(lines.some((line) => line.startsWith('Checks:'))).toBe(false)
    expect(lines).toContain('Changes: not recorded | /diff <branch|agent>')
  })

  it('requires explicit check evidence and accepts exec_command cmd input', () => {
    const transcript: TranscriptEntry[] = [
      entry('echo-use', { kind: 'tool_use', id: 'echo1', name: 'Bash', input: { command: "echo 'npm test'" } }),
      entry('echo-result', { kind: 'tool_result', toolUseId: 'echo1', content: 'completed', isError: false }),
      entry('exec-use', { kind: 'tool_use', id: 'exec1', name: 'exec_command', input: { cmd: 'npm test' } }),
      entry('exec-result', { kind: 'tool_result', toolUseId: 'exec1', content: 'exit code 0', isError: false }),
      entry('unknown-use', { kind: 'tool_use', id: 'unknown1', name: 'Bash', input: { command: 'npm run build' } }),
      entry('unknown-result', { kind: 'tool_result', toolUseId: 'unknown1', content: 'completed (exit not recorded)', isError: false })
    ]
    const lines = completionLines(state({ execOutcome: 'budget-exceeded' }, { transcript }))
    expect(lines.join('\n')).toContain('npm test passed')
    expect(lines.join('\n')).not.toContain('echo')
    expect(lines.join('\n')).not.toContain('npm run build')
    expect(lines[0]).toBe('Run finished')
  })

  it('uses the latest result for a normalized rerun and rejects loose prose', () => {
    const transcript: TranscriptEntry[] = [
      entry('first-use', { kind: 'tool_use', id: 'first', name: 'Bash', input: { command: 'npm test' } }),
      entry('first-result', { kind: 'tool_result', toolUseId: 'first', content: 'exit code 2', isError: false }),
      entry('second-use', { kind: 'tool_use', id: 'second', name: 'Bash', input: { command: '  npm   test ' } }),
      entry('second-result', { kind: 'tool_result', toolUseId: 'second', content: 'expected 1 test passed but received 2', isError: false }),
      entry('third-use', { kind: 'tool_use', id: 'third', name: 'Bash', input: { command: 'npm test' } }),
      entry('third-result', { kind: 'tool_result', toolUseId: 'third', content: 'exit code 0', isError: false })
    ]
    const lines = completionLines(state({ execOutcome: 'completed' }, { transcript }))
    expect(lines.join('\n')).toContain('npm test passed')
    expect(lines.join('\n')).not.toContain('failed')
    expect(lines.join('\n')).not.toContain('expected')
  })

  it('records explicit zero and nonzero exits as pass and fail', () => {
    const transcript: TranscriptEntry[] = [
      entry('pass-use', { kind: 'tool_use', id: 'pass', name: 'Bash', input: { command: 'npm test' } }),
      entry('pass-result', { kind: 'tool_result', toolUseId: 'pass', content: 'status: 0', isError: false }),
      entry('fail-use', { kind: 'tool_use', id: 'fail', name: 'Bash', input: { command: 'npm run build' } }),
      entry('fail-result', { kind: 'tool_result', toolUseId: 'fail', content: 'process exited with code 1', isError: false })
    ]
    const lines = completionLines(state({ execOutcome: 'completed' }, { transcript }))
    expect(lines.join('\n')).toContain('npm test passed')
    expect(lines.join('\n')).toContain('npm run build failed')
  })

  it('accepts a terminal exit footer, preserves command case, and omits mixed prose', () => {
    const transcript: TranscriptEntry[] = [
      entry('footer-use', { kind: 'tool_use', id: 'footer', name: 'Bash', input: { command: 'npm test Foo' } }),
      entry('footer-result', { kind: 'tool_result', toolUseId: 'footer', content: 'test output\n[exit code 0]', isError: false }),
      entry('case-use', { kind: 'tool_use', id: 'case', name: 'Bash', input: { command: 'npm test foo' } }),
      entry('case-result', { kind: 'tool_result', toolUseId: 'case', content: 'Test Files 1 failed | 2 passed', isError: false })
    ]
    const lines = completionLines(state({ execOutcome: 'completed' }, { transcript }))
    expect(lines.join('\n')).toContain('npm test Foo passed')
    expect(lines.join('\n')).not.toContain('npm test foo')
  })

  it('does not retain an earlier pass when the latest rerun has unknown exit evidence', () => {
    const transcript: TranscriptEntry[] = [
      entry('pass-use', { kind: 'tool_use', id: 'pass-latest', name: 'Bash', input: { command: 'npm test' } }),
      entry('pass-result', { kind: 'tool_result', toolUseId: 'pass-latest', content: 'exit code 0', isError: false }),
      entry('unknown-use', { kind: 'tool_use', id: 'unknown-latest', name: 'Bash', input: { command: 'npm test' } }),
      entry('unknown-result', { kind: 'tool_result', toolUseId: 'unknown-latest', content: 'completed (exit not recorded)', isError: false })
    ]
    const lines = completionLines(state({ execOutcome: 'completed' }, { transcript }))
    expect(lines.filter((line) => line.startsWith('Checks:'))).toEqual([])
  })

  it('renders a static bounded accessible view', () => {
    const view = render(
      <Providers env={{ ...DEFAULT_TUI_ENV, color: false, screenReader: true }} bus={new InputBus()}>
        <RunCompletion width={42} height={5} state={state({ execOutcome: 'completed' }, { agents: { worker: agent(['a.ts']) } })} />
      </Providers>
    )
    const frame = view.lastFrame() ?? ''
    expect(frame).toContain('Run finished')
    expect(frame).toContain('/diff')
    expect(frame).not.toMatch(/\x1b\[/)
    expect(frame.split('\n').length).toBeLessThanOrEqual(5)
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(42)
    view.unmount()
  })
})
