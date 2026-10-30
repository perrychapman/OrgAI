import type { ReactElement } from 'react'
import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Only these schemes ever become links. Relative, javascript:, data:, file: and everything else render as plain text. */
const SAFE_LINK = /^(https?:|mailto:)/i

/** react-markdown's urlTransform: returns '' (no link) for anything outside the allowlist. */
export function safeUrl(url: string): string {
  return SAFE_LINK.test(url.trim()) ? url : ''
}

/**
 * Renders model output as GitHub-flavored Markdown. Untrusted text: no raw HTML (no rehype-raw, and `skipHtml` drops
 * any HTML node), links limited to http(s) and mailto, and no images at all (a remote `<img>` is a tracking pixel and
 * a local one is a file read); an image becomes its alt text. Links open in the default browser through the main
 * process's window-open handler, with noopener and noreferrer.
 */
function MarkdownView({ text }: { text: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrl}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span className="md-image-alt">{alt ? `[image: ${alt}]` : '[image]'}</span>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownView)
