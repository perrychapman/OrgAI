import { describe, expect, it } from 'vitest'
import {
  continueRunArgs,
  installAnswerArgs,
  mergeDecideArgs,
  permissionDecideArgs,
  proposalDecideArgs,
  questionAnswerArgs,
  quickArgs,
  ruleDecideArgs,
  runMessageArgs,
  startRunArgs
} from './args'

const bad = { code: 'bad_request' }

/** Throws something whose `code` is bad_request. */
function expectBad(fn: () => unknown): void {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(Error)
  expect(caught).toMatchObject(bad)
}

describe('headless overrides at the RPC boundary (cli-spec 6.2(1))', () => {
  it('startRunArgs keeps overrides, rebuilt (unknown keys dropped, a partial policy filled in)', () => {
    const input = startRunArgs({
      projectId: 'proj_a',
      prompt: 'go',
      overrides: { permissionMode: 'plan', maxBudgetUsd: 0, execMode: true, junk: 1, decisionPolicy: { question: 'conservative' } }
    })
    expect(input.overrides).toEqual({
      permissionMode: 'plan',
      maxBudgetUsd: 0,
      execMode: true,
      decisionPolicy: { permission: 'deny', rules: 'deny', mcpInstall: 'deny', question: 'conservative', proposal: 'decline', merge: 'hold' }
    })
    expect(startRunArgs({ projectId: 'proj_a', prompt: 'go' })).not.toHaveProperty('overrides')
    expect(startRunArgs({ projectId: 'proj_a', prompt: 'go', overrides: null })).not.toHaveProperty('overrides')
    expect(startRunArgs({ projectId: 'proj_a', prompt: 'go', overrides: { junk: 1 } })).not.toHaveProperty('overrides')
  })

  it('bad overrides are bad_request on runs:start, runs:continue and runs:startQuick', () => {
    for (const overrides of [
      'plan',
      [],
      { permissionMode: 'yolo' },
      { autoContinue: 'yes' },
      { maxAutoContinues: -1 },
      { maxAutoContinues: 1.5 },
      { maxBudgetUsd: Number.POSITIVE_INFINITY },
      { maxBudgetUsd: -0.01 },
      { execChainId: 'has space' },
      { decisionPolicy: { permission: 'allow' } },
      { decisionPolicy: 'deny' }
    ]) {
      expectBad(() => startRunArgs({ projectId: 'proj_a', prompt: 'go', overrides }))
      expectBad(() => continueRunArgs({ runId: 'run_1', text: 'more', overrides }))
      expectBad(() => quickArgs.start({ prompt: 'hi', overrides }))
    }
  })

  it('quickArgs.start keeps overrides', () => {
    expect(quickArgs.start({ prompt: 'hi', overrides: { permissionMode: 'plan', allowPeerMessages: false } })).toEqual({
      prompt: 'hi',
      team: 'single',
      allowEdits: false,
      overrides: { permissionMode: 'plan', allowPeerMessages: false }
    })
    expect(quickArgs.start({ prompt: 'hi' })).not.toHaveProperty('overrides')
  })

  it('continueRunArgs keeps overrides and a literal boolean exec', () => {
    expect(continueRunArgs({ runId: 'run_1', text: 'more', exec: true, overrides: { maxBudgetUsd: 1 } })).toEqual({
      runId: 'run_1',
      text: 'more',
      exec: true,
      overrides: { maxBudgetUsd: 1 }
    })
    expect(continueRunArgs({ runId: 'run_1', text: 'more', exec: false })).toEqual({ runId: 'run_1', text: 'more', exec: false })
    expect(continueRunArgs({ runId: 'run_1', text: 'more', exec: null })).toEqual({ runId: 'run_1', text: 'more' })
    expect(continueRunArgs({ runId: 'run_1', text: 'more' })).toEqual({ runId: 'run_1', text: 'more' })
    for (const exec of ['true', 1, {}]) expectBad(() => continueRunArgs({ runId: 'run_1', text: 'more', exec }))
  })

  it('runs:send never takes overrides or exec (dropped like any extra field)', () => {
    expect(runMessageArgs({ runId: 'run_1', text: 'hi', overrides: { permissionMode: 'bypassPermissions' }, exec: true })).toEqual({ runId: 'run_1', text: 'hi' })
    // Not even a malformed one is looked at.
    expect(runMessageArgs({ runId: 'run_1', text: 'hi', overrides: 'junk', exec: 'x' })).toEqual({ runId: 'run_1', text: 'hi' })
  })
})

describe('expectedRevision on the six decision builders (cli-spec 5.3)', () => {
  const builders: Array<[string, (rev: unknown) => unknown]> = [
    ['runs:decide', (rev) => permissionDecideArgs({ runId: 'r1', requestId: 'p1', expectedRevision: rev, decision: { behavior: 'allow' } })],
    ['permissions:decideRequest', (rev) => ruleDecideArgs({ runId: 'r1', requestId: 'p1', expectedRevision: rev, decision: { behavior: 'grant', scope: 'run' } })],
    ['setup:decide', (rev) => proposalDecideArgs({ runId: 'r1', proposalId: 'p1', expectedRevision: rev, decision: { behavior: 'approve' } })],
    ['setup:answer', (rev) => questionAnswerArgs({ runId: 'r1', questionId: 'q1', expectedRevision: rev, answer: { selected: ['A'] } })],
    ['merges:decide', (rev) => mergeDecideArgs({ runId: 'r1', reviewId: 'm1', expectedRevision: rev, decision: { behavior: 'hold' } })],
    ['mcp:answerInstall', (rev) => installAnswerArgs({ runId: 'r1', requestId: 'i1', expectedRevision: rev, decision: { approved: false } })]
  ]

  it.each(builders)('%s accepts and returns a non-negative whole revision', (_name, build) => {
    expect(build(0)).toMatchObject({ expectedRevision: 0 })
    expect(build(7)).toMatchObject({ expectedRevision: 7 })
    expect(build(Number.MAX_SAFE_INTEGER)).toMatchObject({ expectedRevision: Number.MAX_SAFE_INTEGER })
  })

  it.each(builders)('%s leaves it out when absent or null', (_name, build) => {
    expect(build(undefined)).not.toHaveProperty('expectedRevision')
    expect(build(null)).not.toHaveProperty('expectedRevision')
  })

  it.each(builders)('%s refuses a bad revision as bad_request', (_name, build) => {
    for (const rev of [-1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, true, {}]) expectBad(() => build(rev))
  })
})
