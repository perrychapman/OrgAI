import type { TeamDoc, TeamFile, TeamRoleDoc } from './doc'

/** Test fixtures for the team files modules (not used by production code). */

export function role(slug: string, over: Partial<TeamRoleDoc> = {}): TeamRoleDoc {
  return {
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    description: `Does ${slug} work.`,
    responsibilities: [],
    prompt: `You are the ${slug}.`,
    tools: ['Glob', 'Grep', 'Read'],
    tier: 'everyday',
    canSpawn: false,
    spawnable: [],
    reportsTo: 'lead',
    color: '#2bb0ff',
    skills: [],
    mcpServers: [],
    ...over
  }
}

export function sampleDoc(): TeamDoc {
  return {
    settings: {
      brief: 'A small web app.\nSecond line.',
      permissionMode: 'default',
      maxBudgetUsd: 5,
      isolateWriters: true,
      teamReview: { auto: 'ai', tokenBudget: 20000, everyRuns: 3 }
    },
    roles: [
      role('lead', { reportsTo: null, canSpawn: true, spawnable: ['dev', 'reviewer'], tier: 'deep', tools: ['Glob', 'Grep', 'Read', 'SendMessage'], effort: 'high', color: '#7c5cff' }),
      role('dev', { tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], skills: ['code-style'], mcpServers: ['docs'] }),
      role('reviewer', { model: 'inherit', tier: undefined, responsibilities: ['Read the diff', 'Check tests'] })
    ],
    skills: [
      {
        name: 'code-style',
        description: 'How we format code.',
        body: '# Style\n\nUse two spaces.',
        files: [
          { path: 'format.sh', text: '#!/bin/sh\necho format\n' },
          { path: 'logo.bin', base64: Buffer.from([0, 1, 2, 255, 254]).toString('base64') }
        ],
        enabled: true
      },
      { name: 'old-skill', description: 'Switched off.', body: 'Nothing.', files: [], enabled: false }
    ],
    mcp: [
      { name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-server@1.2.3'], env: { MODE: 'read' }, secretEnv: ['DOCS_TOKEN'], enabled: true },
      { name: 'wiki', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-Team': 'a' }, secretHeaders: ['Authorization'], enabled: true, roles: ['dev', 'lead'], connectorId: 'wiki-co', connectorVariant: 'read' }
    ]
  }
}

export const toCrlf = (files: TeamFile[]): TeamFile[] => files.map((f) => (f.data.includes(0) ? f : { path: f.path, data: Buffer.from(f.data.toString('utf8').replace(/\n/g, '\r\n'), 'utf8') }))

export const textFile = (path: string, text: string): TeamFile => ({ path, data: Buffer.from(text, 'utf8') })

/** Shuffles deterministically (seeded) so tests do not flake. */
export function shuffled<T>(list: T[], seed = 7): T[] {
  const a = [...list]
  let s = seed
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
