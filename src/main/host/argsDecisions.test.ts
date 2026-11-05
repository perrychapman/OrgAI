import { describe, expect, it } from 'vitest'
import {
  installAnswerArgs,
  mergeDecideArgs,
  permissionDecideArgs,
  questionAnswerArgs,
  ruleDecideArgs,
  runMessageArgs,
  startRunArgs
} from './args'

const bad = { code: 'bad_request' }

describe('decision card validators (cli-spec 3.3(3))', () => {
  it('permissionDecideArgs rebuilds what the PermissionCard sends and drops extra fields', () => {
    expect(permissionDecideArgs({ runId: 'r1', requestId: 'p1', decision: { behavior: 'allow', scope: 'session', extra: 1 }, junk: true })).toEqual({
      runId: 'r1',
      requestId: 'p1',
      decision: { behavior: 'allow', scope: 'session' }
    })
    expect(permissionDecideArgs({ runId: 'r1', requestId: 'p1', decision: { behavior: 'allow' } }).decision).toEqual({ behavior: 'allow' })
    expect(permissionDecideArgs({ runId: 'r1', requestId: 'p1', decision: { behavior: 'deny', message: 'no' } }).decision).toEqual({ behavior: 'deny', message: 'no' })
  })

  it('permissionDecideArgs refuses shapes that are not a PermissionDecision', () => {
    for (const input of [
      { runId: 'r1', requestId: 'p1', decision: 'yes' },
      { runId: 'r1', requestId: 'p1', decision: { behavior: 'allow', scope: 'forever' } },
      { runId: 'r1', requestId: 'p1', decision: { behavior: 'deny' } },
      { runId: 'r1', requestId: 'p1', decision: { behavior: 'deny', message: 7 } },
      { runId: 'r1', requestId: 'p1', decision: { behavior: 'maybe' } },
      { runId: 1, requestId: 'p1', decision: { behavior: 'allow' } },
      { runId: 'r1', decision: { behavior: 'allow' } },
      [{ runId: 'r1', requestId: 'p1', decision: { behavior: 'allow' } }],
      null
    ]) {
      expect(() => permissionDecideArgs(input), JSON.stringify(input)).toThrow(expect.objectContaining(bad))
    }
  })

  it('ruleDecideArgs accepts grant run / project and deny with or without a message', () => {
    expect(ruleDecideArgs({ runId: 'r', requestId: 'q', decision: { behavior: 'grant', scope: 'project' } }).decision).toEqual({ behavior: 'grant', scope: 'project' })
    expect(ruleDecideArgs({ runId: 'r', requestId: 'q', decision: { behavior: 'deny' } }).decision).toEqual({ behavior: 'deny' })
    expect(ruleDecideArgs({ runId: 'r', requestId: 'q', decision: { behavior: 'deny', message: 'x' } }).decision).toEqual({ behavior: 'deny', message: 'x' })
    expect(() => ruleDecideArgs({ runId: 'r', requestId: 'q', decision: { behavior: 'grant' } })).toThrow(expect.objectContaining(bad))
    expect(() => ruleDecideArgs({ runId: 'r', requestId: 'q', decision: { behavior: 'grant', scope: 'session' } })).toThrow(expect.objectContaining(bad))
  })

  it('mergeDecideArgs accepts merge / discard / hold only', () => {
    for (const behavior of ['merge', 'discard', 'hold'] as const) {
      expect(mergeDecideArgs({ runId: 'r', reviewId: 'm', decision: { behavior, extra: 1 } })).toEqual({ runId: 'r', reviewId: 'm', decision: { behavior } })
    }
    expect(() => mergeDecideArgs({ runId: 'r', reviewId: 'm', decision: { behavior: 'push' } })).toThrow(expect.objectContaining(bad))
    expect(() => mergeDecideArgs({ runId: 'r', decision: { behavior: 'merge' } })).toThrow(expect.objectContaining(bad))
  })

  it('questionAnswerArgs needs a list of text labels and optional text', () => {
    expect(questionAnswerArgs({ runId: 'r', questionId: 'q', answer: { selected: ['A'], text: 'note', x: 1 } })).toEqual({
      runId: 'r',
      questionId: 'q',
      answer: { selected: ['A'], text: 'note' }
    })
    expect(questionAnswerArgs({ runId: 'r', questionId: 'q', answer: { selected: [] } }).answer).toEqual({ selected: [] })
    expect(() => questionAnswerArgs({ runId: 'r', questionId: 'q', answer: { selected: 'A' } })).toThrow(expect.objectContaining(bad))
    expect(() => questionAnswerArgs({ runId: 'r', questionId: 'q', answer: { selected: [1] } })).toThrow(expect.objectContaining(bad))
    expect(() => questionAnswerArgs({ runId: 'r', questionId: 'q', answer: { selected: [], text: 3 } })).toThrow(expect.objectContaining(bad))
    expect(() => questionAnswerArgs({ runId: 'r', questionId: 'q', answer: { selected: Array(201).fill('A') } })).toThrow(expect.objectContaining(bad))
  })

  it('installAnswerArgs rebuilds what the McpInstallCard sends', () => {
    expect(installAnswerArgs({ runId: 'r', requestId: 'i', decision: { approved: false, note: undefined, scope: 'run' } })).toEqual({
      runId: 'r',
      requestId: 'i',
      decision: { approved: false, scope: 'run' }
    })
    const ok = installAnswerArgs({ runId: 'r', requestId: 'i', decision: { approved: true, secrets: { TOKEN: 'v' }, note: 'n', scope: 'library', junk: 1 } })
    expect(ok.decision).toEqual({ approved: true, scope: 'library', note: 'n', secrets: { TOKEN: 'v' } })
    expect(() => installAnswerArgs({ runId: 'r', requestId: 'i', decision: { approved: 'yes' } })).toThrow(expect.objectContaining(bad))
    expect(() => installAnswerArgs({ runId: 'r', requestId: 'i', decision: { approved: true, scope: 'global' } })).toThrow(expect.objectContaining(bad))
    expect(() => installAnswerArgs({ runId: 'r', requestId: 'i', decision: { approved: true, secrets: { A: 1 } } })).toThrow(expect.objectContaining(bad))
    expect(() => installAnswerArgs({ runId: 'r', requestId: 'i', decision: { approved: true, spec: 'x' } })).toThrow(expect.objectContaining(bad))
  })
})

