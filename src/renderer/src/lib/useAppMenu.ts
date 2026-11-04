import { useEffect } from 'react'
import type { MenuState } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { installMenuRouter } from './menuRegistry'
import { menuStateChanged, menuStateFor, routeMenuAction } from './menuActions'

/**
 * Connects the native application menu: installs the router, subscribes to `menu:action`, and reports the five
 * `MenuState` booleans to main once on mount and again only when one of them changes.
 */
export function useAppMenu(): void {
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.orgai : undefined
    const uninstall = installMenuRouter(routeMenuAction)
    let last: MenuState | null = null
    const send = (state: MenuState): void => {
      last = state
      try {
        void Promise.resolve(api?.menu?.setState?.(state)).catch(() => undefined)
      } catch {
        /* older preload: the menu just stays at its default state */
      }
    }
    send(menuStateFor(useAppStore.getState()))
    const unsubscribeStore = useAppStore.subscribe((state) => {
      const next = menuStateFor(state)
      if (last && !menuStateChanged(last, next)) return
      send(next)
    })
    let unsubscribeAction: (() => void) | undefined
    try {
      unsubscribeAction = api?.onMenuAction?.(routeMenuAction)
    } catch {
      unsubscribeAction = undefined
    }
    return () => {
      uninstall()
      unsubscribeStore()
      unsubscribeAction?.()
    }
  }, [])
}
