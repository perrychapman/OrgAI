import { describe, expect, it } from 'vitest'
import type { ProjectPathCheck, RepoSourceParse, RepoTools } from '@shared/types'
import { REPO_CLONE_CANCELLED_PREFIX, REPO_CONFIG_PATHS, REPO_DESTINATION_MAX_CHARS } from '@shared/types'
import {
  FRESH_ANNOUNCER,
  GIT_MISSING_REASON,
  LAST_CLONE_PARENT_KEY,
  cancelledNotice,
  cloneActionLabel,
  cloneBlocker,
  cloneTarget,
  destinationFieldProblem,
  effectiveMode,
  emptyRepoFields,
  folderNameProblem,
  forkAvailability,
  forkPreview,
  forkResultLines,
  isCancelledMessage,
  isDestinationRefusal,
  joinDestination,
  nextAnnouncement,
  progressLine,
  readLastCloneParent,
  repoBridge,
  repoConfigGroups,
  repoConfigLines,
  setupChoiceAnnouncement,
  targetProblem,
  writeLastCloneParent
} from './repoStart'

const gh: RepoSourceParse = { ok: true, url: 'https://github.com/o/r.git', host: 'github.com', owner: 'o', repo: 'r', display: 'o/r', suggestedFolder: 'r', canFork: true }
const lab: RepoSourceParse = { ok: true, url: 'https://gitlab.com/g/r.git', host: 'gitlab.com', owner: 'g', repo: 'r', display: 'gitlab.com/g/r', suggestedFolder: 'r', canFork: false }
const signedIn: RepoTools = { git: { available: true }, gh: { available: true, loggedIn: true, login: 'me' } }
const check = (over: Partial<ProjectPathCheck>): ProjectPathCheck => ({ exists: true, isDirectory: true, empty: true, isGitRepo: false, ...over }) as ProjectPathCheck

describe('joinDestination', () => {
  it('uses the separator of the parent', () => {
    expect(joinDestination('C:\\Projects', 'shop')).toBe('C:\\Projects\\shop')
    expect(joinDestination('C:/Projects', 'shop')).toBe('C:/Projects\\shop')
    expect(joinDestination('/home/me', 'shop')).toBe('/home/me/shop')
  })
  it('does not double a trailing separator or lose a root', () => {
    expect(joinDestination('C:\\Projects\\', 'shop')).toBe('C:\\Projects\\shop')
    expect(joinDestination('/home/me/', 'shop')).toBe('/home/me/shop')
    expect(joinDestination('C:\\', 'shop')).toBe('C:\\shop')
    expect(joinDestination('/', 'shop')).toBe('/shop')
  })
  it('trims both parts', () => {
    expect(joinDestination(' /a ', ' b ')).toBe('/a/b')
  })
})

describe('folderNameProblem', () => {
  it('takes a plain name', () => {
    expect(folderNameProblem('hello-world.js')).toBeNull()
  })
  it.each(['', '  ', '.', '..', 'a/b', 'a\\b', 'a:b', 'a?', 'name.', 'CON', 'nul.txt', 'com1', 'a\u0007b'])('refuses %j', (name) => {
    expect(folderNameProblem(name)).toBeTruthy()
  })
})

describe('cloneTarget and destinationFieldProblem', () => {
  it('makes a target only from a full parent and a valid name', () => {
    expect(cloneTarget({ parent: 'C:\\p', folder: 'r' })).toBe('C:\\p\\r')
    expect(cloneTarget({ parent: 'p', folder: 'r' })).toBeNull()
    expect(cloneTarget({ parent: 'C:\\p', folder: 'a/b' })).toBeNull()
    expect(cloneTarget({ parent: '', folder: 'r' })).toBeNull()
  })
  it('refuses a target past the length limit, and says so', () => {
    const parent = `C:\\${'x'.repeat(REPO_DESTINATION_MAX_CHARS)}`
    expect(cloneTarget({ parent, folder: 'r' })).toBeNull()
    expect(destinationFieldProblem({ parent, folder: 'r' })).toMatch(/too long/)
  })
  it('says nothing about an empty parent, and names a relative one', () => {
    expect(destinationFieldProblem({ parent: '', folder: 'a/b' })).toBeNull()
    expect(destinationFieldProblem({ parent: 'rel', folder: 'r' })).toMatch(/full path/)
    expect(destinationFieldProblem({ parent: 'C:\\p', folder: 'a/b' })).toMatch(/one folder name/)
  })
})

