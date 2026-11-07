/**
 * Wave 0 gate (cli-spec 3.3(1), section 8): every OrgAIApi channel is covered by the JSON codec tables, the API types
 * hold nothing JSON cannot carry, and representative requests and responses survive JSON serialization.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, newProject } from '../../shared/defaults'
import {
  HOST_IPC,
  IPC,
  KIT_IPC,
  MCP_SCOPE_IPC,
  SECRETS_IPC,
  TEAM_FILES_IPC,
  OUTPUTS_IPC,
  type AppSettings,
  type DecisionOutcome,
  type KitBundleApplyInput,
  type KitImportPreview,
  type KnowledgeNodeSaveInput,
  type Project,
  type ProviderConnection,
  type RunRecord,
  type RunsSubscribeInput,
  type RunsSubscribeResult,
  type RunSummary,
  type SkillBundleInput
} from '../../shared/types'
import { CHANNEL_JSON_FIELDS, decodeRequest, encodeRequest, parseJsonSafe, PUSH_CHANNELS, requestChannels, stringifyJson } from './jsonCodec'

/** Request over the wire: encode, JSON (safe parse on the host), decode. */
function overWire(channel: string, args: unknown[]): unknown[] {
  return decodeRequest(channel, parseJsonSafe(stringifyJson(encodeRequest(channel, args))) as unknown[])
}

/** Drop undefined-valued keys at every depth (what JSON does to a response). */
function dropUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropUndefined)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = dropUndefined(x)
    return out
  }
  return v
}

describe('(a) completeness', () => {
  const existing: string[] = [...Object.values(IPC), ...Object.values(MCP_SCOPE_IPC), ...Object.values(KIT_IPC), ...Object.values(TEAM_FILES_IPC), ...Object.values(OUTPUTS_IPC)]
  // HOST_IPC (socket only) and SECRETS_IPC (Wave 7, every surface): channels added for the host.
  const host: string[] = [...Object.values(HOST_IPC), ...Object.values(SECRETS_IPC)]

  it('matches the spec counts: 191 existing channels (177 request + 14 push) plus 6 HOST_IPC and 5 SECRETS_IPC', () => {
    const push = new Set(PUSH_CHANNELS)
    expect(new Set(existing).size).toBe(existing.length)
    expect(existing.length).toBe(191)
    expect(existing.filter((c) => push.has(c)).length).toBe(14)
    expect(existing.filter((c) => !push.has(c)).length).toBe(177)
    expect(Object.values(HOST_IPC).length).toBe(6)
    expect(Object.values(SECRETS_IPC).length).toBe(5)
    expect(requestChannels().length).toBe(188)
  })

  it('every channel is either in CHANNEL_JSON_FIELDS or a push channel, never both', () => {
    const push = new Set(PUSH_CHANNELS)
    for (const ch of [...existing, ...host]) {
      const inTable = Object.hasOwn(CHANNEL_JSON_FIELDS, ch)
      expect(inTable !== push.has(ch), ch).toBe(true)
    }
    for (const p of PUSH_CHANNELS) expect(existing, p).toContain(p)
  })

  it('has no unknown table keys', () => {
    const known = new Set([...existing, ...host])
    for (const key of Object.keys(CHANNEL_JSON_FIELDS)) expect(known.has(key), key).toBe(true)
  })
})

