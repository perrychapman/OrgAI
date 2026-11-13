/**
 * The CLI bundle (cli-spec 7): src/cli/bin.ts (which loads src/cli/index.ts as a chunk) -> out/cli/orgai.mjs, an ESM
 * file Node started with `--disable-sigusr1` runs (or the packaged app's own binary with ELECTRON_RUN_AS_NODE=1,
 * build/bin/orgai). The generated shebang supplies the flag for npm bin launchers; invoke the bundle directly as
 * `node --disable-sigusr1 out/cli/orgai.mjs`. Only src/cli/packaging.ts `isCliExternal` stays a bare
 * import: Node builtins, electron (never imported by the CLI), the Claude Agent SDK, Codex and zod (unpacked from
 * app.asar by electron-builder.yml). Every other dependency (ink, react, react/jsx-runtime, react-reconciler, ...) is
 * bundled, so a packaged app needs no node_modules tree for the CLI beyond those three.
 * Dynamic imports become their own chunks under out/cli/ (inprocHost.mjs); the TUI (src/cli/tui/index.ts) is a second
 * input emitted as tui.mjs, and ink / react land only in chunks tui.mjs reaches (lazyTui.test.ts, packaging.test.ts).
 * .tsx uses React's automatic runtime. Bundled CommonJS dependencies (signal-exit, stack-utils, ...) `require` Node
 * builtins; with the node SSR target the bundler emits its own `__require = createRequire(import.meta.url)` for them,
 * so no banner is needed. yoga-layout (ink) embeds its wasm as base64, so no file is loaded at run time.
 * Built after electron-vite (`npm run build`); it empties out/cli only, so out/main, out/preload and out/renderer survive.
 */
import { chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { isCliExternal } from './src/cli/packaging.js'

const root = fileURLToPath(new URL('.', import.meta.url))
const tuiEntry = resolve(root, 'src/cli/tui/index.ts')

export default defineConfig({
  plugins: [
    {
      name: 'orgai-cli-executable',
      // `./out/cli/orgai.mjs` uses env -S to pass the flag; npm's POSIX and Windows bin shims carry it too.
      writeBundle(options, bundle) {
        for (const [file, out] of Object.entries(bundle)) {
          if (out.type === 'chunk' && out.isEntry && file === 'orgai.mjs' && options.dir) chmodSync(resolve(options.dir, file), 0o755)
        }
      }
    }
  ],
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: 'out/cli',
    // Empties out/cli only (the outDir), so stale hashed chunks never ship in a pack; out/main and the rest survive.
    emptyOutDir: true,
    target: 'node22',
    // Two inputs: the CLI and the TUI entry, so out/cli/tui.mjs always exists (commands/tui.ts reaches it only through a
    // dynamic import, which then resolves to this same chunk; lazyTui.test.ts keeps ink and react out of orgai.mjs).
    ssr: true,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      // bin.ts installs inspectorSignal.ts, then loads index.ts as its own chunk (cli-parity 3.4 hardening).
      input: { orgai: resolve(root, 'src/cli/bin.ts'), tui: tuiEntry },
      external: isCliExternal,
      output: {
        format: 'es',
        entryFileNames: (chunk) => (chunk.name === 'tui' ? 'tui.mjs' : 'orgai.mjs'),
        chunkFileNames: (chunk) => {
          if (chunk.name === 'inprocHost') return 'inprocHost.mjs'
          // A lazily split commands/tui.ts would also be named 'tui'; keep it apart from the tui.mjs entry.
          return chunk.name === 'tui' ? 'tuiCommand-[hash].mjs' : '[name]-[hash].mjs'
        },
        banner: (chunk) => (chunk.isEntry && chunk.name === 'orgai' ? '#!/usr/bin/env -S node --disable-sigusr1' : '')
      }
    }
  },
  ssr: { noExternal: true, target: 'node' }
})
