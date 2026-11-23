import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTestGate, TEST_GATE_DETAIL_CHARS, testGateCommand, testGateEnv, testGateMissingCommand } from './testGate'

// Real shell, real processes: the commands below are plain `node -e` lines that behave the same under cmd.exe and /bin/sh.
let dir: string

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-gate-')))
})

afterEach(() => {
  try {
    // The killed tree may still be letting go of its cwd (taskkill is asynchronous on Windows).
    rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
  } catch {
    /* a temp directory left behind is not a test failure */
  }
})

describe('testGateCommand', () => {
  it('is the trimmed command only when the gate is on, for a code project', () => {
    expect(testGateCommand({ requireTestsPass: true, testCommand: '  npm test  ' })).toBe('npm test')
    expect(testGateCommand({})).toBeNull()
    expect(testGateCommand({ testCommand: 'npm test' })).toBeNull()
    expect(testGateCommand({ requireTestsPass: false, testCommand: 'npm test' })).toBeNull()
    expect(testGateCommand({ requireTestsPass: true })).toBeNull()
    expect(testGateCommand({ requireTestsPass: true, testCommand: '   ' })).toBeNull()
    expect(testGateCommand({ requireTestsPass: true, testCommand: 'npm test', kind: 'engagement' })).toBeNull()
  })
})

describe('testGateMissingCommand', () => {
  const SENTENCE = 'Tests are required before merging, but no test command is set. Add one in Settings > Branches.'
  it('names the missing command only when tests are required for a code project', () => {
    expect(testGateMissingCommand({ requireTestsPass: true })).toBe(SENTENCE)
    expect(testGateMissingCommand({ requireTestsPass: true, testCommand: '' })).toBe(SENTENCE)
    expect(testGateMissingCommand({ requireTestsPass: true, testCommand: '   ' })).toBe(SENTENCE)
    expect(testGateMissingCommand({ requireTestsPass: true, testCommand: 'npm test' })).toBeNull()
    expect(testGateMissingCommand({})).toBeNull()
    expect(testGateMissingCommand({ requireTestsPass: false })).toBeNull()
    expect(testGateMissingCommand({ requireTestsPass: true, kind: 'engagement' })).toBeNull()
  })
})

