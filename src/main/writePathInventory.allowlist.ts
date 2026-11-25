// Write-path inventory allow-list (docs/design/cli-sessions.md; the idea comes from docs/design/parallel-sessions.md 8).
//
// Every file-write call site under src/main and src/cli, keyed `relativePath:enclosingFunction:callee` (see
// writePathInventory.test.ts for how keys are built and what the scanner cannot see). The value names the lock, claim or
// ownership rule that makes the write safe when several app/CLI hosts share the data folder.
//
// 'single owner' is the label of a site that is written only by the process that owns the data folder (or the project,
// see below). A new site MUST name its rule; do not add 'single owner' for new code.
//
// Sessions (docs/design/cli-sessions.md, 2026-11): the orgai CLI now runs several processes on one data folder. The
// shared JSON files carry their rule (WRITE_LOCK, RUN_HOST, SESSION_*, VAULT_*). A site that still says 'single owner'
// was looked at for that change and is one of:
// - the desktop app only (it keeps one process per data folder);
// - a per-run file inside one project's own data (a run's record and images: written by the run's host only);
// - a library entry's own folder (`skills/<entryId>/`, an MCP build): the skill library changes it under the write
//   lock (SkillService.libraryLocked); an MCP build belongs to the one assistant run that builds it;
// - the outputs index, written through OutputStore, whose changes run under the write lock (outputs/store.ts `locked`);
// - a per-run or per-process file with a unique name (run skill folders, scratch folders, temp files, the Codex
//   catalog's temp file), or an append to a log;
// - a file every writer fills with the same content (the product marker, the mock home), or one whose lost update only
//   repeats a hint (`tui-hints.json`);
// - a file outside the data folder.
// MCP builds and the logs are the two that rely on convention rather than a lock.
//
// Labels for pre-existing sites that are not covered by data-folder ownership:
// - OWNERSHIP_PRIMITIVE: the write is part of the cross-process data-folder ownership protocol itself (host/ownership.ts:
//   startup mkdir mutex, endpoint and secret files); it is safe by that protocol, not by an owner.
// - REPO_LOCK_PRIMITIVE: the write is part of the cross-process repository lock itself (runtime/repoLock.ts lock dir).
// - REPO_LOCK: the write runs inside withRepoLock for that repository (cross-process).
// - OUTSIDE_DATA_FOLDER: the write targets a file in the user's project that other tools also edit (Claude Code's
//   settings.local.json); no OrgAI lock covers it yet, to be classified in a later phase.
const OWNERSHIP_PRIMITIVE = 'ownership primitive: part of the cross-process data-folder ownership protocol (host/ownership.ts)'
const REPO_LOCK_PRIMITIVE = 'repo lock primitive: part of the cross-process repository lock itself (runtime/repoLock.ts)'
const REPO_LOCK = 'repo lock: runs inside withRepoLock for the repository (cross-process)'
const OUTSIDE_DATA_FOLDER = 'outside data folder: project file shared with other tools, no OrgAI lock yet (later phase)'
const SCRATCH_TEMP ='scratch folder: a private mkdtemp folder (owner-only where the platform has modes) per use inside the OrgAI scratch folder of the OS temp folder (orgai-merge-scratch), holding one temp git index made by git for one call and removed with the folder by that call, or by the next start\'s sweep when a crash left it (older than ten minutes only); nothing else reads or writes it'
// Added after Phase 1 by Schedules, to-dos and team evolution: <dataDir>/schedules.json, <dataDir>/todos.json (and .bak) and <dataDir>/evolution/<projectId>.json
// are written by whichever host owns that data folder (the desktop or the CLI's in-process host, each on its own folder;
// host/ownership.ts refuses a second owner). No shared-store osLock covers them yet: ownership, not a file lock, keeps a
// second process out.
const DATA_FOLDER_OWNER = 'data-folder owner: written only by the host holding host/ownership.ts for that folder (durable write, mkdir or corrupt-file rename); no osLock yet'
// exec --output-last-message: a user-chosen path outside the data folder that other tools may also write; written to a
// private temp file and renamed over the destination (never through a link); no OrgAI lock covers it.
const EXEC_OUTPUT_FILE = 'outside data folder: user-chosen --output-last-message file, temp file + rename, no OrgAI lock'
// Windows portable build only: <userData>/app-icon.ico, the stable copy of the app icon the AppUserModelID registry entry
// points at. Written at start by the desktop process holding Electron's single-instance lock; the CLI never writes it. The
// content is the same bytes from every writer (copied only when missing or of a different size), so a lost race is harmless.
const DESKTOP_ICON_COPY = 'desktop single instance: idempotent copy of the app icon to <userData>/app-icon.ico (portable Windows build), same bytes from any writer'
const TEST_TEMP = 'test helper: private mkdtemp folder under the OS temp dir, never the data folder'
// Not a call site here (the scanner sees only src/main and src/cli): the desktop updater (updater.ts) has electron-updater
// write its download cache outside the data folder, in the OS per-user cache (Windows %LOCALAPPDATA%\orgai-updater
// (electron-builder's updaterCacheDirName, from app-update.yml)\pending), only after the user's updates:download. One desktop per user data folder (single-instance
// lock); the CLI never loads electron-updater. Recorded so the inventory names every writer the app starts.
// Sessions (docs/design/cli-sessions.md): several orgai processes on one CLI data folder. The labels below name the rule
// that covers a site there; the desktop app has its data folder to itself, where the same sites are written by the one
// process that owns it.
// Several sessions may work in one project. Its own files (projects/<id>/ notes, document, knowledge graph, team-file
// state, outputs data; staffing/<id>.json; project-skills/<id>/; team-reviews; the project folder's .orgai/ files and
// ARCHITECTURE.md) are read, changed and rewritten as one step under the data folder's write lock: by the function's
// own locked wrapper (the site is then in its ...Unlocked half), by TeamFilesService.oneChange, or because the whole
// service is wrapped in oneChangePerCall (host/bootstrap.ts). The desktop app has one process and takes no lock.
const PROJECT_LOCKED = "project files: the read-change-write runs as one step under the data folder's write lock (locked wrapper, TeamFilesService.oneChange or oneChangePerCall)"
const RULES_LOCKED = "outside data folder: a project's settings.local.json (other tools may write it too); orgai sessions change it one at a time under the write lock (lockedForProcess)"
const EVOLVE_LOCKED = "team evolution: one operation per project at a time, in this process (serial) and across orgai sessions (namedLock.ts); the desktop app has one process"
const WRITE_LOCK =
  "write lock: the file is re-read and rewritten under the data folder's write lock (store/shared/storeSync.ts) when orgai sessions share the folder; one process per folder writes it directly"
