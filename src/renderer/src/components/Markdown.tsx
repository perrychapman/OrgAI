import type { ReactElement } from 'react'
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownView)
