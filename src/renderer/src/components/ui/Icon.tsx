import type { ReactElement } from 'react'
import type { LucideIcon } from 'lucide-react'

export type IconSize = 'xs' | 'sm' | 'md' | 'lg'

/** Thin lucide wrapper: token-sized, currentColor. With `label` it is a standalone image; otherwise decorative. */
export function Icon({ icon: Glyph, size = 'md', label }: { icon: LucideIcon; size?: IconSize; label?: string }): ReactElement {
  return (
    <Glyph
      size={`var(--icon-${size})`}
      color="currentColor"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      focusable="false"
    />
  )
}