describe('targetProblem', () => {
  it('blocks a file and a folder with contents, never a missing or empty one', () => {
    expect(targetProblem(null)).toBeNull()
    expect(targetProblem(check({ exists: false, isDirectory: false }))).toBeNull()
    expect(targetProblem(check({ empty: true }))).toBeNull()
    expect(targetProblem(check({ empty: false }))).toMatch(/not empty/)
    expect(targetProblem(check({ isDirectory: false }))).toMatch(/file/)
  })
})

describe('forkAvailability', () => {
  it('says GitHub only for another host, whatever the tools say', () => {
    expect(forkAvailability(signedIn, lab)).toMatchObject({ available: false, canRecheck: false, reason: expect.stringMatching(/github\.com/) })
  })
  it('is inert while the tools are unknown', () => {
    expect(forkAvailability(null, gh)).toMatchObject({ available: false, canRecheck: false })
  })
  it('offers Check again when gh is missing, and the command when logged out', () => {
    const missing: RepoTools = { git: { available: true }, gh: { available: false, loggedIn: false, detail: 'Install it.' } }
    expect(forkAvailability(missing, gh)).toEqual({ available: false, reason: 'Install it.', canRecheck: true, command: null })
    const out: RepoTools = { git: { available: true }, gh: { available: true, loggedIn: false, detail: 'Run it.' } }
    expect(forkAvailability(out, gh)).toEqual({ available: false, reason: 'Run it.', canRecheck: true, command: 'gh auth login' })
  })
  it('is available when signed in, carrying a check that could not finish', () => {
    expect(forkAvailability(signedIn, gh)).toEqual({ available: true, reason: null, canRecheck: false, command: null })
    const unsure: RepoTools = { git: { available: true }, gh: { available: true, loggedIn: true, login: 'me', detail: 'Could not reach GitHub.' } }
    expect(forkAvailability(unsure, gh)).toMatchObject({ available: true, reason: 'Could not reach GitHub.', canRecheck: true })
  })
  it('does not judge a source it has no answer for', () => {
    expect(forkAvailability(signedIn, null).available).toBe(true)
    expect(forkAvailability(signedIn, { ok: false, problem: 'no' }).available).toBe(true)
  })
})

describe('effectiveMode and the action label', () => {
  it('never reports a fork that cannot run', () => {
    expect(effectiveMode('fork', forkAvailability(signedIn, gh))).toBe('fork')
    expect(effectiveMode('fork', forkAvailability(signedIn, lab))).toBe('clone')
    expect(effectiveMode('clone', forkAvailability(signedIn, gh))).toBe('clone')
  })
  it('names the write', () => {
    expect(cloneActionLabel('clone')).toBe('Clone')
    expect(cloneActionLabel('fork')).toBe('Fork and clone')
  })
})

describe('forkPreview', () => {
  it('names the account, the new repository, visibility and the remotes', () => {
    const text = forkPreview(signedIn, gh).join(' ')
    expect(text).toContain('Signed in to the GitHub CLI as me.')
    expect(text).toContain('Creates github.com/me/r.')
    expect(text).toContain('public')
    expect(text).toContain('upstream')
  })
  it('does not invent an account', () => {
    const noLogin: RepoTools = { git: { available: true }, gh: { available: true, loggedIn: true } }
    const text = forkPreview(noLogin, gh).join(' ')
    expect(text).not.toContain('undefined')
    expect(text).toContain('on your GitHub account')
  })
})

describe('cloneBlocker', () => {
  const fields = { ...emptyRepoFields('C:\\p'), source: 'o/r', folder: 'r' }
  it('passes a complete form', () => {
    expect(cloneBlocker({ fields, parse: gh, tools: signedIn, check: null })).toBeNull()
  })
  it('names each missing step, git first', () => {
    const noGit: RepoTools = { git: { available: false }, gh: { available: false, loggedIn: false } }
    expect(cloneBlocker({ fields, parse: gh, tools: noGit, check: null })).toBe(GIT_MISSING_REASON)
    expect(cloneBlocker({ fields: { ...fields, source: ' ' }, parse: null, tools: signedIn, check: null })).toMatch(/Paste/)
    expect(cloneBlocker({ fields, parse: null, tools: signedIn, check: null })).toMatch(/Checking/)
    expect(cloneBlocker({ fields, parse: { ok: false, problem: 'Nope.' }, tools: signedIn, check: null })).toBe('Nope.')
    expect(cloneBlocker({ fields: { ...fields, parent: '' }, parse: gh, tools: signedIn, check: null })).toMatch(/where to save/)
    expect(cloneBlocker({ fields: { ...fields, folder: '' }, parse: gh, tools: signedIn, check: null })).toMatch(/name/)
    expect(cloneBlocker({ fields, parse: gh, tools: signedIn, check: check({ empty: false }) })).toMatch(/not empty/)
    expect(cloneBlocker({ fields, parse: gh, tools: signedIn, check: check({}), existingProjectName: 'Shop' })).toContain('Shop')
  })
  it('does not wait for the slow gh check', () => {
    expect(cloneBlocker({ fields, parse: gh, tools: null, check: null })).toBeNull()
  })
})

