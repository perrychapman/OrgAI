// The e2e scripts must never reach the real OS keychain: importing e2e/lib.mjs sets the isolation flags in
// process.env (the app's vault variable and the orgai CLI's own), which every launch(), CLI and pty child inherits.
import assert from 'node:assert/strict'
import test from 'node:test'

const FLAGS = ['ORGAI_VAULT_NO_OS_KEYSTORE', 'ORGAI_CLI_VAULT_NO_OS_KEYSTORE']

test('e2e/lib.mjs turns the OS keystore off for every child it starts, for the app and the CLI', async () => {
  for (const f of FLAGS) delete process.env[f]
  await import('../e2e/lib.mjs')
  for (const f of FLAGS) assert.equal(process.env[f], '1', f)
})

test('cliLib environment carries both flags', async () => {
  const { ENV } = await import('../e2e/cliLib.mjs')
  for (const f of FLAGS) assert.equal(ENV[f], '1', f)
})
