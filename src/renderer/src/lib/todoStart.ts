import { useSyncExternalStore } from 'react'
import type { ImageAttachment, TodoItem, TodoScope } from '@shared/types'
import { QUICK_PROJECT_ID } from '@shared/types'
import { todoStartPrompt } from '@shared/todos'
import { clampLabel } from '@shared/view/clampLabel'
import type { ComposerDraft } from '../store/useAppStore'
import { isDraftEmpty, newRunDraftKey, useAppStore } from '../store/useAppStore'
import type { ConfirmOptions } from '../components/ui/ConfirmDialog'

/**
 * Start a session from a to-do (docs/design/todos.md). It only fills the New run / New chat message box and puts the
 * user there; it never sends and never changes the item. The link between the item and the run the user starts is kept
 * here until that draft is sent (`takeTodoStart`) or abandoned (emptied without a send), then written with
 * `todos:linkRun` once the run exists.
 */
export interface TodoStartLink {
  /** The composer draft key the prompt was put in. */
  key: string
  scope: TodoScope
  id: string
  /** The first line of the prefilled draft ("To-do: <title>"). The run is linked only while the sent text still begins with it. */
  lead?: string
}

const pending = new Map<string, TodoStartLink>()
const listeners = new Set<() => void>()
const notify = (): void => {
  for (const l of listeners) l()
}

export const todoDraftKey = (scope: TodoScope): string => newRunDraftKey(scope.kind === 'chat' ? QUICK_PROJECT_ID : scope.projectId)

/** The link waiting on this draft, if any. Call it first thing in the start handler: it consumes the link. */
export function takeTodoStart(key: string): TodoStartLink | undefined {
  const link = pending.get(key)
  if (link) {
    pending.delete(key)
    notify()
  }
  return link
}

/** A start that threw gives its link back (the draft comes back too), unless another to-do took the slot meanwhile. */
export function restoreTodoStart(link: TodoStartLink | undefined): void {
  if (link && !pending.has(link.key)) {
    pending.set(link.key, link)
    notify()
  }
}

export function hasPendingTodoStart(key: string): boolean {
  return pending.has(key)
}

/** Remembers a link for a draft; a link already waiting on the same draft is replaced. */
export function setPendingTodoStart(link: TodoStartLink): void {
  pending.set(link.key, link)
  notify()
}

/** Test hook: forget every pending link. */
export function clearPendingTodoStarts(): void {
  pending.clear()
  notify()
}

/** True while the draft under `key` was prefilled from a to-do, is still linked and is not empty. */
function linkedDraftShown(key: string): boolean {
  const link = pending.get(key)
  if (!link) return false
  const draft = useAppStore.getState().composerDrafts[key]
  return !isDraftEmpty(draft) && textKeepsLead(draft?.text ?? '', link)
}

/** The start page shows its "Drafted from your to-do" line while this is true. */
export function useTodoDraftLinked(key: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      const off = useAppStore.subscribe(cb)
      return () => {
        listeners.delete(cb)
        off()
      }
    },
    () => linkedDraftShown(key),
    () => false
  )
}

/** The text being sent still begins with the line the draft was prefilled with (a link made without one always holds). */
function textKeepsLead(text: string, link: TodoStartLink): boolean {
  return !link.lead || text.trim().startsWith(link.lead.trim())
}

/** Writes the link once the run exists. The run already started, so a failure is logged and nothing else. */
export async function linkTodoStart(link: TodoStartLink | undefined, runId: string | undefined): Promise<void> {
  if (!link || !runId) return
  try {
    await window.orgai.todos?.linkRun({ scope: link.scope, id: link.id, runId })
  } catch (err) {
    console.warn('todos: could not link the started run to the to-do', err)
  }
}

/**
 * Wraps a start page's onSubmit: takes the pending link first thing (so the Composer's synchronous call beats the
 * discard rule), gives it back when the start throws, and links the new run after a start that succeeded.
 */
export function linkedStart<R>(
  key: string,
  start: (text: string, images: ImageAttachment[] | undefined) => Promise<R>,
  runIdOf: (result: R) => string | undefined
): (text: string, images: ImageAttachment[] | undefined) => Promise<void> {
  return async (text, images) => {
    const taken = takeTodoStart(key)
    // The user replaced the whole text: the run is theirs alone, so the link is dropped silently.
    const todo = taken && textKeepsLead(text, taken) ? taken : undefined
    let result: R
    try {
      result = await start(text, images)
    } catch (err) {
      restoreTodoStart(todo)
      throw err
    }
    void linkTodoStart(todo, runIdOf(result))
  }
}

interface DraftStore {
  subscribe(listener: (state: { composerDrafts: Record<string, ComposerDraft> }, prev: { composerDrafts: Record<string, ComposerDraft> }) => void): () => void
  getState(): { composerDrafts: Record<string, ComposerDraft> }
}

/**
 * Drops a pending link when its draft goes from something to nothing without being sent. A real send empties the
 * draft and calls the start handler synchronously, which takes the link first, so by the microtask there is nothing
 * left to drop. Returns the unsubscribe.
 */
export function watchTodoDrafts(store: DraftStore): () => void {
  return store.subscribe((state, prev) => {
    if (pending.size === 0 || state.composerDrafts === prev.composerDrafts) return
    for (const [key, link] of pending) {
      if (isDraftEmpty(prev.composerDrafts[key]) || !isDraftEmpty(state.composerDrafts[key])) continue
      queueMicrotask(() => {
        if (pending.get(key) === link && isDraftEmpty(store.getState().composerDrafts[key])) {
          pending.delete(key)
          notify()
        }
      })
    }
  })
}

let watching = false
function ensureWatch(): void {
  if (watching) return
  watching = true
  watchTodoDrafts(useAppStore)
}

/**
 * Fills the start page's message box with the item's prompt. Returns false when the user kept their own unsent message.
 * Nothing is sent, and the item's status is not touched.
 */
export async function startSessionFromTodo(item: TodoItem, confirm: (opts: ConfirmOptions) => Promise<boolean>): Promise<boolean> {
  ensureWatch()
  const scope = item.scope
  const key = todoDraftKey(scope)
  const prompt = todoStartPrompt(item)
  const before = useAppStore.getState().composerDrafts[key]
  const sameText = !!before && before.text.trim() === prompt.trim()
  if (!isDraftEmpty(before) && !sameText) {
    const ok = await confirm({
      title: 'Replace your unsent message?',
      body: `The message box already holds text you have not sent. Starting from “${clampLabel(item.title, 80)}” replaces it, and the old text is lost.`,
      confirmLabel: 'Replace message',
      danger: true,
      confirmTestId: 'todo-replace-draft-confirm'
    })
    if (!ok) return false
  }
  if (scope.kind === 'chat') {
    await useAppStore.getState().openAssistant(QUICK_PROJECT_ID, { fresh: true })
  } else {
    if (useAppStore.getState().selectedProjectId !== scope.projectId) useAppStore.getState().selectProject(scope.projectId)
    useAppStore.getState().openDraft()
  }
  // Read again: the draft may have changed while the confirm was open.
  const images = sameText ? (useAppStore.getState().composerDrafts[key]?.images ?? []) : []
  setPendingTodoStart({ key, scope, id: item.id, lead: prompt.split('\n')[0] })
  useAppStore.getState().setComposerDraft(key, { text: prompt, images })
  requestAnimationFrame(() => requestAnimationFrame(() => useAppStore.getState().focusComposer()))
  return true
}
