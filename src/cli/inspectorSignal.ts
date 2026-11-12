/**
 * The CLI starts Node with the inspector signal disabled: a listener for SIGUSR1 replaces Node's default handling of
 * that signal. Imported first by index.ts, so it is installed before the rest of the CLI loads. POSIX only (Windows has
 * no SIGUSR1). Plain Node, no imports.
 */
const ignoreSignal = (): void => undefined

/** Install the listener once on `proc` (default: this process). Never throws. */
export function disableInspectorSignal(proc: Pick<NodeJS.Process, 'platform' | 'on' | 'listeners'> = process): void {
  if (proc.platform === 'win32') return
  try {
    if (!proc.listeners('SIGUSR1').includes(ignoreSignal)) proc.on('SIGUSR1', ignoreSignal)
  } catch {
    // A runtime without signal listeners (a worker thread): nothing to install.
  }
}

disableInspectorSignal()
