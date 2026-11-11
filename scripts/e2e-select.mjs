// Picks the e2e:free scripts a change needs (owner decision 2026-11-10: pushes and pull requests to dev run the scripts of
// the changed area plus a small smoke set; the full chain runs for pull requests into main, pushes to main, the nightly
// run and manual dispatch).
//
//   node scripts/e2e-select.mjs --base <sha> --head <sha> [--print | --run]
//   node scripts/e2e-select.mjs --full [--print | --run]
//
// --print (the default) prints the decision, --run also runs the chosen scripts in chain order and stops at the first
// failure with its exit code, --ci takes the plan from the E2E_* environment variables (ciPlan; used by ci.yml so the step
// is one shell-neutral line), --full forces the whole chain. --range two|three picks `git diff base head` (pushes: base
// is the last green commit) or `base...head` (pull requests, the default). Exit 2 on a malformed or empty chain. No dependencies.
//
// The script list is read from the e2e:free entry in package.json (the single source of truth). The table below maps a
// changed path to the scripts that exercise it. Rules are tried in order and the first match wins, so put narrow rules
// before broad ones. FAIL OPEN: a path no rule matches means the full chain, and so does an empty or unreadable diff.
// When unsure whether a path is narrow, leave it out of the table.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Added to every `selected` result that touched code: one renderer flow, the run flow and the CLI host. */
export const SMOKE = ['layout', 'runs', 'cli-readonly']

const R = 'src/renderer/src/'
const C = `${R}components/`
const S = `${R}styles/`
const L = `${R}lib/`

// Script groups used by several rules.
const KNOWLEDGE = ['knowledge', 'knowledge-graph', 'knowledge-run']
const OUTPUTS = ['outputs', 'outputs-versions', 'outputs-notes', 'outputs-slides']
const USAGE = ['usage', 'usage-app']
const PROJECT_FORM = ['dashboard', 'layout', 'engagement', 'engagement2', 'clone-start', 'import', 'team-files', 'project-connection']
const RUN_VIEW = ['runs', 'run-start', 'model-switch', 'org-change', 'menu', 'usage']

/**
 * Each rule: `match` (globs: `**` crosses folders, `*` does not), `scripts` (names from the e2e:free chain), `why`, and
 * optional `kind`: 'full' forces the whole chain; 'none' marks a file no e2e can be affected by (tests, docs): it adds no
 * scripts and, when every changed file is 'none', no smoke set either. A rule without `kind` is narrow code: its scripts
 * plus the smoke set. Verified by reading the e2e script headers and docs/agent-notes; see e2e/README.md.
 */
