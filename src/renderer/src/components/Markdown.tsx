import type { ReactElement, ReactNode } from 'react'
import { isValidElement, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Only these schemes ever become links. Relative, javascript:, data:, file: and everything else render as plain text. */
const SAFE_LINK = /^https?:/i

/** react-markdown's urlTransform: returns '' (no link) for anything outside the allowlist. */
export function safeUrl(url: string): string {
  return SAFE_LINK.test(url.trim()) ? url : ''
}

function textOf(n: ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children)
  return ''
}

/** The link's host when the visible text does not mention it (text can claim one site and go to another), else ''. */
export function spoofHost(href: string, children: ReactNode): string {
  let host = ''
  try {
    host = new URL(href).host.toLowerCase()
  } catch {
    return ''
  }
  if (!host) return ''
  const shown = textOf(children).toLowerCase()
  const bare = host.replace(/^www\./, '')
  return shown.includes(host) || shown.includes(bare) ? '' : host
}

/**
 * Renders model output as GitHub-flavored Markdown. Untrusted text: no raw HTML (no rehype-raw, and `skipHtml` drops
 * any HTML node), links limited to http(s), and no images at all (a remote `<img>` is a tracking pixel and
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
              <a href={href} title={href} target="_blank" rel="noreferrer noopener">
                {children}
                {spoofHost(href, children) && <span className="md-link-host"> ({spoofHost(href, children)})</span>}
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
