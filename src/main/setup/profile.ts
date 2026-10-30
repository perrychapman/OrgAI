import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { ProjectProfile } from '@shared/types'

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.next', '.nuxt', '.turbo',
  '.cache', '.parcel-cache', 'coverage', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.idea',
  '.vscode', '.gradle', 'Pods', 'DerivedData', 'vendor', '.terraform', '.orgai'
])

/** Files whose contents tell the Architect what the project is. Matched by relative path or basename, case-insensitive. */
const KEY_FILES = new Set([
  'readme.md', 'readme', 'readme.txt', 'claude.md', 'agents.md', 'contributing.md', 'architecture.md',
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json', 'mix.exs', 'pubspec.yaml', 'deno.json',
  'tsconfig.json', 'docker-compose.yml', 'docker-compose.yaml', 'dockerfile', 'makefile', 'justfile',
  '.github/workflows/ci.yml', '.github/workflows/ci.yaml', '.gitlab-ci.yml', 'vite.config.ts', 'next.config.js',
  'next.config.ts', 'electron.vite.config.ts', 'angular.json', 'nx.json', 'turbo.json', 'pnpm-workspace.yaml'
])

/** Files the OS creates in any folder Finder or Explorer has opened; they must not make an empty folder look populated. */
const OS_JUNK_FILES = new Set(['.DS_Store', '.localized', '.AppleDouble', 'Icon\r', 'Thumbs.db', 'desktop.ini'])

const MAX_TREE_ENTRIES = 400
const MAX_DEPTH = 4
const MAX_KEY_FILE_BYTES = 6000
const MAX_KEY_FILES = 14

/** Build a token-free profile of a working directory. Never throws; a missing directory yields an empty profile. */
export async function profileRepo(root: string): Promise<ProjectProfile> {
  const scannedAt = new Date().toISOString()
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { scannedAt, exists: false, isEmpty: true, hasGit: false, fileCount: 0, tree: '', languages: [], keyFiles: [], gitLog: [] }
  }

  const treeLines: string[] = []
  const langs = new Map<string, number>()
  const keyFiles: { path: string; content: string }[] = []
  let fileCount = 0
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir).sort((a, b) => a.localeCompare(b))
    } catch {
      return
    }
    for (const name of entries) {
      if (OS_JUNK_FILES.has(name)) continue
      const full = join(dir, name)
      const rel = relative(root, full).replace(/\\/g, '/')
      let isDir = false
      try {
        const entry = lstatSync(full)
        if (entry.isSymbolicLink()) continue
        isDir = entry.isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.github')) continue
        if (treeLines.length < MAX_TREE_ENTRIES) treeLines.push(`${'  '.repeat(depth)}${name}/`)
        else truncated = true
        if (depth < MAX_DEPTH) walk(full, depth + 1)
        continue
      }
      fileCount++
      const ext = extname(name).toLowerCase()
      if (ext) langs.set(ext, (langs.get(ext) ?? 0) + 1)
      if (treeLines.length < MAX_TREE_ENTRIES) treeLines.push(`${'  '.repeat(depth)}${name}`)
      else truncated = true
      if ((KEY_FILES.has(rel.toLowerCase()) || KEY_FILES.has(name.toLowerCase())) && keyFiles.length < MAX_KEY_FILES) {
        try {
          const raw = readFileSync(full, 'utf8')
          const content = raw.length > MAX_KEY_FILE_BYTES ? `${raw.slice(0, MAX_KEY_FILE_BYTES)}\n… (truncated)` : raw
          keyFiles.push({ path: rel, content })
        } catch {
          /* unreadable, skip */
        }
      }
    }
  }
  walk(root, 0)
  if (truncated) treeLines.push(`… (${fileCount} files total, listing truncated)`)

  const hasGit = existsSync(join(root, '.git'))
  const gitLog = hasGit ? await gitLogLines(root) : []

  const languages = [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([ext, files]) => ({ ext, files }))

  return { scannedAt, exists: true, isEmpty: fileCount === 0, hasGit, fileCount, tree: treeLines.join('\n'), languages, keyFiles, gitLog }
}

function gitLogLines(root: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['log', '--oneline', '-n', '30', '--no-decorate'], { cwd: root, timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) resolve([])
      else resolve(stdout.split('\n').map((l) => l.trim()).filter(Boolean))
    })
  })
}

/** Render a profile as plain text for a model prompt. */
export function renderProfile(p: ProjectProfile): string {
  if (!p.exists) return 'The working directory does not exist yet. It will be created when work starts.'
  if (p.isEmpty) return 'The working directory exists and is empty.'
  const parts: string[] = [
    `Files: ${p.fileCount}. Git: ${p.hasGit ? 'yes' : 'no'}.`,
    `Languages by file count: ${p.languages.map((l) => `${l.ext} (${l.files})`).join(', ') || 'none detected'}.`,
    `Directory tree:\n${p.tree}`
  ]
  if (p.gitLog.length) parts.push(`Recent commits:\n${p.gitLog.join('\n')}`)
  for (const f of p.keyFiles) parts.push(`--- ${f.path} ---\n${f.content}`)
  return parts.join('\n\n')
}
