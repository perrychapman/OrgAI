/**
 * `orgai knowledge` (cli-spec 6.3, Wave 5): an engagement's knowledge graph (types.ts "Engagement knowledge graph").
 * Engagements only: a code project is exit 2.
 *
 * `upsert --fact` on an existing item is an append-only save (cli-spec 3.6 item 3): `{ nodeId, appendFacts,
 * expectedUpdatedAt }` with no client-side read-modify-write of the facts list; the host appends atomically and
 * deduplicates. On stale_revision the CLI re-reads and retries (at most 3 times) unless the user pinned the revision
 * with --if-updated-at, which is then exit 1 "The item changed since <time>; read it again".
 *
 * Items are named by id (kn_ / ke_ / kf_), `kind:name`, or a name (or alias) that matches one item. Every item text is
 * untrusted (agents write it) and is sanitized before printing. Exit codes: 2 usage (unknown or ambiguous item, bad
 * kind), 1 refusals and stale writes.
 */
import {
  KNOWLEDGE_SEARCH_LIMIT,
  type HostScope,
  type KnowledgeEdge,
  type KnowledgeEdgeSaveInput,
  type KnowledgeFactInput,
  type KnowledgeGraph,
  type KnowledgeNode,
  type KnowledgeNodeSaveInput,
  type KnowledgeSource,
  type Project
} from '../../shared/types'
import { knowledgeEdgesOf, knowledgeNameKey, matchKnowledgeNodes, normalizeKnowledgeKey, resolveKnowledgeNode, searchKnowledge } from '../../shared/knowledge'
import { clearCountsLine, kindOrder } from '../../shared/view/knowledge'
import { formatDateTime } from '../../shared/view/dates'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireEngagement, requireProject, runSubcommands, withHost, type SubcommandFn } from '../manage'
import { emit, plural, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostCallError, type HostClient } from '../types'
import { changeError, hostChange } from './skills'

export const KNOWLEDGE_USAGE =
  'knowledge list [--kind <k>] [--retired] [--origin user|agent] | search <query> [--limit <n>] [--kind <k>] [--retired] | show <item> | upsert --kind <k> --name <n> [--alias <a>]... [--summary <s>] [--fact <text>]... [--if-updated-at <ms>] | link <a> <relation> <b> [--note <text>] | unlink <edge-id | a relation b> | retire <item> | restore <item> | remove <item> [--yes] | clear [--yes]'

const READ: HostScope[] = ['read']
const CONFIGURE: HostScope[] = ['read', 'configure']
/** Re-reads after a stale_revision of an unpinned upsert. */
export const UPSERT_RETRIES = 3
/** The graph may be large (knowledge:get is a bulk channel). */
const GRAPH_TIMEOUT_MS = 120_000

const usage = (m: string): CliError => new CliError(m, EXIT.usage)
const q = (s: string): string => `"${safeLine(s).slice(0, 80)}"`

async function engagement(ctx: CliContext, client: HostClient): Promise<Project> {
  const project = await requireProject(ctx, client)
  requireEngagement(project, 'the knowledge graph')
  return project
}

const getGraph = (client: HostClient, projectId: string): Promise<KnowledgeGraph> => hostCall<KnowledgeGraph>(client, 'knowledge:get', [projectId], { timeoutMs: GRAPH_TIMEOUT_MS })

/** True for a host error with this code. */
const isCode = (e: unknown, code: string): boolean => (e as Partial<HostCallError> | undefined)?.data?.code === code

function one(p: string[], what: string): string {
  if (p.length === 0) throw usage(`Missing ${what}.`)
  if (p.length > 1) throw usage(`Unexpected argument "${safeLine(p[1]).slice(0, 64)}". Quote names with spaces.`)
  return p[0]
}

function kindArg(raw: string): string {
  const k = normalizeKnowledgeKey(raw)
  if (!k) throw usage(`${q(raw)} is not a valid kind or relation (letters, digits and dashes, at most 40).`)
  return k
}

