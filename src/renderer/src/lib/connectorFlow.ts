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

/** Disconnect signs out (OAuth kinds) or clears the stored token. */
export function disconnectKind(auth: ConnectorAuth): 'signOut' | 'clearToken' {
  return auth.kind === 'token' ? 'clearToken' : 'signOut'
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
    return { message, hint: kind === 'token' ? 'Save the token again.' : 'Sign in again: Disconnect, then Connect.' }
  }
  return { message }
}
