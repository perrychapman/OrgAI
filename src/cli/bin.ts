/**
 * The `orgai` command: the bundle's entry (out/cli/orgai.mjs; the build adds the `#!/usr/bin/env -S node --disable-sigusr1` banner). The CLI
 * starts Node with the inspector signal disabled: inspectorSignal.ts is installed here before anything else, and the
 * rest of the CLI (index.ts and everything it imports) loads after it as its own chunk.
 */
import './inspectorSignal'

const { runCli } = await import('./index')
runCli()