/** A node by id, `kind:name` or a name / alias that matches exactly one node. Exit 2 when none or several. */
export function findNode(graph: KnowledgeGraph, ref: string): KnowledgeNode {
  const colon = ref.indexOf(':')
  if (colon > 0 && !ref.startsWith('kn_')) {
    const kind = normalizeKnowledgeKey(ref.slice(0, colon))
    const name = ref.slice(colon + 1)
    if (kind && name.trim()) {
      const hits = matchKnowledgeNodes(graph, name, kind)
      if (hits.length === 1) return hits[0]
      if (hits.length > 1) throw usage(`${q(ref)} names ${hits.length} items: ${hits.map((n) => n.id).join(', ')}.`)
    }
  }
  const r = resolveKnowledgeNode(graph, ref)
  if (r && 'node' in r) return r.node
  if (r && 'candidates' in r) throw usage(`${q(ref)} names ${r.candidates.length} items: ${r.candidates.map((n) => `${n.kind}:${safeLine(n.name)} (${n.id})`).join(', ')}. Use kind:name or the id.`)
  throw usage(`No item ${q(ref)} in the knowledge graph. See \`orgai knowledge list\`.`)
}

type Target = { type: 'node'; node: KnowledgeNode } | { type: 'edge'; edge: KnowledgeEdge } | { type: 'fact'; node: KnowledgeNode; factId: string }

/** An item named by a ke_ / kf_ id, an `a relation b` triple, or a node reference. */
export function findTarget(graph: KnowledgeGraph, refs: string[]): Target {
  if (refs.length === 3) return { type: 'edge', edge: findEdge(graph, refs) }
  const ref = one(refs, 'the item')
  if (ref.startsWith('ke_')) {
    const edge = graph.edges.find((e) => e.id === ref)
    if (!edge) throw usage(`No relation ${q(ref)} in the knowledge graph.`)
    return { type: 'edge', edge }
  }
  if (ref.startsWith('kf_')) {
    const node = graph.nodes.find((n) => n.facts.some((f) => f.id === ref))
    if (!node) throw usage(`No fact ${q(ref)} in the knowledge graph.`)
    return { type: 'fact', node, factId: ref }
  }
  return { type: 'node', node: findNode(graph, ref) }
}

function findEdge(graph: KnowledgeGraph, [a, rel, b]: string[]): KnowledgeEdge {
  const from = findNode(graph, a)
  const to = findNode(graph, b)
  const relation = kindArg(rel)
  const edge = graph.edges.find((e) => e.from === from.id && e.to === to.id && e.relation === relation)
  if (!edge) throw usage(`No relation ${safeLine(from.name)} ${relation} ${safeLine(to.name)}.`)
  return edge
}

const sourceText = (s: KnowledgeSource | undefined): string =>
  !s ? '' : s.by === 'user' ? `you, ${formatDateTime(s.at)}` : `${safeLine(s.role ?? 'an agent')}${s.runId ? ` in ${safeLine(s.runId)}` : ''}, ${formatDateTime(s.at)}`

const nodeName = (graph: KnowledgeGraph, id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? id

const nodeJson = (n: KnowledgeNode): Json => n as unknown as Json

// ---------- reads ----------

const list: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { kind: { type: 'string' }, retired: { type: 'boolean' }, origin: { type: 'string' } })
  if (positionals.length) throw usage(`Unexpected argument ${q(positionals[0])}.`)
  if (values.origin !== undefined && values.origin !== 'user' && values.origin !== 'agent') throw usage('--origin must be user or agent.')
  const kind = values.kind === undefined ? undefined : kindArg(values.kind)
  return withHost(ctx, READ, async (client) => {
    const project = await engagement(ctx, client)
    const graph = await getGraph(client, project.id)
    const order = kindOrder(graph.nodes.map((n) => n.kind))
    const nodes = graph.nodes
      .filter((n) => (values.retired || !n.retired) && (kind === undefined || n.kind === kind) && (values.origin === undefined || n.source.by === values.origin))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.createdAt - b.createdAt)
    emit(ctx, { project: { id: project.id, name: project.name }, nodes: nodes.map(nodeJson), total: graph.nodes.length }, () => {
      if (nodes.length === 0) return [graph.nodes.length ? 'No items match.' : `Nothing recorded yet in ${safeLine(project.name)}.`]
      const st = styleFor(ctx)
      return [
        ...table(
          [{ header: 'KIND', min: 4 }, { header: 'NAME', flex: true, min: 8 }, { header: 'BY', min: 3 }, { header: 'FACTS', align: 'right', min: 5 }, { header: 'ID', min: 6 }],
          nodes.map((n) => [n.kind, `${safeLine(n.name)}${n.retired ? ' (retired)' : ''}`, n.source.by === 'user' ? 'you' : safeLine(n.source.role ?? 'agent'), String(n.facts.filter((f) => !f.retired).length), n.id]),
          termWidth(ctx),
          st
        ),
        st.dim(`${nodes.length} of ${plural(graph.nodes.length, 'item')}`)
      ]
    })
    return EXIT.ok
  })
}

