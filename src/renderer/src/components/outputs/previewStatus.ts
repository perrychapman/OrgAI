import { createContext, useContext, useEffect } from 'react'

/** Lets a preview body (the Mermaid drawing) speak through OutputPreview's one always-mounted status region. */
export const PreviewStatusContext = createContext<(text: string) => void>(() => undefined)

/** Sets the preview's status text while `text` is current; clears it when the body goes away. */
export function usePreviewStatus(text: string): void {
  const set = useContext(PreviewStatusContext)
  useEffect(() => {
    set(text)
    return () => set('')
  }, [set, text])
}

/** Where a preview is shown, for the pan/zoom viewers inside it. */
export interface OutputViewValue {
  /** 'detail' sits in a scrolling column (a plain wheel passes through); 'dialog' is the Larger view (the wheel zooms). */
  context: 'detail' | 'dialog'
  /** The detail's way into the Larger view ("Open large"). */
  onOpenLarge?: () => void
  /** The Larger view covers the whole window. */
  full?: boolean
  onToggleFull?: () => void
}

export const OutputViewContext = createContext<OutputViewValue>({ context: 'detail' })

export function useOutputView(): OutputViewValue {
  return useContext(OutputViewContext)
}
