/**
 * The CLI bundle (cli-spec 7): src/cli/index.ts -> out/cli/orgai.mjs, an ESM file plain `node` runs. Node builtins
 * and every package.json dependency stay external; electron is never bundled (and the CLI never imports it).
 * Dynamic imports become their own chunks under out/cli/ (inprocHost.mjs); the TUI (src/cli/tui/index.ts) is a second
 * input emitted as tui.mjs. .tsx uses React's automatic runtime; react, react/jsx-runtime and
 * ink are dependencies, so they stay external and load only when tui.mjs does. Built after
 * electron-vite (`npm run build`) and never empties out/, so out/main, out/preload and out/renderer survive.
 */
import { builtinModules } from 'node:module'
import { chmodSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const packages = [...Object.keys(pkg.dependencies ?? {}), 'electron']
const tuiEntry = resolve(root, 'src/cli/tui/index.ts')
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/** A bare import of a dependency (or a subpath of one) or a Node builtin stays an import. */
function isExternal(id: string): boolean {
  if (builtins.has(id) || id.startsWith('node:')) return true
  return packages.some((p) => id === p || id.startsWith(`${p}/`))
}

export default defineConfig({
  plugins: [
    {
      name: 'orgai-cli-executable',
      // `./out/cli/orgai.mjs` runs directly (the banner names node); npm's bin link needs no mode, a checkout does.
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
    emptyOutDir: false,
    target: 'node22',
    // Two inputs: the CLI and the TUI entry, so out/cli/tui.mjs always exists (commands/tui.ts reaches it only through a
    // dynamic import, which then resolves to this same chunk; lazyTui.test.ts keeps ink and react out of orgai.mjs).
    ssr: true,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: { orgai: resolve(root, 'src/cli/index.ts'), tui: tuiEntry },
      external: isExternal,
      output: {
        format: 'es',
        entryFileNames: (chunk) => (chunk.name === 'tui' ? 'tui.mjs' : 'orgai.mjs'),
        chunkFileNames: (chunk) => {
          if (chunk.name === 'inprocHost') return 'inprocHost.mjs'
          // A lazily split commands/tui.ts would also be named 'tui'; keep it apart from the tui.mjs entry.
          return chunk.name === 'tui' ? 'tuiCommand-[hash].mjs' : '[name]-[hash].mjs'
        },
        banner: (chunk) => (chunk.isEntry && chunk.name === 'orgai' ? '#!/usr/bin/env node' : '')
      }
    }
  },
  ssr: { noExternal: true, target: 'node' }
})
