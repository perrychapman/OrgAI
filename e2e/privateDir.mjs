// A fresh temp folder only the current user can create files in (mirror of src/main/testSupport/privateTempDir.ts).
// On win32 %TEMP% can grant other accounts inheritable write, and the key-file custodian refuses a key file whose own
// folder allows that, so the leaf folder drops inheritance and grants only this user's SID. POSIX: plain mkdtemp.
// No imports from lib.mjs (it sets env as a side effect).
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const sys32 = () => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')

function userSid() {
  const who = execFileSync(path.join(sys32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true })
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(who)?.[1]
  if (!sid) throw new Error(`privateTempDir: whoami named no user SID: ${who}`)
  return sid
}

export function privateTempDir(prefix, parent = os.tmpdir()) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, prefix)))
  if (process.platform !== 'win32') return dir
  execFileSync(path.join(sys32(), 'icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${userSid()}:(OI)(CI)F`], { cwd: os.tmpdir(), windowsHide: true, stdio: 'ignore' })
  return dir
}

/**
 * Writes a provisioned key file (mode 0600). On win32 the key-file custodian also requires the file's own DACL to be
 * protected with this user's SID as the only entry (an inherited entry is refused even from a private folder), so the
 * file gets the same `icacls /inheritance:r /grant:r *<SID>:F` the custodian applies to a key it creates.
 */
export function writePrivateKeyFile(file, bytes) {
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  if (process.platform !== 'win32') return
  execFileSync(path.join(sys32(), 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${userSid()}:F`], { cwd: os.tmpdir(), windowsHide: true, stdio: 'ignore' })
}
