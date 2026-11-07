/**
 * Host contracts (cli-spec Wave 1): the services a host dispatcher serves, how a call arrived, the desktop-only hooks
 * and the activity tracker's API. Types only: every import is `import type`, so this module loads no service and no
 * Electron code (noElectronImport.test.ts). Relative imports only.
 */
import type {
  ActivityLeaseKind,
  AppNavigateEvent,
  AppReferenceQuery,
  AppReferenceResult,
  FocusRunTarget,
  HostActivitySnapshot,
  HostClientKind,
  HostKind,
  HostScope,
  HostState,
  HostStatusResult,
  HostStopInput,
  HostStopResult,
  Project,
  TeamFilesStatus
} from '../../shared/types'
import type { AppLike } from '../appInfo'
import type { CapabilityServiceApi } from '../capabilities/types'
import type { ConnectionService } from '../connections/service'
import type { KitService } from '../kit/service'
import type { MaintenanceService } from '../maintenance'
import type { McpService } from '../mcp/service'
import type { QuickRunService } from '../quick/quickRuns'
import type { RunManager } from '../runtime/runManager'
import type { AgentImportService } from '../setup/import/importer'
import type { TeamFilesService } from '../teamFiles/service'
import type { OutputsServiceApi } from '../outputs/api'
import type { SetupService } from '../setup/service'
import type { TemplateService } from '../setup/templates'
import type { SkillEvaluationApi, SkillServiceApi } from '../skills/types'
import type { ProjectStore } from '../store/projects'
import type { SettingsStore } from '../store/settings'
import type { HostEventBus } from './events'

/** What the host needs from its environment to answer app:info / app:logPath without Electron. */
export interface HostDispatchEnv {
  app: AppLike
  platform: string
  logsDir: () => string
  hostKind?: HostKind
}

/** Hooks only the Electron shell can serve. Absent under --host inproc (window:openRun answers desktop_unavailable). */
export interface DesktopHooks {
  /**
   * window:openRun after validation: focus the window already scoped to this run, or open a new one at
   * `#/run/<projectId>/<runId>` (index.ts window factory).
   */
  openRunWindow(target: FocusRunTarget): void
  /** teamFiles:changed: send a project's team-files status to every window (desktop_only push; never to a socket). */
  teamFilesChanged?(status: TeamFilesStatus): void
  /**
   * An agent's open_in_app (RunManager -> SelfKnowledgeHooks.navigate): send an AppNavigateEvent on IPC.appNavigate to
   * the live unscoped main window (restored, focused, created when closed). false only when no window can be made.
   */
  navigate?(event: AppNavigateEvent): boolean
}

/** host.status / host.stop, served by whoever owns the host lifecycle (bootstrap). */
export interface HostControl {
  status(): HostStatusResult
  stop(input: HostStopInput): Promise<HostStopResult>
}

/**
 * Everything a host dispatcher serves. The required fields are exactly the old ipc.ts IpcServices minus
 * openRunWindow (now DesktopHooks); the optional ones are new in Wave 1.
 */
export interface HostServices {
  projects: ProjectStore
  runs: RunManager
  setup: SetupService
  maintenance: MaintenanceService
  settings: SettingsStore
  connections: ConnectionService
  mcp: McpService
  /** Ids of the adapters handed to RunManager; `app:info` reports `mockAdapter` from it. */
  adapterIds: readonly string[]
  /** The virtual harness project (HARNESS_PROJECT_ID), built fresh from the current settings (mcp/assist.ts harnessProject). */
  harnessProject(): Project
  /** Agent import and org export (src/main/setup/import/importer.ts). */
  importer: AgentImportService
  /** Project skills, the skill library and the repo skill import (src/main/skills/service.ts). */
  skills: SkillServiceApi
  /** Skill evaluation (src/main/skills/evaluation.ts). */
  skillEvaluation: SkillEvaluationApi
  /** The Team assistant: discovery, recommendations, apply and grants (src/main/capabilities/service.ts). */
  capabilities: CapabilityServiceApi
  /** Chat (quick runs): start, promote, the project of a continued run and the display project (src/main/quick/quickRuns.ts). */
  quick: QuickRunService
  /** Saved team templates (src/main/setup/templates.ts). */
  templates: TemplateService
  /** The practice kit (src/main/kit/service.ts). Absent = the kit channels are not registered (older tests). */
  kit?: KitService
  /** Team files (src/main/teamFiles/service.ts). Absent = the teamFiles channels answer 'not available' (older tests). */
  teamFiles?: TeamFilesService
  /** The reference service (reference/appReference.ts); app:reference answers with status allowed. Absent = "not available". */
  reference?: { query(q: AppReferenceQuery, opts: { status: boolean }): Promise<AppReferenceResult> }
  /** Run outputs (src/main/outputs/service.ts). Absent = outputs:list answers [], preview 'none', forget / delete reject. */
  outputs?: OutputsServiceApi
  /** The push bus. Absent = the dispatcher makes its own. */
  events?: HostEventBus
  /** Lease tracking for idle exit and drain. Absent = no tracking (noopActivity). */
  activity?: HostActivityTrackerApi
  /** usage:refresh. Absent = the channel is not served. */
  usage?: { refresh(): Promise<unknown> }
  /** app:info / app:logPath without Electron. */
  env?: HostDispatchEnv
  /** Desktop-only hooks (Electron shell). */
  desktop?: DesktopHooks
  /** host.status / host.stop. */
  host?: HostControl
}

/** How a call reached the dispatcher. */
export interface InvokeContext {
  /** 'desktop': ipcMain from a window. 'socket': an authenticated socket client. 'inproc': the CLI's own in-process host. */
  surface: 'desktop' | 'socket' | 'inproc'
  /** webContents id of the calling window (desktop). */
  senderId?: number
  clientKind?: HostClientKind
  /** The client's pid (socket, from host.hello). */
  pid?: number
  grantedScopes?: readonly HostScope[]
}

/** An RPC call (socket or inproc): it always carries the scopes host.hello granted. */
export type RpcInvokeContext = InvokeContext & { surface: 'socket' | 'inproc'; grantedScopes: readonly HostScope[] }

/** cli-spec 3.2(4): leases and polled sources that keep a host from going idle, plus the drain transition. */
export interface HostActivityTrackerApi {
  /** Hold one lease of this kind; the returned release is idempotent. */
  acquire(kind: ActivityLeaseKind, label?: string): () => void
  /** Hold one lease of this kind until the promise settles; resolves or rejects as it does. */
  track<T>(kind: ActivityLeaseKind, p: Promise<T>): Promise<T>
  /** Add a polled count to this kind (e.g. runManager.liveRuns().length); the returned remover is idempotent. */
  addSource(kind: ActivityLeaseKind, count: () => number): () => void
  snapshot(): HostActivitySnapshot
  isIdle(): boolean
  state(): HostState
  /** Move to 'draining' when idle (or with force) and shut down; refused with the blocking counts otherwise. */
  requestDrain(input?: HostStopInput): Promise<HostStopResult>
  onChange(listener: (s: HostActivitySnapshot) => void): () => void
}