describe('testGateEnv', () => {
  it('also drops names holding a token, secret or password, and AWS / Azure / GitHub credentials (review M3)', () => {
    const env = testGateEnv({
      PATH: '/bin',
      HOME: '/home/u',
      USERPROFILE: 'C:\\Users\\u',
      TMPDIR: '/tmp',
      NODE_ENV: 'test',
      NPM_TOKEN: 'n',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
      GH_TOKEN: 'g',
      GH_HOST: 'h',
      GITHUB_ACTIONS: 'true',
      GITHUB_PAT: 'p',
      AWS_ACCESS_KEY_ID: 'a',
      AWS_REGION: 'r',
      AZURE_CLIENT_ID: 'z',
      DB_PASSWORD: 'pw',
      MY_SECRET: 's',
      session_token: 't',
      SLACK_BOT_TOKEN: 'b'
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', USERPROFILE: 'C:\\Users\\u', TMPDIR: '/tmp', NODE_ENV: 'test', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' })
  })

  it('drops provider secrets, routing variables and OrgAI control variables, keeps the rest', () => {
    const env = testGateEnv({
      PATH: '/bin',
      HOME: '/home/u',
      CI: 'true',
      ANTHROPIC_API_KEY: 'sk-ant-1',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'https://gw',
      OPENAI_API_KEY: 'sk-1',
      OPENAI_BASE_URL: 'https://x',
      CODEX_API_KEY: 'c',
      ORGAI_CODEX_API_KEY: 'c2',
      ORGAI_DATA_DIR: '/data',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CONFIG_DIR: '/cfg',
      GOOGLE_API_KEY: 'g',
      MY_SERVICE_API_KEY: 'k',
      ELECTRON_RUN_AS_NODE: '1'
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', CI: 'true' })
  })
})

describe('runTestGate', () => {
  it('passes on exit code 0 and reports the output', async () => {
    const r = await runTestGate('node -e "console.log(42)"', dir)
    expect(r.outcome).toBe('passed')
    expect(r.exitCode).toBe(0)
    expect(r.detail).toContain('Tests passed')
    expect(r.detail).toContain('42')
  })

  it('fails on a non-zero exit and keeps the end of the output', async () => {
    const r = await runTestGate('node -e "console.error(\'boom\'); process.exit(3)"', dir)
    expect(r.outcome).toBe('failed')
    expect(r.exitCode).toBe(3)
    expect(r.detail).toContain('exit code 3')
    expect(r.detail).toContain('boom')
  })

  it('runs in the given directory', async () => {
    writeFileSync(join(dir, 'marker.txt'), 'x')
    const r = await runTestGate('node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\') ? 0 : 9)"', dir)
    expect(r.outcome).toBe('passed')
  })

  it('caps the output to the last characters', async () => {
    const r = await runTestGate('node -e "console.log(\'A\'.repeat(20000)); console.log(\'THE-END\')"', dir)
    expect(r.detail.length).toBeLessThanOrEqual(TEST_GATE_DETAIL_CHARS + 200)
    expect(r.detail).toContain('THE-END')
  })

  it('closes stdin: a command that reads it ends at once', async () => {
    const r = await runTestGate('node -e "process.stdin.on(\'end\', () => process.exit(0)); process.stdin.resume()"', dir, { timeoutMs: 20_000 })
    expect(r.outcome).toBe('passed')
  })

  it('passes no provider secret to the command, and no OrgAI control variable', async () => {
    const env = { ...process.env, OPENAI_API_KEY: 'sk-SECRET', ANTHROPIC_API_KEY: 'sk-ant-SECRET', CODEX_API_KEY: 'x', ORGAI_DATA_DIR: '/d', CLAUDE_CODE_OAUTH_TOKEN: 'tok', KEEP_ME: 'yes' }
    const script = "const k=['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_API_KEY','ORGAI_DATA_DIR','CLAUDE_CODE_OAUTH_TOKEN'].filter(n=>process.env[n]!==undefined);console.log('leaked='+k.join(',')+';keep='+process.env.KEEP_ME)"
    const r = await runTestGate(`node -e "${script}"`, dir, { env })
    expect(r.outcome).toBe('passed')
    expect(r.detail).toContain('leaked=;keep=yes')
    expect(r.detail).not.toContain('SECRET')
  })

  it('stops a run that does not finish: outcome timeout, quickly', async () => {
    const t0 = Date.now()
    const r = await runTestGate('node -e "setTimeout(() => {}, 60000)"', dir, { timeoutMs: 700 })
    expect(r.outcome).toBe('timeout')
    expect(r.exitCode).toBeNull()
    expect(r.detail).toContain('did not finish')
    expect(Date.now() - t0).toBeLessThan(10_000)
  })

  it('kills the process tree on timeout', async () => {
    const marker = join(dir, 'alive.txt').replace(/\\/g, '/')
    // The shell starts a node child which starts a grandchild that would write the marker after 3 s.
    const grand = `setTimeout(()=>require('fs').writeFileSync('${marker}','x'),3000)`
    const child = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'ignore'});setTimeout(()=>{},60000)`
    writeFileSync(join(dir, 'child.js'), child)
    const r = await runTestGate('node child.js', dir, { timeoutMs: 800 })
    expect(r.outcome).toBe('timeout')
    await new Promise((res) => setTimeout(res, 4000))
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'alive.txt'))).toBe(false)
  }, 20_000)

  it('treats a command that cannot be run as a failed run', async () => {
    const r = await runTestGate('this-command-does-not-exist-orgai', dir)
    expect(r.outcome).toBe('failed')
    expect(r.exitCode).not.toBe(0)
  })

  it('refuses a multi-line command without running it', async () => {
    const r = await runTestGate('node -e "1"\nnode -e "2"', dir)
    expect(r.outcome).toBe('failed')
    expect(r.exitCode).toBeNull()
    expect(r.detail).toContain('not a single line')
  })
})
