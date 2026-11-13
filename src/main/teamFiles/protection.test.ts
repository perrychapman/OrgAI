import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SELF_CONTROL_DENIAL_MESSAGE,
  checkSelfControlDenial,
  controlProtectedPaths,
  type SelfControlContext
} from '../runtime/selfControlGate'
import { existingTeamFilesProtectedPaths, teamFilesProtectedPaths } from './protection'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('team-files approval control paths', () => {
  it('protects current project snapshots from file tools, searches and shell commands', () => {
    const base = mkdtempSync(join(tmpdir(), 'orgai team-files protection-'))
    dirs.push(base)
    const data = join(base, 'data')
    const projectDir = join(data, 'projects', 'p_alpha')
    const teamDir = join(projectDir, 'team-files')
    mkdirSync(teamDir, { recursive: true })
    const approved = join(teamDir, 'approved.json')
    const approvedCanonical = join(realpathSync.native(teamDir), 'approved.json')
    const refs = [...controlProtectedPaths(data), ...teamFilesProtectedPaths(data, ['p_alpha'])]
    const ctx: SelfControlContext = { protectedPaths: refs, cwd: join(base, 'repo'), home: base }

    for (const [tool, input] of [
      ['Read', { file_path: approved }],
      ['Read', { file_path: approvedCanonical }],
      ['Write', { file_path: approved, content: '{"roles":[]}' }],
      ['Write', { file_path: approvedCanonical, content: '{"roles":[]}' }],
      ['Grep', { pattern: 'permissionMode', path: teamDir }],
      ['Glob', { pattern: '**/*', path: join(data, 'projects') }],
      ['Bash', { command: `cat '${approved}'` }],
      ['Bash', { command: `cat '${approvedCanonical}'` }],
      ['Bash', { command: `printf forged > '${approved}'` }]
    ] as const) {
      expect(checkSelfControlDenial(tool, input, ctx), `${tool} ${JSON.stringify(input)}`).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
    expect(checkSelfControlDenial('Read', { file_path: join(projectDir, 'ENGAGEMENT.md') }, ctx)).toBeNull()
    const relativeCtx = { ...ctx, cwd: teamDir }
    expect(checkSelfControlDenial('Read', { file_path: 'approved.json' }, relativeCtx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('Write', { file_path: 'approved.json', content: '{}' }, relativeCtx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('Grep', { pattern: 'permissionMode', path: '.' }, relativeCtx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('Glob', { pattern: '**/*' }, relativeCtx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(checkSelfControlDenial('Bash', { command: 'cat approved.json' }, relativeCtx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it('recomputes roots as projects are added and retains both data-root spellings', () => {
    const base = mkdtempSync(join(tmpdir(), 'orgai-team-files-links-'))
    dirs.push(base)
    const realData = join(base, 'real-data')
    mkdirSync(join(realData, 'projects', 'p_first', 'team-files'), { recursive: true })
    const realDataCanonical = realpathSync.native(realData)
    const linkedData = join(base, 'data-link')
    symlinkSync(realData, linkedData, process.platform === 'win32' ? 'junction' : 'dir')
    const projectIds = ['p_first']
    const refs = () => teamFilesProtectedPaths(linkedData, projectIds)
    const first = join(linkedData, 'projects', 'p_first', 'team-files')
    const firstReal = join(realDataCanonical, 'projects', 'p_first', 'team-files')
    const protectedRefs = () => [...controlProtectedPaths(linkedData), ...teamFilesProtectedPaths(linkedData, projectIds)]
    const addedSnapshot = join(linkedData, 'projects', 'p_second', 'team-files', 'approved.json')

    expect(refs()).toEqual(expect.arrayContaining([first, firstReal]))
    expect(checkSelfControlDenial('Read', { file_path: addedSnapshot }, { protectedPaths: protectedRefs(), cwd: base })).toBeNull()
    projectIds.push('p_second')
    expect(refs()).toContain(join(linkedData, 'projects', 'p_second', 'team-files'))
    expect(refs()).toContain(join(realDataCanonical, 'projects', 'p_second', 'team-files'))
    expect(checkSelfControlDenial('Read', { file_path: addedSnapshot }, { protectedPaths: protectedRefs(), cwd: base })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
  })

  it('enumerates only existing sibling project roots and fails closed when enumeration is unsafe', () => {
    const base = mkdtempSync(join(tmpdir(), 'orgai-team-files-sibling-'))
    dirs.push(base)
    const siblingData = join(base, 'sibling-data')
    const teamDir = join(siblingData, 'projects', 'p_sibling', 'team-files')
    mkdirSync(teamDir, { recursive: true })
    const paths = existingTeamFilesProtectedPaths(siblingData)
    expect(paths).toContain(teamDir)
    expect(checkSelfControlDenial('Read', { file_path: join(teamDir, 'approved.json') }, { protectedPaths: paths, cwd: base })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(existingTeamFilesProtectedPaths(join(base, 'missing-data'))).toEqual([])

    const linkedData = join(base, 'linked-data')
    const linkedProjects = join(linkedData, 'projects')
    const targetProject = join(base, 'outside-project', 'team-files')
    mkdirSync(targetProject, { recursive: true })
    mkdirSync(linkedProjects, { recursive: true })
    symlinkSync(join(base, 'outside-project'), join(linkedProjects, 'p_linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const realpaths = vi.spyOn(fs.realpathSync, 'native')
    const linkedFallback = existingTeamFilesProtectedPaths(linkedData)
    expect(realpaths.mock.calls.map(([path]) => String(path))).toEqual([linkedProjects])
    expect(linkedFallback).toContain(linkedProjects)
    expect(linkedFallback).not.toContain(targetProject)
    expect(checkSelfControlDenial('Read', { file_path: join(linkedProjects, 'p_linked', 'team-files', 'approved.json') }, { protectedPaths: linkedFallback, cwd: base })).toBe(SELF_CONTROL_DENIAL_MESSAGE)

    const fileEntryData = join(base, 'file-entry-data')
    const fileEntryProjects = join(fileEntryData, 'projects')
    mkdirSync(fileEntryProjects, { recursive: true })
    writeFileSync(join(fileEntryProjects, 'p_file'), 'not a project directory')
    expect(existingTeamFilesProtectedPaths(fileEntryData)).toContain(fileEntryProjects)

    const unreadableData = join(base, 'unreadable-data')
    mkdirSync(unreadableData, { recursive: true })
    const projectsRoot = join(unreadableData, 'projects')
    writeFileSync(projectsRoot, 'not a directory')
    const fallback = existingTeamFilesProtectedPaths(unreadableData)
    expect(fallback).toContain(projectsRoot)
    expect(checkSelfControlDenial('Read', { file_path: join(projectsRoot, 'p_unknown', 'team-files', 'approved.json') }, { protectedPaths: fallback, cwd: base })).toBe(SELF_CONTROL_DENIAL_MESSAGE)

    const linkedTeamData = join(base, 'linked-team-data')
    const linkedTeamProjects = join(linkedTeamData, 'projects')
    const linkedTeamProject = join(linkedTeamProjects, 'p_team_link')
    const outsideTeam = join(base, 'outside-team-files')
    mkdirSync(linkedTeamProject, { recursive: true })
    mkdirSync(outsideTeam, { recursive: true })
    symlinkSync(outsideTeam, join(linkedTeamProject, 'team-files'), process.platform === 'win32' ? 'junction' : 'dir')
    const teamRealpaths = vi.spyOn(fs.realpathSync, 'native')
    const teamFallback = existingTeamFilesProtectedPaths(linkedTeamData)
    expect(teamFallback).toContain(linkedTeamProjects)
    expect(teamFallback).not.toContain(outsideTeam)
    expect(teamRealpaths.mock.calls.map(([path]) => String(path))).toEqual([linkedTeamProjects])

    const rootLinkData = join(base, 'root-link-data')
    const rootLinkProjects = join(rootLinkData, 'projects')
    const outsideProjects = join(base, 'outside-projects')
    mkdirSync(rootLinkData, { recursive: true })
    mkdirSync(join(outsideProjects, 'p_outside', 'team-files'), { recursive: true })
    symlinkSync(outsideProjects, rootLinkProjects, process.platform === 'win32' ? 'junction' : 'dir')
    teamRealpaths.mockClear()
    const rootFallback = existingTeamFilesProtectedPaths(rootLinkData)
    expect(rootFallback).toEqual([rootLinkData])
    const linkedSnapshot = join(rootLinkProjects, 'p_outside', 'team-files', 'approved.json')
    expect(checkSelfControlDenial('Read', { file_path: linkedSnapshot }, { protectedPaths: rootFallback, cwd: base })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    expect(teamRealpaths).not.toHaveBeenCalled()
  })

  it('matches Windows device and slash variants of the protected snapshot', () => {
    const protectedDir = win32.join('C:\\Users\\Ryan\\AppData\\Roaming\\OrgAI', 'projects', 'p_alpha', 'team-files')
    const canonical = `${protectedDir}\\approved.json`
    const device = `\\\\?\\${canonical}`
    const ctx: SelfControlContext = {
      protectedPaths: [protectedDir],
      cwd: 'C:\\work\\repo',
      home: 'C:\\Users\\Ryan',
      platform: 'win32'
    }
    const slash = canonical.replaceAll('\\', '/')

    for (const file of [canonical, device, slash]) {
      for (const tool of ['Read', 'Write'] as const) {
        const input = tool === 'Read' ? { file_path: file } : { file_path: file, content: '{}' }
        expect(checkSelfControlDenial(tool, input, ctx), `${tool} ${file}`).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      }
      expect(checkSelfControlDenial('Grep', { pattern: 'forged', path: win32.dirname(file) }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(checkSelfControlDenial('Glob', { pattern: '**/*', path: file }, ctx)).toBe(SELF_CONTROL_DENIAL_MESSAGE)
      expect(checkSelfControlDenial('Bash', { command: `type "${file}"` }, { ...ctx, shell: 'powershell' })).toBe(SELF_CONTROL_DENIAL_MESSAGE)
    }
  })
})