describe('(b) JSON-safety scan of OrgAIApi', () => {
  const source = readFileSync(join(__dirname, '../../shared/types.ts'), 'utf8')
  // Comments mention words like "Date" in prose; scan code only.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1')

  /** The balanced `{ ... }` block starting at the first '{' at or after `from`. */
  function blockAt(text: string, from: number): string {
    const open = text.indexOf('{', from)
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1)
    }
    throw new Error('Unbalanced block')
  }

  /** The declaration of an exported interface or type alias named `name`, or undefined. */
  function declarationOf(name: string): string | undefined {
    const iface = new RegExp(`export interface ${name}\\b[^{]*`).exec(code)
    if (iface) return blockAt(code, iface.index)
    const alias = new RegExp(`export type ${name}\\b[^=]*=`).exec(code)
    if (!alias) return undefined
    // A type alias runs until the next top-level export.
    const rest = code.slice(alias.index)
    const end = rest.slice(1).search(/\nexport /)
    return end === -1 ? rest : rest.slice(0, end + 1)
  }

  const apiBlocks: string[] = []
  for (const m of code.matchAll(/export interface OrgAIApi\b/g)) apiBlocks.push(blockAt(code, m.index))

  const named = new Set<string>()
  for (const block of apiBlocks) for (const m of block.matchAll(/\b([A-Z][A-Za-z0-9]+)\b/g)) named.add(m[1])
  const builtins = new Set(['Promise', 'Record', 'Partial', 'Pick', 'Omit', 'Readonly', 'Required', 'Array'])
  const declarations = [...named].filter((n) => !builtins.has(n)).map((n) => [n, declarationOf(n)] as const)

  const FORBIDDEN = /\b(?:Map|Set|ReadonlyMap|ReadonlySet|WeakMap|WeakSet)<|\bDate\b|\bUint8Array\b|\bArrayBuffer\b|\bBuffer\b|\bbigint\b/

  it('finds the OrgAIApi blocks and the types they name', () => {
    expect(apiBlocks.length).toBeGreaterThanOrEqual(5)
    expect(declarations.filter(([, d]) => d !== undefined).length).toBeGreaterThan(50)
    // Every name an OrgAIApi block uses resolves to an exported declaration.
    expect(declarations.filter(([, d]) => d === undefined).map(([n]) => n)).toEqual([])
  })

  it('the forbidden pattern catches each non-JSON type', () => {
    for (const bad of ['Map<string, X>', 'ReadonlySet<string>', 'at: Date', 'b: Uint8Array', 'b: ArrayBuffer', 'b: Buffer', 'n: bigint']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['updatedAt: number', 'mapping: string', 'Settings', 'rawBytesBase64: string']) expect(FORBIDDEN.test(ok), ok).toBe(false)
  })

  it('no OrgAIApi block mentions Map, Set, Date, Uint8Array, ArrayBuffer, Buffer or bigint', () => {
    for (const block of apiBlocks) expect(FORBIDDEN.exec(block)?.[0] ?? null).toBeNull()
  })

  it('no request / response type the API names (one level deep) mentions them either', () => {
    const offenders = declarations.filter(([, d]) => d !== undefined && FORBIDDEN.test(d)).map(([n, d]) => `${n}: ${FORBIDDEN.exec(d!)?.[0]}`)
    expect(offenders).toEqual([])
  })
})

