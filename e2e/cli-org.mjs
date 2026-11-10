// `orgai org`, `team`, `worktrees` and `permissions` end to end (cli-spec 6.3, Wave 5). Run `npm run build` first.
// Mock adapter only (ORGAI_MOCK=1): no tokens, no network. Every command hosts itself, one at a time; the
// project is seeded with `projects create` (e2e/cliLib.mjs).
//
// Fixture: a git repo with a Claude Code agent definition (.claude/agents/backend-dev.md) and two leftover report
// worktrees planted the way e2e/maintenance.mjs plants them (one clean, one that conflicts with main).
// Checks: org show (text, JSON), permissions add / list / remove / mode, team templates save / list, team roles /
// role, team role add / set / move / rm (spend gate, --yes, previousRoles), mcp update --role / --no-roles,
// worktrees list / diff / merge (clean ok, conflict exit 1) / discard (exit 2 without --yes, then --yes),
// org import --yes (the agent lands in the chart), org recommend (keyword fallback under mock).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, finish, git, gitSafe, log, makeFixtureRepo, removeFixture, writeFile } from './lib.mjs'
import { cli, json, requireBuild, seedProject, show } from './cliLib.mjs'

requireBuild()

const repo = makeFixtureRepo('cliorg')
fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.claude/worktrees/\n')
writeFile(repo, '.claude/agents/backend-dev.md', '---\nname: backend-dev\ndescription: Builds the API\ntools: Read, Edit, Bash\nmodel: sonnet\n---\nYou build the backend. Keep handlers small.\n')
git(repo, ['add', '-A'])
git(repo, ['commit', '-q', '-m', 'agent definition'])
const plant = (id) => {
  const rel = `.claude/worktrees/agent-${id}`
  git(repo, ['worktree', 'add', '-q', '-b', `worktree-agent-${id}`, rel])
  return path.join(repo, rel)
}
const wtA = plant('cleanA')
writeFile(wtA, 'src/health.js', 'export const health = () => ({ ok: true })\n')
git(wtA, ['add', '-A'])
git(wtA, ['commit', '-q', '-m', 'Implementer: add health helper'])
const wtB = plant('conflictB')
writeFile(wtB, 'README.md', '# tiny-notes-api (from the report)\n')
git(wtB, ['add', '-A'])
git(wtB, ['commit', '-q', '-m', 'Implementer: retitle README'])
writeFile(repo, 'README.md', '# tiny-notes-api (from main)\n')
git(repo, ['add', '-A'])
git(repo, ['commit', '-q', '-m', 'main: retitle README'])
log('fixture at', repo)

/** The CLI in the fixture folder (project resolution by cwd). */
const at = (args, opts = {}) => cli(args, { cwd: repo, ...opts })
const jsonOf = async (args) => {
  const r = await at(['--output-format', 'json', ...args])
  return { r, v: json(r.out) }
}

