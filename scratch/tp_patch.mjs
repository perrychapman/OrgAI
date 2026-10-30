import fs from 'node:fs'
const p = 'src/renderer/src/components/TranscriptPanel.tsx'
let s = fs.readFileSync(p, 'utf8').split(String.fromCharCode(13, 10)).join('\n')
function rep(a, b) {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70))
  s = s.replace(a, () => b)
}
rep(
  "import { activeRun, isRunLive, selectedProject, useAppStore, type LogLine } from '../store/useAppStore'",
  "import { selectedProject, useAppStore, useRunIndexes, type LogLine } from '../store/useAppStore'\nimport { runTag } from '../lib/runLabels'"
)
rep("import RunHistory from './RunHistory'\n", '')
rep('interface Props {\n  agent:', 'interface Props {\n  /** The run this panel shows. */\n  runId: string\n  agent:')
rep(
  "export default function TranscriptPanel({ agent, entries, logs, finished }: Props): ReactElement {\n  const selectedTab = useAppStore((s) => s.sideTab)",
  "export default function TranscriptPanel({ runId, agent, entries, logs, finished }: Props): ReactElement {\n  const selectedTab = useAppStore((s) => s.sideTabByRun[runId] ?? 'transcript')"
)
rep('(agent ? activeRun(s)?.partial[agent.id] : undefined)', '(agent ? s.runs[runId]?.partial[agent.id] : undefined)')
rep('const plan = useAppStore((s) => activeRun(s)?.plan)', 'const plan = useAppStore((s) => s.runs[runId]?.plan)')
rep(
  "const isWork = useAppStore((s) => activeRun(s)?.summary.kind === 'work')\n  const openRuns = useAppStore((s) => Object.values(s.runs).filter((r) => r.summary.projectId === s.selectedProjectId && isRunLive(r)).length)\n",
  "const isWork = useAppStore((s) => s.runs[runId]?.summary.kind === 'work')\n  const index = useRunIndexes().get(runId)\n"
)
rep('        <h2 title={headerTitle}>{headerTitle}</h2>', '        <span className="run-index" title="The run this panel belongs to">\n          {runTag(index)}\n        </span>\n        <h2 title={headerTitle}>{headerTitle}</h2>')
rep(
  "          <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')} title={openRuns > 0 ? `${openRuns} open run${openRuns === 1 ? '' : 's'}` : undefined}>\n            Runs{openRuns > 0 ? ` (${openRuns})` : ''}\n          </button>\n",
  ''
)
rep("      {tab === 'runs' && <RunHistory />}\n", '')
rep("{tab === 'runs' || tab === 'plan' ||", "{tab === 'plan' ||")
fs.writeFileSync(p, s)
console.log('ok')
