// `cli-mcp` end to end (cli-spec 6.3, Wave 5): `orgai mcp` against a `--host inproc` daemon on the mock adapter. Run
// `npm run build` first. No tokens, no network (ORGAI_MOCK=1 makes connector sign-in and tests network-free).
//
// A `--host inproc` host cannot save secrets (no safeStorage outside Electron), so set-secret and the mock sign-in end
// with that refusal here; src/cli/commands/mcp.int.test.ts covers both succeeding with a writable test store.
//
// 1. add a stdio server (text and JSON), list, show, disable / enable, set-secret --stdin (refused: read-only store,
//    the value never echoed), remove without --yes (exit 2), remove --yes.
// 2. library add / list; connectors list (text and JSON), connectors add of a no-sign-in preset (connected at once).
// 3. `SSH_CONNECTION=... orgai mcp auth --library linear` prints the forward command `ssh -L 38917:127.0.0.1:38917 ...`
//    and the announced URL; with JSON output the instructions go to stderr and stdout stays one document.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, finish, log, makeFixtureRepo, removeFixture } from './lib.mjs'
import { cli, json, requireBuild, seedProject, show, startDaemon, stopDaemon } from './cliLib.mjs'

requireBuild()
const repo = makeFixtureRepo('cli-mcp')
const MOCK_URL = 'https://mock.invalid/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A38917%2Fcallback&state=mock'

