import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWhoamiUser } from '../store/custodians/keyFile'
import { system32Path } from '../host/systemBinaries'

/**
 * Test helper: a fresh temp folder that only the current user can create files in. On win32 %TEMP% may grant other
 * accounts inheritable write (CI runners, sandbox users), and keyFile.ts refuses to create a key file in a folder where
 * "Other accounts can open new files", so the leaf folder drops inheritance and grants only this user's SID (keyFile.ts
 * checks the key folder itself, not its parents). POSIX: plain mkdtemp. Returns the realpath.
 */
export function privateTempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  if (process.platform !== 'win32') return dir
  const who = execFileSync(system32Path('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', cwd: tmpdir(), windowsHide: true })
  const user = parseWhoamiUser(who)
  if (!user) throw new Error('privateTempDir: whoami named no user SID')
  execFileSync(system32Path('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${user.sid}:(OI)(CI)F`], {
    cwd: tmpdir(),
    windowsHide: true,
    stdio: 'ignore'
  })
  return dir
}
