import type { ReactElement } from 'react'
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Model output may link only to absolute web URLs; relative, local and custom-protocol links are inert. */
export function safeMarkdownUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}

/**
 * Renders model output as GitHub-flavored Markdown. react-markdown never injects raw HTML,
 * so model text cannot smuggle markup into the renderer. Links open in the default browser
 * through the main process's window-open handler.
 */
function MarkdownView({ text }: { text: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrl}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownView)
