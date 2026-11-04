/**
 * Renderer-side mirror of the "Practice kit" contracts (src/shared/types.ts on dev at f0009dc, plus the additive
 * `KitPreviewItem.roles` of the kit review follow-up). This branch was cut before that merge, so the shared
 * declarations are not visible here; this module mirrors them field for field and reaches the preload through
 * `window.orgai.kit` with a cast. After the merge, switch the imports to '@shared/types' and drop the cast.
 * `kitApi()` is undefined when the build has no runtime side for it, so callers can hide the surface.
 */

export const KIT_FORMAT = 'orgai.kit/1'
export const KIT_MAX_BYTES = 50 * 1024 * 1024
export const KIT_MAX_ITEMS_PER_KIND = 200
export const KIT_MAX_ITEMS = 500
export const KIT_MAX_CHOICES = 500

export type KitItemKind = 'skill' | 'server' | 'preset' | 'template'

/** The stored ids of one group, or every item. Absent = none. */
export type KitSelection = string[] | 'all'

export interface KitExportInput {
  /** Must come from kit.pickExportPath(). */
  path: string
  include: {
    skills?: KitSelection
    mcpServers?: KitSelection
    connectorPresets?: KitSelection
    templates?: KitSelection
  }
}

export interface KitCounts {
  skills: number
  mcpServers: number
  connectorPresets: number
  templates: number
}

export interface KitExportResult {
  path: string
  counts: KitCounts
  bytes: number
  /** Items left out and why, what the file does not carry. */
  notes: string[]
}

export interface KitPreviewInput {
  /** Must come from kit.pickImportPath(). */
  path: string
}

export type KitItemStatus = 'new' | 'same' | 'different' | 'refused'
export type KitAction = 'add' | 'replace' | 'copy' | 'skip'

/** Elevated grants a template role carries (kit review follow-up). */
export type KitRoleElevatedTool = 'Bash' | 'Edit' | 'Write' | 'NotebookEdit' | 'canSpawn' | 'mcp'

export interface KitTemplateRole {
  name: string
  slug: string
  prompt: string
  elevatedTools: KitRoleElevatedTool[]
}

export interface KitPreviewItem {
  key: string
  kind: KitItemKind
  name: string
  description?: string
  status: KitItemStatus
  /** Preselected: 'add' for new, otherwise 'skip'. */
  action: KitAction
  conflict?: string
  /** False when a replace is not possible. */
  canReplace: boolean
  size: number
  notes: string[]
  refusal?: string
  /** Servers and presets: full command and arguments, or address. Never clamp. */
  command?: string
  secretSlots?: string[]
  perProjectSecrets?: boolean
  files?: string[]
  scripts?: string[]
  roleNames?: string[]
  /** Templates (newer main only): every role with its prompt and elevated grants. */
  roles?: KitTemplateRole[]
}

export interface KitImportPreview {
  path: string
  fileName: string
  digest: string
  bytes: number
  exportedAt?: string
  appVersion?: string
  platform?: string
  items: KitPreviewItem[]
  notes: string[]
}

export interface KitImportChoice {
  key: string
  action: KitAction
}

export interface KitApplyInput {
  path: string
  digest: string
  /** Items without a choice are skipped. At most KIT_MAX_CHOICES. */
  choices: KitImportChoice[]
}

export interface KitNeedsSecrets {
  name: string
  env: string[]
  headers: string[]
  perProject: boolean
}

export interface KitApplyResult {
  added: number
  replaced: number
  copied: number
  skipped: number
  counts: KitCounts
  failed: { key: string; name: string; reason: string }[]
  needsSecrets: KitNeedsSecrets[]
  notes: string[]
}

export interface KitApi {
  /** Main's save dialog; the path or null (cancelled). kit.export accepts only this path, once. */
  pickExportPath(): Promise<string | null>
  /** Main's open dialog; the path or null. Preview and apply accept only this path (kept for "Preview again"). */
  pickImportPath(): Promise<string | null>
  export(input: KitExportInput): Promise<KitExportResult>
  previewImport(input: KitPreviewInput): Promise<KitImportPreview>
  applyImport(input: KitApplyInput): Promise<KitApplyResult>
}

/** window.orgai.kit, or undefined when this build has no runtime side for it. */
export function kitApi(): KitApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window.orgai as unknown as { kit?: KitApi }).kit
}
