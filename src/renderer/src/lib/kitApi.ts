/**
 * Accessor for the "Practice kit" contracts. The types and limits live in '@shared/types' and are re-exported here so
 * callers keep one import. `kitApi()` is undefined when the build has no runtime side for it, so callers can hide the
 * surface.
 */

import { KIT_FORMAT, KIT_MAX_BYTES, KIT_MAX_CHOICES, KIT_MAX_ITEMS, KIT_MAX_ITEMS_PER_KIND, type KitPreviewRole, type OrgAIApi } from '@shared/types'

export { KIT_FORMAT, KIT_MAX_BYTES, KIT_MAX_CHOICES, KIT_MAX_ITEMS, KIT_MAX_ITEMS_PER_KIND }
export type {
  KitAction,
  KitApplyInput,
  KitApplyResult,
  KitCounts,
  KitExportInput,
  KitExportResult,
  KitImportChoice,
  KitImportPreview,
  KitItemKind,
  KitItemStatus,
  KitNeedsSecrets,
  KitPreviewInput,
  KitPreviewItem,
  KitPreviewRole,
  KitSelection
} from '@shared/types'

/** Elevated grants a template role carries. */
export type KitRoleElevatedTool = KitPreviewRole['elevatedTools'][number]
export type KitTemplateRole = KitPreviewRole

export type KitApi = OrgAIApi['kit']

/** window.orgai.kit, or undefined when this build has no runtime side for it. */
export function kitApi(): KitApi | undefined {
  if (typeof window === 'undefined') return undefined
  return window.orgai?.kit
}
