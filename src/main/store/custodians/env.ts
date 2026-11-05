/**
 * The environment a custodian helper sees (cli-standalone.md 5.3): a per-scheme allowlist, never NODE_OPTIONS and never
 * an ORGAI_* variable, so neither the vault key file's location nor the CLI's secret overlay (ORGAI_SECRET_*) reaches
 * `security`, PowerShell or `secret-tool`. Pure; relative imports only.
 */
import type { VaultCustodyScheme } from '../../../shared/types'

type Env = Readonly<Record<string, string | undefined>>

/** The variables kept per scheme (5.3 table), spelled as the helper expects them. */
export const CUSTODIAN_ENV_ALLOWLIST: Readonly<Record<VaultCustodyScheme, readonly string[]>> = {
  keychain: ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'PATH'],
  'dpapi-user': ['SystemRoot', 'windir', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PSModulePath'],
  'secret-service': ['HOME', 'USER', 'LOGNAME', 'PATH', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY'],
  // No custodian child on POSIX. On Windows the key-file DACL steps run whoami.exe and icacls.exe by absolute path,
  // which need only the system folder and a temp folder.
  'key-file': ['SystemRoot', 'windir', 'TEMP', 'TMP']
}

/** Never passed, whatever an allowlist says. */
function forbidden(name: string): boolean {
  const u = name.toUpperCase()
  return u === 'NODE_OPTIONS' || u.startsWith('ORGAI_')
}

/**
 * The helper's environment for `scheme`: only the allowlisted names, matched case-insensitively on Windows (so `PATH`
 * or `path` is kept as `Path`) and exactly elsewhere. Values with NUL or an empty value are dropped. key-file has no
 * child outside Windows, so it gets an empty environment there.
 */
export function custodianEnvFor(scheme: VaultCustodyScheme, env: Env = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const out: Record<string, string> = {}
  if (scheme === 'key-file' && platform !== 'win32') return out
  const win = platform === 'win32'
  const names = CUSTODIAN_ENV_ALLOWLIST[scheme]
  const present = Object.keys(env)
  for (const name of names) {
    if (forbidden(name)) continue
    let value: string | undefined
    if (win) {
      const lower = name.toLowerCase()
      // Prefer the exact spelling, then any other casing (Windows variables are case-insensitive).
      const hit = env[name] !== undefined ? name : present.find((k) => k.toLowerCase() === lower)
      value = hit === undefined ? undefined : env[hit]
    } else {
      value = env[name]
    }
    if (typeof value !== 'string' || value === '' || value.includes('\0')) continue
    out[name] = value
  }
  return out
}
