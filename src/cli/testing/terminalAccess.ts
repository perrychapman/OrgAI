/**
 * Tests only: record the user's choice of Terminal access 'full' in `<dataDir>/settings.json` before a host boots, so
 * CLI clients in other contexts than the one that started a `--host inproc` host (they have no owner key) may use
 * decide / configure, as a desktop user allows in App settings (review H2). Keeps any other stored settings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function allowFullTerminalAccess(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'settings.json')
  let doc: { version?: number; settings?: Record<string, unknown> } = {}
  try {
    if (existsSync(file)) doc = JSON.parse(readFileSync(file, 'utf8')) as typeof doc
  } catch {
    doc = {}
  }
  writeFileSync(file, JSON.stringify({ version: 1, ...doc, settings: { ...(doc.settings ?? {}), terminalAccessLevel: 'full' } }, null, 2), 'utf8')
}
