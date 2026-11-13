/**
 * The vite-node CLI entry for tests that run a fixture in a real child process (`node <cli> -c vitest.config.ts <file>`).
 * Resolved through the package's `./cli` export, never a hard-coded path: vite-node 6 ships only `dist/` (its bin is
 * `dist/cli.mjs`), and 3.x had `vite-node.mjs` at the package root.
 */
import { createRequire } from 'node:module'

export const VITE_NODE_CLI: string = createRequire(import.meta.url).resolve('vite-node/cli')
