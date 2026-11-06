/** `orgai worktrees` (cli-spec 6.3, Wave 5): leftover report branches. Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'worktrees',
  summary: 'Agent worktrees (pending report branches)',
  usage: 'worktrees list | diff <branch> [--pager] | merge <branch> | discard <branch> [--yes] | uninstall [--yes]',
  subcommands: ['list', 'diff', 'merge', 'discard', 'uninstall'],
  flags: [
    { name: 'pager', takesValue: false, summary: 'diff: show it in $PAGER (or less / more)' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'discard / uninstall: confirm without asking' }
  ],
  available: true
}
