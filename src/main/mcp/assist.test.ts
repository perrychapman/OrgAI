import { describe, expect, it } from 'vitest'
import { HARNESS_PROJECT_ID, type McpLibraryEntry } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { assistContext, assistPrompt, describeLibrary, describeServer, harnessProject } from './assist'
import { mcpSpec, project } from '../runtime/testHelpers'

const entry: McpLibraryEntry = {
  id: 'mcpl_1',
  name: 'docs',
  transport: 'http',
  url: 'https://docs.test/mcp',
  secretHeaders: ['X-Key'],
  oauth: { clientId: 'c' },
  source: 'user',
  addedAt: ''
}

describe('assistPrompt', () => {
  it('defaults by scope and prefers the user instruction', () => {
    expect(assistPrompt({ id: 'p1', name: 'Shop' })).toMatch(/for this project/)
    expect(assistPrompt({ id: HARNESS_PROJECT_ID, name: 'OrgAI' })).toMatch(/MCP library/)
    expect(assistPrompt({ id: 'p1', name: 'Shop' }, '  add github  ')).toBe('add github')
  })
})

describe('assistContext', () => {
  it('project scope: lists project servers with link info and the library, no secret values', () => {
    const linked = mcpSpec({ id: 'mcp-9', name: 'docs', libraryId: 'mcpl_1', source: 'library', transport: 'http', url: 'https://docs.test/mcp', command: undefined, args: undefined, secretEnv: undefined })
    const text = assistContext(project({ mcpServers: [linked, mcpSpec()] }), [entry])
    expect(text).toContain('Session scope: this project')
    expect(text).toContain('name=docs id=mcp-9 transport=http enabled=true source=library libraryId=mcpl_1')
    expect(text).toContain('name=github id=mcp-1')
    expect(text).toContain('MCP library entries')
    expect(text).toContain('name=docs id=mcpl_1 transport=http source=user')
    expect(text).toContain('oauth=yes')
    expect(text).toContain('secrets=X-Key')
  })

  it('harness scope: says it is the app-wide library and has no project sections', () => {
    const harness = harnessProject(DEFAULT_APP_SETTINGS, '/data')
    const text = assistContext(harness, [entry])
    expect(text).toContain('Session scope: the app-wide MCP library')
    expect(text).toContain('id=mcpl_1')
    expect(text).not.toContain('Project brief')
    expect(assistContext(harness)).toContain('MCP library: empty.')
  })

  it('describeServer and describeLibrary stay on one line per entry', () => {
    expect(describeServer(entry)).not.toContain('\n')
    expect(describeLibrary([])).toBe('MCP library: empty.')
  })
})

describe('harnessProject', () => {
  it('is the virtual OrgAI project with no roles or servers', () => {
    const h = harnessProject(DEFAULT_APP_SETTINGS, '/data', { mock: true })
    expect(h).toMatchObject({ id: HARNESS_PROJECT_ID, name: 'OrgAI', path: '/data', roles: [], mcpServers: [] })
    expect(h.provider.id).toBe('mock')
    expect(harnessProject(DEFAULT_APP_SETTINGS, '/data').provider.id).not.toBe('mock')
  })
})
