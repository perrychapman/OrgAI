import type { ReactElement } from 'react'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { IconButton } from './IconButton'

/** Copies text to the clipboard and flashes a check. Never use it for stored secrets. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): ReactElement {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      icon={done ? Check : Copy}
      label={done ? 'Copied' : label}
      size="sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => undefined)
      }}
    />
  )
}
