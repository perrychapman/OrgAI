// Markdown rendering for the org chart benchmark: report.md and the --compare output. Pure (strings in, strings out).
// Everything the model produced (role names, rationales) is data: it is escaped for table cells and never interpreted.

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').slice(0, 160)
const pct = (x) => (typeof x === 'number' ? String(Math.round(x * 100)) : '-')
const num = (x, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '-')
const usd = (x) => (typeof x === 'number' ? `$${x.toFixed(2)}` : '-')
const secs = (ms) => (typeof ms === 'number' ? `${Math.round(ms / 1000)}s` : '-')

/** A Markdown table; columns in `left` (default the first) are left-aligned, the rest right-aligned numbers. */
function table(head, rows, left = [0]) {
  return [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (left.includes(i) ? '---' : '---:')).join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
}

const RECOMMEND_DIMS = [['validity', 'valid'], ['structure', 'struct'], ['right-sizing', 'size'], ['coverage', 'cover'], ['least-privilege', 'priv'], ['tiering', 'tier'], ['prompt-quality', 'prompt']]
const RETRO_DIMS = [['fix', 'fix'], ['minimality', 'minimal'], ['stability', 'stable'], ['spend', 'spend'], ['validity', 'valid']]

const mixText = (m) => (m ? ['top', 'deep', 'everyday', 'fast', 'inherit', 'other'].filter((k) => m[k]).map((k) => `${k} ${m[k]}`).join(', ') || '-' : '-')

function sessionLine(s) {
  const status = s.status === 'ok' ? '' : ` [${s.status}]`
  const score = s.score ? num(s.score.total) : 'skipped'
  if (s.family === 'retro') {
    const m = s.score?.metrics
    const bits = m ? [`changed ${m.changed.join(', ') || 'none'}`, m.added.length ? `added ${m.added.join(', ')}` : '', m.removed.length ? `removed ${m.removed.join(', ')}` : '', `ending ${m.ending ?? 'none'}`].filter(Boolean) : []
    return `- ${s.scenarioId} #${s.repeat}${status}: ${score}; ${bits.join('; ')}; revise ${s.reviseRounds ?? 0}; ${s.turns ?? '-'} turns, ${usd(s.costUsd)}, ${secs(s.durationMs)}`
  }
  // A draft that left model out gets the tier the tool resolved (chart.roles, same order): shown as "tier, default".
  const views = s.chart?.roles ?? []
  const roles = (s.chart?.drafts ?? []).map((d, i) => `${d.name} (${d.model ?? (views[i]?.tier ? `${views[i].tier}, default` : 'default')})`).join(', ')
  return `- ${s.scenarioId} #${s.repeat}${status}: ${score}; ${roles || 'no chart'}; revise ${s.reviseRounds ?? 0}; ask_user ${s.askUserCalls ?? 0}; question turns ${s.questionTurns ?? 0}; ${usd(s.costUsd)}`
}

