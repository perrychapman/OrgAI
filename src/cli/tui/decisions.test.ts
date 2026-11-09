import { describe, expect, it } from 'vitest'
import type { CardKind, McpInstallRequest, MergeReview, PermissionRequest, PermissionRuleRequest, Proposal, UserQuestion } from '../../shared/types'
import { bindingsFor, cardDetailLines, cardFullText, cardTitle, decisionFor, secretSlotsFor, wrapLine, type TrayAction } from './decisions'
import { cardKey, type CardRef, type TrayCard } from './types'

const RUN = 'run_1'
const REQ = 'req_1'

const permission = (extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: REQ,
  runId: RUN,
  agentId: 'root',
  toolName: 'Bash',
  input: { command: 'npm test' },
  summary: 'Run npm test',
  suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }],
  ruleLabels: ['Bash(npm test:*)'],
  ...extra
})
const rules = (extra: Partial<PermissionRuleRequest> = {}): PermissionRuleRequest => ({
  id: REQ,
  runId: RUN,
  agentId: 'root',
  rules: ['Bash(gh repo create:*)'],
  reason: 'create the repo',
  flagged: [],
  createdAt: 1,
  ...extra
})
const mcpProposal = (secrets = true): Proposal => ({
  id: REQ,
  runId: RUN,
  agentId: 'root',
  title: 'Add GitHub',
  createdAt: 1,
  kind: 'mcpServers',
  payload: {
    upsert: [{ id: 'gh', name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@1.2.3'], source: 'agent' } as never],
    rationale: 'issues',
    ...(secrets ? { secrets: [{ serverId: 'gh', kind: 'env' as const, name: 'GITHUB_TOKEN' }] } : {})
  }
})
const question = (extra: Partial<UserQuestion> = {}): UserQuestion => ({
  id: REQ,
  runId: RUN,
  agentId: 'root',
  question: 'Which DB?',
  options: [{ label: 'Postgres', description: 'server' }, { label: 'SQLite' }],
  allowMultiple: false,
  allowFreeText: true,
  createdAt: 1,
  ...extra
})
const merge = (): MergeReview => ({
  id: REQ,
  runId: RUN,
  agentId: 'a1',
  agentName: 'impl',
  branch: 'worktree-agent-1',
  path: '/x',
  changedFiles: ['src/a.ts'],
  stat: ' src/a.ts | 2 +-',
  patch: '+added\n-removed',
  createdAt: 1
})
const install = (requiredSecrets: string[] = ['API_KEY']): McpInstallRequest => ({
  id: REQ,
  runId: RUN,
  agentId: 'root',
  reason: 'need it',
  spec: { id: 's', name: 'srv', transport: 'stdio', command: 'npx', args: ['srv@1.0.0'], source: 'agent' } as never,
  requiredSecrets,
  createdAt: 1
})

function tray(kind: CardKind, card: unknown, revision = 1, extra: Partial<TrayCard> = {}): TrayCard {
  const ref: CardRef = { hostInstanceId: 'h1', runId: RUN, requestId: REQ, kind, revision }
  return { key: cardKey(ref), ref, runTag: 'R1', runKind: 'work', arrivedSeq: 1, kind, card, ...extra } as TrayCard
}

describe('decisionFor: exact cli-spec 5.3 payloads', () => {
  const cases: [string, () => TrayCard, TrayAction, string, unknown][] = [
    ['permission allow once', () => tray('permission', permission()), { kind: 'permission', act: 'allow-once' }, 'runs:decide', { runId: RUN, requestId: REQ, decision: { behavior: 'allow', scope: 'once' } }],
    ['permission allow session', () => tray('permission', permission()), { kind: 'permission', act: 'allow-session' }, 'runs:decide', { runId: RUN, requestId: REQ, decision: { behavior: 'allow', scope: 'session' } }],
    ['permission allow project', () => tray('permission', permission()), { kind: 'permission', act: 'allow-project' }, 'runs:decide', { runId: RUN, requestId: REQ, decision: { behavior: 'allow', scope: 'project' } }],
    ['permission deny default', () => tray('permission', permission()), { kind: 'permission', act: 'deny' }, 'runs:decide', { runId: RUN, requestId: REQ, decision: { behavior: 'deny', message: 'Denied by user' } }],
    ['permission deny blank', () => tray('permission', permission()), { kind: 'permission', act: 'deny', message: '   ' }, 'runs:decide', { runId: RUN, requestId: REQ, decision: { behavior: 'deny', message: 'Denied by user' } }],
    ['permission deny note', () => tray('permission', permission()), { kind: 'permission', act: 'deny', message: 'Use yarn' }, 'runs:decide', { runId: RUN, requestId: REQ, decision: { behavior: 'deny', message: 'Use yarn' } }],
    ['rules grant run', () => tray('rules', rules()), { kind: 'rules', act: 'grant-run' }, 'permissions:decideRequest', { runId: RUN, requestId: REQ, decision: { behavior: 'grant', scope: 'run' } }],
    ['rules grant project', () => tray('rules', rules()), { kind: 'rules', act: 'grant-project' }, 'permissions:decideRequest', { runId: RUN, requestId: REQ, decision: { behavior: 'grant', scope: 'project' } }],
    ['rules deny', () => tray('rules', rules()), { kind: 'rules', act: 'deny' }, 'permissions:decideRequest', { runId: RUN, requestId: REQ, decision: { behavior: 'deny' } }],
    ['rules deny message', () => tray('rules', rules()), { kind: 'rules', act: 'deny', message: 'too broad' }, 'permissions:decideRequest', { runId: RUN, requestId: REQ, decision: { behavior: 'deny', message: 'too broad' } }],
    ['proposal approve', () => tray('proposal', mcpProposal()), { kind: 'proposal', act: 'approve' }, 'setup:decide', { runId: RUN, proposalId: REQ, decision: { behavior: 'approve' } }],
    [
      'proposal approve secrets',
      () => tray('proposal', mcpProposal()),
      { kind: 'proposal', act: 'approve', secrets: { 'gh:env:GITHUB_TOKEN': 'tok', 'other:env:X': 'drop', 'gh:env:EMPTY': '' } },
      'setup:decide',
      { runId: RUN, proposalId: REQ, decision: { behavior: 'approve', secrets: { 'gh:env:GITHUB_TOKEN': 'tok' } } }
    ],
    ['proposal revise', () => tray('proposal', mcpProposal()), { kind: 'proposal', act: 'revise', feedback: 'fewer roles' }, 'setup:decide', { runId: RUN, proposalId: REQ, decision: { behavior: 'revise', feedback: 'fewer roles' } }],
    ['proposal decline', () => tray('proposal', mcpProposal()), { kind: 'proposal', act: 'decline' }, 'setup:decide', { runId: RUN, proposalId: REQ, decision: { behavior: 'decline' } }],
    ['proposal decline note', () => tray('proposal', mcpProposal()), { kind: 'proposal', act: 'decline', note: 'no' }, 'setup:decide', { runId: RUN, proposalId: REQ, decision: { behavior: 'decline', note: 'no' } }],
    ['question answer', () => tray('question', question()), { kind: 'question', act: 'answer', selected: ['SQLite'] }, 'setup:answer', { runId: RUN, questionId: REQ, answer: { selected: ['SQLite'] } }],
    ['question answer text', () => tray('question', question()), { kind: 'question', act: 'answer', selected: [], text: 'DuckDB' }, 'setup:answer', { runId: RUN, questionId: REQ, answer: { selected: [], text: 'DuckDB' } }],
    ['merge', () => tray('merge', merge()), { kind: 'merge', act: 'merge' }, 'merges:decide', { runId: RUN, reviewId: REQ, decision: { behavior: 'merge' } }],
    ['hold', () => tray('merge', merge()), { kind: 'merge', act: 'hold' }, 'merges:decide', { runId: RUN, reviewId: REQ, decision: { behavior: 'hold' } }],
    ['discard', () => tray('merge', merge()), { kind: 'merge', act: 'discard' }, 'merges:decide', { runId: RUN, reviewId: REQ, decision: { behavior: 'discard' } }],
    [
      'install allow run',
      () => tray('mcpInstall', install()),
      { kind: 'mcpInstall', act: 'allow-run', secrets: { API_KEY: 'k', NOPE: 'x' } },
      'mcp:answerInstall',
      { runId: RUN, requestId: REQ, decision: { approved: true, scope: 'run', secrets: { API_KEY: 'k' } } }
    ],
    ['install save project', () => tray('mcpInstall', install([])), { kind: 'mcpInstall', act: 'save-project' }, 'mcp:answerInstall', { runId: RUN, requestId: REQ, decision: { approved: true, scope: 'project' } }],
    ['install save library', () => tray('mcpInstall', install([])), { kind: 'mcpInstall', act: 'save-library', note: 'ok' }, 'mcp:answerInstall', { runId: RUN, requestId: REQ, decision: { approved: true, scope: 'library', note: 'ok' } }],
    ['install deny', () => tray('mcpInstall', install()), { kind: 'mcpInstall', act: 'deny' }, 'mcp:answerInstall', { runId: RUN, requestId: REQ, decision: { approved: false, scope: 'run' } }],
    ['install deny note', () => tray('mcpInstall', install()), { kind: 'mcpInstall', act: 'deny', note: 'not now' }, 'mcp:answerInstall', { runId: RUN, requestId: REQ, decision: { approved: false, scope: 'run', note: 'not now' } }]
  ]
  for (const [name, mk, action, channel, payload] of cases) {
    it(`${name} (revision 1 and 3)`, () => {
      for (const revision of [1, 3]) {
        const c = mk()
        const card = { ...c, ref: { ...c.ref, revision } } as TrayCard
        expect(decisionFor(card, action)).toEqual({ channel, payload: { ...(payload as object), expectedRevision: revision } })
      }
    })
  }

  it('refuses an action of another kind and a blank revise', () => {
    expect(() => decisionFor(tray('merge', merge()), { kind: 'permission', act: 'allow-once' })).toThrow()
    expect(() => decisionFor(tray('proposal', mcpProposal()), { kind: 'proposal', act: 'revise', feedback: ' ' })).toThrow()
  })
})

describe('bindingsFor', () => {
  const keys = (c: TrayCard): string[] => bindingsFor(c).map((b) => b.key)

  it('permission: y s a n with suggestions, a is two-step, n takes an optional note', () => {
    const bs = bindingsFor(tray('permission', permission()))
    expect(bs.map((b) => b.key)).toEqual(['y', 's', 'a', 'n', 'v'])
    expect(bs.find((b) => b.key === 'a')?.twoStep).toBe(true)
    expect(bs.find((b) => b.key === 'n')?.text).toBe('optional')
  })

  it('permission: only y and n under a reference folder or without suggestions', () => {
    expect(keys(tray('permission', permission({ referenceFolder: '/ref' })))).toEqual(['y', 'n', 'v'])
    expect(keys(tray('permission', permission({ suggestions: [], ruleLabels: [] })))).toEqual(['y', 'n', 'v'])
    expect(keys(tray('permission', permission({ suggestions: undefined })))).toEqual(['y', 'n', 'v'])
  })

  it('rules, merge and install keys', () => {
    expect(keys(tray('rules', rules()))).toEqual(['r', 'a', 'n'])
    expect(bindingsFor(tray('merge', merge())).filter((b) => b.twoStep).map((b) => b.key)).toEqual(['x'])
    expect(keys(tray('merge', merge()))).toEqual(['v', 'm', 'h', 'x'])
    expect(keys(tray('mcpInstall', install()))).toEqual(['r', 'p', 'l', 'n'])
    expect(bindingsFor(tray('mcpInstall', install())).filter((b) => b.twoStep).map((b) => b.key)).toEqual(['p', 'l'])
  })

  it('proposal: decline only on work runs, s only for mcpServers with secret slots', () => {
    expect(keys(tray('proposal', mcpProposal()))).toEqual(['y', 's', 'e', 'd', 'v'])
    expect(keys(tray('proposal', mcpProposal(), 1, { runKind: 'setup' }))).toEqual(['y', 's', 'e', 'v'])
    expect(keys(tray('proposal', mcpProposal(false)))).toEqual(['y', 'e', 'd', 'v'])
    const arch: Proposal = { id: REQ, runId: RUN, agentId: 'root', title: 'Arch', createdAt: 1, kind: 'architecture', payload: { summary: 's', stack: [], modules: [], conventions: [], commands: [], risks: [] } }
    expect(keys(tray('proposal', arch, 1, { runKind: 'setup' }))).toEqual(['y', 'e', 'v'])
    expect(bindingsFor(tray('proposal', mcpProposal())).find((b) => b.key === 'e')?.text).toBe('required')
  })

  it('question: digits, Space only for multiple, c only for free text', () => {
    expect(keys(tray('question', question()))).toEqual(['1', '2', 'enter', 'c'])
    expect(keys(tray('question', question({ allowMultiple: true, allowFreeText: false })))).toEqual(['1', '2', 'space', 'enter'])
  })

  it('secret slots: proposal keys use proposalSecretKey, duplicates dropped', () => {
    const p = mcpProposal()
    if (p.kind === 'mcpServers') p.payload.secrets?.push({ serverId: 'gh', kind: 'env', name: 'GITHUB_TOKEN' })
    expect(secretSlotsFor(tray('proposal', p)).map((s) => s.key)).toEqual(['gh:env:GITHUB_TOKEN'])
    expect(secretSlotsFor(tray('mcpInstall', install(['A', 'A', 'B']))).map((s) => s.key)).toEqual(['A', 'B'])
  })
})

describe('card text', () => {
  const ESC_OR_BIDI = /[\u001b\u009b‪-‮⁦-⁩​\u0007]/

  it('strips escapes and bidi from agent-provided strings and badges them', () => {
    const evil = 'rm -rf / \u001b]52;c;aGk=\u0007 ‮evil\u001b[2J'
    const cards: TrayCard[] = [
      tray('permission', permission({ input: { command: evil }, summary: evil })),
      tray('rules', rules({ rules: [evil], reason: evil })),
      tray('question', question({ question: evil, options: [{ label: evil, description: evil }] })),
      tray('merge', { ...merge(), branch: evil, agentName: evil, stat: evil, changedFiles: [evil] }),
      tray('mcpInstall', { ...install(), reason: evil, spec: { id: 's', name: evil, transport: 'stdio', command: evil, args: [evil], source: 'agent' } as never }),
      tray('proposal', { ...mcpProposal(), title: evil })
    ]
    for (const c of cards) {
      const lines = cardDetailLines(c, 60)
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) expect(l).not.toMatch(ESC_OR_BIDI)
      expect(lines[0]).toMatch(/hidden characters/)
      expect(cardTitle(c)).not.toMatch(ESC_OR_BIDI)
      expect(cardFullText(c)).not.toMatch(ESC_OR_BIDI)
    }
  })

  it('wraps to the width', () => {
    const lines = cardDetailLines(tray('permission', permission({ summary: 'word '.repeat(40) })), 30)
    for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(30)
    expect(wrapLine('abc', 30)).toEqual(['abc'])
  })

  it('permission: rule chips, a no-rule line, the reference folder', () => {
    expect(cardDetailLines(tray('permission', permission()), 100)).toContain('Rule: Bash(npm test:*)')
    const none = cardDetailLines(tray('permission', permission({ suggestions: [], ruleLabels: [] })), 200)
    expect(none.some((l) => l.startsWith('No rule can cover'))).toBe(true)
    const ref = cardDetailLines(tray('permission', permission({ referenceFolder: '/refs/brief' })), 200)
    expect(ref.some((l) => l.includes('Touches a reference folder'))).toBe(true)
    expect(ref.some((l) => l.startsWith('Rule:'))).toBe(false)
  })

  it('question options are numbered with descriptions; merge lists files; install shows the command', () => {
    expect(cardDetailLines(tray('question', question()), 100)).toEqual(expect.arrayContaining(['1. Postgres - server', '2. SQLite']))
    expect(cardDetailLines(tray('merge', merge()), 100)).toEqual(expect.arrayContaining(['Branch: worktree-agent-1', '  src/a.ts']))
    const inst = cardDetailLines(tray('mcpInstall', install()), 100)
    expect(inst).toEqual(expect.arrayContaining(['Runs: npx srv@1.0.0', 'Pinned version 1.0.0', 'Needs secrets: API_KEY']))
  })

  it('titles and the merge full text', () => {
    expect(cardTitle(tray('permission', permission()))).toBe('Run npm test')
    expect(cardTitle(tray('merge', merge()))).toBe("Merge impl's changes")
    expect(cardFullText(tray('merge', merge()))).toContain('+added\n-removed')
    const arch: Proposal = { id: REQ, runId: RUN, agentId: 'root', title: 'Arch', createdAt: 1, kind: 'architecture', payload: { summary: 's', stack: [], modules: [], conventions: [], commands: [], risks: [] } }
    expect(cardTitle(tray('proposal', arch, 1, { projectKind: 'engagement' }))).toBe('Approve engagement plan')
  })
})
