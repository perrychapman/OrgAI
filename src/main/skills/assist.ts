import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, Project } from '@shared/types'
import { SKILLS_PROJECT_ID } from '@shared/types'
import { newProject } from '@shared/defaults'
import type { SkillAssistCatalog } from '../runtime/types'

/**
 * The Skill assistant (RunKind 'skill-assist'): the display project for the virtual SKILLS_PROJECT_ID and the
 * session's first message and hidden context. PHASE 2 STUB: the Skill assistant engineer completes this module.
 */

/**
 * The virtual project that owns library-scope Skill assistant runs: name 'Skill assistant', path
 * `<data>/harness-workspace`, the app's default connection, no roles, servers, plugins or skills. Never stored.
 * With the mock adapter registered (ORGAI_MOCK=1) it runs on mock.
 */
export function skillsProject(settings: AppSettings, dataDir: string, opts: { mock?: boolean } = {}): Project {
  const workspace = join(dataDir, 'harness-workspace')
  mkdirSync(workspace, { recursive: true })
  const base = newProject({ name: 'Skill assistant', path: workspace, brief: 'Harness-level session: the app-wide skill library, shared by every project.' }, settings)
  const connection = settings.defaultConnection
  const id = opts.mock ? 'mock' : connection === 'openai' ? 'codex' : 'claude'
  return {
    ...base,
    id: SKILLS_PROJECT_ID,
    provider: { ...base.provider, id, connection },
    isolateWriters: false,
    autoContinue: false,
    roles: [],
    mcpServers: [],
    plugins: [],
    skills: [],
    setup: undefined,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z'
  }
}

/** The visible first message of a Skill assistant session. */
export function skillAssistPrompt(project: Pick<Project, 'id' | 'name'>, instruction?: string): string {
  const text = instruction?.trim()
  if (text) return text
  return project.id === SKILLS_PROJECT_ID
    ? 'Help me improve my skill library: review the skills I have, then propose new or better ones.'
    : 'Help me improve the skills of this project: review them and which roles load them, then propose changes.'
}

/** Hidden context of a Skill assistant session (every untrusted string through promptDatum). */
export function skillAssistContext(project: Project, catalog: SkillAssistCatalog): string {
  void catalog
  return project.id === SKILLS_PROJECT_ID ? 'Session scope: the app-wide skill library.' : 'Session scope: this project.'
}