try {
  const project = await seedProject(repo, { name: 'CLI org e2e' })
  check(!!project?.id, 'project seeded with projects create', JSON.stringify(project).slice(0, 200))
  const roleCount = project.roles.length

  // ---------- org show ----------
  let r = await at(['org', 'show'])
  check(r.code === 0 && r.out.includes(`CLI org e2e: ${roleCount} role`) && r.out.includes('Subagent limits:'), 'org show prints the tree and limits', show(r))
  check(/effort \S+ · .*runs on \S+/.test(r.out), 'org show names effort, staffing and the connection each role runs on', show(r))
  let j = await jsonOf(['org', 'show'])
  check(j.r.code === 0 && j.v?.roles?.length === roleCount && j.v.roles[0].depth === 0 && typeof j.v.roles[0].model === 'string', 'org show JSON: roles with depth and model id', show(j.r))

  // ---------- permissions ----------
  r = await at(['permissions', 'add', 'Bash(npm test:*)'])
  check(r.code === 0 && r.out.includes('Saved Bash(npm test:*)'), 'permissions add saves the rule', show(r))
  j = await jsonOf(['permissions', 'list'])
  // Where rules live follows the project: gated folder config (folderConfigTrust set) or an engagement = the app's data folder.
  const gated = project.folderConfigTrust !== undefined || project.kind === 'engagement'
  const wantLocation = gated ? 'app' : 'folder'
  check(j.r.code === 0 && j.v?.rules?.some((x) => x.rule === 'Bash(npm test:*)') && j.v.location === wantLocation, `permissions list JSON has the rule (${wantLocation} location)`, show(j.r))
  r = await at(['permissions', 'list'])
  check(r.code === 0 && r.out.includes('.claude/settings.local.json') === !gated && (gated ? r.out.includes("OrgAI's data folder") : true), 'permissions list text names where rules live', show(r))
  r = await at(['permissions', 'add', 'Bash(curl:*)'])
  check(r.code === 2 && /orgai: /.test(r.err), 'a too-broad rule is refused with the host sentence (exit 2)', show(r))
  r = await at(['permissions', 'remove', 'Bash(npm test:*)'])
  check(r.code === 0, 'permissions remove', show(r))
  j = await jsonOf(['permissions', 'list'])
  check(j.v?.rules?.length === 0, 'the rule is gone', show(j.r))
  r = await at(['permissions', 'mode', 'acceptEdits'])
  check(r.code === 0 && r.out.includes('acceptEdits'), 'permissions mode acceptEdits', show(r))
  r = await at(['permissions', 'mode', 'default'])
  j = await jsonOf(['permissions', 'mode'])
  check(r.code === 0 && j.v?.mode === 'default', 'permissions mode default (JSON shows it)', show(j.r))
  r = await at(['permissions', 'mode', 'yolo'])
  check(r.code === 2, 'an unknown mode is exit 2', show(r))

  // ---------- team ----------
  r = await at(['team', 'templates', 'save', '--name', 'E2E team'])
  check(r.code === 0 && r.out.includes('Saved template E2E team'), 'team templates save', show(r))
  j = await jsonOf(['team', 'templates', 'list'])
  check(j.r.code === 0 && j.v?.templates?.some((t) => t.name === 'E2E team'), 'team templates list JSON has it', show(j.r))
  r = await at(['team', 'roles'])
  check(r.code === 0 && r.out.includes(`${roleCount} role`), 'team roles', show(r))
  r = await at(['team', 'role', project.roles[0].slug])
  check(r.code === 0 && r.out.includes('prompt:'), 'team role shows the prompt', show(r))
  check(r.out.includes('  effort: ') && r.out.includes('  staffing: ') && r.out.includes('  runs on: '), 'team role text names effort, staffing and the connection', show(r))

  // ---------- team role editing (cli-parity 3.3) ----------
  const rootSlug = project.roles.find((x) => x.reportsTo === null).slug
  r = await at(['team', 'role', 'add', 'E2E Writer', '--reports-to', rootSlug, '--model', 'top'])
  check(r.code === 2 && r.err.includes('May spend more') && r.err.includes('--yes'), 'team role add that may spend more asks for --yes without a terminal', show(r))
  j = await jsonOf(['team', 'role', 'add', 'E2E Writer', '--reports-to', rootSlug, '--yes'])
  check(j.r.code === 0 && j.v?.role?.before === null && j.v.role.after?.slug === 'e2e-writer', 'team role add --yes (JSON before null, after the role)', show(j.r))
  j = await jsonOf(['team', 'role', 'set', 'e2e-writer', '--effort', 'high', '--staffing', 'auto', '--max-effort', 'high', '--add-tool', 'Write', '--yes'])
  check(j.r.code === 0 && j.v?.role?.after?.effort === 'high' && j.v.role.after.tools.includes('Write') && j.v.role.after.staffing?.maxEffort === 'high', 'team role set saves effort, staffing and tools', show(j.r))
  r = await at(['team', 'role', 'set', 'e2e-writer', '--tools', 'Teleport'])
  check(r.code === 2 && r.err.includes('--tools'), 'team role set refuses an unknown tool naming the flag', show(r))
  r = await at(['team', 'role', 'move', rootSlug, '--reports-to', 'e2e-writer'])
  check(r.code === 2 && r.err.includes('top of the chart'), 'team role move refuses the root', show(r))
  r = await at(['team', 'role', 'rm', 'e2e-writer'])
  check(r.code === 2 && r.err.includes('--yes'), 'team role rm without --yes and without a terminal is exit 2', show(r))
  j = await jsonOf(['team', 'role', 'rm', 'e2e-writer', '--yes'])
  check(j.r.code === 0 && j.v?.previousRoles?.some((x) => x.slug === 'e2e-writer'), 'team role rm --yes (JSON previousRoles)', show(j.r))
  j = await jsonOf(['team', 'roles'])
  check(j.r.code === 0 && !j.v?.roles?.some((x) => x.slug === 'e2e-writer'), 'the removed role is gone', show(j.r))

  // ---------- mcp update --role ----------
  r = await at(['mcp', 'add', 'e2e-notes', '--command', 'node', '--arg', 'server.js'])
  check(r.code === 0, 'mcp add for the role-access rows', show(r))
  j = await jsonOf(['mcp', 'update', 'e2e-notes', '--role', rootSlug])
  check(j.r.code === 0 && JSON.stringify(j.v?.roles) === JSON.stringify([rootSlug]), 'mcp update --role limits the server to that role', show(j.r))
  j = await jsonOf(['mcp', 'update', 'e2e-notes', '--no-roles'])
  check(j.r.code === 0 && Array.isArray(j.v?.roles) && j.v.roles.length === 0, 'mcp update --no-roles leaves it to no role', show(j.r))
  r = await at(['mcp', 'remove', 'e2e-notes', '--yes'])
  check(r.code === 0, 'mcp remove after the role-access rows', show(r))

  // ---------- worktrees ----------
  j = await jsonOf(['worktrees', 'list'])
  const branches = (j.v?.worktrees ?? []).map((w) => w.branch).sort()
  check(j.r.code === 0 && branches.join(',') === 'worktree-agent-cleanA,worktree-agent-conflictB', 'worktrees list JSON shows both branches', show(j.r))
  r = await at(['worktrees', 'list'])
  check(r.code === 0 && r.out.includes('2 pending report branches'), 'worktrees list text', show(r))
  r = await at(['worktrees', 'diff', 'worktree-agent-cleanA'])
  check(r.code === 0 && r.out.includes('+export const health') && !r.out.includes('\x1b'), 'worktrees diff prints the plain patch', show(r))
  j = await jsonOf(['worktrees', 'diff', 'worktree-agent-cleanA'])
  check(j.r.code === 0 && typeof j.v?.patch === 'string' && j.v.patch.includes('health'), 'worktrees diff JSON', show(j.r))
  r = await at(['worktrees', 'merge', 'worktree-agent-cleanA'])
  check(r.code === 0, 'worktrees merge of the clean branch', show(r))
  r = await at(['worktrees', 'merge', 'worktree-agent-conflictB'])
  check(r.code === 1 && r.err.length > 0, 'worktrees merge of the conflicting branch is exit 1 with the message', show(r))
  r = await at(['worktrees', 'discard', 'worktree-agent-conflictB'])
  check(r.code === 2 && r.err.includes('--yes'), 'worktrees discard without --yes and without a terminal is exit 2', show(r))
  r = await at(['worktrees', 'discard', 'worktree-agent-conflictB', '--yes'])
  check(r.code === 0, 'worktrees discard --yes', show(r))
  j = await jsonOf(['worktrees', 'list'])
  check(j.v?.worktrees?.length === 0, 'no pending branches left', show(j.r))
  check(!/worktree-agent-/.test(gitSafe(repo, ['branch', '--list'])), 'no report branches in git', gitSafe(repo, ['branch', '--list']))
  check(gitSafe(repo, ['ls-files', 'src/health.js']) === 'src/health.js', 'the clean branch was merged into main')

  // ---------- org import ----------
  r = await at(['org', 'import'])
  check(r.code === 2 && r.out.includes('backend-dev') && r.err.includes('--yes'), 'org import previews and asks for --yes without a terminal', show(r))
  r = await at(['org', 'import', '--yes'])
  check(r.code === 0 && r.out.includes('Imported 1 role') && !r.out.includes('Desktop Team tab'), 'org import --yes applies (and never promises a Desktop Undo)', show(r))
  j = await jsonOf(['org', 'show'])
  check(j.v?.roles?.some((x) => x.slug.startsWith('backend-dev')), 'the imported role is in the chart', show(j.r))

  // ---------- Team assistant ----------
  j = await jsonOf(['org', 'recommend'])
  check(j.r.code === 0 && j.v?.recommendations?.projectId === project.id && Array.isArray(j.v.recommendations.recommendations), 'org recommend under mock', show(j.r))
  r = await at(['org', 'review'])
  check(r.code === 0, 'org review shows the last review', show(r))
  // ---------- org draft --from --apply (CLI parity 3.3: a printed draft is kept) ----------
  {
    const cur = await jsonOf(['org', 'show'])
    const base = cur.v?.roles?.[0]
    const mk = (id, extra = {}) => ({ ...base, id, slug: id, name: id.toUpperCase(), reportsTo: null, ...extra })
    const draftFile = path.join(path.dirname(repo), `cliorg-draft-${process.pid}.json`)
    fs.writeFileSync(draftFile, JSON.stringify({ draft: { roles: [mk('draftlead', { canSpawn: true }), mk('draftdev', { reportsTo: 'draftlead' })], rationale: 'e2e' } }))
    r = await at(['org', 'draft', '--from', draftFile, '--apply'])
    check(r.code === 2 && r.err.includes('--yes'), 'org draft --from --apply without --yes and without a terminal is exit 2', show(r))
    j = await jsonOf(['org', 'draft', '--from', draftFile, '--apply', '--yes'])
    check(j.r.code === 0 && j.v?.applied === true && Array.isArray(j.v.previousRoles) && j.v.previousRoles.length > 0, 'org draft --from --apply --yes saves and returns previousRoles', show(j.r))
    j = await jsonOf(['org', 'show'])
    check(j.v?.roles?.map((x) => x.slug).sort().join(',') === 'draftdev,draftlead', 'the drafted chart replaced the chart', show(j.r))
    fs.rmSync(draftFile, { force: true })
  }
} catch (e) {
  check(false, 'cli-org ran to the end', e?.stack ?? String(e))
} finally {
  removeFixture(repo)
}

finish('cli-org')
