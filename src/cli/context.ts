/**
 * Builds the one CliContext a command runs with (cli-spec 6): resolved data dirs, the host client, the read-only store
 * reader, project resolution, the in-process host entry and signal listeners. Electron-free.
 */
import { homedir } from 'node:os'
import { connectHost } from './client/hostClient'
import { checkCliFolder, readProductMarker } from '../main/store/productMarker'
import { DESKTOP_DATA_DIR_NOTE, ignoresDesktopDataDir, platformUserDataDir, resolveDataDirs } from './client/locate'
import { readOnlySnapshot } from './client/readOnlyStore'
import { resolveProject } from './client/resolveProject'
import type { SecretOverlay } from './secretOverlay'
import { CliError, EXIT, type CliContext, type CliGlobals, type CliIo, type InprocHostHandle, type InprocStartOptions } from './types'
import { CLI_VERSION } from './version'

export interface BuildContextInput {
  globals: CliGlobals
  env: NodeJS.ProcessEnv
  cwd: string
  platform: NodeJS.Platform
  io: CliIo
  /** The environment secret overlay (collected and scrubbed by index.ts prepareContext). */
  overlay?: SecretOverlay['overlay']
  /** Where SIGINT / SIGTERM come from (process by default). */
  signalSource?: Pick<NodeJS.Process, 'on' | 'off'>
  pid?: number
  /** The home folder (default os.homedir()); tests. */
  home?: string
}

/** Printed once, the first time orgai opens a new data folder (cli-standalone-default.md 4.4). Never reads the app's folder. */
export const FIRST_START_NOTE =
  'orgai keeps its own projects and settings, separate from the OrgAI app. Projects made with an older orgai are in the OrgAI app.'

/** NO_COLOR (any non-empty value), --no-color and a non-TTY stdout all turn colour off. */
export function colorEnabled(globals: CliGlobals, env: NodeJS.ProcessEnv, io: CliIo): boolean {
  return globals.color && io.stdout.isTTY === true && !env.NO_COLOR
}

/** Contexts whose host must keep the terminal clean (the TUI owns the screen). */
const quietContexts = new WeakSet<CliContext>()

/**
 * The terminal UI owns the screen: the host this context starts later logs to its file only (console
 * output never reaches the terminal). Call before the host starts; a no-op for a host already running.
 */
export function quietInproc(ctx: CliContext): void {
  quietContexts.add(ctx)
}

/**
 * One in-process host per process at a time: concurrent calls share the start; once that host has closed (a withHost
 * stopped it), the next call starts a new one, so `orgai init`'s Architect can follow its withHost. A failed start is
 * forgotten too. The first call's options decide while a host is running.
 */
export function reusableInproc(start: (opts: InprocStartOptions) => Promise<InprocHostHandle>): (opts?: InprocStartOptions) => Promise<InprocHostHandle> {
  let current: Promise<InprocHostHandle> | undefined
  return (opts = {}) => {
    if (current) return current
    const started = start(opts)
    current = started
    const forget = (): void => {
      if (current === started) current = undefined
    }
    started.then((h) => h.closed.then(forget, forget), forget)
    return started
  }
}

/** The note about ORGAI_DATA_DIR is printed once per process. */
let desktopEnvNoted = false

/** Tests: forget that the note was printed. */
export function resetDesktopEnvNote(): void {
  desktopEnvNoted = false
}

export function buildContext(input: BuildContextInput): CliContext {
  const { env, cwd, platform, io } = input
  const globals: CliGlobals = { ...input.globals, color: colorEnabled(input.globals, env, io) }
  const home = input.home ?? homedir()
  const paths = resolveDataDirs({ flag: globals.dataDir, env, platform, cwd, home })
  // First, before anything reads or writes the folder: it must be the CLI's own (spec 3.1).
  const firstStart = readProductMarker(paths.userDataDir).state === 'absent'
  const refusal = checkCliFolder({ ...paths, desktopDefault: platformUserDataDir(platform, env, home), platform })
  if (refusal) throw new CliError(refusal, EXIT.usage)
  if (firstStart && globals.outputFormat === 'text') io.stderr.write(`${FIRST_START_NOTE}\n`)
  if (!desktopEnvNoted && ignoresDesktopDataDir({ flag: globals.dataDir, env })) {
    desktopEnvNoted = true
    io.stderr.write(`${DESKTOP_DATA_DIR_NOTE}\n`)
  }
  const signalSource = input.signalSource ?? process
  const pid = input.pid ?? process.pid
  // The started in-process host's owner key (memory only): connect() proves ownership of that host with it.
  let owner: { key: string; hostInstanceId: string } | undefined
  const startInproc = reusableInproc((opts) =>
    import('./inprocHost').then((m) =>
      m.startInprocHost({
        userDataDir: paths.userDataDir,
        dataDir: paths.dataDir,
        env,
        mock: env.ORGAI_MOCK === '1',
        overlay: input.overlay ?? new Map(),
        ...(opts.background ? { background: opts.background } : {}),
        cwd,
        ...(quietContexts.has(ctx) ? { quiet: true } : {})
      })
    ).then((h) => {
      if (h.ownerKey && h.hostInstanceId) owner = { key: h.ownerKey, hostInstanceId: h.hostInstanceId }
      return h
    })
  )
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
    startInproc,
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
