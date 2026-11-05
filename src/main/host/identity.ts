import { randomBytes } from 'node:crypto'

/**
 * The host instance id: 12 lowercase hex chars naming one host process (daemon.json, the per-instance socket
 * `d-<id>.sock`, and the repo lock owner file read it). Pure Node, no electron import.
 */

export const HOST_INSTANCE_ID_RE = /^[0-9a-f]{12}$/

let current: string | undefined

/** A fresh random id (6 random bytes as hex). */
export function newHostInstanceId(): string {
  return randomBytes(6).toString('hex')
}

/** This process's id, created on first use and stable for the process's life (unless setHostInstanceId replaces it). */
export function currentHostInstanceId(): string {
  current ??= newHostInstanceId()
  return current
}

/** Pin this process's id (the ownership protocol picks it before writing daemon.json). Throws on a malformed id. */
export function setHostInstanceId(id: string): void {
  if (typeof id !== 'string' || !HOST_INSTANCE_ID_RE.test(id)) throw new Error(`Invalid host instance id: ${String(id)}`)
  current = id
}
