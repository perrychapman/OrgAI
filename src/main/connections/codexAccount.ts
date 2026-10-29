import type { CodexAppServer } from '../runtime/codexAppServer'

/**
 * Account, login, model and rate-limit calls against `codex app-server`. Every method name and shape for
 * these lives here. Shapes come from `codex app-server generate-ts --experimental` (@openai/codex 0.166.0).
 * VERIFIED live (token-free): initialize + account/read on an empty CODEX_HOME -> { account: null,
 * requiresOpenaiAuth: true }. UNVERIFIED live (need a login): account/login/start, account/login/completed,
 * model/list, account/rateLimits/read. All parsing is defensive: unknown or missing fields degrade, never throw.
 */

/** The slice of CodexAppServer this module needs; tests pass a fake. */
export type CodexRpc = Pick<CodexAppServer, 'request' | 'onNotification'>

export type CodexAccount =
  | { type: 'chatgpt'; email: string | null; planType: string | null }
  | { type: 'apiKey' }
  | { type: 'other'; kind: string }

export interface CodexAccountState {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}

export type CodexLoginStart =
  | { method: 'browser'; loginId: string; authUrl: string }
  | { method: 'deviceCode'; loginId: string; verificationUrl: string; userCode: string }

export interface CodexLoginResult {
  loginId: string | null
  success: boolean
  error: string | null
}

export interface CodexModelInfo {
  /** The slug to put in a role's model (Model.model, falling back to Model.id). */
  id: string
  label: string
  description?: string
  hidden: boolean
  isDefault: boolean
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function parseAccountState(raw: unknown): CodexAccountState {
  const r = obj(raw)
  const a = r.account ? obj(r.account) : null
  let account: CodexAccount | null = null
  if (a) {
    const type = str(a.type)
    if (type === 'chatgpt') account = { type, email: str(a.email) ?? null, planType: str(a.planType) ?? null }
    else if (type === 'apiKey') account = { type }
    else account = { type: 'other', kind: type ?? 'unknown' }
  }
  return { account, requiresOpenaiAuth: r.requiresOpenaiAuth === true }
}

export function parseLoginStart(raw: unknown): CodexLoginStart {
  const r = obj(raw)
  const loginId = str(r.loginId)
  if (r.type === 'chatgpt' && loginId && str(r.authUrl)) return { method: 'browser', loginId, authUrl: str(r.authUrl)! }
  if (r.type === 'chatgptDeviceCode' && loginId && str(r.verificationUrl) && str(r.userCode)) {
    return { method: 'deviceCode', loginId, verificationUrl: str(r.verificationUrl)!, userCode: str(r.userCode)! }
  }
  throw new Error('Codex did not return a login URL')
}

export function parseLoginCompleted(params: unknown): CodexLoginResult {
  const p = obj(params)
  return { loginId: str(p.loginId) ?? null, success: p.success === true, error: str(p.error) ?? null }
}

export function parseModelPage(raw: unknown): { models: CodexModelInfo[]; nextCursor: string | null } {
  const r = obj(raw)
  const data = Array.isArray(r.data) ? r.data : []
  const models: CodexModelInfo[] = []
  for (const item of data) {
    const m = obj(item)
    const id = str(m.model) ?? str(m.id)
    if (!id) continue
    models.push({
      id,
      label: str(m.displayName) ?? id,
      ...(str(m.description) ? { description: str(m.description) } : {}),
      hidden: m.hidden === true,
      isDefault: m.isDefault === true
    })
  }
  return { models, nextCursor: str(r.nextCursor) ?? null }
}

export async function readAccount(rpc: CodexRpc): Promise<CodexAccountState> {
  return parseAccountState(await rpc.request('account/read', { refreshToken: false }))
}

export async function startLogin(rpc: CodexRpc, method: 'browser' | 'deviceCode'): Promise<CodexLoginStart> {
  const params = method === 'browser' ? { type: 'chatgpt' } : { type: 'chatgptDeviceCode' }
  return parseLoginStart(await rpc.request('account/login/start', params))
}

export async function cancelLogin(rpc: CodexRpc, loginId: string): Promise<void> {
  await rpc.request('account/login/cancel', { loginId })
}

export async function logoutAccount(rpc: CodexRpc): Promise<void> {
  await rpc.request('account/logout')
}

/** Subscribe to account/login/completed. Returns an unsubscribe function. */
export function onLoginCompleted(rpc: CodexRpc, cb: (r: CodexLoginResult) => void): () => void {
  return rpc.onNotification((method, params) => {
    if (method === 'account/login/completed') cb(parseLoginCompleted(params))
  })
}

/** All pages of model/list (hidden models excluded by the server unless asked for). Capped at 20 pages. */
export async function listModels(rpc: CodexRpc): Promise<CodexModelInfo[]> {
  const out: CodexModelInfo[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const raw: unknown = await rpc.request('model/list', cursor ? { cursor } : {})
    const parsed = parseModelPage(raw)
    out.push(...parsed.models)
    if (!parsed.nextCursor) break
    cursor = parsed.nextCursor
  }
  return out.filter((m) => !m.hidden)
}

/** Raw account/rateLimits/read result; codexUsage.ts maps it. */
export function readRateLimits(rpc: CodexRpc): Promise<unknown> {
  return rpc.request('account/rateLimits/read')
}