describe('progress', () => {
  it('shows main\'s fixed label, or the phase, with the percent', () => {
    expect(progressLine(null)).toBe('Starting')
    expect(progressLine({ phase: 'forking' })).toMatch(/fork/i)
    expect(progressLine({ phase: 'cloning', percent: 40, text: 'Receiving files' })).toBe('Receiving files, 40%')
  })
  it('announces each phase once and then quarters, not every percent', () => {
    const said: (string | null)[] = []
    let state = FRESH_ANNOUNCER
    const feed = (phase: 'forking' | 'cloning' | 'finishing', percent?: number): void => {
      const n = nextAnnouncement(state, { phase, percent })
      state = n.state
      said.push(n.text)
    }
    feed('forking')
    feed('forking')
    for (const p of [0, 1, 10, 24, 25, 26, 49, 50, 74, 80, 99, 100]) feed('cloning', p)
    feed('finishing')
    const spoken = said.filter(Boolean)
    expect(spoken).toEqual(['Creating the fork on GitHub', 'Cloning', 'Cloning, 25%', 'Cloning, 50%', 'Cloning, 75%', 'Finishing'])
  })
})

describe('messages from main', () => {
  it('reads a cancelled clone and keeps the fork sentence', () => {
    expect(isCancelledMessage(REPO_CLONE_CANCELLED_PREFIX)).toBe(true)
    expect(isCancelledMessage('The clone failed.')).toBe(false)
    expect(cancelledNotice(REPO_CLONE_CANCELLED_PREFIX)).toBe('Clone stopped. OrgAI removed what it had written.')
    expect(cancelledNotice(`${REPO_CLONE_CANCELLED_PREFIX} The fork exists at https://github.com/me/r.`)).toContain('The fork exists at https://github.com/me/r.')
  })
  // Every destination sentence of repoClone.ts checkDestination and the folder lock. Keep in step with that file.
  it.each([
    'Choose a folder for the new project.',
    'That folder path is too long.',
    'That folder path holds a hidden or control character.',
    'Choose a folder on this computer, not a network or device path.',
    'Use the full path of the folder.',
    'That folder path has a colon in it, which Windows does not allow there.',
    'A part of that folder path is not a valid folder name on Windows.',
    'That folder path has a "." or ".." part. Use the full path.',
    'Choose a folder inside a drive, not the drive itself.',
    "Choose a folder outside OrgAI's own data folder.",
    'OrgAI could not check that folder.',
    'That folder is a link. Choose the real folder.',
    'That path is a file, not a folder.',
    'That folder is not empty. Choose an empty or new folder.',
    'OrgAI could not read that folder.',
    'Part of that path is a file, not a folder.',
    'That folder is one OrgAI will not clone into: files there can run or sign in later. Choose another folder.',
    'That folder belongs to an existing project. Choose a new folder.',
    'A clone into that folder is already running.'
  ])('treats %j as about the destination', (m) => {
    expect(isDestinationRefusal(m)).toBe(true)
  })
  it.each(['Git is not installed. Install it from git-scm.com, then try again.', 'Too many clones are running. Wait for one to finish.', 'This is your own repository, so GitHub will not fork it. Clone it instead.'])('does not treat %j as about the destination', (m) => {
    expect(isDestinationRefusal(m)).toBe(false)
  })
})

describe('forkResultLines', () => {
  const fork = { fullName: 'me/r', htmlUrl: 'https://github.com/me/r', upstreamUrl: 'https://github.com/o/r.git', upstreamAdded: true }
  it('names the fork and the upstream', () => {
    const lines = forkResultLines(fork)
    expect(lines[0].text).toBe('Forked to github.com/me/r.')
    expect(lines[1].text).toContain('upstream')
    expect(lines[1].warn).toBeUndefined()
  })
  it('says when the fork was already there, and when upstream failed', () => {
    expect(forkResultLines({ ...fork, alreadyExisted: true })[0].text).toContain('already had')
    expect(forkResultLines({ ...fork, upstreamAdded: false })[1].warn).toBe(true)
  })
})

