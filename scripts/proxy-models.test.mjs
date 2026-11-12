// node --test scripts/proxy-models.test.mjs (npm run test:scripts). Pure parts only; no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkKey, checkModelsUrl, familyOf, formatRows, isPrivateHost, keyEnvName, parseModels } from './lib/proxyModels.mjs'

test('checkModelsUrl: https, or http only on private hosts, never credentials', () => {
  assert.equal(checkModelsUrl('https://proxy.example.com/v1/models').hostname, 'proxy.example.com')
  assert.equal(checkModelsUrl('http://localhost:4000/v1/models').port, '4000')
  assert.equal(checkModelsUrl('http://192.168.1.5/v1/models').hostname, '192.168.1.5')
  for (const bad of ['http://proxy.example.com/v1/models', 'ftp://x', 'nope', 'https://u:p@proxy.example.com/', 'http://8.8.8.8/']) {
    assert.throws(() => checkModelsUrl(bad), undefined, bad)
  }
})

test('isPrivateHost', () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.1', '172.20.1.1', '192.168.0.9', '169.254.1.1', '::1', '[::1]', 'fd00::1', 'box.local']) assert.equal(isPrivateHost(h), true, h)
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(isPrivateHost(h), false, h)
})

test('familyOf follows the app rule', () => {
  assert.equal(familyOf('claude-sonnet-4', ''), 'claude')
  assert.equal(familyOf('team-model', 'anthropic'), 'claude')
  assert.equal(familyOf('gpt-5', ''), 'openai')
  assert.equal(familyOf('o3-mini', 'someone'), 'openai')
  assert.equal(familyOf('mystery', 'openai'), 'openai')
  assert.equal(familyOf('gemini-pro', 'google'), 'other')
})

test('parseModels cleans text and skips junk', () => {
  const rows = parseModels({ data: [{ id: 'gpt-5', owned_by: 'openai' }, { id: 'bad\u001b[31m', owned_by: 'x‮' }, { owned_by: 'x' }, null, 7] })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { id: 'gpt-5', owned_by: 'openai', family: 'openai' })
  assert.ok(!/[\u001b‮]/.test(JSON.stringify(rows[1])))
  assert.throws(() => parseModels({ nope: 1 }))
  assert.equal(parseModels([{ id: 'a' }]).length, 1)
})

test('key handling: variable name and value checks never echo the value', () => {
  assert.equal(keyEnvName(undefined), 'PROXY_API_KEY')
  assert.equal(keyEnvName('MY_KEY'), 'MY_KEY')
  assert.throws(() => keyEnvName('sk-abc def'))
  assert.equal(checkKey(' sk-1 '), 'sk-1')
  for (const bad of [undefined, '', 'a\nb', 'x'.repeat(4001)]) {
    try {
      checkKey(bad)
      assert.fail('should throw')
    } catch (e) {
      assert.ok(!String(e.message).includes('x'.repeat(10)))
    }
  }
})

test('formatRows', () => {
  assert.equal(formatRows([]), 'No models listed.')
  assert.match(formatRows([{ id: 'a', owned_by: 'b', family: 'other' }]), /ID +OWNED_BY +FAMILY\na +b +other/)
})
