/** Terminal presentation only: keep the stored transcript untouched. Input is already sanitized. */
export function readableMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  const links: string[] = []
  let fence: string | undefined
  const inline = (line: string): string => line.replace(/`[^`]*`|\[([^\]\n]+)\]\((<[^>\n]+>|[^\s()]+(?:\([^()]*\)[^\s()]*)*)\)/g, (match, label: string | undefined, destination: string | undefined) => {
    if (!label || !destination) return match
    const target = destination.startsWith('<') ? destination.slice(1, -1) : destination
    let index = links.indexOf(target)
    if (index < 0) { index = links.length; links.push(target) }
    return `${label} [${index + 1}]`
  })
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      out.push(line)
      continue
    }
    if (fence || /^ {4}/.test(line)) { out.push(line); continue }
    const headers = tableCells(line)
    const separators = tableCells(lines[i + 1] ?? '')
    if (headers.length > 1 && separators.length === headers.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
      out.push(inline(`### ${headers.join(' / ')}`))
      i++
      while (i + 1 < lines.length) {
        const cells = tableCells(lines[i + 1])
        if (cells.length !== headers.length) break
        i++
        out.push('')
        cells.forEach((cell, column) => out.push(inline(`**${headers[column]}:** ${cell}`)))
      }
      out.push('')
    } else out.push(inline(line))
  }
  if (links.length) out.push('', '### References', ...links.map((target, index) => `[${index + 1}] ${target}`))
  return out.join('\n')
}

/** Pipes escaped with a backslash or inside inline code are cell content. */
function tableCells(line: string): string[] {
  let source = line.trim()
  if (!source.includes('|')) return []
  if (source.startsWith('|')) source = source.slice(1)
  if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let ticks = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\' && source[i + 1] === '|') { cell += '|'; i++; continue }
    if (ch === '`') {
      let end = i + 1
      while (source[end] === '`') end++
      const count = end - i
      if (!ticks) ticks = count
      else if (ticks === count) ticks = 0
      cell += source.slice(i, end)
      i = end - 1
    } else if (ch === '|' && !ticks) { cells.push(cell.trim()); cell = '' }
    else cell += ch
  }
  cells.push(cell.trim())
  return cells
}
