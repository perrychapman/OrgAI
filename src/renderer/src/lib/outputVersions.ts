// Pure wording for output versions (docs/design/outputs-2.md 7, 10, 12). No React, no DOM, no store.
import type { OutputDeletePreview, OutputVersion, RunOutput } from '@shared/types'
import { formatBytes } from './outputs'

/** "7 Nov" (local, no year; '' when unusable). */
export function shortDate(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** "7 Nov 11:04" (local, 24-hour). */
export function shortDateTime(ms: number | undefined): string {
  const d = shortDate(ms)
  if (!d) return ''
  return `${d} ${new Date(ms as number).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

/** Who made a version, in a few words ("Analyst", "edited by you"). */
function whoShort(v: OutputVersion): string {
  switch (v.source) {
    case 'edit':
      return 'edited by you'
    case 'external':
      return 'changed outside OrgAI'
    case 'restore':
      return v.restoredFrom ? `restored from version ${v.restoredFrom}` : 'restored'
    default:
      return v.role?.trim() || 'an agent'
  }
}

/** The version select's option: "v3 · now, Analyst · 7 Nov", "v2 · edited by you · 7 Nov"; a name replaces nothing but sits after the number. */
export function versionOptionLabel(v: OutputVersion, currentN: number): string {
  const who = v.n === currentN ? `now, ${whoShort(v)}` : whoShort(v)
  return [`v${v.n}`, v.label?.trim(), who, shortDate(v.createdAt)].filter(Boolean).join(' · ')
}

export interface VersionSourceInput {
  /** The version is the oldest one kept (it reads "Produced by"). */
  first: boolean
  /** "R2" for the run that made it, when known. */
  runTag?: string
  /** Notes the request it answers carried. */
  answeredNotes?: number
}

/** "Produced by Analyst · R2", "Updated by Analyst · R3 (answering 2 notes)", "Edited by you", "Changed outside OrgAI", "Restored from version 1". */
export function versionSourceText(v: OutputVersion, o: VersionSourceInput): string {
  switch (v.source) {
    case 'edit':
      return 'Edited by you'
    case 'external':
      return 'Changed outside OrgAI'
    case 'restore':
      return v.restoredFrom ? `Restored from version ${v.restoredFrom}` : 'Restored from an earlier version'
    default: {
      const who = v.role?.trim() || 'An agent'
      const lead = `${o.first ? 'Produced' : 'Updated'} by ${who}`
      const n = o.answeredNotes ?? 0
      const answer = n > 0 ? ` (answering ${n} ${n === 1 ? 'note' : 'notes'})` : ''
      return `${[lead, o.runTag].filter(Boolean).join(' · ')}${answer}`
    }
  }
}

/** "+2.1 KB" / "-300 bytes" against the version before; '' for the first version or no change. */
export function sizeDelta(prevBytes: number | undefined, bytes: number): string {
  if (prevBytes === undefined || !Number.isFinite(prevBytes) || !Number.isFinite(bytes) || prevBytes === bytes) return ''
  const d = bytes - prevBytes
  return `${d > 0 ? '+' : '-'}${formatBytes(Math.abs(d))}`
}

/** "2 open notes" / "1 open note"; '' for none. */
export function openNotesText(n: number): string {
  return n > 0 ? `${n} open ${n === 1 ? 'note' : 'notes'}` : ''
}

export const restoredNotice = (from: number, to: number): string => `Restored version ${from} as version ${to}.`
export const externalNotice = (n: number, app: string): string => `Version ${n} added from your changes in ${app}.`
export const oldVersionText = (viewing: number, current: number): string => `You are looking at version ${viewing}. The current version is ${current}.`
export const VERSIONS_PRUNED_TEXT = 'Older versions were removed to save space.'
export const VERSIONS_FIRST_TEXT = 'This is version 1. Later changes appear here.'
export const VERSION_NAME_MAX = 60

/** Parts of a confirm: a lead, an optional path to show in code, a tail. */
export interface DeleteCopy {
  title: string
  lead: string
  path?: string
  tail: string
  confirmLabel: string
}

const trashText = (trash: boolean): string => (trash ? 'The file goes to the Recycle Bin or Trash when your computer has one.' : 'Your computer has no Recycle Bin or Trash here, so the file is deleted for good.')

/** The three wordings of 12.4 from main's deletePreview. */
export function deleteCopy(title: string, output: Pick<RunOutput, 'source'>, p: OutputDeletePreview): DeleteCopy {
  if (p.missing) {
    return { title: `Remove ${title} from OrgAI?`, lead: 'The file is already gone. This removes the output and its stored versions.', tail: '', confirmLabel: 'Remove' }
  }
  const earlier = Math.max(0, p.versions - 1)
  if (p.outsideOutputsFolder || output.source === 'registered') {
    return {
      title: `Delete ${title} and its file?`,
      lead: 'This deletes',
      path: p.path,
      tail: `, a file the team registered. It is not in OrgAI's outputs folder. ${trashText(p.trash)} OrgAI's stored versions are deleted too.`,
      confirmLabel: 'Delete'
    }
  }
  const versions = earlier > 0 ? ` and its ${earlier} earlier ${earlier === 1 ? 'version' : 'versions'}` : ''
  return { title: `Delete ${title}?`, lead: `This deletes ${p.relPath}${versions} from your computer. ${trashText(p.trash)}`, tail: '', confirmLabel: 'Delete' }
}

/** "Delete 3 outputs?" with the totals: files that still exist and every stored version. */
export function bulkDeleteCopy(previews: readonly OutputDeletePreview[]): { title: string; lead: string } {
  const n = previews.length
  const files = previews.filter((p) => !p.missing).length
  const versions = previews.reduce((s, p) => s + p.versions, 0)
  const noTrash = previews.some((p) => !p.missing && !p.trash)
  const f = `${files} ${files === 1 ? 'file' : 'files'}`
  const v = `${versions} stored ${versions === 1 ? 'version' : 'versions'}`
  return {
    title: `Delete ${n} ${n === 1 ? 'output' : 'outputs'}?`,
    lead: `This deletes ${f} and ${v}. ${noTrash ? 'Some files cannot go to the Recycle Bin or Trash and are deleted for good.' : 'The files go to the Recycle Bin or Trash when your computer has one.'}`
  }
}

export const forgetBody = (relPath: string): string => `The file stays at ${relPath}. OrgAI's earlier versions and notes are deleted.`

export const DELETE_CHANGED = 'This output changed. Check it and delete again.'
