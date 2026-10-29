import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { app } from 'electron'
import type { RunEvent, RunSummary } from '@shared/types'

/**
 * Main-process log at <userData>/logs/main.log. Rotates to main.1.log at 2 MB (two files kept).
 * Writes are synchronous so the last lines before a crash make it to disk.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 2 * 1024 * 1024

let dir: string | undefined
let file: string | undefined
let size = 0
let installed = false
let writing = false

const original = { error: console.error.bind(console), warn: console.warn.bind(console) }

export function logsDir(): string {
  if (!dir) dir = join(app.getPath('userData'), 'logs')
  return dir
}

export function logPath(): string {
  if (!file) {
    file = join(logsDir(), 'main.log')
    try {
      mkdirSync(logsDir(), { recursive: true })
      size = existsSync(file) ? statSync(file).size : 0
    } catch {
      size = 0
    }
  }
  return file
}

function rotate(path: string): void {
  const previous = join(logsDir(), 'main.1.log')
  try {
    rmSync(previous, { force: true })
    renameSync(path, previous)
  } catch {
    // A locked file on Windows: keep appending rather than lose lines.
  }
  size = existsSync(path) ? statSync(path).size : 0
}

function write(level: LogLevel, args: unknown[]): void {
  if (writing) return
  writing = true
  try {
    const path = logPath()
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${format(...args)}\n`
    if (size + line.length > MAX_BYTES && size > 0) rotate(path)
    appendFileSync(path, line)
    size += Buffer.byteLength(line)
  } catch {
    // Logging must never take the app down.
  } finally {
    writing = false
  }
}

export const log = {
  debug: (...args: unknown[]): void => write('debug', args),
  info: (...args: unknown[]): void => write('info', args),
  warn: (...args: unknown[]): void => write('warn', args),
  error: (...args: unknown[]): void => write('error', args)
}

/** Install crash handlers and mirror console.error/warn into the log. Safe to call once, before app ready. */
export function installLogging(): void {
  if (installed) return
  installed = true

  console.error = (...args: unknown[]): void => {
    original.error(...args)
    write('error', args)
  }
  console.warn = (...args: unknown[]): void => {
    original.warn(...args)
    write('warn', args)
  }

  process.on('uncaughtException', (err) => {
    original.error('Uncaught exception:', err)
    write('error', ['Uncaught exception:', err])
  })
  process.on('unhandledRejection', (reason) => {
    original.error('Unhandled rejection:', reason)
    write('error', ['Unhandled rejection:', reason])
  })

  app.on('render-process-gone', (_e, contents, details) => {
    write('error', [`Renderer gone (${details.reason}, exit ${details.exitCode}) url=${safeUrl(contents)}`])
  })
  app.on('child-process-gone', (_e, details) => {
    const name = details.name ?? details.serviceName ?? ''
    write('error', [`Child process gone: ${details.type} ${name} (${details.reason}, exit ${details.exitCode})`])
  })
  app.on('web-contents-created', (_e, contents) => {
    contents.on('unresponsive', () => write('warn', [`WebContents unresponsive url=${safeUrl(contents)}`]))
    contents.on('responsive', () => write('info', [`WebContents responsive again url=${safeUrl(contents)}`]))
  })

  write('info', [
    `OrgAI ${app.getVersion()} starting (electron ${process.versions.electron}, node ${process.versions.node}, ` +
      `chrome ${process.versions.chrome}, ${process.platform} ${process.arch}, packaged=${app.isPackaged})`
  ])
}

function safeUrl(contents: Electron.WebContents): string {
  try {
    return contents.getURL()
  } catch {
    return '?'
  }
}

/** Run lifecycle and warn/error run logs, called for every event a run emits. */
export function logRunEvent(summary: RunSummary, e: RunEvent): void {
  if (e.type === 'run.status') {
    const tag = `run ${summary.id} kind=${summary.kind} project=${summary.projectId}`
    if (e.status === 'starting') log.info(`${tag} started`)
    else if (e.status === 'finished') log.info(`${tag} finished cost=$${summary.totalCostUsd.toFixed(4)}`)
    else if (e.status === 'error') log.info(`${tag} error cost=$${summary.totalCostUsd.toFixed(4)}: ${e.error ?? 'unknown error'}`)
  } else if (e.type === 'log' && (e.level === 'warn' || e.level === 'error')) {
    write(e.level, [`run ${e.runId}: ${e.message}`])
  }
}
