/**
 * Builds the one CliContext a command runs with (cli-spec 6): resolved data dirs, the host client, the read-only store
 * reader, project resolution, the launcher, the `--host inproc` entry and signal listeners. Electron-free.
 */
import { connectHost } from './client/hostClient'
import { createLauncher } from './client/launcher'
import { resolveDataDirs, userChoseDataDir } from './client/locate'
import { readOnlySnapshot } from './client/readOnlyStore'
import { resolveProject } from './client/resolveProject'
import type { SecretOverlay } from './secretOverlay'
import type { CliContext, CliGlobals, CliIo, InprocHostHandle } from './types'
import { CLI_VERSION } from './version'

export interface BuildContextInput {
  globals: CliGlobals
  env: NodeJS.ProcessEnv
  cwd: string
  platform: NodeJS.Platform
  io: CliIo
  /** The environment secret overlay (collected and scrubbed by index.ts for --host inproc). */
  overlay?: SecretOverlay['overlay']
  /** Where SIGINT / SIGTERM come from (process by default). */
  signalSource?: Pick<NodeJS.Process, 'on' | 'off'>
  pid?: number
}

/** NO_COLOR (any non-empty value), --no-color and a non-TTY stdout all turn colour off. */
export function colorEnabled(globals: CliGlobals, env: NodeJS.ProcessEnv, io: CliIo): boolean {
  return globals.color && io.stdout.isTTY === true && !env.NO_COLOR
}

/** Contexts whose `--host inproc` host must keep the terminal clean (the TUI owns the screen). */
const quietContexts = new WeakSet<CliContext>()

/**
 * The terminal UI owns the screen: a `--host inproc` host this context starts later logs to its file only (console
 * output never reaches the terminal). Call before the host starts; a no-op for a host already running.
 */
export function quietInproc(ctx: CliContext): void {
  quietContexts.add(ctx)
}

export function buildContext(input: BuildContextInput): CliContext {
  const { env, cwd, platform, io } = input
  const globals: CliGlobals = { ...input.globals, color: colorEnabled(input.globals, env, io) }
  const paths = resolveDataDirs({ flag: globals.dataDir, env, platform, cwd })
  const signalSource = input.signalSource ?? process
  const pid = input.pid ?? process.pid
  const launcher = createLauncher({
    dataDir: paths.dataDir,
    userDataDir: paths.userDataDir,
    userChoseDataDir: userChoseDataDir({ flag: globals.dataDir, env }),
    env
  })

  let inproc: Promise<InprocHostHandle> | undefined
  // The started in-process host's owner key (memory only): connect() proves ownership of that host with it.
  let owner: { key: string; hostInstanceId: string } | undefined
  const ctx: CliContext = {
    globals,
    paths,
    env,
    cwd,
    platform,
    io,
    version: CLI_VERSION,
    connect: (scopes, opts = {}) =>
      connectHost({
        dataDir: paths.dataDir,
        scopes,
        clientKind: opts.clientKind ?? 'cli',
        clientVersion: CLI_VERSION,
        cwd,
        pid,
        ...(opts.waitStartingMs !== undefined ? { waitStartingMs: opts.waitStartingMs } : {}),
        ...(owner ? { ownerKey: owner.key, ownerHostInstanceId: owner.hostInstanceId } : {}),
        platform
      }),
    readStore: () => readOnlySnapshot({ dataDir: paths.dataDir }),
    resolveProject: (projects) => resolveProject(projects, { flag: globals.project, cwd, platform }),
    launcher,
    startInproc: () => {
      // One in-process host per CLI process.
      inproc ??= import('./inprocHost').then((m) =>
        m.startInprocHost({
          userDataDir: paths.userDataDir,
          dataDir: paths.dataDir,
          env,
          mock: env.ORGAI_MOCK === '1',
          overlay: input.overlay ?? new Map(),
          ...(quietContexts.has(ctx) ? { quiet: true } : {})
        })
      ).then((h) => {
        if (h.ownerKey && h.hostInstanceId) owner = { key: h.ownerKey, hostInstanceId: h.hostInstanceId }
        return h
      })
      return inproc
    },
    signals: {
      onInterrupt(fn) {
        const onInt = (): void => fn('SIGINT')
        const onTerm = (): void => fn('SIGTERM')
        signalSource.on('SIGINT', onInt)
        signalSource.on('SIGTERM', onTerm)
        return () => {
          signalSource.off('SIGINT', onInt)
          signalSource.off('SIGTERM', onTerm)
        }
      }
    }
  }
  return ctx
}