try {
  await startDaemon()
  const project = await seedProject(repo, { name: 'Mcp e2e' })
  check(!!project?.id, 'seeded a mock project over hostRpc')
  const inRepo = { cwd: repo }

  // ---- 1. project servers ----
  let r = await cli(['mcp', 'add', 'notes', '--command', 'node', '--arg', 'server.js', '--secret-var', 'NOTES_TOKEN', '--env', 'LOG=1'], inRepo)
  check(r.code === 0 && r.out.includes('Added notes to Mcp e2e.'), 'mcp add (text)', show(r))
  r = await cli(['mcp', 'add', 'remote-docs', '--url', 'https://docs.example.com/mcp', '--header', 'X-Org=acme', '--output-format', 'json'], inRepo)
  const added = json(r.out)
  check(r.code === 0 && added?.schemaVersion === 1 && added?.server?.spec?.transport === 'http', 'mcp add --url (json)', show(r))
  r = await cli(['mcp', 'add', 'dup', '--command', 'x', '--env', 'A=1', '--env', 'A=2'], inRepo)
  check(r.code === 2, 'a duplicate NAME=VALUE is exit 2', show(r))

  r = await cli(['mcp', 'list'], inRepo)
  check(r.code === 0 && /notes\s+stdio\s+on\s+-\s+NOTES_TOKEN/.test(r.out) && /remote-docs\s+http\s+on/.test(r.out), 'mcp list (text)', show(r))
  r = await cli(['mcp', 'list', '--output-format', 'json'], inRepo)
  const listed = json(r.out)
  check(r.code === 0 && listed?.servers?.length === 2 && listed.servers.some((s) => s.name === 'notes' && s.missingSecrets[0] === 'NOTES_TOKEN'), 'mcp list (json)', show(r))
  r = await cli(['mcp', 'show', 'notes'], inRepo)
  check(r.code === 0 && r.out.includes('NOTES_TOKEN (missing)') && r.out.includes('LOG=1'), 'mcp show', show(r))

  r = await cli(['mcp', 'disable', 'notes'], inRepo)
  check(r.code === 0 && r.out.includes('Disabled notes.'), 'mcp disable', show(r))
  r = await cli(['mcp', 'show', 'notes', '--output-format', 'json'], inRepo)
  check(json(r.out)?.server?.enabled === false, 'disabled in json', show(r))
  r = await cli(['mcp', 'enable', 'notes'], inRepo)
  check(r.code === 0 && json((await cli(['mcp', 'show', 'notes', '--output-format', 'json'], inRepo)).out)?.server?.enabled === true, 'mcp enable', show(r))

  r = await cli(['mcp', 'set-secret', 'notes', 'NOTES_TOKEN', '--stdin'], { ...inRepo, input: 'e2e-secret-value\n' })
  // Wave 7: the CLI's own host has the secret vault, so the value is saved (never echoed).
  check(r.code === 0 && r.out.includes('Saved NOTES_TOKEN') && !(r.out + r.err).includes('e2e-secret-value'), 'set-secret --stdin on an inproc host saves to the vault and never echoes the value', show(r))
  r = await cli(['mcp', 'set-secret', 'notes', 'NOTES_TOKEN', 'on-argv'], inRepo)
  check(r.code === 2, 'a secret value on argv is exit 2', show(r))

  r = await cli(['mcp', 'remove', 'notes'], inRepo)
  check(r.code === 2 && r.err.includes('--yes'), 'remove without a terminal needs --yes', show(r))
  r = await cli(['mcp', 'remove', 'notes', '--yes'], inRepo)
  check(r.code === 0 && r.out.includes('Removed notes.'), 'mcp remove --yes', show(r))
  r = await cli(['mcp', 'list', '--output-format', 'json'], inRepo)
  check(json(r.out)?.servers?.length === 1, 'one server left', show(r))

  // ---- 2. library and connectors ----
  r = await cli(['mcp', 'library', 'add', 'shared-docs', '--url', 'https://docs.example.com/v2/mcp', '--secret-header', 'Authorization'])
  check(r.code === 0 && r.out.includes('Added shared-docs to your MCP library'), 'mcp library add', show(r))
  r = await cli(['mcp', 'library', 'list'])
  check(r.code === 0 && /shared-docs\s+mcpl_\S+\s+http/.test(r.out), 'mcp library list', show(r))
  r = await cli(['mcp', 'library', 'list', '--output-format', 'json'])
  check(json(r.out)?.entries?.some((e) => e.name === 'shared-docs' && e.missingSecrets[0] === 'Authorization'), 'mcp library list (json)', show(r))

  r = await cli(['mcp', 'connectors', 'list'])
  check(r.code === 0 && /deepwiki\s+DeepWiki\s+No sign-in needed\s+available/.test(r.out) && /linear\s+Linear\s+Sign in/.test(r.out), 'mcp connectors list (text)', show(r))
  r = await cli(['mcp', 'connectors', 'add', 'deepwiki'])
  check(r.code === 0 && r.out.includes('It is connected.'), 'connectors add of a no-sign-in preset', show(r))
  r = await cli(['mcp', 'connectors', 'list', '--filter', 'deepwiki', '--output-format', 'json'])
  const dw = json(r.out)?.connectors?.[0]
  check(dw?.id === 'deepwiki' && dw?.state === 'connected' && dw?.ease === 'none', 'deepwiki connected (json)', show(r))
  r = await cli(['mcp', 'connectors', 'add', 'Not_Kebab'])
  check(r.code === 2, 'a non-kebab connector id is exit 2', show(r))
  r = await cli(['mcp', 'link', 'deepwiki'], inRepo)
  check(r.code === 0 && r.out.includes('Linked deepwiki'), 'mcp link a library entry', show(r))

  // ---- 3. auth over SSH ----
  r = await cli(['mcp', 'connectors', 'add', 'linear'])
  check(r.code === 0 && r.out.includes('orgai mcp auth --library linear'), 'connectors add linear names the auth step', show(r))
  const ssh = { SSH_CONNECTION: '10.9.8.7 50123 10.9.8.6 22', USER: 'dev' }
  r = await cli(['mcp', 'auth', '--library', 'linear'], { env: ssh })
  check(r.out.includes('Forward the callback first: ssh -L 38917:127.0.0.1:38917 dev@10.9.8.6'), 'mcp auth over SSH prints the ssh -L command', show(r))
  check(r.out.includes('Open this URL in a browser to sign in:') && r.out.includes(MOCK_URL), 'mcp auth prints the announced URL (browser not opened)', show(r))
  // Wave 7: the vault stores the (fake) token, so the mock sign-in completes.
  check(r.code === 0 && r.out.includes('linear: authorized'), 'the vault stores the token and the sign-in completes', show(r))
  r = await cli(['mcp', 'auth', '--library', 'linear', '--no-browser', '--output-format', 'json'], { env: ssh })
  const doc = json(r.out)
  check(doc?.schemaVersion === 1 && doc?.authorizeUrl === MOCK_URL && doc?.openedBrowser === false && r.err.includes('ssh -L 38917:127.0.0.1:38917'), 'mcp auth json: one document, instructions on stderr', show(r))

  r = await cli(['mcp', 'search', 'x', '--limit', '0'])
  check(r.code === 2, 'search --limit 0 is exit 2 (no network)', show(r))
} catch (e) {
  check(false, 'cli-mcp ran to the end', e?.stack ?? String(e?.message ?? e))
} finally {
  const stop = await stopDaemon().catch((e) => ({ code: -1, out: '', err: String(e) }))
  log(`daemon stop: exit ${stop.code}`)
  removeFixture(repo)
  if (fs.existsSync(path.join(repo))) log('fixture left behind', repo)
  finish('cli-mcp')
}
