import { Box } from 'ink'
import { CLI_VERSION } from '../version'
import { Brand, brandHeight } from './Brand'
import { useTuiEnv } from './context'
import { cutSegs, PaneLines, type PaneLine, type Seg } from './panes/lines'
import { sanitizeTty } from './sanitizeTty'

const DEFAULT_WIDTH = 80
const DEFAULT_HEIGHT = 24

function safe(text: unknown, fallback: string): string {
  const value = sanitizeTty(String(text ?? '')).replace(/\s+/g, ' ').trim()
  return value || fallback
}

function line(key: string, segs: Seg[], width: number, env: ReturnType<typeof useTuiEnv>): PaneLine {
  return { key, segs: cutSegs(segs, Math.max(0, width), env) }
}

function commandSegments(command: string, description: string): Seg[] {
  return [
    { text: command, tone: 'accent', bold: true },
    { text: `  ${description}`, dim: true }
  ]
}

function commandRows(width: number, env: ReturnType<typeof useTuiEnv>, oneRow: boolean): PaneLine[] {
  const commands: Array<[string, string]> = [
    ['/help', 'commands'],
    ['/new', 'fresh run'],
    ['/runs', 'recent runs']
  ]
  if (oneRow) {
    const segs: Seg[] = []
    commands.forEach(([command, description], i) => {
      if (i) segs.push({ text: '    ' })
      segs.push(...commandSegments(command, description))
    })
    return [line('commands', segs, width, env)]
  }
  return commands.map(([command, description], i) => line(`command-${i}`, commandSegments(command, description), width, env))
}

function welcomeLines(args: {
  width: number
  height: number
  folder: string
  project: string
  compact: boolean
  env: ReturnType<typeof useTuiEnv>
}): PaneLine[] {
  const { width, height, folder, project, compact, env } = args
  const context: PaneLine[] = [
    line('project', [{ text: project, bold: true }], width, env),
    line('folder', [{ text: folder, dim: true }], width, env)
  ]
  const compactRows = [
    line('tagline', [{ text: 'Big ideas. A team to build them.', bold: true }], width, env),
    ...context,
    ...commandRows(width, env, true)
  ]
  if (height <= 5) return [...context, ...commandRows(width, env, true)]
  if (height <= 8 || compact) return compactRows
  return [
    ...compactRows.slice(0, 3),
    line('space-before-guidance', [], width, env),
    line('guidance', [{ text: 'Describe what you want to build, fix, or explore.' }], width, env),
    line('team', [{ text: 'Follow your team here as the work unfolds.', dim: true }], width, env),
    line('space-before-commands', [], width, env),
    ...commandRows(width, env, width >= 62)
  ]
}

/** A quiet, left-flowing idle view. The composer owns interaction; this component only establishes context. */
export function Welcome(props: { width: number; height?: number; folder: string; projectName?: string; compact?: boolean; animated?: boolean }) {
  const env = useTuiEnv()
  const width = Math.max(0, Number.isFinite(props.width) ? Math.floor(props.width) : DEFAULT_WIDTH)
  const height = Math.max(0, Number.isFinite(props.height) ? Math.floor(props.height as number) : DEFAULT_HEIGHT)
  if (width === 0 || height === 0) return <Box width={width} height={height} />

  const gutter = width >= 40 ? 2 : width >= 2 ? 1 : 0
  const contentWidth = Math.max(0, width - gutter)
  const folder = safe(props.folder, 'Current folder')
  const project = safe(props.projectName, 'Your workspace')
  const headerHeight = brandHeight(contentWidth, env, !props.compact && height >= 18)
  const lines = welcomeLines({ width: contentWidth, height: Math.max(0, height - headerHeight), folder, project, compact: Boolean(props.compact), env })

  return (
    <Box width={width} height={height} paddingLeft={gutter} flexDirection="column" overflow="hidden">
      <Brand width={contentWidth} version={`v${CLI_VERSION}`} prominent={headerHeight > 1} />
      <PaneLines width={contentWidth} height={Math.max(0, height - headerHeight)} env={env} lines={lines} />
    </Box>
  )
}
