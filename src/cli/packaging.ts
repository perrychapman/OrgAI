/**
 * What the CLI bundle (vite.cli.config.ts, out/cli) leaves as bare imports (cli-spec 7, Wave 6). Pure: node:module
 * only. Everything else (ink, react, react/jsx-runtime, react-reconciler, chalk, ...) is bundled into out/cli, so a
 * npm package keeps these as its dependencies (CLI_RUNTIME_PACKAGES; scripts/lib/npmPackage.mjs). The desktop app
 * contains no CLI and has its own unpack list (electron-builder.yml asarUnpack; scripts/verify-pack.mjs).
 *
 * Why these stay external: the Claude Agent SDK and Codex spawn per-platform native binaries that resolve next to
 * their own package (`@anthropic-ai/claude-agent-sdk-<platform>`, `@openai/codex-<platform>`), and zod is the SDK's
 * peer (one copy, so the SDK's `instanceof` checks on tool schemas hold). electron is never imported by the CLI.
 */
import { builtinModules } from 'node:module'

/** Packages the CLI bundle imports at run time; the npm package depends on each one. */
export const CLI_RUNTIME_PACKAGES = ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'zod'] as const

/** Per-platform native packages of the runtime packages (optional dependencies, unpacked too). */
const NATIVE_PREFIXES = ['@anthropic-ai/claude-agent-sdk-', '@openai/codex-'] as const

const BUILTINS: ReadonlySet<string> = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

/** True when the CLI bundle keeps `id` as a bare import: Node builtins, electron, the runtime packages and natives. */
export function isCliExternal(id: string): boolean {
  if (typeof id !== 'string' || !id) return false
  if (id.startsWith('node:') || BUILTINS.has(id)) return true
  // `fs/promises` and other builtin subpaths.
  if (BUILTINS.has(id.split('/')[0]) && !id.startsWith('@')) return true
  if (id === 'electron' || id.startsWith('electron/')) return true
  if (CLI_RUNTIME_PACKAGES.some((p) => id === p || id.startsWith(`${p}/`))) return true
  return NATIVE_PREFIXES.some((p) => id.startsWith(p) && id.length > p.length)
}