const search: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { limit: { type: 'string', short: 'n' }, kind: { type: 'string' }, retired: { type: 'boolean' } })
  const query = one(positionals, 'the search text')
  let limit: number | undefined
  if (values.limit !== undefined) {
    limit = Number(values.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > KNOWLEDGE_SEARCH_LIMIT) throw usage(`--limit must be a whole number from 1 to ${KNOWLEDGE_SEARCH_LIMIT}.`)
  }
  const kind = values.kind === undefined ? undefined : kindArg(values.kind)
  return withHost(ctx, READ, async (client) => {
    const project = await engagement(ctx, client)
    const graph = await getGraph(client, project.id)
    const hits = searchKnowledge(graph, { query, ...(kind ? { kind } : {}), ...(limit ? { limit } : {}), includeRetired: !!values.retired })
    emit(ctx, { query, hits: hits.map((h) => ({ node: nodeJson(h.node), nameHit: h.nameHit, edgeCount: h.edgeCount })) }, () => {
      if (hits.length === 0) return [`Nothing matches ${q(query)}.`]
      return table(
        [{ header: 'KIND', min: 4 }, { header: 'NAME', flex: true, min: 8 }, { header: 'RELATIONS', align: 'right', min: 4 }, { header: 'ID', min: 6 }],
        hits.map((h) => [h.node.kind, `${safeLine(h.node.name)}${h.node.retired ? ' (retired)' : ''}`, String(h.edgeCount), h.node.id]),
        termWidth(ctx),
        styleFor(ctx)
      )
    })
    return EXIT.ok
  })
}

function showLines(ctx: CliContext, graph: KnowledgeGraph, n: KnowledgeNode): string[] {
  const st = styleFor(ctx)
  const lines = [`${st.bold(safeLine(n.name))}  ${n.kind}  ${n.id}${n.retired ? '  (retired)' : ''}`]
  if (n.aliases?.length) lines.push(`Also known as: ${n.aliases.map(safeLine).join(', ')}`)
  if (n.summary) lines.push('', safeLine(n.summary))
  const facts = n.facts
  lines.push('', `Facts (${facts.filter((f) => !f.retired).length}):`)
  for (const f of facts) lines.push(`  - ${safeLine(f.text)}${f.retired ? ' (retired)' : ''}  ${st.dim(`${f.id}, ${sourceText(f.source)}`)}`)
  const edges = knowledgeEdgesOf(graph, n.id)
  if (edges.length) {
    lines.push('', 'Relations:')
    for (const e of edges) lines.push(`  ${safeLine(nodeName(graph, e.from))} ${e.relation} ${safeLine(nodeName(graph, e.to))}${e.note ? `: ${safeLine(e.note)}` : ''}${e.retired ? ' (retired)' : ''}  ${st.dim(e.id)}`)
  }
  lines.push('', st.dim(`Recorded by ${sourceText(n.source)}${n.updatedBy ? `; last changed by ${sourceText(n.updatedBy)}` : ''}. Revision ${n.updatedAt}.`))
  return lines
}

const show: SubcommandFn = async (ctx, args) => {
  const ref = one(parseFlags(args, {}).positionals, 'the item (id, kind:name or name)')
  return withHost(ctx, READ, async (client) => {
    const project = await engagement(ctx, client)
    const graph = await getGraph(client, project.id)
    const n = findNode(graph, ref)
    emit(ctx, { node: nodeJson(n), edges: knowledgeEdgesOf(graph, n.id) as unknown as Json[] }, () => showLines(ctx, graph, n))
    return EXIT.ok
  })
}

// ---------- writes ----------