describe('run message validators', () => {
  it('startRunArgs keeps prompt, scaffold, images and team single; drops the rest', () => {
    expect(startRunArgs({ projectId: 'p1', prompt: 'hi', scaffold: true, images: [], team: 'single', extra: 1 })).toEqual({
      projectId: 'p1',
      prompt: 'hi',
      scaffold: true,
      images: [],
      team: 'single'
    })
    expect(startRunArgs({ projectId: 'p1', prompt: 'hi', team: 'big', scaffold: false })).toEqual({ projectId: 'p1', prompt: 'hi' })
    expect(() => startRunArgs({ projectId: 'p1', prompt: 3 })).toThrow(expect.objectContaining(bad))
    expect(() => startRunArgs({ projectId: 'p1', prompt: 'x', images: 'img' })).toThrow(expect.objectContaining(bad))
    expect(() => startRunArgs({ projectId: 'p1', prompt: 'x', scaffold: 'yes' })).toThrow(expect.objectContaining(bad))
    expect(() => startRunArgs({ projectId: '../x', prompt: 'x' })).toThrow(expect.objectContaining(bad))
  })

  it('runMessageArgs needs a run id and text', () => {
    expect(runMessageArgs({ runId: 'r', text: '', images: [{ mediaType: 'image/png', data: 'AA' }] })).toEqual({ runId: 'r', text: '', images: [{ mediaType: 'image/png', data: 'AA' }] })
    expect(runMessageArgs({ runId: 'r', text: 'x', images: null })).toEqual({ runId: 'r', text: 'x' })
    expect(() => runMessageArgs({ runId: 'r' })).toThrow(expect.objectContaining(bad))
    expect(() => runMessageArgs({ text: 'x' })).toThrow(expect.objectContaining(bad))
  })
})
