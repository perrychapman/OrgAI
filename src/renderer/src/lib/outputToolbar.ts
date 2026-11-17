// Pure rules for the output detail's action toolbar (docs/design/ux-review-outputs-usability.md, outputs-2.md section 7).
// The toolbar at rest holds one primary action for the kind, Add note, Larger view and More. Every other action lives
// in More, and nothing is both in the toolbar and in More. No React, no DOM.
import type { OutputKind } from '@shared/types'

/** The one action the toolbar leads with, or null when the kind has nothing to lead with. */
export type PrimaryAction = 'edit' | 'edit-external' | 'open' | 'revise'

/** Kinds whose preview is the file's own drawing or text. PDF and "other" files have none: the preview says so. */
const NO_PREVIEW: readonly OutputKind[] = ['pdf', 'other']

/** False for pdf and other (the preview is a line of text, so there is nothing to enlarge). */
export function hasPreviewKind(kind: OutputKind): boolean {
  return !NO_PREVIEW.includes(kind)
}

export interface PrimaryInput {
  kind: OutputKind
  missing: boolean
  /** The shown version is the current one. */
  isCurrent: boolean
  /** In-app edit is offered right now: an editable kind, nothing blocking it, not already editing. */
  canEdit: boolean
  /** The app that edits an Office kind outside OrgAI (Word, Excel, PowerPoint), or null. */
  external: string | null
  /** OrgAI can open the file in the computer's own app (canOpenOutput). */
  canOpen: boolean
  /** Asking the team to revise is possible (canReviseFallback). */
  canRevise: boolean
  /** The editor is open: it has its own bar, so the toolbar leads with nothing. */
  editing?: boolean
}

/** Which action leads the toolbar. First match wins. */
export function primaryAction(i: PrimaryInput): PrimaryAction | null {
  if (i.editing) return null
  if (i.missing) return i.canRevise ? 'revise' : null
  if (i.external && i.isCurrent) return 'edit-external'
  if (i.canEdit) return 'edit'
  // An older version cannot be edited or opened as itself: asking for a revision of the current one is the way forward.
  if (!i.isCurrent) return i.canRevise ? 'revise' : i.canOpen ? 'open' : null
  // Current but not editable here (pdf, image, a file too large to edit, svg): open it, else ask for a revision.
  if (i.canOpen) return 'open'
  return i.canRevise ? 'revise' : null
}

export interface MenuLead {
  edit: boolean
  editExternal: boolean
  open: boolean
  revise: boolean
}

/** The lead actions that go into More: every one that is available and is not the toolbar's primary. */
export function menuLeadActions(
  primary: PrimaryAction | null,
  avail: { canEdit: boolean; canEditExternal: boolean; canOpen: boolean; canRevise: boolean }
): MenuLead {
  return {
    edit: avail.canEdit && primary !== 'edit',
    editExternal: avail.canEditExternal && primary !== 'edit-external',
    open: avail.canOpen && primary !== 'open',
    revise: avail.canRevise && primary !== 'revise'
  }
}

/** Number of controls the toolbar shows at rest: the primary, Add note (when the kind has notes), Larger view (panel, kinds with a preview) and More. */
export function toolbarControlCount(o: { primary: PrimaryAction | null; notes: boolean; larger: boolean }): number {
  return (o.primary ? 1 : 0) + (o.notes ? 1 : 0) + (o.larger ? 1 : 0) + 1
}

/** The few DOM members `overlayOwnsEscape` reads, so the rule is testable without a DOM. */
export interface EscapeTarget {
  closest(selector: string): unknown
  getAttribute(name: string): string | null
}

/**
 * Whether an Escape keydown at `target` belongs to a menu or dialog and must not close the detail. Inside a popover,
 * dialog or role=dialog it does. So does the popover's own trigger while that popover is open: the menu moves focus in
 * only a frame or more after it opens, and an Escape that lands in between has the trigger as its target, which would
 * otherwise read as "leave the detail" (the platform closes the menu on the same key).
 * `popoverById` returns whether the element with that id is a popover (`[popover]`).
 */
export function overlayOwnsEscape(target: EscapeTarget | null, popoverById: (id: string) => boolean): boolean {
  if (!target) return false
  if (target.closest('[popover], dialog, [role=dialog]')) return true
  const controls = target.getAttribute('aria-controls')
  return target.getAttribute('aria-expanded') === 'true' && controls !== null && popoverById(controls)
}