/** report.md for a (re-scored) results object and its summary. */
export function renderReport(results, summary) {
  const out = []
  out.push('# Org chart benchmark report', '')
  out.push(`- label: ${results.label ?? '(none)'}`, `- model: ${results.model ?? '(not recorded)'}`, `- date: ${results.date ?? '-'}; commit: ${results.gitSha ?? '-'}; scorer version: ${summary.scorerVersion}`)
  out.push(`- sessions: ${summary.sessions} (${summary.scored} scored, ${summary.skipped} skipped); reported spend ${usd(summary.costUsd)}${results.maxUsd ? ` of a ${usd(results.maxUsd)} cap` : ''}`, '')
  const rec = summary.families.recommend
  if (rec) {
    out.push(`## Recommendation (mean ${num(rec.meanTotal)} / 100)`, '')
    out.push(table(['scenario', 'cx', 'n', 'score', ...RECOMMEND_DIMS.map(([, h]) => h), 'roles', 'depth', 'tier mix', 'cost proxy', 'asks', 'q turns', 'revise', '$'],
      rec.scenarios.map((s) => [s.id, s.complexity ?? '-', s.n, `${num(s.meanTotal)}${s.noResult ? ` (${s.noResult} no chart)` : ''}`, ...RECOMMEND_DIMS.map(([id]) => pct(s.dimensions[id])), num(s.roles), num(s.depth), mixText(s.tierMix), num(s.costProxy), num(s.askUserCalls), num(s.questionTurns), num(s.reviseRounds), usd(s.costUsd)]), [0, 13]))
    out.push('', 'Dimension columns are percent of the dimension; the score is out of 100 (weights in docs/design/org-chart-benchmark.md). Cost proxy: top 5, deep 3, everyday 1, fast 0.3 per role, unscored.', '')
    out.push(`Mean per dimension: ${RECOMMEND_DIMS.map(([id, h]) => `${h} ${pct(rec.dimensions[id])}`).join(', ')}`, '')
  }
  const retro = summary.families.retro
  if (retro) {
    out.push(`## Self-healing: revisions after a run record (mean ${num(retro.meanTotal)} / 100)`, '')
    out.push(table(['scenario', 'cx', 'n', 'score', ...RETRO_DIMS.map(([, h]) => h), 'listed', 'roles before>after', 'cost proxy delta', 'turns', 'revise', '$', 'time'],
      retro.scenarios.map((s) => [s.id, s.complexity ?? '-', s.n, `${num(s.meanTotal)}${s.noResult ? ` (${s.noResult} no ending)` : ''}`, ...RETRO_DIMS.map(([id]) => pct(s.dimensions[id])), num(s.listed), `${num(s.rolesBefore, 0)}>${num(s.rolesAfter, 0)}`, num(s.costProxyDelta, 2), num(s.turns), num(s.reviseRounds), usd(s.costUsd), secs(s.durationMs)])))
    out.push('', 'Efficiency (unscored): turns, reported cost and time of the healing session itself. Cost proxy delta is the change in the chart\'s ongoing cost proxy (positive = the chart now costs more per run).', '')
    out.push(`Mean per dimension: ${RETRO_DIMS.map(([id, h]) => `${h} ${pct(retro.dimensions[id])}`).join(', ')}`, '')
  }
  out.push('## Lowest-scoring checks (these drive the tuning)', '')
  if (!summary.weakestChecks.length) out.push('No check failed in any scored session.', '')
  else {
    out.push(table(['check', 'dimension', 'failed', 'of', 'mean credit %', 'scenarios', 'example'], summary.weakestChecks.slice(0, 20).map((c) => [`${c.family}/${c.id}`, c.dimension, c.fails, c.total, pct(c.meanCredit), c.scenarios.join(' '), c.sample]), [0, 1, 5, 6]), '')
  }
  out.push('## Sessions', '', ...(results.sessions ?? []).map(sessionLine), '')
  out.push('Model output is data: role names and rationales above are shown as the model wrote them.', '')
  return out.join('\n')
}

const signed = (d) => (typeof d === 'number' ? `${d > 0 ? '+' : ''}${d.toFixed(1)}` : '-')

/** The --compare output: per-scenario and per-dimension deltas (b minus a), retro included. `cmp` is compareSummaries output. */
export function renderCompare(cmp, labels = ['a', 'b']) {
  const out = [`# Compare ${labels[0]} -> ${labels[1]}`, '']
  for (const [family, f] of Object.entries(cmp.families)) {
    out.push(`## ${family === 'retro' ? 'Self-healing (retro)' : 'Recommendation'}: mean ${num(f.a)} -> ${num(f.b)} (${signed(f.delta)})`, '')
    out.push(table(['scenario', labels[0], labels[1], 'delta', ...(family === 'retro' ? ['turns a>b', '$ a>b'] : [])], f.scenarios.map((s) => [s.id, num(s.a), num(s.b), signed(s.delta), ...(family === 'retro' ? [`${num(s.turnsA)}>${num(s.turnsB)}`, `${usd(s.costUsdA)}>${usd(s.costUsdB)}`] : [])])), '')
    out.push(table(['dimension (points of 100)', labels[0], labels[1], 'delta'], f.dimensions.map((d) => [d.id, pct(d.a), pct(d.b), signed(d.delta)])), '')
  }
  out.push('## Checks whose failure rate moved', '')
  if (!cmp.checks.length) out.push('No check changed its failure rate.')
  else out.push(table(['check', `fail rate ${labels[0]}`, `fail rate ${labels[1]}`, 'delta'], cmp.checks.slice(0, 20).map((c) => [c.id, num(c.failRateA, 2), num(c.failRateB, 2), signed(c.delta)])))
  out.push('')
  return out.join('\n')
}
