import { createContext, useContext } from 'react'

/**
 * The selected role's quick actions on the org chart (UI overhaul, Team board): the small toolbar above a selected node.
 * TeamView provides them; RoleNode reads them through context so the node's data (and its memo) stays unchanged.
 * Every action also exists elsewhere: Add a report in the node menu, Move as the inspector's Reports to, Remove in the
 * inspector header and the node menu, Duplicate only here and in the node menu.
 */
export interface RoleNodeActions {
  addReport: (roleId: string) => void
  duplicate: (roleId: string) => void
  move: (roleId: string) => void
  remove: (roleId: string) => void
}

export const RoleNodeActionsContext = createContext<RoleNodeActions | null>(null)

export function useRoleNodeActions(): RoleNodeActions | null {
  return useContext(RoleNodeActionsContext)
}
