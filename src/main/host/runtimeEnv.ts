/**
 * What the entry point tells the host about the process it runs in (cli-spec 3.1.1). The Electron entry
 * (src/main/index.ts) fills it from `app`; a pure-Node host (`--host inproc`, a later wave) fills it without electron.
 * Pure types: importing this module loads nothing.
 */
export interface HostRuntimeEnv {
  /** The canonical userData folder (ORGAI_DATA_DIR replaces it); the data dir is `<userDataDir>/data`. */
  userDataDir: string
  /** Where main.log goes (created by installLogging). */
  logsDir: string
  appVersion: string
  isPackaged: boolean
  /** Set only when running inside Electron; the startup log line names it then. */
  electronVersion?: string
}
