import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * Put data attributes on a Popover's trigger button (a null value removes the attribute). The shared Popover renders its
 * own trigger and takes no extra attributes, so the chip's state (`data-default`, `data-tone`) is set on the button
 * after each render. Styling does not depend on it (the chips also carry a class); the attributes are for tests and
 * assistive checks.
 */
export function useTriggerAttrs(attrs: Record<string, string | null>): RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement>(null)
  const key = JSON.stringify(attrs)
  useLayoutEffect(() => {
    const trigger = ref.current?.querySelector<HTMLButtonElement>('.popover-wrap > button')
    if (!trigger) return
    for (const [name, value] of Object.entries(JSON.parse(key) as Record<string, string | null>)) {
      if (value === null) trigger.removeAttribute(name)
      else trigger.setAttribute(name, value)
    }
  }, [key])
  return ref
}
