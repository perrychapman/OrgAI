// node --test scripts/mac-dev-app-name.test.mjs (npm run test:scripts). Injected runner; never touches a real plist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDevAppName, appBundleOf, CODESIGN, PLUTIL } from './lib/macDevAppName.mjs'

const APP = '/p/node_modules/electron/dist/Electron.app'
const BIN = `${APP}/Contents/MacOS/Electron`

function fake(names) {
  const calls = []
  const run = async (file, args) => {
    calls.push([file, ...args])
    if (args[0] === '-extract') {
      const v = names[args[1]]
      if (v === undefined) throw new Error('no such key')
      return { stdout: v + '\n' }
    }
    return { stdout: '' }
  }
  return { calls, run }
}

test('appBundleOf', () => {
  assert.equal(appBundleOf(BIN), APP)
  assert.equal(appBundleOf('/x/electron.exe'), null)
  assert.equal(appBundleOf(undefined), null)
})

test('non-darwin is a no-op without running anything', async () => {
  const f = fake({})
  const r = await applyDevAppName({ platform: 'win32', electronBinary: BIN, run: f.run })
  assert.equal(r.action, 'skipped')
  assert.equal(f.calls.length, 0)
})

test('already named: reads only, no edit or sign', async () => {
  const f = fake({ CFBundleName: 'OrgAI', CFBundleDisplayName: 'OrgAI' })
  const r = await applyDevAppName({ platform: 'darwin', electronBinary: BIN, run: f.run })
  assert.equal(r.action, 'unchanged')
  assert.ok(f.calls.every((c) => c[1] === '-extract'))
})

test('renames both keys then signs, exact argv', async () => {
  const f = fake({ CFBundleName: 'Electron' }) // display name missing
  const r = await applyDevAppName({ platform: 'darwin', electronBinary: BIN, run: f.run })
  assert.equal(r.action, 'renamed')
  const plist = `${APP}/Contents/Info.plist`
  assert.deepEqual(f.calls.slice(2), [
    [PLUTIL, '-replace', 'CFBundleName', '-string', 'OrgAI', plist],
    [PLUTIL, '-replace', 'CFBundleDisplayName', '-string', 'OrgAI', plist],
    [CODESIGN, '--force', '--deep', '--sign', '-', APP]
  ])
})

test('only the stale key is replaced', async () => {
  const f = fake({ CFBundleName: 'OrgAI', CFBundleDisplayName: 'Electron' })
  await applyDevAppName({ platform: 'darwin', electronBinary: BIN, run: f.run })
  const edits = f.calls.filter((c) => c[1] === '-replace')
  assert.equal(edits.length, 1)
  assert.equal(edits[0][2], 'CFBundleDisplayName')
})

test('runner failure on edit propagates; bad path throws', async () => {
  const run = async (_f, a) => {
    if (a[0] === '-replace') throw new Error('denied')
    return { stdout: 'Electron' }
  }
  await assert.rejects(applyDevAppName({ platform: 'darwin', electronBinary: BIN, run }), /denied/)
  await assert.rejects(applyDevAppName({ platform: 'darwin', electronBinary: '/x/y', run }), /Unexpected/)
})
