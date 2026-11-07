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
