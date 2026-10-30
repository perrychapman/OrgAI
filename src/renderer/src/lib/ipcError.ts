/** The message of a rejected IPC call without Electron's "Error invoking remote method '...': Error: " wrapper. */
export function cleanIpcError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '').trim() || fallback
}