export const RULES = [
  // ---- files no e2e run depends on (unit tests, docs, repo chores) ----
  { match: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.mjs'], kind: 'none', scripts: [], why: 'unit test file' },
  // Markdown the app bundles for Ask OrgAI about itself (src/main/reference/docs.ts); self-help.mjs searches it.
  { match: ['README.md', 'docs/how-it-works.md', 'docs/design/*.md'], scripts: ['self-help'], why: 'bundled in-app reference docs' },
  { match: ['**/*.md', 'docs/**', '.orgai/**', '.claude/**', 'LICENSE'], kind: 'none', scripts: [], why: 'docs or agent notes' },
  { match: ['.github/workflows/**'], kind: 'full', scripts: [], why: 'CI workflow change' },
  { match: ['.github/**'], kind: 'none', scripts: [], why: 'GitHub metadata (templates, dependabot)' },
  { match: ['scripts/smoke-*.mjs', 'scripts/probe-*.mjs', 'scripts/readme-media.mjs', 'scripts/measure-prompt-size.mjs', 'scripts/list-proxy-models.mjs'], kind: 'none', scripts: [], why: 'manual helper script no e2e runs' },
  { match: ['e2e/setup.mjs', 'e2e/history.mjs', 'e2e/worktree.mjs', 'e2e/shots/**'], kind: 'none', scripts: [], why: 'token-spending e2e or screenshots, not part of the free chain' },

  // ---- shared or hot paths: every flow passes through them ----
  { match: ['scripts/e2e-select.mjs'], kind: 'full', scripts: [], why: 'the selector itself changed' },
  { match: ['e2e/lib.mjs', 'e2e/cliLib.mjs', 'e2e/privateDir.mjs'], kind: 'full', scripts: [], why: 'shared e2e helper' },
  { match: ['package.json', 'package-lock.json'], kind: 'full', scripts: [], why: 'dependencies or scripts changed' },
  { match: ['electron.vite.config.ts', 'vite.cli.config.ts', 'vitest.config.ts', 'tsconfig*.json', 'electron-builder*', '**/index.html'], kind: 'full', scripts: [], why: 'build or compiler config' },
  { match: ['src/shared/**', 'src/preload/**'], kind: 'full', scripts: [], why: 'shared contracts and preload cross IPC for every flow' },
  { match: ['src/main/runtime/runManager.ts', 'src/main/runtime/mock.ts', 'src/main/runtime/harnessTools.ts', 'src/main/runtime/types.ts', 'src/main/ipc.ts', 'src/main/index.ts', 'src/main/store/**', 'src/main/host/**'], kind: 'full', scripts: [], why: 'hot main-process file every flow passes through' },

  // ---- e2e helpers that belong to one script ----
  { match: ['e2e/ptyDriver.mjs', 'e2e/pty-helper.py'], scripts: ['cli-tui'], why: 'pseudo-terminal driver of cli-tui' },
  { match: ['e2e/dialog-stub.cjs'], scripts: ['separation'], why: 'dialog stub of separation' },
  { match: ['e2e/office.mjs', 'e2e/pocket-office.mjs'], scripts: ['canvas'], why: 'Pocket Office checks canvas.mjs imports' },
  { match: ['e2e/outputs-compare.part.mjs', 'e2e/outputs-edit.part.mjs'], scripts: ['outputs-versions'], why: 'part called by outputs-versions' },
  { match: ['e2e/outputs-revise.part.mjs'], scripts: ['outputs-notes'], why: 'part called by outputs-notes' },

  // ---- renderer, narrow feature areas (specific files first) ----
  { match: [`${C}settings/CliCommandRow.tsx`], scripts: ['install-row'], why: 'Terminal install row' },
  { match: [`${C}settings/CanvasSection.tsx`], scripts: ['canvas'], why: 'canvas settings' },
  { match: [`${C}settings/FolderTrustSection.tsx`, `${C}settings/useFolderTrustReview.ts`], scripts: ['folder-trust'], why: 'folder trust settings' },
  { match: [`${C}settings/PermissionsSection.tsx`, `${C}settings/AllowedDirectoriesSection.tsx`], scripts: ['permissions'], why: 'permission settings' },
  { match: [`${C}settings/ModelPricesSection.tsx`], scripts: ['usage'], why: 'model prices' },
  { match: [`${C}settings/ContextNotesSection.tsx`, `${C}settings/EngagementPlanSection.tsx`, `${C}settings/ReferenceDirectoriesSection.tsx`], scripts: ['engagement', 'engagement2'], why: 'engagement settings' },
  { match: [`${C}settings/MaintenanceSection.tsx`], scripts: ['maintenance'], why: 'maintenance panel' },
  { match: [`${C}settings/**`, `${R}views/SettingsView.tsx`, `${R}views/AppSettingsView.tsx`, `${S}settings.css`, `${S}model-prices.css`], scripts: ['connections', 'permissions', 'folder-trust', 'engagement', 'engagement2', 'canvas', 'install-row', 'usage', 'maintenance', 'self-help'], why: 'settings pages' },

  { match: [`${C}team/TeamFiles*`, `${C}team/useTeamFilesActions.ts`, `${L}teamFiles.ts`, `${L}teamFound.ts`, `${S}teamFiles.css`, `${S}teamFound.css`, `${C}dashboard/TeamFoundPanel.tsx`], scripts: ['team-files'], why: 'team files UI' },
  { match: [`${C}team/OrgChangePointer.tsx`, `${C}team/useOrgChange.ts`, `${L}orgChange.ts`], scripts: ['org-change'], why: 'org change sessions' },
  { match: [`${C}team/**`, `${R}views/TeamView.tsx`, `${S}team.css`, `${L}roleCapabilities.ts`, `${L}roleModels.ts`, `${L}roleOps.ts`, `${L}roleStaffing.ts`, `${L}teamView.ts`, `${L}orgDiff.ts`], scripts: ['team', 'org-change', 'multi-provider'], why: 'Team tab' },
  { match: [`${C}templates/**`, `${L}templates.ts`], scripts: ['engagement2'], why: 'team templates' },
  { match: [`${C}import/**`, `${S}import.css`, `${L}agentImport.ts`], scripts: ['import'], why: 'agent import' },

  { match: [`${C}dashboard/SecretNotices.tsx`], scripts: ['secrets-notices'], why: 'secure storage notices' },
  { match: [`${C}dashboard/RepoStartPanel.tsx`, `${L}repoStart.ts`, `${L}repoCloneSession.ts`], scripts: ['clone-start'], why: 'From GitHub start' },
  { match: [`${C}dashboard/NewProjectForm.tsx`, `${C}dashboard/NewProjectDialog.tsx`], scripts: PROJECT_FORM, why: 'New project form is driven by many scripts' },
  { match: [`${C}dashboard/ProjectTile.tsx`], scripts: ['dashboard', 'engagement'], why: 'project tile (client display)' },
  { match: [`${C}dashboard/**`, `${R}views/DashboardView.tsx`, `${S}dashboard*.css`, `${L}dashboard*.ts`, `${L}setupGaps.ts`], scripts: ['dashboard'], why: 'Dashboard' },

  { match: [`${C}knowledge/**`, `${R}views/KnowledgeView.tsx`, `${L}knowledge*.ts`, `${L}runKnowledge.ts`, `${S}knowledge*.css`], scripts: KNOWLEDGE, why: 'Knowledge tab and graph' },
  { match: [`${C}outputs/**`, `${R}views/OutputsView.tsx`, `${L}output*.ts`, `${L}csvGrid.ts`, `${L}slideStage.ts`, `${L}diagram*.ts`, `${S}outputs*.css`], scripts: OUTPUTS, why: 'Outputs' },
  { match: [`${C}usage/**`, `${C}Usage*.tsx`, `${R}views/UsageView.tsx`, `${L}usage*.ts`, `${L}trends.ts`, `${L}modelPrices.ts`, `${S}usage*.css`, `${S}history-trends.css`], scripts: USAGE, why: 'Usage pages' },
  { match: [`${C}connectors/**`, `${S}connectors.css`, `${L}connector*.ts`, `${L}roleServices.ts`], scripts: ['connectors', 'presets', 'team'], why: 'Connectors' },
  { match: [`${C}connections/**`, `${S}connections.css`, `${S}project-connection.css`, `${L}proxy*.ts`, `${L}remap.ts`, `${L}tierMapping.ts`, `${C}Remap*.tsx`, `${C}ProviderAuthPicker.tsx`], scripts: ['connections', 'project-connection', 'multi-provider'], why: 'Connections' },
  { match: [`${C}mcp/**`, `${C}McpInstallCard.tsx`, `${S}mcp*.css`, `${L}mcp*.ts`], scripts: ['per-project', 'presets', 'connections', 'proposals'], why: 'MCP settings and install card' },
  { match: [`${C}skills/**`, `${S}skill-library.css`, `${L}skills.ts`, `${L}skillProposal.ts`], scripts: ['skills'], why: 'Skills' },

  { match: [`${C}canvas/**`, `${S}canvas*.css`, `${S}flow.css`, `${S}office.css`, `${L}canvas*.ts`, `${L}office/**`], scripts: ['canvas'], why: 'canvas themes and Pocket Office' },
  { match: [`${C}AgentNode.tsx`, `${C}DoneGroupNode.tsx`, `${C}RoleNode.tsx`], scripts: ['canvas', 'runs', 'team'], why: 'canvas nodes' },
  { match: [`${C}LiveModelSwitch.tsx`, `${S}live-model-switch.css`, `${L}liveModelSwitch.ts`, `${C}runSettings/**`, `${S}run-settings.css`, `${L}runSettings.ts`, `${L}runGoal.ts`], scripts: ['run-start', 'model-switch'], why: 'run settings row and live model switch' },
  { match: [`${C}assistants/**`, `${S}assistants.css`, `${L}assistantNav.ts`, `${L}assistants.ts`,`${L}selfHelpRows.ts`], scripts: ['assistants', 'self-help'], why: 'Chat, MCP and Skill assistants, self-help' },
  { match: [`${C}PermissionCard.tsx`, `${C}PermissionRulesPanel.tsx`, `${C}RuleRequestCard.tsx`, `${S}permissions.css`, `${L}chatPermissions.ts`, `${L}rulesChange.ts`, `${L}ignoredRules.ts`], scripts: ['permissions', 'folder-trust'], why: 'permission cards and rules' },
  { match: [`${C}FolderTrustNotice.tsx`, `${L}folderTrust.ts`], scripts: ['folder-trust'], why: 'folder trust notice' },
  { match: [`${C}ProposalCard.tsx`, `${C}proposals/**`, `${S}proposals.css`,`${L}proposalSummary.ts`, `${L}appSettingsCard.ts`], scripts: ['proposals', 'self-help'], why: 'proposal cards' },
  { match: [`${C}DecisionCard.tsx`, `${C}DecisionTray.tsx`, `${C}QuestionCard.tsx`, `${C}MergeReviewCard.tsx`, `${L}decisionTitle.ts`], scripts: ['proposals', 'permissions', 'runs'], why: 'decision cards' },
  { match: [`${L}transcriptMedia.ts`], scripts: ['transcript-media', 'runs'], why: 'transcript media' },
  { match: [`${C}TranscriptPanel.tsx`, `${S}transcript.css`, `${L}transcript*.ts`], scripts: ['runs', 'transcript-media', 'knowledge-run', 'outputs'], why: 'transcript rendering' },
  { match: [`${R}views/LiveRunView.tsx`, `${C}RunTabs.tsx`, `${C}RunHistory.tsx`, `${C}RunMeta.tsx`, `${C}RunActions.tsx`, `${C}RunLabel.tsx`, `${C}FinishedList.tsx`, `${S}run.css`, `${S}run-tabs.css`, `${L}run*.ts`, `${L}chainView.ts`], scripts: RUN_VIEW, why: 'live run view' },
  { match: [`${C}AppMenuLayer.tsx`, `${C}KeyboardShortcutsDialog.tsx`, `${S}menu.css`, `${L}menu*.ts`, `${L}useAppMenu.ts`, 'src/main/appMenu.ts'], scripts: ['menu', 'self-help'], why: 'application menu' },
  { match: [`${S}motion.css`, `${L}motion.ts`, `${L}layoutMotion.ts`], scripts: ['motion', 'layout', 'canvas', 'dashboard'], why: 'motion tokens' },

  // ---- main process, narrow areas ----
  { match: ['src/main/runtime/codexBinary.ts'], scripts: ['connections', 'project-connection', 'multi-provider', 'cli-connections'], why: 'Codex binary discovery (connection status)' },
  { match: ['src/main/runtime/codex*.ts', 'src/main/runtime/fixtures/**'], scripts: [], why: 'Codex adapter: no e2e uses a real adapter; unit tests plus the smoke set (the app still launches)' },
  { match: ['src/main/runtime/folderConfigTrust.ts'], scripts: ['folder-trust'], why: 'folder config trust' },
  { match: ['src/main/runtime/modelHandoff.ts'], scripts: ['model-switch', 'runs'], why: 'model handoff' },
  { match: ['src/main/runtime/worktrees.ts', 'src/main/runtime/repoLock.ts', 'src/main/maintenance*.ts'], scripts: ['maintenance', 'cli-org'], why: 'worktrees and maintenance' },
  { match: ['src/main/connections/**'], scripts: ['connections', 'project-connection', 'multi-provider', 'run-start', 'cli-connections'], why: 'connection service and catalog' },
  { match: ['src/main/mcp/**'], scripts: ['connectors', 'presets', 'per-project', 'connections', 'proposals', 'cli-mcp'], why: 'MCP registry, connectors, OAuth' },
  { match: ['src/main/capabilities/**'], scripts: ['team', 'skills', 'connectors'], why: 'capability service (Team catalog)' },
  { match: ['src/main/skills/**'], scripts: ['skills', 'assistants', 'cli-skills-kit'], why: 'skills service' },
  { match: ['src/main/kit/**'], scripts: ['cli-skills-kit'], why: 'practice kit' },
  { match: ['src/main/outputs/**', 'src/main/outputsIpc.ts'], scripts: OUTPUTS, why: 'run outputs' },
  { match: ['src/main/quick/**'], scripts: ['assistants', 'self-help'], why: 'Chat and quick runs' },
  { match: ['src/main/reference/**'], scripts: ['self-help'], why: 'self-knowledge' },
  { match: ['src/main/repoClone.ts'], scripts: ['clone-start'], why: 'repository clone' },
  { match: ['src/main/usageMonitor.ts'], scripts: USAGE, why: 'usage monitor' },
  { match: ['src/main/teamFiles/**'], scripts: ['team-files', 'cli-org'], why: 'team files' },
  { match: ['src/main/setup/import/**'], scripts: ['import'], why: 'agent import' },
  { match: ['src/main/setup/**'], scripts: ['import', 'org-change', 'team', 'engagement2', 'dashboard'], why: 'setup, org merge, templates' },

  // ---- CLI, by command ----
  { match: ['src/cli/tui/**', 'src/cli/commands/tui.ts', 'src/cli/commands/interactive.ts'], scripts: ['cli-tui'], why: 'terminal UI' },
  { match: ['src/cli/commands/projects.ts', 'src/cli/commands/init.ts', 'src/cli/entries/projects.ts', 'src/cli/entries/init.ts'], scripts: ['cli-projects'], why: 'orgai projects / init' },
  { match: ['src/cli/commands/{org,team,permissions,worktrees}.ts', 'src/cli/entries/{org,team,permissions,worktrees}.ts'], scripts: ['cli-org'], why: 'orgai org / team / permissions / worktrees' },
  { match: ['src/cli/commands/{connections,models,usage,notes}.ts', 'src/cli/entries/{connections,models,usage,notes}.ts'], scripts: ['cli-connections'], why: 'orgai connections / models / usage / notes' },
  { match: ['src/cli/commands/mcp.ts', 'src/cli/commands/mcp/**', 'src/cli/commands/secrets.ts', 'src/cli/entries/{mcp,secrets}.ts'], scripts: ['cli-mcp'], why: 'orgai mcp / secrets' },
  { match: ['src/cli/commands/{skills,kit,knowledge}.ts', 'src/cli/entries/{skills,kit,knowledge}.ts'], scripts: ['cli-skills-kit'], why: 'orgai skills / kit / knowledge' },
  { match: ['src/cli/commands/exec.ts'], scripts: ['cli-exec'], why: 'orgai exec' },
  { match: ['src/cli/commands/{runs,status,doctor,completions}.ts', 'src/cli/doctor/**'], scripts: ['cli-readonly', 'cli-exec'], why: 'read-only CLI commands' },
]

// ---------------------------------------------------------------- glob matching

/** Glob to RegExp: `**` any characters, `*` any but `/`, `{a,b}` alternatives, everything else literal. */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      out += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`
      i = end
    } else out += escape(c)
  }
  return new RegExp(`^${out}$`)
}
function escape(s) {
  return s.replace(/[.+^$()|[\]\\?]/g, '\\$&')
}

const COMPILED = RULES.map((r) => ({ rule: r, res: r.match.map(globToRegExp) }))

/** The first rule matching a repo-relative path (any slash style), or null. */
export function ruleFor(path) {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const { rule, res } of COMPILED) if (res.some((re) => re.test(p))) return rule
  // A script of the chain selects itself (checked against the chain in selectE2e).
  const own = /^e2e\/([\w.-]+)\.mjs$/.exec(p)
  return own ? { ownScript: own[1] } : null
}

// ---------------------------------------------------------------- the chain

/** Script names (no folder, no extension) of the `e2e:free` entry, in chain order. */
export function parseChain(pkg) {
  const chain = pkg?.scripts?.['e2e:free']
  if (typeof chain !== 'string') return []
  // Strict: every `&&` segment must be exactly `node e2e/<name>.mjs`. Anything else (an env prefix, a flag, `||`, a
  // different command) would make the parsed list differ from what `npm run e2e:free` runs, so refuse to guess.
  return chain.split('&&').map((seg) => {
    const m = /^node e2e\/([\w.-]+)\.mjs$/.exec(seg.trim())
    if (!m) throw new Error(`e2e:free has a segment that is not "node e2e/<name>.mjs": ${printable(seg.trim())}`)
    return m[1]
  })
}

export function loadChain(root = ROOT) {
  return parseChain(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
}

// ---------------------------------------------------------------- the decision

/** A string safe to print: control characters (newline, ESC, ...) are escaped, so a file name cannot forge log lines or `::` workflow commands. */
export function printable(s) {
  return JSON.stringify(String(s))
    .slice(1, -1)
    .replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * @param {{ changedFiles: string[] | null | undefined, allScripts: string[] }} input
 * @returns {{ mode: 'full' | 'selected', scripts: string[], reasons: string[] }}
 */
export function selectE2e({ changedFiles, allScripts }) {
  const full = (reason) => ({ mode: 'full', scripts: [...allScripts], reasons: [reason] })
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return full('no changed files known (empty or unreadable diff): running everything')
  if (allScripts.length === 0) return full('no e2e:free chain found: running everything')

  const wanted = new Set()
  const reasons = []
  let code = false
  for (const raw of changedFiles) {
    const file = String(raw).replace(/\\/g, '/')
    const shown = printable(file)
    const rule = ruleFor(file)
    if (!rule) return full(`${shown}: no rule maps it to an area, so everything runs`)
    if (rule.ownScript) {
      if (!allScripts.includes(rule.ownScript)) return full(`${shown}: not a script of the e2e:free chain (unknown e2e helper), so everything runs`)
      wanted.add(rule.ownScript)
      code = true
      reasons.push(`${shown}: the script itself`)
      continue
    }
    if (rule.kind === 'full') return full(`${shown}: ${rule.why}, so everything runs`)
    if (rule.kind === 'none') {
      reasons.push(`${shown}: ${rule.why}, no e2e`)
      continue
    }
    code = true
    for (const s of rule.scripts) wanted.add(s)
    reasons.push(`${shown}: ${rule.why} -> ${rule.scripts.length ? rule.scripts.join(', ') : 'smoke set only'}`)
  }
  if (code) {
    for (const s of SMOKE) wanted.add(s)
    reasons.push(`smoke set: ${SMOKE.join(', ')}`)
  } else reasons.push('only tests or docs changed: no e2e script needed')
  // Chain order, and only names the chain really has (a stale table entry cannot select a missing script).
  const scripts = allScripts.filter((s) => wanted.has(s))
  return { mode: 'selected', scripts, reasons }
}

// ---------------------------------------------------------------- git and CLI

const SHA = /^[0-9a-f]{7,64}$/i

/** Changed files between two commits, or null when anything is off (the caller then runs everything). */
export function changedFilesBetween(base, head, cwd = ROOT, range = 'three') {
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) return null
  if (/^0+$/.test(base) || /^0+$/.test(head)) return null
  try {
    // 'two' (pushes): everything that differs between the last green commit and this one, so earlier cancelled or red
    // pushes keep their area. The base must be an ancestor of head; otherwise (rewritten history) null means full.
    // 'three' (pull requests): changes since the merge base.
    if (range === 'two') execFileSync('git', ['merge-base', '--is-ancestor', base, head], { cwd, stdio: 'ignore' })
    const spec = range === 'two' ? [base, head] : [`${base}...${head}`]
    const out = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', ...spec, '--'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

/**
 * What the CI step does, from its environment (E2E_FULL, E2E_EVENT, E2E_BASE, E2E_LAST_GREEN, E2E_HEAD). Pure.
 * Full when E2E_FULL is "true"; a push diffs two-dot from the last green commit; anything else diffs three-dot from the
 * pull request base. Missing or invalid shas are left to changedFilesBetween, which turns them into the full chain.
 */
export function ciPlan(env) {
  if (env.E2E_FULL === 'true') return { full: true }
  if (env.E2E_EVENT === 'push') return { full: false, range: 'two', base: env.E2E_LAST_GREEN, head: env.E2E_HEAD }
  return { full: false, range: 'three', base: env.E2E_BASE, head: env.E2E_HEAD }
}

export function parseArgs(argv, env = {}) {
  const o = { base: undefined, head: undefined, range: 'three', full: false, run: false, print: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ci') Object.assign(o, ciPlan(env))
    else if (a === '--base') o.base = argv[++i]
    else if (a === '--head') o.head = argv[++i]
    else if (a === '--range') {
      o.range = argv[++i]
      if (o.range !== 'two' && o.range !== 'three') throw new Error('--range takes "two" or "three"')
    }
    else if (a === '--full') o.full = true
    else if (a === '--run') o.run = true
    else if (a === '--print') o.print = true
    else throw new Error(`unknown argument: ${printable(a)}`)
  }
  return o
}

function report(decision, allScripts) {
  const lines = [
    `e2e selection: ${decision.mode}, ${decision.scripts.length} of ${allScripts.length} scripts`,
    ...decision.reasons.map((r) => `  - ${r}`),
    `scripts: ${decision.scripts.join(' ') || '(none)'}`,
  ]
  const text = lines.join('\n')
  console.log(text)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    try {
      appendFileSync(summary, `### ${lines[0]}\n\n${lines.slice(1, -1).join('\n')}\n\n`)
    } catch {
      // the log above is enough
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), process.env)
  const allScripts = loadChain()
  if (allScripts.length === 0) throw new Error('the e2e:free chain in package.json is missing or empty')
  let decision
  if (args.full) decision = { mode: 'full', scripts: [...allScripts], reasons: ['--full: the whole chain'] }
  else decision = selectE2e({ changedFiles: changedFilesBetween(args.base, args.head, ROOT, args.range), allScripts })
  report(decision, allScripts)
  if (!args.run) return 0
  for (const name of decision.scripts) {
    console.log(`\n=== node e2e/${name}.mjs`)
    const r = spawnSync(process.execPath, [join('e2e', `${name}.mjs`)], { cwd: ROOT, stdio: 'inherit' })
    const code = r.status ?? 1
    if (code !== 0) {
      console.error(`e2e/${name}.mjs failed with exit code ${code}`)
      return code
    }
  }
  return 0
}

/** True when this file is the entry point. Real paths on both sides: a symlinked tmp dir or checkout must not make main() silently skip. */
function isEntry() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  }
}

if (isEntry()) {
  try {
    process.exitCode = main()
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 2
  }
}
