/** `orgai skills` (cli-spec 6.3, Wave 5). Pure data: what help, routing and completions read. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'skills',
  summary: 'Project skills, the skill library, repo import, evaluation and the Skill assistant',
  usage:
    'skills list | show <skill> | create --name <n> --description <d> (--file <path|-> | --text <body>) [--role <slug>]... | update <skill> [--name] [--description] [--file|--text] [--enable|--disable] [--role <slug>]... [--no-roles] | remove <skill> [--yes] | link <libraryId> [--role <slug>]... | promote <skill> | import [--skill <name>]... [--yes] | undo-import <undoId> | evaluate | evaluation | apply-suggestion <id> [--role <slug>]... | library list|show <id>|add <folder> [--name <n>]|create|update <id>|remove <id> [--yes] | assist ["<goal>"] [--library]',
  subcommands: ['list', 'show', 'create', 'update', 'remove', 'link', 'promote', 'import', 'undo-import', 'evaluate', 'evaluation', 'apply-suggestion', 'library', 'assist'],
  flags: [
    { name: 'name', takesValue: true, summary: 'create / update / library add: the skill name' },
    { name: 'description', takesValue: true, summary: 'create / update: when to use the skill' },
    { name: 'file', takesValue: true, summary: 'create / update: the instructions from a file (- for stdin)' },
    { name: 'text', takesValue: true, summary: 'create / update: the instructions as text' },
    { name: 'role', takesValue: true, summary: 'Grant to this role (slug, id or name; repeatable)' },
    { name: 'no-roles', takesValue: false, summary: 'update: grant to no role' },
    { name: 'enable', takesValue: false, summary: 'update: pass the skill to runs' },
    { name: 'disable', takesValue: false, summary: 'update: keep the skill but do not pass it to runs' },
    { name: 'skill', takesValue: true, summary: 'import: only this skill (name or folder; repeatable)' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'Confirm without asking' },
    { name: 'library', takesValue: false, summary: 'assist: work on the app-wide skill library' },
    { name: 'inline', takesValue: false, summary: 'assist: draw in the normal scrollback' },
    { name: 'ax-screen-reader', takesValue: false, summary: 'assist: screen reader mode' }
  ],
  available: true
}