const upsert: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    kind: { type: 'string' },
    name: { type: 'string' },
    alias: { type: 'string', multiple: true },
    summary: { type: 'string' },
    fact: { type: 'string', multiple: true },
    'if-updated-at': { type: 'string' }
  })
  if (positionals.length) throw usage(`Unexpected argument ${q(positionals[0])}.`)
  if (!values.kind) throw usage('knowledge upsert needs --kind.')
  if (!values.name?.trim()) throw usage('knowledge upsert needs --name.')
  const kind = kindArg(values.kind)
  const name = values.name
  let pinned: number | undefined
  if (values['if-updated-at'] !== undefined) {
    pinned = Number(values['if-updated-at'])
    if (!Number.isFinite(pinned) || pinned <= 0) throw usage('--if-updated-at needs the item revision (the epoch ms `orgai knowledge show` prints).')
  }
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    for (let attempt = 0; ; attempt++) {
      const graph = await getGraph(client, project.id)
      const hits = matchKnowledgeNodes(graph, name, kind)
      if (hits.length > 1) throw usage(`${kind}:${q(name)} names ${hits.length} items: ${hits.map((n) => n.id).join(', ')}.`)
      const existing = hits[0]
      let input: KnowledgeNodeSaveInput
      if (!existing) {
        if (pinned !== undefined) throw new CliError(`${kind}:${q(name)} does not exist (any more); read it again.`, EXIT.failure)
        input = {
          projectId: project.id,
          kind,
          name,
          ...(values.alias?.length ? { aliases: values.alias } : {}),
          ...(values.summary !== undefined ? { summary: values.summary } : {}),
          ...(values.fact?.length ? { appendFacts: values.fact } : {})
        }
      } else {
        input = { projectId: project.id, nodeId: existing.id, expectedUpdatedAt: pinned ?? existing.updatedAt }
        if (values.fact?.length) input.appendFacts = values.fact
        if (values.summary !== undefined && values.summary !== existing.summary) input.summary = values.summary
        if (values.alias?.length) {
          const have = existing.aliases ?? []
          const keys = new Set([existing.name, ...have].map(knowledgeNameKey))
          const add = values.alias.filter((a) => !keys.has(knowledgeNameKey(a)))
          if (add.length) input.aliases = [...have, ...add]
        }
        if (input.appendFacts === undefined && input.summary === undefined && input.aliases === undefined) {
          emit(ctx, { node: nodeJson(existing), created: false, changed: false }, () => `${safeLine(existing.name)} is already recorded with that (${existing.id}).`)
          return EXIT.ok
        }
      }
      try {
        const node = await client.call<KnowledgeNode>('knowledge:saveNode', [input])
        const created = !existing
        emit(ctx, { node: nodeJson(node), created, changed: true, attempts: attempt + 1 }, () => `${created ? 'Recorded' : 'Updated'} ${node.kind} ${safeLine(node.name)} (${node.id}).`)
        return EXIT.ok
      } catch (e) {
        if (!isCode(e, 'stale_revision')) throw changeError(e)
        if (pinned !== undefined) throw new CliError(`The item changed since ${formatDateTime(pinned)}; read it again.`, EXIT.failure)
        if (attempt >= UPSERT_RETRIES) throw new CliError(`${safeLine(name)} kept changing while it was saved; try again.`, EXIT.failure)
      }
    }
  })
}

const link: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { note: { type: 'string' } })
  if (positionals.length !== 3) throw usage('knowledge link needs <a> <relation> <b>.')
  const relation = kindArg(positionals[1])
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    const graph = await getGraph(client, project.id)
    const from = findNode(graph, positionals[0])
    const to = findNode(graph, positionals[2])
    const input: KnowledgeEdgeSaveInput = { projectId: project.id, from: from.id, to: to.id, relation, ...(values.note !== undefined ? { note: values.note } : {}) }
    const edge = await hostChange<KnowledgeEdge>(client, 'knowledge:saveEdge', [input])
    emit(ctx, { edge: edge as unknown as Json }, () => `Linked ${safeLine(from.name)} ${relation} ${safeLine(to.name)} (${edge.id}).`)
    return EXIT.ok
  })
}

const unlink: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  if (positionals.length !== 1 && positionals.length !== 3) throw usage('knowledge unlink needs <edge-id> or <a> <relation> <b>.')
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    const graph = await getGraph(client, project.id)
    const t = findTarget(graph, positionals)
    if (t.type !== 'edge') throw usage('knowledge unlink takes a relation (ke_ id or <a> <relation> <b>); use `knowledge remove` for an item.')
    await hostChange<KnowledgeGraph>(client, 'knowledge:removeEdge', [{ projectId: project.id, edgeId: t.edge.id }])
    emit(ctx, { removed: t.edge.id }, () => `Removed ${safeLine(nodeName(graph, t.edge.from))} ${t.edge.relation} ${safeLine(nodeName(graph, t.edge.to))}.`)
    return EXIT.ok
  })
}