describe('(c) representative round trips', () => {
  it('settings:set clearing defaultMaxBudgetUsd (the spec names defaultProjectDir, which AppSettings no longer has)', () => {
    const args = [{ ...DEFAULT_APP_SETTINGS, defaultMaxBudgetUsd: undefined, quickRunModel: undefined } satisfies AppSettings]
    const back = overWire(IPC.settingsSet, args)
    expect(back).toEqual(args)
    expect(Object.hasOwn(back[0] as object, 'defaultMaxBudgetUsd')).toBe(true)
    expect((back[0] as AppSettings).defaultMaxBudgetUsd).toBeUndefined()
    expect(Object.hasOwn(back[0] as object, 'quickRunModel')).toBe(true)
  })

  it('projects:save clearing maxBudgetUsd, permissionMode and the automatic limits (spec defaultTier / worktreeSetupCommand do not exist)', () => {
    const base = newProject({ name: 'P', path: '/tmp/p', brief: 'b' })
    const args = [
      {
        ...base,
        maxBudgetUsd: undefined,
        permissionMode: undefined as unknown as Project['permissionMode'],
        maxSubagentDepth: undefined,
        maxConcurrentSubagents: undefined,
        preferEverydayNearLimit: undefined,
        client: undefined
      } satisfies Project
    ]
    const back = overWire(IPC.projectsSave, args)
    expect(back).toEqual(args)
    for (const k of ['maxBudgetUsd', 'permissionMode', 'maxSubagentDepth', 'maxConcurrentSubagents', 'preferEverydayNearLimit', 'client']) {
      expect(Object.hasOwn(back[0] as object, k), k).toBe(true)
      expect((back[0] as Record<string, unknown>)[k], k).toBeUndefined()
    }
    const roles = (back[0] as Project).roles
    expect(roles.length).toBeGreaterThan(0)
    expect(roles.find((r) => r.reportsTo === null)).toBeTruthy()
  })

  it('connections:update clearing a proxy openaiBaseUrl and a tier model', () => {
    const conn: ProviderConnection = {
      id: 'proxy-0a1b2c3d',
      name: 'Gateway',
      kind: 'litellm',
      enabled: true,
      anthropicBaseUrl: 'https://example.com',
      openaiBaseUrl: undefined,
      hasApiKey: false,
      tierModels: { deep: 'm', top: undefined }
    } as ProviderConnection
    const args = [conn]
    const back = overWire(IPC.connectionsUpdate, args)
    expect(back).toEqual(args)
    expect(Object.hasOwn(back[0] as object, 'openaiBaseUrl')).toBe(true)
    expect(Object.hasOwn((back[0] as { tierModels: object }).tierModels, 'top')).toBe(true)
  })

  it('connections:setDefault(null)', () => {
    const back = overWire(IPC.connectionsSetDefault, [null])
    expect(back).toEqual([null])
    expect(back[0]).toBeNull()
  })

  it('knowledge:saveNode with appendFacts and expectedUpdatedAt', () => {
    const input: KnowledgeNodeSaveInput = {
      projectId: 'p1',
      nodeId: 'kn_abc',
      kind: 'person',
      name: 'Jane Doe',
      appendFacts: ['Works at Acme', 'Prefers email'],
      expectedUpdatedAt: 1_700_000_000_000
    }
    expect(overWire(IPC.knowledgeSaveNode, [input])).toEqual([input])
  })

  it('kit:applyBundle', () => {
    const input: KitBundleApplyInput = {
      rawBytesBase64: Buffer.from('{"format":"orgai.kit/1"}').toString('base64'),
      digest: 'a'.repeat(64),
      targetDigest: 'b'.repeat(64),
      choices: [{ key: 'skill:0', action: 'add' }]
    }
    expect(overWire(HOST_IPC.kitApplyBundle, [input])).toEqual([input])
  })

  it('skillLibrary:addFromBundle', () => {
    const input: SkillBundleInput = {
      name: 'code-review',
      files: [
        { relPath: 'SKILL.md', base64: Buffer.from('---\nname: code-review\n---\nBody').toString('base64') },
        { relPath: 'scripts/check.sh', base64: Buffer.from('echo hi').toString('base64') }
      ]
    }
    expect(overWire(HOST_IPC.skillLibraryAddFromBundle, [input])).toEqual([input])
  })

  it('runs:subscribe input', () => {
    const input: RunsSubscribeInput = { projectIds: ['p1'], runIds: ['r1'], includeActiveRunRecord: 'r1', followChains: true, sinceSeq: 42, filterKey: 'k', hostInstanceId: 'abcdef012345' }
    expect(overWire(HOST_IPC.runsSubscribe, [input])).toEqual([input])
  })

  describe('responses', () => {
    const summary: RunSummary = {
      id: 'run_1',
      projectId: 'p1',
      kind: 'work',
      prompt: 'Do it',
      status: 'finished',
      startedAt: 1,
      endedAt: 2,
      totalCostUsd: 0.5,
      endedBy: 'budget',
      execOutcome: 'budget-exceeded',
      overrides: { execMode: true, execChainId: 'chain_1', maxBudgetUsd: 1, decisionPolicy: { permission: 'deny', rules: 'deny', mcpInstall: 'deny', question: 'fail', proposal: 'decline', merge: 'hold' } }
    }
    const record: RunRecord = {
      summary,
      agents: {},
      transcript: [
        { id: 't1', agentId: 'root', at: 1, block: { kind: 'user', text: 'Look', images: [{ mediaType: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64'), name: 'a.png' }] } },
        { id: 't2', agentId: 'root', at: 2, block: { kind: 'tool_use', id: 'tu', name: 'Read', input: { path: '/x', nested: [1, null] } } }
      ],
      logs: [{ at: 1, level: 'info', message: 'ok' }]
    }
    const project: Project = newProject({ name: 'P', path: '/tmp/p', brief: 'b' })
    const preview: KitImportPreview = {
      path: '',
      fileName: 'team.orgai-kit.json',
      digest: 'c'.repeat(64),
      bytes: 10,
      items: [{ key: 'skill:0', kind: 'skill', name: 'x', status: 'new', action: 'add', canReplace: true, size: 5, notes: [] }],
      notes: [],
      targetDigest: 'd'.repeat(64)
    }
    const outcome: DecisionOutcome = { status: 'applied', runId: 'run_1', requestId: 'req', effectiveDecision: 'deny', decidedBy: { surface: 'policy' } }
    const snapshot: RunsSubscribeResult = {
      mode: 'snapshot',
      hostInstanceId: 'abcdef012345',
      seq: 3,
      filterKey: 'k',
      snapshot: {
        liveRuns: [summary],
        pendingCards: { run_1: { permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] } },
        activeRun: record,
        recentEndedRuns: []
      }
    }
    const replay: RunsSubscribeResult = {
      mode: 'replay',
      hostInstanceId: 'abcdef012345',
      fromSeq: 1,
      toSeq: 2,
      filterKey: 'k',
      events: [{ seq: 2, event: { type: 'run.status', runId: 'run_1', status: 'finished', endedBy: 'budget' } as never }]
    }
    const fixtures: [string, unknown][] = [
      ['RunRecord with a base64 image', record],
      ['Project with roles', project],
      ['AppSettings', DEFAULT_APP_SETTINGS],
      ['KitImportPreview with targetDigest', preview],
      ['DecisionOutcome', outcome],
      ['RunSummary with overrides / execOutcome / endedBy budget', summary],
      ['RunsSubscribeResult snapshot', snapshot],
      ['RunsSubscribeResult replay', replay]
    ]

    it.each(fixtures)('%s survives JSON', (_name, value) => {
      expect(parseJsonSafe(stringifyJson(value))).toEqual(dropUndefined(value))
      expect(JSON.parse(JSON.stringify(value))).toStrictEqual(dropUndefined(value))
    })

    it('the project fixture has roles', () => {
      expect(project.roles.length).toBeGreaterThan(0)
    })
  })
})
