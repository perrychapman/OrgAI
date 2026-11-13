/** `orgai org` (cli-spec 6.3, Wave 5): the org chart and the Team assistant. Pure data. */
import { AGENT_IMPORT_SOURCES } from '../../shared/types'
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'org',
  summary: 'Org chart and Team assistant',
  usage:
    'org show | export | import [--source <id>...] [--mode merge|replace] [--yes] | retro <runRef> [--unattended [--apply]] | evolve [--runs N] [--goal balanced|cost|speed] [--strategy deterministic|hybrid] [--min-waste <0-100>] [--apply | -y] | evolve history | evolve rollback [genId] | evolve loop --prompt "<task>" [--iterations K] | draft "<description>" [--mode replace|revise|merge] [--apply [--yes]] | draft --from <file.json> --apply [--mode replace|merge] [--yes] | revise "<instruction>" | discover [--outside] | recommend [--outside] [--role <role>] | review [--recheck [--outside] [--model]] | apply <recommendationId> [--candidate <id>] [--role <role>...] [--access read|full] | undo <undoId> | dismiss <id> [--candidate] | restore <candidateId>',
  subcommands: ['show', 'import', 'export', 'retro', 'evolve', 'draft', 'revise', 'discover', 'recommend', 'review', 'apply', 'undo', 'dismiss', 'restore'],
  flags: [
    { name: 'source', takesValue: true, values: AGENT_IMPORT_SOURCES, summary: 'import: only this source (repeatable; default every source found)' },
    { name: 'mode', takesValue: true, values: ['merge', 'replace', 'revise'], summary: 'import: merge (default) or replace the chart; draft: revise (default) or replace; draft --apply: replace (default) or merge' },
    { name: 'apply', takesValue: false, summary: 'draft: save the drafted chart (preview, then confirm or --yes); evolve / retro --unattended: apply the plan as a trial generation' },
    { name: 'from', takesValue: true, summary: 'draft --apply: a draft file printed earlier with --output-format json' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'Confirm without asking' },
    { name: 'inline', takesValue: false, summary: 'retro / revise: draw the terminal UI in the normal scrollback' },
    { name: 'ax-screen-reader', takesValue: false, summary: 'retro / revise: screen reader mode' },
    { name: 'outside', takesValue: false, summary: 'discover / recommend / review --recheck: also search outside sources (network)' },
    { name: 'query', takesValue: true, summary: 'discover: extra registry search words' },
    { name: 'role', takesValue: true, summary: 'recommend: one role; apply: the roles that get it (repeatable)' },
    { name: 'runs', takesValue: true, summary: 'evolve / retro --unattended: finished work runs to read (1-50, default 10)' },
    { name: 'goal', takesValue: true, values: ['balanced', 'cost', 'speed'], summary: 'evolve / loop: what staffing favors (default: the project\'s)' },
    { name: 'strategy', takesValue: true, values: ['deterministic', 'hybrid'], summary: 'evolve / loop: deterministic (default, no tokens) or hybrid (one tracked model call)' },
    { name: 'min-waste', takesValue: true, summary: 'evolve: below this waste score (0-100, default 15) the plan is empty' },
    { name: 'eval-window', takesValue: true, summary: 'evolve --apply / loop: runs a trial is measured over (1-10, default 3)' },
    { name: 'iterations', takesValue: true, summary: 'evolve loop: how many runs (1-10, default 3)' },
    { name: 'prompt', takesValue: true, summary: 'evolve loop: the task each run gets' },
    { name: 'prompt-file', takesValue: true, summary: 'evolve loop: read the task from this file ("-" reads stdin)' },
    { name: 'unattended', takesValue: false, summary: 'retro: no terminal; run the evolution analysis on the run\'s project' },
    { name: 'recheck', takesValue: false, summary: 'review: run a manual re-check now' },
    { name: 'model', takesValue: false, summary: 'review --recheck: also run the recommendation model step' },
    { name: 'candidate', takesValue: true, summary: 'apply: the candidate id; dismiss: the id is a candidate id (no value)' },
    { name: 'access', takesValue: true, values: ['read', 'full'], summary: 'apply: read or full access (default: the recommendation’s)' }
  ],
  available: true,
  notes: [
    'org evolve: reads the newest finished work runs of the project and prints a waste digest, the proposed role / tier / effort / skill changes (checked by a safety gate) and the estimated savings. It changes nothing unless you pass --apply (or -y), which applies the plan as a trial generation that rolls back by itself when the next runs get worse. The default strategy is deterministic and spends nothing; --strategy hybrid makes one tracked model call.',
    'org evolve history (alias status) shows the champion, the active trial, each generation\'s cost / time / token / first-pass figures and the rejected hypotheses. org evolve rollback [genId] undoes a generation. org evolve loop runs the task K times (default 3, at most 10) on one in-process host with the ratchet between runs and stops early on a failed or refused run; --max-budget and --max-cost apply to each run, not to the loop as a whole. All of them work without a terminal and with --output-format json.',
    'org retro <runRef> --unattended: the headless retrospective. The interactive retro is a Team assistant session and needs a terminal; the unattended form runs the team-evolution analysis on the run\'s project instead (and says so), and with --apply applies only what the safety gate allows.'
  ]
}
