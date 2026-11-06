import type { MenuAction } from '@shared/types'

/**
 * Screen-local handlers for application menu actions (H2 in docs/design/ux-review-menu.md). A mounted view registers
 * the actions only it can run (the Live view: canvas zoom / fit, Hide finished, Show conversation, Go to decision;
 * RunActions: Save chat as project, Org retrospective). The router in lib/menuActions.ts calls the newest registered
 * handler first and falls back to its own store-based handling, else announces that the action does not apply.
 *
 * A handler returns nothing when it ran, or the sentence to announce when the action does not apply right now.
 * No React, no DOM: views register from an effect and call the returned function on cleanup.
 */
export type MenuHandler = () => string | void

const handlers = new Map<MenuAction, MenuHandler[]>()

/** Registers `handler` for `action`; the newest registration wins. Returns the unregister function. */
export function registerMenuHandler(action: MenuAction, handler: MenuHandler): () => void {
  const list = handlers.get(action) ?? []
  list.push(handler)
  handlers.set(action, list)
  return () => {
    const now = handlers.get(action)
    if (!now) return
    const i = now.lastIndexOf(handler)
    if (i >= 0) now.splice(i, 1)
    if (now.length === 0) handlers.delete(action)
  }
}

/** The newest handler registered for `action`, if any. */
export function menuHandlerFor(action: MenuAction): MenuHandler | undefined {
  const list = handlers.get(action)
  return list && list.length > 0 ? list[list.length - 1] : undefined
}

type Router = (action: MenuAction) => void

let router: Router | null = null

/** lib/menuActions.ts installs the one router at app start; returns the uninstall function. */
export function installMenuRouter(fn: Router): () => void {
  router = fn
  return () => {
    if (router === fn) router = null
  }
}

/**
 * Runs a menu action the same way whether it came from the native menu (`menu:action`) or a renderer keydown handler
 * (Ctrl+T, Ctrl+W, Ctrl+., Alt+D ...). Before the router is installed only a registered handler can run.
 */
export function runMenuAction(action: MenuAction): void {
  if (router) {
    router(action)
    return
  }
  menuHandlerFor(action)?.()
}

/** Test helper: forget every handler and the router. */
export function resetMenuRegistry(): void {
  handlers.clear()
  router = null
}
