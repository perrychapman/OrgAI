import { useEffect, useState } from 'react'

function read(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Resolved value of a design token (e.g. '--canvas-pattern') for libraries that cannot take var(). It re-reads when the
 * theme attribute on <html> changes or the OS scheme flips (theme "system").
 */
export function useCssVar(name: string): string {
  const [value, setValue] = useState(() => read(name))
  useEffect(() => {
    const update = (): void => setValue(read(name))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [name])
  return value
}
