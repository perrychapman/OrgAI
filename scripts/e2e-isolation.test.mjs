// The e2e scripts must never reach the real OS keychain: importing e2e/lib.mjs sets the isolation flag in
// process.env, which every launch(), CLI and pty child inherits.
import assert from 'node:assert/strict'
import test from 'node:test'

test('e2e/lib.mjs turns the OS keystore off for every child it starts', async () => {
  delete process.env.ORGAI_VAULT_NO_OS_KEYSTORE
  await import('../e2e/lib.mjs')
  assert.equal(process.env.ORGAI_VAULT_NO_OS_KEYSTORE, '1')
})

test('cliLib environment carries the flag', async () => {
  const { ENV } = await import('../e2e/cliLib.mjs')
  assert.equal(ENV.ORGAI_VAULT_NO_OS_KEYSTORE, '1')
})
