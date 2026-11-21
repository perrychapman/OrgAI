import type { TodoItem } from '@shared/types'

/**
 * The pure model of the Dashboard's To-dos section (docs/design/dashboard-overhaul.md 7.5; the schedule half of the old
 * Today section is `lib/upNext.ts`): which open to-dos could start a session. No DOM, no store.
 */

export interface TodoRow {
  item: TodoItem
  /** The project name, or "Chat". */
  list: string
  agentAdded: boolean
}

/**
 * Open items (status not 'done') across every loaded list, newest `updatedAt` first. Items of a project that is no longer
 * stored are left out.
 */
export function openTodoRows(listsByScope: Readonly<Record<string, readonly TodoItem[] | undefined>>, projects: readonly { id: string; name: string }[]): TodoRow[] {
  const rows: TodoRow[] = []
  for (const list of Object.values(listsByScope)) {
    for (const item of list ?? []) {
      if (item.status === 'done') continue
      let name: string
      if (item.scope.kind === 'chat') name = 'Chat'
      else {
        const projectId = item.scope.projectId
        const p = projects.find((x) => x.id === projectId)
        if (!p) continue
        name = p.name
      }
      rows.push({ item, list: name, agentAdded: item.createdBy === 'agent' })
    }
  }
  return rows.sort((a, b) => b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id))
}