const WRITE_LOCK_CACHE =
  "write lock: a whole-file cache replaced under the data folder's write lock (storeSync.ts SyncedFile.replace; nothing to merge, any writer's content is valid)"
const RUN_HOST =
  'run host: a run record and its images are written only by the session that hosts the run (the run index `owners`), or by one that changes an ended run of a project it holds'
// Self-healing efficiency step 1 (store/runDigest.ts): runs/<runId>/digest.json, a derived cache of an ENDED run's
// record. Any session may write it; every writer computes the same content from the same record, and the file carries a
// key (version, record size, mtime, inode, endedAt) that a reader checks before trusting it, so a lost race or a stale
// write is recomputed, never used. Unique temp name, then an atomic rename; best effort.
const RUN_DIGEST_CACHE =
  'run digest cache: runs/<runId>/digest.json of an ended run, same content from any writer, keyed by the record stat and shape-checked on read; unique temp name + rename, best effort'
const RUN_REMOVAL =
  'run removal: files of runs the index no longer lists (dropped under the write lock), and the orphan sweep only by a session that is alone on the folder, inside the startup mutex'
const SESSION_OWN = "sessions: a session's own record, written while it holds its <id>.lock (own temp name + rename)"
const SESSION_RELEASE = "sessions: a session's own record and lock file, removed by that session when it ends"
const SESSION_SWEEP = "sessions: files of sessions whose lock is free (their process is gone), removed inside the startup mutex"
const SESSION_MKDIR = 'sessions: idempotent recursive mkdir of <data>/run/sessions (mode 0700), inside <data>/run'
const VAULT_LOCKED =
  "vault: every commit runs under the data folder's write lock; a value change re-reads vault.json first; a creation re-checks under the lock that no other session created one"
const VAULT_ALONE = 'vault reset: refused while another orgai session runs (SecretStore.refuseWhileOthersRun)'
// UI overhaul skill export (SkillService.exportTo, desktop window only): the destination is a folder the user just picked,
// outside the data folder; each export makes a NEW folder there (mkdirSync fails with EEXIST rather than reuse one, files
// are written with flag 'wx'), so nothing is ever overwritten and two sessions exporting to one place get two folders.
// The skill it reads is read inside the service's one change under the write lock (oneChangePerCall).
const EXPORT_NEW_FOLDER = "outside data folder: a user-picked destination; a new folder per export (mkdir EEXIST, files 'wx'), never overwrites; the skill is read under the write lock (oneChangePerCall)"
const TEMP_AGE ='temp folder: run skill folders older than 24 h, swept by a session that is alone on its data folder (age keeps a session that starts meanwhile safe)'
const DATA_MKDIR = 'data folder creation: idempotent recursive mkdir'
const COMPILE_CACHE =
  "compile cache: <data>/run/compile-cache/<version> (mode 0700, inside the folder agent tools are kept out of); V8 writes its own entries there with unique names; the folder's creation is idempotent and only another version's folder unused for 14 days is removed (a session that still used it would only lose cached code)"
