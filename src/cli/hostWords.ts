/** How a host kind reads in the CLI's text: no "node", no "inproc". */
export function hostKindWord(kind: string | null | undefined): string {
  if (kind === 'desktop') return 'app'
  if (kind === 'node') return 'background'
  if (kind === 'inproc') return 'this command'
  return kind ? String(kind) : 'host'
}