describe('repoConfig lines', () => {
  it('groups by effect, most capable first', () => {
    const g = repoConfigGroups(['AGENTS.md', '.mcp.json', '.claude/settings.json', '.claude/agents'])
    expect(g['runs-commands']).toEqual(['.claude/settings.json'])
    expect(g.tools).toEqual(['.mcp.json', '.claude/agents'])
    expect(g.instructions).toEqual(['AGENTS.md'])
    const lines = repoConfigLines(['AGENTS.md', '.mcp.json', '.claude/settings.json'])
    expect(lines[0]).toMatch(/^Can run commands.*\.claude\/settings\.json/)
    expect(lines[1]).toMatch(/\.mcp\.json/)
    expect(lines[2]).toMatch(/AGENTS\.md/)
    expect(lines[3]).toMatch(/subfolders/)
  })
  it('covers every known path', () => {
    const lines = repoConfigLines(REPO_CONFIG_PATHS.map((c) => c.path)).join(' ')
    for (const c of REPO_CONFIG_PATHS) expect(lines).toContain(c.path)
  })
  it('keeps the note when nothing is found, and promises nothing about what OrgAI does', () => {
    const empty = repoConfigLines([]).join(' ')
    expect(empty).toMatch(/subfolders/)
    const all = repoConfigLines(REPO_CONFIG_PATHS.map((c) => c.path)).join(' ')
    expect(all).not.toMatch(/until you allow|will not use|allowed|safe/i)
  })
})

describe('repoBridge', () => {
  it('offers the clone for an address and replaces the path error', () => {
    expect(repoBridge('https://github.com/o/r', gh)).toMatchObject({ replacesError: true })
    expect(repoBridge('git@github.com:o/r.git', gh)).toMatchObject({ replacesError: true })
  })
  it('keeps the path error for a shorthand, which may be a relative path', () => {
    const b = repoBridge('o/r', gh)
    expect(b?.replacesError).toBe(false)
    expect(b?.line).toContain('o/r')
  })
  it('stays out for full paths, refusals and no answer', () => {
    expect(repoBridge('C:\\o\\r', gh)).toBeNull()
    expect(repoBridge('/o/r', gh)).toBeNull()
    expect(repoBridge('o r', { ok: false, problem: 'no' })).toBeNull()
    expect(repoBridge('o/r', null)).toBeNull()
    expect(repoBridge('', gh)).toBeNull()
  })
})

describe('setupChoiceAnnouncement', () => {
  it('says what changed after a clone', () => {
    expect(setupChoiceAnnouncement({ found: 'Found 1 agent.', hasAgents: true, hadAgents: null, afterClone: true })).toBe('Cloned. Found 1 agent. Choose how the team starts.')
    expect(setupChoiceAnnouncement({ found: null, hasAgents: false, hadAgents: null, afterClone: true })).toBe('Cloned. Choose how the team starts.')
  })
  it('announces the swap on Existing code, first answer included', () => {
    expect(setupChoiceAnnouncement({ found: 'Found 1 agent.', hasAgents: true, hadAgents: null, afterClone: false })).toContain('Found 1 agent.')
    expect(setupChoiceAnnouncement({ found: null, hasAgents: false, hadAgents: true, afterClone: false })).toBeTruthy()
  })
  it('stays quiet when nothing changed', () => {
    expect(setupChoiceAnnouncement({ found: null, hasAgents: false, hadAgents: null, afterClone: false })).toBeNull()
    expect(setupChoiceAnnouncement({ found: 'x', hasAgents: true, hadAgents: true, afterClone: false })).toBeNull()
  })
})

describe('last parent', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
    const m = new Map<string, string>()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
  }
  it('round-trips, trimmed', () => {
    const s = memory()
    writeLastCloneParent(' C:\\p ', s)
    expect(readLastCloneParent(s)).toBe('C:\\p')
  })
  it('drops junk and survives a storage that throws', () => {
    const s = memory()
    s.setItem(LAST_CLONE_PARENT_KEY, 'relative')
    expect(readLastCloneParent(s)).toBe('')
    const bad = {
      getItem: () => {
        throw new Error('no')
      },
      setItem: () => {
        throw new Error('no')
      }
    }
    expect(readLastCloneParent(bad)).toBe('')
    expect(() => writeLastCloneParent('C:\\p', bad)).not.toThrow()
  })
})
