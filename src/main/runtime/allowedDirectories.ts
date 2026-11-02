import { posix, win32 } from 'node:path'
import { isOfferableDirectory } from './permissionRules'
import { isFreeCdTarget } from './ruleMatch'

/** Why a folder is never an allowed directory on static grounds alone (no file-system access). */
export type AllowedDirectoryRisk = 'project' | 'unsafe'

export interface AllowedDirectoryRiskOpts {
  /** The project's folder: the folder itself and anything inside it is already free ('project'). */
  projectPath?: string
  /** The user's home folder. Empty string skips the home rules; undefined means os.homedir() (isOfferableDirectory). */
  home?: string
  /** OrgAI's data folder spellings; touching one in either direction is 'unsafe'. */
  deniedDirs?: readonly string[]
  /** Path flavour (tests); default process.platform. */
  platform?: NodeJS.Platform
}

/**
 * The static "too broad or sensitive" rules for Project.allowedDirectories, shared by ProjectStore
 * (cleanAllowedDirectories, on save and at boot) and RunManager (resolveAllowedDirectories, at run start, on the
 * canonical path). Lexical (win32 case-insensitive) and pure:
 * - 'project': the project folder or a folder inside it (already free).
 * - 'unsafe' (isOfferableDirectory, the one rule list): not absolute, a root, UNC / device, touching a denied folder,
 *   home or a folder containing it, a credential / agent config folder under home (.ssh, .aws, .gnupg, .claude,
 *   .codex, .config, .kube, .docker, .azure, .npmrc, .git-credentials, AppData/Roaming, Library/Application Support,
 *   Library/Keychains), or a folder containing the project.
 */
export function allowedDirectoryRisk(dir: string, opts: AllowedDirectoryRiskOpts = {}): AllowedDirectoryRisk | null {
  const platform = opts.platform ?? process.platform
  const p = platform === 'win32' ? win32 : posix
  const project = opts.projectPath && p.isAbsolute(opts.projectPath) ? opts.projectPath : undefined
  if (project && typeof dir === 'string' && p.isAbsolute(dir) && isFreeCdTarget(dir, { freeDirs: [project], platform })) return 'project'
  const ok = isOfferableDirectory(dir, {
    platform,
    ...(project ? { cwd: project } : {}),
    ...(opts.deniedDirs ? { deniedDirs: [...opts.deniedDirs] } : {}),
    ...(opts.home !== undefined ? { home: opts.home } : {})
  })
  return ok ? null : 'unsafe'
}
