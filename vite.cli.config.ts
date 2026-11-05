/**
 * The CLI bundle (cli-spec 7): src/cli/index.ts -> out/cli/orgai.mjs, an ESM file plain `node` runs. Node builtins
 * and every package.json dependency stay external; electron is never bundled (and the CLI never imports it).
 * Dynamic imports (the `--host inproc` host, later the TUI) become their own chunks under out/cli/. Built after
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
          if (out.type === 'chunk' && out.isEntry && options.dir) chmodSync(resolve(options.dir, file), 0o755)
        }
      }
    }
  ],
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: 'out/cli',
    emptyOutDir: false,
    target: 'node22',
    ssr: resolve(root, 'src/cli/index.ts'),
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      external: isExternal,
      output: {
        format: 'es',
        entryFileNames: 'orgai.mjs',
        chunkFileNames: (chunk) => (chunk.name === 'inprocHost' ? 'inprocHost.mjs' : '[name]-[hash].mjs'),
        banner: (chunk) => (chunk.isEntry ? '#!/usr/bin/env node' : '')
      }
    }
  },
  ssr: { noExternal: true, target: 'node' }
})
