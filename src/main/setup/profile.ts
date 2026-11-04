import { execFile } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { PROFILE_DOCUMENTS_MAX, type ProjectKind, type ProjectProfile } from '@shared/types'
import { promptDatum } from '../mcp/assist'
import { agentDefinitionLocations } from './import/scan'

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

/** Document types an engagement profile lists. */
const DOCUMENT_EXTS = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.txt', '.csv'])
/** Engagement notes worth reading in full: .md / .txt files with these words in the name. */
const NOTE_NAME = /(readme|brief|notes?|scope|overview|summary|charter|agenda|minutes|requirements?)/i
const MAX_TOP_FOLDERS = 50

/**
 * Build a token-free profile of a working directory. Never throws; a missing directory yields an empty profile.
 * `kind` 'engagement' profiles a client-work folder: file types, top folders, documents and .md / .txt notes, with no
 * git log and no manifests.
 */
export async function profileRepo(root: string, kind: ProjectKind = 'code'): Promise<ProjectProfile> {
  const scannedAt = new Date().toISOString()
  const engagement = kind === 'engagement'
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { scannedAt, exists: false, isEmpty: true, hasGit: false, fileCount: 0, tree: '', languages: [], keyFiles: [], gitLog: [], ...(engagement ? { kind } : {}) }
  }

  const treeLines: string[] = []
  const langs = new Map<string, number>()
  const keyFiles: { path: string; content: string }[] = []
  const documents: string[] = []
  const topFolders: string[] = []
  let documentsTruncated = false
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
        // lstat: a symlink or junction (to an outside folder or file) is never followed or listed.
        const st = lstatSync(full)
        if (st.isSymbolicLink()) continue
        isDir = st.isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.github')) continue
        if (depth === 0 && topFolders.length < MAX_TOP_FOLDERS) topFolders.push(promptDatum(name, 200))
        if (treeLines.length < MAX_TREE_ENTRIES) treeLines.push(`${'  '.repeat(depth)}${promptDatum(name, 200)}/`)
        else truncated = true
        if (depth < MAX_DEPTH) walk(full, depth + 1)
        continue
      }
      fileCount++
      const ext = extname(name).toLowerCase()
      if (ext) langs.set(ext, (langs.get(ext) ?? 0) + 1)
      if (treeLines.length < MAX_TREE_ENTRIES) treeLines.push(`${'  '.repeat(depth)}${promptDatum(name, 200)}`)
      else truncated = true
      if (engagement && DOCUMENT_EXTS.has(ext)) {
        if (documents.length < PROFILE_DOCUMENTS_MAX) documents.push(promptDatum(rel, 300))
        else documentsTruncated = true
      }
      const isKey = engagement
        ? (ext === '.md' || ext === '.txt') && NOTE_NAME.test(name)
        : KEY_FILES.has(rel.toLowerCase()) || KEY_FILES.has(name.toLowerCase())
      if (isKey && keyFiles.length < MAX_KEY_FILES) {
        try {
          const { text, more } = readBounded(full)
          const content = text.length > MAX_KEY_FILE_BYTES ? `${text.slice(0, MAX_KEY_FILE_BYTES)}\n… (truncated)` : more ? `${text}\n… (truncated)` : text
          keyFiles.push({ path: promptDatum(rel, 300), content })
        } catch {
          /* unreadable, skip */
        }
      }
    }
  }
  walk(root, 0)
  if (truncated) treeLines.push(`… (${fileCount} files total, listing truncated)`)

  const hasGit = existsSync(join(root, '.git'))
  const gitLog = hasGit && !engagement ? await gitLogLines(root) : []

  const languages = [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([ext, files]) => ({ ext, files }))

  // Dot folders are left out of the tree; agent definitions in them are listed here instead (src/main/setup/import).
  const agentDefinitions = agentDefinitionLocations(root)
  return {
    scannedAt,
    exists: true,
    isEmpty: fileCount === 0,
    hasGit,
    fileCount,
    tree: treeLines.join('\n'),
    languages,
    keyFiles,
    gitLog,
    ...(agentDefinitions.length ? { agentDefinitions } : {}),
    ...(engagement ? { kind, topFolders, documents, ...(documentsTruncated ? { documentsTruncated } : {}) } : {})
  }
}

/** Read at most MAX_KEY_FILE_BYTES + 64 bytes of a file through an fd; `more` when the file has more. */
function readBounded(file: string): { text: string; more: boolean } {
  const limit = MAX_KEY_FILE_BYTES + 64
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(limit)
    const n = readSync(fd, buf, 0, limit, 0)
    return { text: buf.subarray(0, n).toString('utf8'), more: n >= limit }
  } finally {
    closeSync(fd)
  }
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
  if (p.kind === 'engagement') {
    if (!p.exists) return 'The working folder does not exist yet. It will be created when work starts.'
    if (p.isEmpty) return 'The working folder exists and is empty.'
    const out: string[] = [
      `Working folder: ${p.fileCount} files. Git repository: ${p.hasGit ? 'yes' : 'no'}.`,
      `File types by count: ${p.languages.map((l) => `${l.ext} (${l.files})`).join(', ') || 'none detected'}.`
    ]
    if (p.topFolders?.length) out.push(`Top-level folders: ${p.topFolders.join(', ')}.`)
    out.push(`Folder tree:\n${p.tree}`)
    if (p.documents?.length) out.push(`Documents${p.documentsTruncated ? ` (first ${p.documents.length}, more not listed)` : ''}:\n${p.documents.join('\n')}`)
    if (p.agentDefinitions?.length) out.push(`Agent definitions present: ${p.agentDefinitions.join(', ')}.`)
    for (const f of p.keyFiles) out.push(`--- ${f.path} ---\n${f.content}`)
    return out.join('\n\n')
  }
  if (!p.exists) return 'The working directory does not exist yet. It will be created when work starts.'
  if (p.isEmpty) return 'The working directory exists and is empty.'
  const parts: string[] = [
    `Files: ${p.fileCount}. Git: ${p.hasGit ? 'yes' : 'no'}.`,
    `Languages by file count: ${p.languages.map((l) => `${l.ext} (${l.files})`).join(', ') || 'none detected'}.`,
    `Directory tree:\n${p.tree}`
  ]
  if (p.agentDefinitions?.length) parts.push(`Agent definitions present: ${p.agentDefinitions.join(', ')}.`)
  if (p.gitLog.length) parts.push(`Recent commits:\n${p.gitLog.join('\n')}`)
  for (const f of p.keyFiles) parts.push(`--- ${f.path} ---\n${f.content}`)
  return parts.join('\n\n')
}
