import type { ConnectorAuth, McpAuthStatus, McpTestResult } from '@shared/types'

/** Only https links from the catalog are ever opened. */
export function httpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Disconnect signs out (OAuth kinds), clears the stored token, or does not exist (no sign-in at all). */
export function disconnectKind(auth: ConnectorAuth): 'signOut' | 'clearToken' | 'none' {
  return auth.kind === 'token' ? 'clearToken' : auth.kind === 'none' ? 'none' : 'signOut'
}

/**
 * What connecting does after the library entry exists: store the token, open the browser sign-in, or nothing (a service
 * that needs no sign-in is connected as soon as it is added).
 */
export function connectStep(auth: ConnectorAuth): 'token' | 'authorize' | 'none' {
  return auth.kind === 'token' ? 'token' : auth.kind === 'none' ? 'none' : 'authorize'
}

/** The message for a sign-in that did not finish, or undefined when it succeeded or the user cancelled it. */
export function authFailure(status: McpAuthStatus, cancelled: boolean): string | undefined {
  if (status.state === 'authorized' || status.state === 'notRequired') return undefined
  if (cancelled) return undefined
  if (status.needsClientId) return status.error ?? 'This service needs its own sign-in app before OrgAI can connect.'
  return status.error ?? 'Sign-in did not finish. Try again.'
}

/** A failed check in plain words, with a hint to sign in again when the service asked for it. */
export function testFailure(result: McpTestResult, kind: ConnectorAuth['kind']): { message: string; hint?: string } {
  const message = result.error ?? 'The service did not answer.'
  if (result.needsAuthorization) {
    return { message, hint: kind === 'token' ? 'Save the token again.' : 'Sign in again: Disconnect, then sign in.' }
  }
  return { message }
}
