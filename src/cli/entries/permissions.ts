/** `orgai permissions` (cli-spec 6.3, Wave 5): saved rules, the permission mode and extra folders. Pure data. */
import { PERMISSION_MODES } from '../../shared/types'
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'permissions',
  summary: 'Saved permission rules, mode and folders',
  usage: `permissions list | add <rule> | remove <rule> | mode [${PERMISSION_MODES.join('|')}] | folders [list|add <dir>|remove <dir>] | reference [list|add <dir>|remove <dir>]`,
  subcommands: ['list', 'add', 'remove', 'mode', 'folders', 'reference'],
  flags: [],
  available: true
}