/** retire / restore: the retired flag on a node, a relation or one fact (a fact goes through the node's facts list under expectedUpdatedAt). */
function setRetired(retired: boolean): SubcommandFn {
  return async (ctx, args) => {
    const { positionals } = parseFlags(args, {})
    return withHost(ctx, CONFIGURE, async (client) => {
      const project = await engagement(ctx, client)
      const graph = await getGraph(client, project.id)
      const t = findTarget(graph, positionals)
      const verb = retired ? 'Retired' : 'Restored'
      if (t.type === 'node') {
        const node = await hostChange<KnowledgeNode>(client, 'knowledge:saveNode', [{ projectId: project.id, nodeId: t.node.id, retired }])
        emit(ctx, { node: nodeJson(node) }, () => `${verb} ${node.kind} ${safeLine(node.name)}.`)
      } else if (t.type === 'edge') {
        const e = t.edge
        const edge = await hostChange<KnowledgeEdge>(client, 'knowledge:saveEdge', [{ projectId: project.id, edgeId: e.id, from: e.from, to: e.to, relation: e.relation, retired }])
        emit(ctx, { edge: edge as unknown as Json }, () => `${verb} ${safeLine(nodeName(graph, e.from))} ${e.relation} ${safeLine(nodeName(graph, e.to))}.`)
      } else {
        const facts: KnowledgeFactInput[] = t.node.facts.map((f) => ({ id: f.id, text: f.text, retired: f.id === t.factId ? retired : !!f.retired }))
        try {
          const node = await client.call<KnowledgeNode>('knowledge:saveNode', [{ projectId: project.id, nodeId: t.node.id, facts, expectedUpdatedAt: t.node.updatedAt }])
          const text = node.facts.find((f) => f.id === t.factId)?.text ?? t.factId
          emit(ctx, { node: nodeJson(node), factId: t.factId }, () => `${verb} the fact "${safeLine(text).slice(0, 80)}" on ${safeLine(node.name)}.`)
        } catch (e) {
          if (isCode(e, 'stale_revision')) throw new CliError(`${safeLine(t.node.name)} changed since it was read; run the command again.`, EXIT.failure)
          throw changeError(e)
        }
      }
      return EXIT.ok
    })
  }
}

const remove: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    const graph = await getGraph(client, project.id)
    const t = findTarget(graph, positionals)
    if (t.type === 'fact') throw usage('knowledge remove takes an item or a relation; retire a fact with `knowledge retire <fact-id>`.')
    if (t.type === 'node') {
      const edges = knowledgeEdgesOf(graph, t.node.id).length
      if (!(await confirm(ctx, `Delete ${t.node.kind} ${safeLine(t.node.name)}${edges ? ` and its ${plural(edges, 'relation')}` : ''}? Retire keeps a record instead.`, !!values.yes))) return declined(ctx)
      await hostChange<KnowledgeGraph>(client, 'knowledge:removeNode', [{ projectId: project.id, nodeId: t.node.id }])
      emit(ctx, { removed: t.node.id, edgesRemoved: edges }, () => `Deleted ${safeLine(t.node.name)}.`)
    } else {
      const label = `${safeLine(nodeName(graph, t.edge.from))} ${t.edge.relation} ${safeLine(nodeName(graph, t.edge.to))}`
      if (!(await confirm(ctx, `Delete the relation ${label}?`, !!values.yes))) return declined(ctx)
      await hostChange<KnowledgeGraph>(client, 'knowledge:removeEdge', [{ projectId: project.id, edgeId: t.edge.id }])
      emit(ctx, { removed: t.edge.id }, () => `Deleted ${label}.`)
    }
    return EXIT.ok
  })
}

function declined(ctx: CliContext): number {
  emit(ctx, { cancelled: true }, () => 'Cancelled.')
  return EXIT.failure
}

const clear: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  if (positionals.length) throw usage(`Unexpected argument ${q(positionals[0])}.`)
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    const graph = await getGraph(client, project.id)
    const counts = clearCountsLine(graph)
    if (!(await confirm(ctx, `Delete everything in the knowledge graph of ${safeLine(project.name)}: ${counts}? Context notes stay.`, !!values.yes))) return declined(ctx)
    await hostChange<KnowledgeGraph>(client, 'knowledge:clear', [project.id])
    emit(ctx, { cleared: true, counts: { nodes: graph.nodes.length, edges: graph.edges.length, facts: graph.nodes.reduce((s, n) => s + n.facts.length, 0) } }, () => `Deleted ${counts}.`)
    return EXIT.ok
  })
}

export const runKnowledge: CommandFn = (ctx, args) =>
  runSubcommands(
    ctx,
    args,
    { list, search, show, upsert, link, unlink, retire: setRetired(true), restore: setRetired(false), remove, clear },
    KNOWLEDGE_USAGE
  )