export const WRITE_SITES: Record<string, string> = {
  'src/cli/commands/exec.ts:writeLastMessage:openSync': EXEC_OUTPUT_FILE,
  'src/cli/commands/exec.ts:writeLastMessage:renameSync': EXEC_OUTPUT_FILE,
  'src/cli/commands/exec.ts:writeLastMessage:rmSync': EXEC_OUTPUT_FILE,
  'src/cli/commands/exec.ts:writeLastMessage:writeSync': EXEC_OUTPUT_FILE,
  'src/cli/commands/kit.ts:<module>:link#ref': 'single owner',
  'src/cli/commands/kit.ts:<module>:rename#ref': 'single owner',
  'src/cli/commands/kit.ts:<module>:unlink#ref': 'single owner',
  'src/cli/commands/kit.ts:<module>:writeFile#ref': 'single owner',
  'src/cli/commands/kit.ts:exportCmd:writeAtomically': 'single owner',
  'src/cli/commands/kit.ts:writeAtomically:kitFs.link': 'single owner',
  'src/cli/commands/kit.ts:writeAtomically:kitFs.rename': 'single owner',
  'src/cli/commands/kit.ts:writeAtomically:kitFs.unlink': 'single owner',
  'src/cli/commands/kit.ts:writeAtomically:kitFs.writeFile': 'single owner',
  'src/cli/commands/teamRoleEdit.ts:editTextIn:mkdtempSync': 'single owner',
  'src/cli/commands/teamRoleEdit.ts:editTextIn:rmSync': 'single owner',
  'src/cli/commands/teamRoleEdit.ts:editTextIn:writeFileSync': 'single owner',
  'src/cli/commands/usage.ts:runCsv:fs.writeFileSync': 'single owner',
  'src/cli/compileCache.ts:enableCliCompileCache:mkdirSync': COMPILE_CACHE,
  'src/cli/compileCache.ts:enableCliCompileCache:rmSync': COMPILE_CACHE,
  'src/cli/inprocHost.ts:inprocHardLimitExit:writeSync': 'single owner',
  'src/cli/manage.ts:ttyAsk:fs.openSync': 'single owner',
  'src/cli/tui/configApi.ts:hintStore:mkdirSync': 'single owner',
  'src/cli/tui/configApi.ts:hintStore:renameSync': 'single owner',
  'src/cli/tui/configApi.ts:hintStore:writeFileSync': 'single owner',
  'src/cli/tui/externalEditor.ts:editInExternalEditor:mkdtempSync': 'single owner',
  'src/cli/tui/externalEditor.ts:editInExternalEditor:rmSync': 'single owner',
  'src/cli/tui/externalEditor.ts:editInExternalEditor:writeFileSync': 'single owner',
  'src/cli/tui/terminal.ts:onCrash:writeSync': 'single owner',
  'src/cli/tui/terminal.ts:writeNow:writeSync': 'single owner',
  'src/main/appIdentity.ts:copy:copyFileSync': DESKTOP_ICON_COPY,
  'src/main/appIdentity.ts:mkdir:mkdirSync': DESKTOP_ICON_COPY,
  'src/main/appIdentity.ts:stableIconPath:fs.mkdir': DESKTOP_ICON_COPY,
  'src/main/capabilities/mockHome.ts:seedMockHome:mkdirSync': 'single owner',
  'src/main/capabilities/mockHome.ts:seedMockHome:writeFileSync': 'single owner',
  'src/main/capabilities/reviewStore.ts:removeReview:rmSync': PROJECT_LOCKED,
  'src/main/capabilities/reviewStore.ts:writeReview:mkdirSync': PROJECT_LOCKED,
  'src/main/capabilities/reviewStore.ts:writeReview:renameSync': PROJECT_LOCKED,
  'src/main/capabilities/reviewStore.ts:writeReview:rmSync': PROJECT_LOCKED,
  'src/main/capabilities/reviewStore.ts:writeReview:writeFileSync': PROJECT_LOCKED,
  'src/main/connections/anthropicAuth.ts:privateAuthCwd:mkdirSync': 'single owner',
  'src/main/connections/anthropicAuth.ts:privateAuthCwd:mkdtempSync': 'single owner',
  'src/main/connections/anthropicAuth.ts:privateAuthCwd:rmSync': 'single owner',
  'src/main/connections/anthropicAuth.ts:removeWithoutFollowing:rmdirSync': 'single owner',
  'src/main/connections/anthropicAuth.ts:removeWithoutFollowing:rmSync': 'single owner',
  'src/main/connections/anthropicAuth.ts:removeWithoutFollowing:unlinkSync': 'single owner',
  'src/main/connections/communityPrices.ts:CommunityPrices.save:mkdirSync': WRITE_LOCK_CACHE,
  'src/main/connections/communityPrices.ts:CommunityPrices.save:renameSync': WRITE_LOCK_CACHE,
  'src/main/connections/communityPrices.ts:CommunityPrices.save:rmSync': WRITE_LOCK_CACHE,
  'src/main/connections/communityPrices.ts:CommunityPrices.save:writeFileSync': WRITE_LOCK_CACHE,
  'src/main/connections/service.ts:ConnectionService.createCodex:mkdirSync': 'single owner',
  'src/main/connections/service.ts:ConnectionService.persistModels:mkdirSync': WRITE_LOCK,
  'src/main/connections/service.ts:ConnectionService.persistModels:renameSync': WRITE_LOCK,
  'src/main/connections/service.ts:ConnectionService.persistModels:writeFileSync': WRITE_LOCK,
  'src/main/evolve/ratchet.ts:readLedger:renameSync': EVOLVE_LOCKED,
  'src/main/evolve/ratchet.ts:writeLedger:writeFileDurable': EVOLVE_LOCKED,
  'src/main/host/fsRetry.ts:renameSyncRetry:fsRenameSync#ref': 'single owner',
  'src/main/host/ownership.ts:acquire:mkdirSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:acquire:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:acquire:writeAtomic': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:adopt:writeAtomic': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:bindListener:mkdirSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:bindListener:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:bindListener:writeAtomic': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:reclaimStartupDir:renameSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:reclaimStartupDir:renameSyncRetry': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:reclaimStartupDir:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:releaseNow:mkdirSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:releaseNow:renameSyncRetry': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:releaseNow:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:releaseNow:unlinkSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:releaseNow:writeAtomic': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:releaseNow:writeFileSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:removeEndpointFiles:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:removeSecretIfOurs:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:simulateCrash:renameSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:sweepLeftovers:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:takeStartupMutex:mkdirSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:takeStartupMutex:renameSyncRetry': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:takeStartupMutex:writeFileSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:tryUnderStartupMutex:mkdirSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:tryUnderStartupMutex:renameSyncRetry': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:tryUnderStartupMutex:rmSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:tryUnderStartupMutex:writeFileSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:unlinkStaleEndpoint:unlinkSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:write:writeAtomic': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:writeAtomic:renameSyncRetry': OWNERSHIP_PRIMITIVE,
  'src/main/host/ownership.ts:writeAtomic:writeFileSync': OWNERSHIP_PRIMITIVE,
  'src/main/host/sessions.ts:registerSession:mkdirSync': SESSION_MKDIR,
  'src/main/host/sessions.ts:release:unlinkSync': SESSION_RELEASE,
  'src/main/host/sessions.ts:remove:unlinkSync': SESSION_SWEEP,
  'src/main/host/sessions.ts:writeRecord:renameSyncRetry': SESSION_OWN,
  'src/main/host/sessions.ts:writeRecord:writeFileSync': SESSION_OWN,
  'src/main/host/shimInstaller.ts:remove:fs.unlinkSync': 'single owner',
  'src/main/host/shimInstaller.ts:unlinkSync:nodeFs.unlinkSync': 'single owner',
  'src/main/index.ts:<module>:mkdirSync': 'single owner',
  'src/main/index.ts:<module>:mkdtempSync': 'single owner',
  'src/main/index.ts:<module>:rmSync': 'single owner',
  'src/main/index.ts:canonicalUserData:mkdirSync': 'single owner',
  'src/main/kit/service.ts:KitService.export:writeAtomic': 'single owner',
  'src/main/kit/service.ts:writeAtomic:renameSync': 'single owner',
  'src/main/kit/service.ts:writeAtomic:rmSync': 'single owner',
  'src/main/kit/service.ts:writeAtomic:writeFileSync': 'single owner',
  'src/main/log.ts:canWriteDir:mkdirSync': 'single owner',
  'src/main/log.ts:installLogging:mkdirSync': 'single owner',
  'src/main/log.ts:logPath:mkdirSync': 'single owner',
  'src/main/log.ts:rotate:renameSync': 'single owner',
  'src/main/log.ts:rotate:rmSync': 'single owner',
  'src/main/log.ts:write:appendFileSync': 'single owner',
  'src/main/maintenance.ts:MaintenanceService.uninstallRepo:unlinkSync': 'single owner',
  'src/main/maintenance.ts:MaintenanceService.uninstallRepo:writeFileSync': 'single owner',
  'src/main/mcp/assist.ts:harnessProject:mkdirSync': 'single owner',
  'src/main/mcp/builds.ts:discard:rmSync': 'single owner',
  'src/main/mcp/builds.ts:finish:rmSync': 'single owner',
  'src/main/mcp/builds.ts:install:renameSync': 'single owner',
  'src/main/mcp/builds.ts:removeBuildDir:rmSync': 'single owner',
  'src/main/mcp/builds.ts:rollback:renameSync': 'single owner',
  'src/main/mcp/builds.ts:rollback:rmSync': 'single owner',
  'src/main/mcp/builds.ts:stageBuild:copyFileSync': 'single owner',
  'src/main/mcp/builds.ts:stageBuild:mkdirSync': 'single owner',
  'src/main/mcp/builds.ts:stageBuild:rmSync': 'single owner',
  'src/main/mcp/presets.ts:ConnectorPresetStore.persist:mkdirSync': WRITE_LOCK,
  'src/main/mcp/presets.ts:ConnectorPresetStore.persist:renameSync': WRITE_LOCK,
  'src/main/mcp/presets.ts:ConnectorPresetStore.persist:writeFileSync': WRITE_LOCK,
  'src/main/outputs/notes.ts:writeNotes:atomicWrite': PROJECT_LOCKED,
  'src/main/outputs/notes.ts:writeRevisions:atomicWrite': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:ensureLinkFreeDir:mkdirSync': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:readRegularCapped:openSync': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:writeFileAtomic:renameSync': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:writeFileAtomic:rmSync': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:writeFileAtomic:writeFileSync': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:writeProduced:openSync': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:writeProduced:writeFileAtomic': PROJECT_LOCKED,
  'src/main/outputs/paths.ts:writeProduced:writeFileSync': PROJECT_LOCKED,
  'src/main/outputs/service.ts:remove:unlinkSync': PROJECT_LOCKED,
  'src/main/outputs/service.ts:restore:writeFileAtomic': PROJECT_LOCKED,
  'src/main/outputs/service.ts:saveEdit:writeFileAtomic': PROJECT_LOCKED,
  'src/main/outputs/store.ts:save:atomicWrite': PROJECT_LOCKED,
  'src/main/outputs/versions.ts:ensureOutputDataDir:mkdirSync': PROJECT_LOCKED,
  'src/main/outputs/versions.ts:removeOutputData:rmSync': PROJECT_LOCKED,
  'src/main/outputs/versions.ts:removeOutputData:unlinkSync': PROJECT_LOCKED,
  'src/main/outputs/versions.ts:removeSnapshot:unlinkSync': PROJECT_LOCKED,
  'src/main/outputs/versions.ts:writeSnapshot:renameSync': PROJECT_LOCKED,
  'src/main/outputs/versions.ts:writeSnapshot:rmSync': PROJECT_LOCKED,
  'src/main/outputs/versions.ts:writeSnapshot:writeFileSync': PROJECT_LOCKED,
  'src/main/outputsIpc.ts:registerOutputsIpc:copyFile': 'single owner',
  'src/main/outputsIpc.ts:registerOutputsIpc:rename': 'single owner',
  'src/main/outputsIpc.ts:registerOutputsIpc:rm': 'single owner',
  'src/main/outputsIpc.ts:registerOutputsIpc:writeFile': 'single owner',
  'src/main/quick/scratch.ts:createScratchDir:mkdirSync': 'single owner',
  'src/main/quick/scratch.ts:removeScratchDir:rmSync': 'single owner',
  'src/main/repoClone.ts:cleanupDestination:rmSync': 'single owner',
  'src/main/repoClone.ts:cleanupDestinationAsync:fsp.rm': 'single owner',
  'src/main/repoClone.ts:fail:rmdirSync': 'single owner',
  'src/main/repoClone.ts:prepareDestination:mkdirSync': 'single owner',
  'src/main/repoClone.ts:removeChildren:rmSync': 'single owner',
  'src/main/repoClone.ts:removeChildrenAsync:fsp.rm': 'single owner',
  'src/main/repoClone.ts:removeCreatedParents:rmdirSync': 'single owner',
  'src/main/repoClone.ts:RepoCloneService.mockAttempt:mkdirSync': 'single owner',
  'src/main/repoClone.ts:RepoCloneService.mockAttempt:writeFileSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:buildSkillPlugin:mkdirSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:buildSkillPlugin:mkdtempSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:buildSkillPlugin:writeFileSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:cleanup:rmSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:copySkill:mkdirSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:copySkill:rmSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:copySkill:writeFileSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:sweepStaleSkillDirs:rmSync': 'single owner',
  'src/main/runtime/claudeSkills.ts:sweepStaleSkillDirsAsync:rm': TEMP_AGE,
  'src/main/runtime/codexAppServer.ts:CodexAppServer.start:mkdirSync': 'single owner',
  'src/main/runtime/codexNativeCatalog.ts:mkdir:mkdirSync': 'single owner',
  'src/main/runtime/codexNativeCatalog.ts:nativeAgentsCatalogConfig:fs.mkdir': 'single owner',
  'src/main/runtime/codexNativeCatalog.ts:nativeAgentsCatalogConfig:fs.rename': 'single owner',
  'src/main/runtime/codexNativeCatalog.ts:nativeAgentsCatalogConfig:fs.write': 'single owner',
  'src/main/runtime/codexNativeCatalog.ts:remove:unlinkSync': 'single owner',
  'src/main/runtime/codexNativeCatalog.ts:rename:renameSync': 'single owner',
  'src/main/runtime/codexNativeCatalog.ts:write:writeFileSync': 'single owner',
  'src/main/runtime/contextPack.ts:openGuardedFile:openSync': 'single owner',
  'src/main/runtime/folderConfigTrust.ts:openPlain:openSync': 'single owner',
  'src/main/runtime/mock.ts:MockSession.step:mkdirSync': 'single owner',
  'src/main/runtime/mock.ts:MockSession.step:writeFileSync': 'single owner',
  'src/main/runtime/mock.ts:MockSession.toolRan:writeFileSync': 'single owner',
  'src/main/runtime/permissionRules.ts:writeLocalSettings:mkdirSync': RULES_LOCKED,
  'src/main/runtime/permissionRules.ts:writeLocalSettings:writeFileSync': RULES_LOCKED,
  'src/main/runtime/repoLock.ts:acquireDirLock:mkdirSync': REPO_LOCK_PRIMITIVE,
  'src/main/runtime/repoLock.ts:acquireDirLock:renameSync': REPO_LOCK_PRIMITIVE,
  'src/main/runtime/repoLock.ts:acquireDirLock:renameSyncRetry': REPO_LOCK_PRIMITIVE,
  'src/main/runtime/repoLock.ts:acquireDirLock:rmSync': REPO_LOCK_PRIMITIVE,
  'src/main/runtime/repoLock.ts:acquireDirLock:writeFileSync': REPO_LOCK_PRIMITIVE,
  'src/main/runtime/repoLock.ts:release:renameSyncRetry': REPO_LOCK_PRIMITIVE,
  'src/main/runtime/repoLock.ts:release:rmSync': REPO_LOCK_PRIMITIVE,
  'src/main/runtime/runManager.ts:RunManager.start:mkdirSync': 'single owner',
  'src/main/runtime/worktrees.ts:evacuateNested:mkdirSync': 'single owner',
  'src/main/runtime/worktrees.ts:removeMergeScratch:rmSync': SCRATCH_TEMP,
  'src/main/runtime/worktrees.ts:newMergeScratchPath:mkdirSync': SCRATCH_TEMP,
  'src/main/runtime/worktrees.ts:newMergeScratchPath:mkdtempSync': SCRATCH_TEMP,
  'src/main/runtime/worktrees.ts:sweepMergeScratch:rmSync': SCRATCH_TEMP,
  'src/main/runtime/worktrees.ts:sweepMergeScratch:unlinkSync': SCRATCH_TEMP,
  'src/main/runtime/worktrees.ts:prepareRepoUnlocked:appendFileSync': REPO_LOCK,
  'src/main/runtime/worktrees.ts:prepareRepoUnlocked:mkdirSync': REPO_LOCK,
  'src/main/runtime/worktrees.ts:removeExcludeLine:writeFileSync': 'single owner',
  'src/main/setup/import/export.ts:writeOrgExport:mkdirSync': 'single owner',
  'src/main/setup/import/export.ts:writeOrgExport:renameSync': 'single owner',
  'src/main/setup/import/export.ts:writeOrgExport:rmSync': 'single owner',
  'src/main/setup/import/export.ts:writeOrgExport:writeFileSync': 'single owner',
  'src/main/setup/service.ts:writeArchitecture:mkdirSync': PROJECT_LOCKED,
  'src/main/setup/service.ts:writeArchitecture:writeFileSync': PROJECT_LOCKED,
  'src/main/setup/templates.ts:atomicWrite:renameSync': WRITE_LOCK,
  'src/main/setup/templates.ts:atomicWrite:rmSync': WRITE_LOCK,
  'src/main/setup/templates.ts:atomicWrite:writeFileSync': WRITE_LOCK,
  'src/main/setup/templates.ts:ensurePlainDir:mkdirSync': WRITE_LOCK,
  'src/main/setup/templates.ts:TemplateService.removeNow:rmSync': WRITE_LOCK,
  'src/main/setup/templates.ts:TemplateService.saveFromKitNow:atomicWrite': WRITE_LOCK,
  'src/main/setup/templates.ts:TemplateService.saveFromKitNow:rmSync': WRITE_LOCK,
  'src/main/setup/templates.ts:TemplateService.saveFromProjectNow:atomicWrite': WRITE_LOCK,
  'src/main/setup/templates.ts:TemplateService.saveFromProjectNow:rmSync': WRITE_LOCK,
  'src/main/setup/templates.ts:TemplateService.writeIndex:atomicWrite': WRITE_LOCK,
  'src/main/skills/assist.ts:skillsProject:mkdirSync': PROJECT_LOCKED,
  'src/main/skills/evaluation.ts:SkillEvaluationService.write:mkdirSync': PROJECT_LOCKED,
  'src/main/skills/evaluation.ts:SkillEvaluationService.write:renameSync': PROJECT_LOCKED,
  'src/main/skills/evaluation.ts:SkillEvaluationService.write:rmSync': PROJECT_LOCKED,
  'src/main/skills/evaluation.ts:SkillEvaluationService.write:writeFileSync': PROJECT_LOCKED,
  'src/main/skills/files.ts:removeFolder:rmSync': PROJECT_LOCKED,
  'src/main/skills/files.ts:writeFolder:mkdirSync': PROJECT_LOCKED,
  'src/main/skills/files.ts:writeFolder:renameSync': PROJECT_LOCKED,
  'src/main/skills/files.ts:writeFolder:rmSync': PROJECT_LOCKED,
  'src/main/schedules/store.ts:ScheduleStore.persist:this.fs.mkdirSync': DATA_FOLDER_OWNER,
  'src/main/schedules/store.ts:ScheduleStore.persist:writeFileDurable': DATA_FOLDER_OWNER,
  'src/main/todos/store.ts:TodoStore.persist:this.fs.mkdirSync': DATA_FOLDER_OWNER,
  'src/main/todos/store.ts:TodoStore.persist:writeFileDurable': DATA_FOLDER_OWNER,
  'src/main/schedules/testkit.ts:cleanup:rmSync': TEST_TEMP,
  'src/main/schedules/testkit.ts:fakeEnv:mkdtempSync': TEST_TEMP,
  'src/main/skills/files.ts:writeFolder:writeFileSync': PROJECT_LOCKED,
  // UI overhaul: the per-project allow counter (<data>/projects/<id>/allow-counts.json: bumped from the desktop decide path
  // only, read by every host; bumpAllowCount and the version 1 migration in readAllowCounts run under the write lock) and
  // skill export (a new folder under a destination the user just picked; never overwrites).
  'src/main/runtime/allowCounter.ts:writeCounts:atomicWrite': PROJECT_LOCKED,
  'src/main/skills/service.ts:SkillService.exportTo:mkdirSync': EXPORT_NEW_FOLDER,
  'src/main/skills/service.ts:SkillService.exportTo:rmSync': EXPORT_NEW_FOLDER,
  'src/main/skills/service.ts:SkillService.exportTo:writeFileSync': EXPORT_NEW_FOLDER,
  'src/main/skills/service.ts:copy:cpSync': PROJECT_LOCKED,
  'src/main/skills/service.ts:discard:rmSync': PROJECT_LOCKED,
  'src/main/skills/service.ts:restore:cpSync': PROJECT_LOCKED,
  'src/main/skills/service.ts:restore:rmSync': PROJECT_LOCKED,
  'src/main/skills/service.ts:SkillService.snapshotForProposal:mkdtempSync': PROJECT_LOCKED,
  'src/main/store/custodians/keyFile.ts:createKeyFilePosix:openSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:createKeyFilePosix:unlinkSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:createKeyFilePosix:writeSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:createKeyFileWindows:openSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:createKeyFileWindows:unlinkSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:createKeyFileWindows:writeSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:KeyFileCustodian.removeItem:unlinkSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:winDacl:mkdtempSync': 'single owner',
  'src/main/store/custodians/keyFile.ts:winDacl:rmSync': 'single owner',
  'src/main/store/durableFs.ts:mkdirSync:fs.mkdirSync': 'single owner',
  'src/main/store/durableFs.ts:openSync:fs.openSync': 'single owner',
  'src/main/store/durableFs.ts:renameSync:fs.renameSync': 'single owner',
  'src/main/store/durableFs.ts:unlinkSync:fs.unlinkSync': 'single owner',
  'src/main/store/durableFs.ts:writeSync:fs.writeSync': 'single owner',
  'src/main/store/knowledge.ts:clearKnowledgeUnlocked:rmSync': PROJECT_LOCKED,
  'src/main/store/knowledge.ts:writeGraph:atomicWrite': PROJECT_LOCKED,
  'src/main/store/mcpLibrary.ts:McpLibraryStore.persist:mkdirSync': WRITE_LOCK,
  'src/main/store/mcpLibrary.ts:McpLibraryStore.persist:renameSync': WRITE_LOCK,
  'src/main/store/mcpLibrary.ts:McpLibraryStore.persist:writeFileSync': WRITE_LOCK,
  'src/main/store/productMarker.ts:writeProductMarker:linkSync': 'single owner',
  'src/main/store/productMarker.ts:writeProductMarker:mkdirSync': 'single owner',
  'src/main/store/productMarker.ts:writeProductMarker:rmSync': 'single owner',
  'src/main/store/productMarker.ts:writeProductMarker:writeFileSync': 'single owner',
  'src/main/store/projectData.ts:atomicWrite:renameSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:atomicWrite:rmSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:atomicWrite:writeFileSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:commitDocument:atomicWrite': PROJECT_LOCKED,
  'src/main/store/projectData.ts:ensurePlainDir:mkdirSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:removeFileIfExists:rmSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:removeNoteUnlocked:rmSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:removeProjectData:rmSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:retainRunProject:atomicWrite': WRITE_LOCK,
  'src/main/store/projectData.ts:retainRunProject:mkdirSync': WRITE_LOCK,
  'src/main/store/projectData.ts:saveNoteUnlocked:atomicWrite': PROJECT_LOCKED,
  'src/main/store/projectData.ts:saveNoteUnlocked:rmSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:writeEngagementDocumentUnlocked:rmSync': PROJECT_LOCKED,
  'src/main/store/projectData.ts:writeIndex:atomicWrite': PROJECT_LOCKED,
  'src/main/store/projects.ts:ProjectStore.persist:mkdirSync': WRITE_LOCK,
  'src/main/store/projects.ts:ProjectStore.persist:renameSync': WRITE_LOCK,
  'src/main/store/projects.ts:ProjectStore.persist:writeFileSync': WRITE_LOCK,
  'src/main/store/runs.ts:RunStore.persist:mkdirSync': WRITE_LOCK,
  'src/main/store/runs.ts:RunStore.persist:renameSyncRetry': WRITE_LOCK,
  'src/main/store/runs.ts:RunStore.persist:writeFileSync': WRITE_LOCK,
  'src/main/store/runs.ts:RunStore.removeRecord:rmSync': RUN_REMOVAL,
  'src/main/store/runs.ts:RunStore.removeRecord:unlinkSync': RUN_REMOVAL,
  'src/main/store/runs.ts:RunStore.saveRecord:mkdirSync': RUN_HOST,
  'src/main/store/runs.ts:RunStore.saveRecord:renameSyncRetry': RUN_HOST,
  'src/main/store/runs.ts:RunStore.saveRecord:writeFileSync': RUN_HOST,
  'src/main/store/runs.ts:RunStore.storeImage:mkdirSync': RUN_HOST,
  'src/main/store/runs.ts:RunStore.storeImage:renameSyncRetry': RUN_HOST,
  'src/main/store/runs.ts:RunStore.storeImage:writeFileSync': RUN_HOST,
  'src/main/store/runs.ts:RunStore.sweepOrphans:rmSync': RUN_REMOVAL,
  'src/main/store/runs.ts:RunStore.sweepOrphans:unlinkSync': RUN_REMOVAL,
  'src/main/store/runs.ts:RunStore.writeDigestBody:mkdirSync': RUN_DIGEST_CACHE,
  'src/main/store/runs.ts:RunStore.writeDigestBody:renameSyncRetry': RUN_DIGEST_CACHE,
  'src/main/store/runs.ts:RunStore.writeDigestBody:rmSync': RUN_DIGEST_CACHE,
  'src/main/store/runs.ts:RunStore.writeDigestBody:rmdirSync': RUN_DIGEST_CACHE,
  'src/main/store/runs.ts:RunStore.writeDigestBody:writeFileSync': RUN_DIGEST_CACHE,
  'src/main/store/secrets.ts:SecretStore.moveAside:renameDurable': VAULT_ALONE,
  'src/main/store/secrets.ts:SecretStore.writeStep:unlinkDurable': VAULT_LOCKED,
  'src/main/store/secrets.ts:SecretStore.writeStep:writeFileDurable': VAULT_LOCKED,
  'src/main/store/settings.ts:SettingsStore.constructor:mkdirSync': DATA_MKDIR,
  'src/main/store/settings.ts:SettingsStore.persist:mkdirSync': WRITE_LOCK,
  'src/main/store/settings.ts:SettingsStore.persist:renameSync': WRITE_LOCK,
  'src/main/store/settings.ts:SettingsStore.persist:writeFileSync': WRITE_LOCK,
  'src/main/store/shared/namedLock.ts:withNamedLock:mkdirSync': SESSION_MKDIR,
  'src/main/store/shared/osLock.ts:ensureLockFile:openSync': 'osLock: lock file create (0-byte, O_EXCL)',
  'src/main/store/shared/storeSync.ts:createSharedStoreSync:mkdirSync': SESSION_MKDIR,
  'src/main/store/skillLibrary.ts:SkillLibraryStore.persist:mkdirSync': WRITE_LOCK,
  'src/main/store/skillLibrary.ts:SkillLibraryStore.persist:renameSync': WRITE_LOCK,
  'src/main/store/skillLibrary.ts:SkillLibraryStore.persist:writeFileSync': WRITE_LOCK,
  'src/main/store/staffingProfile.ts:writeStaffingProfile:writeFileDurable': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:ensureParents:mkdirSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:removeOrgaiIfEmpty:rmdirSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:removeOrgaiIfEmpty:rmSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:removeTeamFolderFiles:rmSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:writeAtomic:renameSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:writeAtomic:rmSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:writeAtomic:writeFileSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:writeTeamFiles:rmSync': PROJECT_LOCKED,
  'src/main/teamFiles/disk.ts:writeTeamFiles:writeAtomic': PROJECT_LOCKED,
  'src/main/teamFiles/store.ts:TeamFilesStore.clear:rmSync': PROJECT_LOCKED,
  'src/main/teamFiles/store.ts:TeamFilesStore.write:atomicWrite': PROJECT_LOCKED,
  'src/main/teamFiles/store.ts:TeamFilesStore.writeUndo:rmSync': PROJECT_LOCKED,
  'src/main/testSupport/privateTempDir.ts:privateTempDir:mkdtempSync': 'single owner'
}
