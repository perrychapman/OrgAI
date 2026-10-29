import { describe, expect, it } from 'vitest'
import type { ArchitectureSpec } from '@shared/types'
import { ARCHITECTURE_PATH, CLAUDE_MD_MARKER, renderArchitecture } from './service'

const full: ArchitectureSpec = {
  summary: '  A small notes API.  ',
  stack: ['Node 22', 'Express 4'],
  modules: [
    { name: 'Server', purpose: 'HTTP routes.', paths: ['src/server.js'] },
    { name: 'Docs', purpose: 'Written docs.', paths: [] }
  ],
  conventions: ['ES modules only'],
  commands: [{ name: 'Test', command: 'npm test' }],
  risks: ['No persistence']
}

describe('renderArchitecture', () => {
  it('renders every section in order', () => {
    const md = renderArchitecture('Notes', full)
    expect(md).toBe(
      [
        '# Notes architecture',
        '',
        'A small notes API.',
        '',
        '## Stack',
        '',
        '- Node 22',
        '- Express 4',
        '',
        '## Modules',
        '',
        '### Server',
        '',
        'HTTP routes.',
        '',
        '- `src/server.js`',
        '',
        '### Docs',
        '',
        'Written docs.',
        '',
        '## Conventions',
        '',
        '- ES modules only',
        '',
        '## Commands',
        '',
        '- Test: `npm test`',
        '',
        '## Risks and gaps',
        '',
        '- No persistence',
        '',
        '_Maintained by OrgAI. Approved by the project owner during setup._',
        ''
      ].join('\n')
    )
  })

  it('omits empty sections', () => {
    const md = renderArchitecture('Bare', { summary: 'Just a summary.', stack: [], modules: [], conventions: [], commands: [], risks: [] })
    expect(md).toBe('# Bare architecture\n\nJust a summary.\n\n_Maintained by OrgAI. Approved by the project owner during setup._\n')
    expect(md).not.toMatch(/^## /m)
  })

  it('exports the paths the CLAUDE.md block relies on', () => {
    expect(ARCHITECTURE_PATH).toBe('.orgai/ARCHITECTURE.md')
    expect(CLAUDE_MD_MARKER).toMatch(/^<!--.*-->$/)
  })
})
