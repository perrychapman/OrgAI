// Generates components/<Comp>/preview.html and README.md from shared fragments, so cards and pages stay identical.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), 'project', 'components')
const LUCIDE = '<script src="https://cdn.jsdelivr.net/npm/lucide@0.441.0/dist/umd/lucide.min.js"></script>'
const ic = (n) => `<i data-lucide="${n}" aria-hidden="true"></i>`

function doc({ group, height, width, page, body, script = '' }) {
  const attrs = [group && `group="${group}"`, `height=${height}`, width && `width=${width}`, page && 'page'].filter(Boolean).join(' ')
  return `<!-- @dsCard ${attrs} -->
${LUCIDE}
<div class="oa">
<button class="oa-btn sm ghost oa-replay" data-replay>${ic('rotate-ccw')}Replay</button>
${body}
</div>
<script>
${script}
window.OrgAI && window.OrgAI.init();
</script>
`
}

// ---------- fragments ----------
const spark = (pts) => {
  const max = Math.max(...pts), min = Math.min(...pts)
  const p = pts.map((v, i) => `${((i / (pts.length - 1)) * 100).toFixed(1)},${(26 - ((v - min) / (max - min || 1)) * 24).toFixed(1)}`).join(' ')
  return `<svg class="oa-spark oa-wipe" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${p}"/></svg>`
}

const gauge = (pct, name, sub, level = '') => `<li class="oa-gauge"${level ? ` data-level="${level}"` : ''}>
  <div class="oa-gauge-dial" role="img" aria-label="${name}: ${pct} percent used. ${sub}">
    <svg viewBox="0 0 64 64"><circle class="oa-gauge-track" cx="32" cy="32" r="26"/><circle class="oa-gauge-arc oa-arc" cx="32" cy="32" r="26" pathLength="100" style="--pct:${pct}"/></svg>
    <span class="oa-gauge-pct" data-to="${pct}" data-suf="%">${pct}%</span>
  </div>
  <div class="oa-gauge-text"><span class="oa-gauge-name">${name}</span><span class="oa-gauge-sub">${sub}</span></div>
</li>`

const gauges = () => `<ul class="oa-gauges" aria-label="Plan limits">
${gauge(62, '5-hour window', 'Claude plan · resets in 1 h 40 min')}
${gauge(84, '7-day window', 'Claude plan · resets Thu 09:00', 'warn')}
</ul>`

// Team pulse: the live org chart in miniature. Nodes pop, reporting lines trace, working nodes breathe, a signal travels a line when agents message.
const PN = [
  { id: 'root', x: 160, y: 34, r: 13, role: 1, s: 'working', name: 'Orchestrator' },
  { id: 'a', x: 64, y: 104, r: 10, role: 2, s: 'working', name: 'Runtime Engineer', p: 'root' },
  { id: 'b', x: 160, y: 104, r: 10, role: 4, s: 'waiting', name: 'UI Lead', p: 'root' },
  { id: 'c', x: 256, y: 104, r: 10, role: 3, s: 'idle', name: 'Reviewer', p: 'root' },
  { id: 'd', x: 32, y: 166, r: 8, role: 7, s: 'working', name: 'Test runner', p: 'a' },
  { id: 'e', x: 96, y: 166, r: 8, role: 6, s: 'done', name: 'Scan-cost fixer', p: 'a' }
]
const pulse = () => {
  const by = Object.fromEntries(PN.map((n) => [n.id, n]))
  const line = (n) => { const p = by[n.p]; const my = (p.y + n.y) / 2; return `M${p.x} ${p.y + p.r} V${my} H${n.x} V${n.y - n.r}` }
  const lines = PN.filter((n) => n.p).map((n, i) => `<path class="oa-pulse-line oa-trace" pathLength="1" style="--role:var(--role-${by[n.p].role});--i:${i}" d="${line(n)}"/>`).join('')
  const nodes = PN.map((n, i) => `<g class="oa-pulse-node oa-pop" data-state="${n.s}" style="--role:var(--role-${n.role});--i:${i}">${n.s === 'working' ? `<circle class="oa-pulse-halo" cx="${n.x}" cy="${n.y}" r="${n.r}" style="--i:${i}"/>` : ''}<circle class="oa-pulse-dot" cx="${n.x}" cy="${n.y}" r="${n.r}"><title>${n.name}: ${n.s}</title></circle></g>`).join('')
  const sig = `<circle class="oa-pulse-signal" r="3"><animateMotion dur="2.4s" repeatCount="indefinite" path="${line(by.a)}" keyPoints="1;0" keyTimes="0;1" calcMode="linear"/></circle>`
  return `<figure class="oa-pulse" aria-label="Team pulse: 6 agents, 3 working, 1 waiting on you">
  <svg viewBox="0 0 288 184" role="img" aria-hidden="true">${lines}${sig}${nodes}</svg>
  <figcaption><span><b>6</b> agents</span><span class="oa-key" data-state="working">3 working</span><span class="oa-key" data-state="waiting">1 needs you</span><span class="oa-key" data-state="done">1 finished</span></figcaption>
</figure>`
}

const briefing = () => `<section class="oa-brief oa-hero-card oa-rise-lg" aria-label="Briefing">
  <div class="oa-brief-main">
    <p class="oa-brief-date">Saturday 21 November</p>
    <h1 class="oa-brief-hello">Good evening, Alex</h1>
    <p class="oa-brief-status">3 agents are working in 2 runs. <b>2 decisions need you.</b></p>
    <p class="oa-brief-since"><span>Since yesterday 18:40</span><span class="oa-sep">·</span><span><b data-to="4">4</b> runs finished</span><span class="oa-sep">·</span><span><b>1</b> failed</span><span class="oa-sep">·</span><span><b data-to="6.42" data-dec="2" data-pre="$">$6.42</b> spent</span></p>
    <div class="oa-brief-actions">
      <button class="oa-btn primary">${ic('play')}Continue orgai</button>
      <button class="oa-btn">${ic('message-square')}New chat</button>
      <button class="oa-btn">${ic('plus')}New project</button>
      <button class="oa-btn ghost">${ic('sliders-horizontal')}Customise</button>
    </div>
  </div>
  ${pulse()}
  ${gauges()}
</section>`

const needs = () => `<section aria-label="Needs you">
  <div class="oa-head" data-tone="warning"><h2>Needs you</h2><span class="oa-num">2</span></div>
  <ul class="oa-needs">
    <li class="oa-need oa-rise oa-ring" style="--i:0">
      <div class="oa-need-body">
        <span class="oa-need-kind">Runtime Engineer wants to run a command</span>
        <code class="oa-need-cmd">npm run typecheck</code>
        <span class="oa-need-where">orgai · Fix the flaky retry test · in the project folder</span>
      </div>
      <div class="oa-need-actions">
        <button class="oa-btn sm" aria-label="Deny: npm run typecheck">Deny</button>
        <button class="oa-btn sm primary" aria-label="Allow once: npm run typecheck">Allow once</button>
      </div>
    </li>
    <li class="oa-need oa-rise" style="--i:1">
      <div class="oa-need-body">
        <span class="oa-need-kind">UI Lead asks: which chart leads the Usage page?</span>
        <span class="oa-need-where">orgai · Usage page pass</span>
      </div>
      <div class="oa-need-actions">
        <button class="oa-btn sm">Spend over time</button>
        <button class="oa-btn sm">Where it went</button>
      </div>
    </li>
  </ul>
</section>`

const agent = (role, name, act, state, d, i, time = '') => `<li class="oa-agent oa-rise" style="--role:var(--role-${role});--d:${d};--i:${i}">
  <span class="oa-mark" data-state="${state}" style="--i:${i}"></span>
  <span class="oa-agent-line"><span class="oa-agent-name">${name}</span><span class="oa-agent-act">${act}</span></span>
  <span class="oa-num">${time}</span>
</li>`

const rightNow = () => `<section class="oa-card" aria-label="Right now">
  <div class="oa-head"><h2>Right now</h2><span class="oa-num">1 running · 1 waiting</span></div>
  <div class="oa-runs">
    <div class="oa-run">
      <button class="oa-run-head"><span class="oa-mark" data-state="working" style="--role:var(--role-1)"></span><span class="oa-run-title">Fix the flaky retry test</span><span class="oa-badge" data-tone="info">Running</span><span class="oa-num">orgai · 12:04</span></button>
      <div class="oa-plan">
        <div class="oa-plan-bar" role="img" aria-label="Plan: step 3 of 5"><i data-s="done" class="oa-fill" style="--i:0"></i><i data-s="done" class="oa-fill" style="--i:1"></i><i data-s="now"></i><i></i><i></i></div>
        <span class="oa-plan-label">Step 3 of 5 · <b>Run the unit suite</b></span>
      </div>
      <ul class="oa-agents">
        ${agent(1, 'Orchestrator', 'Waiting on 2 reports', 'working', 0, 0, '12:04')}
        ${agent(2, 'Runtime Engineer', 'Running npm test', 'working', 1, 1, '04:12')}
        ${agent(3, 'Reviewer', 'Queued for the review step', 'idle', 1, 2)}
      </ul>
    </div>
    <div class="oa-run">
      <button class="oa-run-head"><span class="oa-mark" data-state="waiting" style="--role:var(--role-1)"></span><span class="oa-run-title">Usage page pass</span><span class="oa-badge" data-tone="warning">Needs you</span><span class="oa-num">orgai · 31:40</span></button>
      <div class="oa-plan">
        <div class="oa-plan-bar" role="img" aria-label="Plan: step 2 of 4"><i data-s="done" class="oa-fill"></i><i data-s="now"></i><i></i><i></i></div>
        <span class="oa-plan-label">Step 2 of 4 · <b>Choose the lead chart</b></span>
      </div>
      <ul class="oa-agents">
        ${agent(4, 'UI Lead', 'Asked you a question', 'waiting', 0, 3, '02:15')}
      </ul>
    </div>
  </div>
</section>`

const kpiItem = (label, value, attrs, delta, pts, pressed) => `<li class="oa-kpi-item"><button class="oa-kpi-btn"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>
  <span class="oa-kpi-label">${label}</span>
  <span class="oa-kpi-row"><span class="oa-kpi-value" ${attrs}>${value}</span><span class="oa-kpi-delta">${delta}</span></span>
  ${spark(pts)}
</button></li>`

const kpiUsage = () => `<div class="oa-kpi-wrap" data-slide>
  <ul class="oa-kpi" aria-label="Totals for the period">
    ${kpiItem('Estimated cost', '$128.40', 'data-to="128.4" data-dec="2" data-pre="$"', '<b>▲ 12%</b> vs prev.', [3, 5, 4, 6, 5, 8, 7, 9, 6, 8, 10, 9], true)}
    ${kpiItem('Tokens', '48.2M', 'data-to="48.2" data-dec="1" data-suf="M"', '<b>▲ 8%</b> vs prev.', [4, 4, 5, 6, 5, 7, 8, 7, 8, 9, 8, 9], false)}
    ${kpiItem('Runs', '212', 'data-to="212"', '<b>▼ 3%</b> vs prev.', [9, 8, 9, 7, 8, 8, 6, 7, 8, 7, 7, 6], false)}
    ${kpiItem('Wall time', '61 h', 'data-to="61" data-suf=" h"', '<b>▲ 5%</b> vs prev.', [5, 6, 5, 6, 7, 6, 7, 8, 7, 8, 8, 9])}
  </ul>
  <span class="oa-indicator" aria-hidden="true"></span>
</div>`

const kpiWeek = () => `<ul class="oa-kpi" aria-label="Your week">
  ${kpiItem('Spend this week', '$31.80', 'data-to="31.8" data-dec="2" data-pre="$"', '<b>▲ 9%</b>', [2, 4, 3, 5, 6, 5, 7])}
  ${kpiItem('Runs', '46', 'data-to="46"', '<b>▼ 2</b>', [8, 7, 6, 7, 5, 7, 6])}
  ${kpiItem('Agent time', '14.5 h', 'data-to="14.5" data-dec="1" data-suf=" h"', '<b>▲ 1.2 h</b>', [1, 2, 2, 3, 2, 3, 4])}
  ${kpiItem('Decisions', '23', 'data-to="23"', 'median 40 s', [4, 3, 5, 2, 4, 3, 2])}
</ul>`

const DAYS = [30, 55, 20, 8, 5, 62, 80, 58, 44, 70, 12, 6, 66, 48]
const strip = () => `<section class="oa-strip" aria-label="Last 14 days">
  <div class="oa-head" data-quiet><h2>Last 14 days</h2><span class="oa-num">94 runs</span><button class="oa-link">Open Usage</button></div>
  <div class="oa-strip-bars" role="group" aria-label="Runs per day">
    ${DAYS.map((h, i) => `<button class="oa-day"${i === 13 ? ' data-today' : ''} aria-label="${8 + i} November: ${Math.round(h / 8)} runs"><i class="oa-grow" style="--h:${h}%;--i:${i}"></i></button>`).join('')}
  </div>
  <div class="oa-strip-foot"><span><b>Today</b> · 6 runs · $4.10</span><span>8 Nov to 21 Nov</span></div>
</section>`

const area = (pts) => {
  const max = Math.max(...pts), min = Math.min(...pts)
  const xy = pts.map((v, i) => `${((i / (pts.length - 1)) * 100).toFixed(1)},${(34 - ((v - min) / (max - min || 1)) * 30).toFixed(1)}`)
  return `<svg class="oa-area oa-wipe" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,36 ${xy.join(' ')} 100,36"/><polyline points="${xy.join(' ')}"/></svg>`
}
const stat = (i, label, value, attrs, delta, pts, focus) => `<li class="oa-stat oa-rise"${focus ? ' data-focus' : ''} style="--i:${i}"><button class="oa-stat-btn" aria-label="${label}: ${value}. Open Usage">
  <span class="oa-stat-label">${label}</span>
  <span class="oa-stat-value" ${attrs}>${value}</span>
  <span class="oa-stat-delta">${delta}</span>
  ${area(pts)}
</button></li>`
const stats = () => `<ul class="oa-stats" aria-label="Your week">
  ${stat(0, 'Spend this week', '$31.80', 'data-to="31.8" data-dec="2" data-pre="$"', '<b>▲ 9%</b> on last week', [2, 4, 3, 5, 6, 5, 7], true)}
  ${stat(1, 'Runs', '46', 'data-to="46"', '<b>▼ 2</b> on last week', [8, 7, 6, 7, 5, 7, 6])}
  ${stat(2, 'Agent time', '14.5 h', 'data-to="14.5" data-dec="1" data-suf=" h"', '<b>▲ 1.2 h</b> on last week', [1, 2, 2, 3, 2, 3, 4])}
  ${stat(3, 'Decisions answered', '23', 'data-to="23"', 'median wait <b>40 s</b>', [4, 3, 5, 2, 4, 3, 2])}
</ul>`

// Activity map: 14 days across, six four-hour blocks down; a cell's strength is the runs started in that block.
const HEAT = ['00', '04', '08', '12', '16', '20'].map((h, r) => ({ h, v: Array.from({ length: 14 }, (_, c) => {
  const weekend = c % 7 === 3 || c % 7 === 4
  const base = [0.02, 0.05, 0.75, 0.9, 0.6, 0.25][r] * (weekend ? 0.15 : 1)
  return Math.max(0, Math.min(1, base + (((c * 7 + r * 13) % 10) - 5) / 22))
}) }))
const heat = () => `<section class="oa-card" aria-label="When your team worked">
  <div class="oa-head" data-quiet><h2>When your team worked</h2><span class="oa-num">94 runs · 14 days</span><button class="oa-link">Open Usage</button></div>
  <div class="oa-heat" role="img" aria-label="Runs started per four-hour block over the last 14 days. Busiest: weekdays 08:00 to 16:00.">
    ${HEAT.map((row) => `<span class="oa-heat-l oa-num">${row.h}</span>${row.v.map((v, c) => `<i class="oa-cell"${c === 13 ? ' data-today' : ''} style="--v:${v.toFixed(2)};--c:${c}"></i>`).join('')}`).join('\n    ')}
  </div>
  <div class="oa-strip-foot"><span>8 Nov</span><span class="oa-heat-scale">Fewer <i style="--v:.1"></i><i style="--v:.35"></i><i style="--v:.6"></i><i style="--v:.9"></i> More</span><span><b>Today</b> · 6 runs</span></div>
</section>`

const week = () => `<section class="oa-stack" aria-label="Your week">${stats()}${heat()}</section>`

const pickUp = () => `<section aria-label="Pick up">
  <div class="oa-head" data-quiet><h2>Pick up</h2><span class="oa-num">3</span></div>
  <ul class="oa-list">
    <li class="oa-rise" style="--i:0"><span class="oa-mark" data-state="idle"></span><span class="oa-list-main"><span class="oa-list-title">Usage page pass</span><span class="oa-list-sub">Paused · resumes 14:10 · orgai</span></span><button class="oa-btn sm">Continue</button></li>
    <li class="oa-rise" style="--i:1"><span class="oa-mark" data-state="done"></span><span class="oa-list-main"><span class="oa-list-title">Add retry to the scan-cost test</span><span class="oa-list-sub">Finished 2 h ago · orgai · $0.84</span></span><button class="oa-btn sm">Continue</button></li>
    <li class="oa-rise" style="--i:2"><span class="oa-mark" data-state="failed"></span><span class="oa-list-main"><span class="oa-list-title">Import the docs-site agents</span><span class="oa-list-sub">Failed yesterday · docs-site</span></span><button class="oa-btn sm">Open</button></li>
  </ul>
</section>`

const upNext = () => `<section aria-label="Up next">
  <div class="oa-head" data-quiet><h2>Up next</h2><span class="oa-num">2</span><button class="oa-link">Schedules</button></div>
  <ul class="oa-list">
    <li class="oa-rise" style="--i:0"><span class="oa-num oa-list-when">Mon 09:00</span><span class="oa-list-main"><span class="oa-list-title">Weekly dependency review</span><span class="oa-list-sub">orgai · team run</span></span><span class="oa-badge">In 2 days</span></li>
    <li class="oa-rise" style="--i:1"><span class="oa-num oa-list-when">Daily 18:00</span><span class="oa-list-main"><span class="oa-list-title">Summarise open issues</span><span class="oa-list-sub">docs-site · ask</span></span><span class="oa-badge" data-tone="accent">In 40 min</span></li>
  </ul>
</section>`

const tile = (i, name, client, roles, more, state, word, caption, folder, cost, pinned) => `<li class="oa-tile oa-rise" style="--i:${i}"${pinned ? ' data-pinned' : ''}>
  <button class="oa-tile-open" aria-label="Open ${name}"><span class="oa-tile-name">${name}</span><span class="oa-tile-client">${client}</span></button>
  <button class="oa-tile-pin" aria-pressed="${pinned ? 'true' : 'false'}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${name}">${ic('pin')}</button>
  <div class="oa-tile-team" aria-hidden="true">${roles.map((r) => `<i style="--role:var(--role-${r})"></i>`).join('')}${more ? `<span>+${more}</span>` : ''}</div>
  <div class="oa-tile-run"><span class="oa-mark" data-state="${state}"></span><span><b>${word}</b>${caption ? ` · ${caption}` : ''}</span></div>
  <div class="oa-tile-foot oa-num"><span>${folder}</span><span>${cost}</span></div>
</li>`

const tiles = () => `<section aria-label="Projects">
  <div class="oa-head"><h2>Projects</h2><span class="oa-num">3</span></div>
  <ul class="oa-tiles">
    ${tile(0, 'orgai', 'Pinned · team of 6', [1, 2, 3, 4, 5, 6], 0, 'working', 'Running', 'Run the unit suite', 'OrgAI', '$84.20', true)}
    ${tile(1, 'docs-site', 'Team of 3', [1, 7, 3], 0, 'done', 'Finished', 'Last run 2 h ago', 'docs-site', '$28.10', false)}
    ${tile(2, 'billing-api', 'Team of 10', [1, 2, 3, 4, 5, 6, 7, 8], 2, 'idle', 'Idle', 'Last run 3 days ago', 'billing-api', '$12.40', false)}
  </ul>
</section>`

const stateMarks = () => `<ul class="oa-gauges">
  ${[['working', 'Running'], ['waiting', 'Needs you'], ['idle', 'Idle'], ['done', 'Finished'], ['failed', 'Failed']].map(([s, w], i) => `<li style="display:flex;align-items:center;gap:var(--space-2)"><span class="oa-mark" data-state="${s}" style="--role:var(--role-${i + 1})"></span>${w}</li>`).join('')}
</ul>`

const pace = () => `<section class="oa-pace oa-hero-card oa-rise-lg" aria-label="Pacing">
  <div class="oa-pace-main">
    <span class="oa-kpi-label">This month · 1 to 21 November</span>
    <span class="oa-pace-figure" data-to="128.4" data-dec="2" data-pre="$">$128.40</span>
    <p class="oa-pace-line"><span><b>▲ 12%</b> against October at this point</span><span class="oa-sep">·</span><span>Projected <b>$183</b> by 30 November</span></p>
  </div>
  <figure class="oa-dial" aria-label="$128.40 of a projected $183, 70 percent. October had reached $114.60 by day 21.">
    <svg viewBox="0 0 200 112" aria-hidden="true">
      <defs><linearGradient id="oa-dial-g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" style="stop-color:var(--brand-ui-from)"/><stop offset="1" style="stop-color:var(--brand-ui-to)"/></linearGradient></defs>
      <path class="oa-dial-track" d="M16 100 A84 84 0 0 1 184 100"/>
      <path class="oa-dial-arc oa-arc" pathLength="100" style="--pct:70" stroke="url(#oa-dial-g)" d="M16 100 A84 84 0 0 1 184 100"/>
      <path class="oa-dial-mark" d="M129.3 29.9 L136.3 13.3"/>
    </svg>
    <div class="oa-dial-text"><span class="oa-dial-pct" data-to="70" data-suf="%">70%</span><span>of the projection</span></div>
    <figcaption>Tick: October at day 21, $114.60</figcaption>
  </figure>
  <ul class="oa-gauges" aria-label="Limits">
    ${gauge(84, '7-day window', 'Claude plan · resets Thu 09:00', 'warn')}
    ${gauge(58, 'Proxy budget', '$29.00 of $50.00 this month')}
  </ul>
</section>`

const S = {
  orgai: [3.1, 4.2, 2.0, 0.6, 0.4, 5.1, 6.2, 4.8, 3.9, 5.5, 1.0, 0.3, 4.4, 6.8, 7.2, 5.9, 6.1, 1.2, 0.8, 5.4, 4.1],
  docs: [1.0, 0.8, 1.5, 0, 0, 2.1, 1.2, 0.9, 1.8, 2.2, 0, 0, 1.1, 0.9, 2.4, 1.9, 1.3, 0, 0.2, 1.6, 1.2],
  billing: [0.5, 0, 0.9, 0, 0, 0.4, 1.1, 0.6, 0, 1.3, 0, 0, 0.8, 1.4, 0.7, 0.3, 0.9, 0, 0, 1.0, 0.6]
}
const MAX = 12
const bars = () => S.orgai.map((a, i) => {
  const b = S.docs[i], c = S.billing[i]
  const seg = (v, col) => (v > 0 ? `<i style="--h:${((v / MAX) * 100).toFixed(1)}%;--c:var(--chart-${col})"></i>` : '')
  return `<button class="oa-bar oa-grow" style="--i:${i}" data-day="${i + 1} Nov" data-a="${a.toFixed(2)}" data-b="${b.toFixed(2)}" data-c="${c.toFixed(2)}" aria-label="${i + 1} November: $${(a + b + c).toFixed(2)}">${seg(a, 's1')}${seg(b, 's2')}${seg(c, 's3')}</button>`
}).join('')

const areas = () => {
  const n = S.orgai.length
  const L1 = S.orgai, L2 = L1.map((v, i) => v + S.docs[i]), L3 = L2.map((v, i) => v + S.billing[i])
  const pt = (v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(100 - (v / MAX) * 100).toFixed(2)}`
  const poly = (top, bottom, col) => `<polygon style="--c:var(--chart-${col})" points="${top.map(pt).join(' ')} ${bottom.map((v, i) => pt(v, i)).reverse().join(' ')}"/>`
  return poly(L1, L1.map(() => 0), 's1') + poly(L2, L1, 's2') + poly(L3, L2, 's3')
}

const spendChart = () => `<section class="oa-card" aria-label="Spend over time">
  <div class="oa-chart-head">
    <h2>Spend over time</h2>
    <div class="oa-seg" role="group" aria-label="Metric"><button aria-pressed="true">Cost</button><button aria-pressed="false">Tokens</button><button aria-pressed="false">Runs</button></div>
    <button class="oa-btn sm ghost">${ic('table')}Table</button>
  </div>
  <div class="oa-legend" role="group" aria-label="Series">
    <button aria-pressed="true"><span class="oa-swatch" style="--c:var(--chart-s1)"></span>orgai</button>
    <button aria-pressed="true"><span class="oa-swatch" style="--c:var(--chart-s2)"></span>docs-site</button>
    <button aria-pressed="true"><span class="oa-swatch" style="--c:var(--chart-s3)"></span>billing-api</button>
  </div>
  <div class="oa-plot">
    <div class="oa-plot-grid" aria-hidden="true"><span style="--y:0%" data-l="$0"></span><span style="--y:33.3%" data-l="$4"></span><span style="--y:66.6%" data-l="$8"></span><span style="--y:100%" data-l="$12"></span></div>
    <div class="oa-plot-area" tabindex="0" role="slider" aria-label="Day" aria-valuemin="1" aria-valuemax="21" aria-valuenow="21" aria-valuetext="21 November" data-series='${JSON.stringify(S)}'>
      <svg class="oa-wipe" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${areas()}</svg>
      <span class="oa-cross" aria-hidden="true"></span>
      <div class="oa-tip" role="status"></div>
    </div>
  </div>
  <div class="oa-axis" aria-hidden="true"><span>1 Nov</span><span>7 Nov</span><span>14 Nov</span><span>21 Nov</span></div>
</section>`

const chartScript = `(function () {
  var plot = document.querySelector('.oa-plot-area'); if (!plot) return;
  var tip = plot.querySelector('.oa-tip'), cross = plot.querySelector('.oa-cross');
  var s = JSON.parse(plot.getAttribute('data-series')), n = s.orgai.length, at = n - 1;
  function show(i) {
    at = Math.max(0, Math.min(n - 1, i));
    var a = s.orgai[at], b = s.docs[at], c = s.billing[at], x = at / (n - 1) * plot.clientWidth;
    cross.style.transform = 'translateX(' + x + 'px)'; cross.setAttribute('data-on', '');
    tip.innerHTML = '<b>' + (at + 1) + ' Nov · $' + (a + b + c).toFixed(2) + '</b><div><span>orgai</span><span>$' + a.toFixed(2) + '</span></div><div><span>docs-site</span><span>$' + b.toFixed(2) + '</span></div><div><span>billing-api</span><span>$' + c.toFixed(2) + '</span></div>';
    tip.style.left = Math.max(0, Math.min(plot.clientWidth - 148, x - 74)) + 'px'; tip.setAttribute('data-on', '');
    plot.setAttribute('aria-valuenow', at + 1); plot.setAttribute('aria-valuetext', (at + 1) + ' November, $' + (a + b + c).toFixed(2));
  }
  function hide() { cross.removeAttribute('data-on'); tip.removeAttribute('data-on'); }
  plot.addEventListener('mousemove', function (e) { var r = plot.getBoundingClientRect(); show(Math.round((e.clientX - r.left) / r.width * (n - 1))); });
  plot.addEventListener('mouseleave', hide);
  plot.addEventListener('focus', function () { show(at); });
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') show(at - 1); else if (e.key === 'ArrowRight') show(at + 1); else if (e.key === 'Home') show(0); else if (e.key === 'End') show(n - 1); else return;
    e.preventDefault();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.oa-seg, .oa-legend'), function (g) {
    var single = g.classList.contains('oa-seg');
    Array.prototype.forEach.call(g.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        if (single) { Array.prototype.forEach.call(g.querySelectorAll('button'), function (o) { o.setAttribute('aria-pressed', 'false'); }); b.setAttribute('aria-pressed', 'true'); }
        else b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
      });
    });
  });
})();`

const rank = (i, name, col, value, share) => `<li class="oa-rise" style="--i:${i}"><span class="oa-rank-name"><span class="oa-swatch" style="--c:var(--chart-${col})"></span>${name}</span><span class="oa-num">${value}</span><span class="oa-num oa-rank-share">${share}%</span><span class="oa-rank-bar"><i class="oa-fill" style="--pct:${share}%;--c:var(--chart-${col});--i:${i}"></i></span></li>`

const breakdown = () => `<section class="oa-card" aria-label="Where it went">
  <div class="oa-chart-head"><h2>Where it went</h2></div>
  <div class="oa-tabs" role="tablist" data-slide>
    <button role="tab" aria-selected="true">Project</button><button role="tab" aria-selected="false">Model</button><button role="tab" aria-selected="false">Role</button><button role="tab" aria-selected="false">Connection</button>
    <span class="oa-indicator" aria-hidden="true"></span>
  </div>
  <div class="oa-ribbon oa-wipe" role="img" aria-label="orgai 66 percent, docs-site 22 percent, billing-api 10 percent, Chat 3 percent"><i style="--pct:66%;--c:var(--chart-s1)"></i><i style="--pct:22%;--c:var(--chart-s2)"></i><i style="--pct:10%;--c:var(--chart-s3)"></i><i style="--pct:3%;--c:var(--chart-other)"></i></div>
  <ol class="oa-rank">
    ${rank(0, 'orgai', 's1', '$84.20', 66)}
    ${rank(1, 'docs-site', 's2', '$28.10', 22)}
    ${rank(2, 'billing-api', 's3', '$12.40', 10)}
    ${rank(3, 'Chat', 'other', '$3.70', 3)}
  </ol>
</section>`

const eff = (i, label, value, attrs, read) => `<li class="oa-rise" style="--i:${i}"><span class="oa-eff-label">${label}</span><span class="oa-eff-value" ${attrs}>${value}</span><span class="oa-eff-read">${read}</span></li>`
const efficiency = () => `<section aria-label="Efficiency">
  <div class="oa-head"><h2>Efficiency</h2></div>
  <ul class="oa-eff">
    ${eff(0, 'Cost per finished run', '$0.61', 'data-to="0.61" data-dec="2" data-pre="$"', 'Down from $0.74. Runs are getting cheaper.')}
    ${eff(1, 'Overlap', '1.8×', 'data-to="1.8" data-dec="1" data-suf="×"', 'Reports work in parallel most of the time.')}
    ${eff(2, 'Time to first report', '42 s', 'data-to="42" data-suf=" s"', 'The lead delegates quickly.')}
    ${eff(3, 'Agents with no result', '6%', 'data-to="6" data-suf="%"', '13 agents produced nothing. See Runs worth a look.')}
  </ul>
</section>`

const worth = () => `<section aria-label="Runs worth a look">
  <div class="oa-head" data-quiet><h2>Runs worth a look</h2><span class="oa-num">3</span></div>
  <ul class="oa-list">
    <li><span class="oa-mark" data-state="done"></span><span class="oa-list-main"><span class="oa-list-title">Rework the import preview</span><span class="oa-list-sub">4 agents produced no result · orgai</span></span><span class="oa-num">$6.80</span></li>
    <li><span class="oa-mark" data-state="failed"></span><span class="oa-list-main"><span class="oa-list-title">Import the docs-site agents</span><span class="oa-list-sub">Failed after 38 min · docs-site</span></span><span class="oa-num">$4.15</span></li>
    <li><span class="oa-mark" data-state="done"></span><span class="oa-list-main"><span class="oa-list-title">Rename the billing events</span><span class="oa-list-sub">Top tier on every step · billing-api</span></span><span class="oa-num">$3.90</span></li>
  </ul>
</section>`

const tiers = () => `<section aria-label="Cost by tier">
  <div class="oa-head" data-quiet><h2>Cost by tier</h2></div>
  <div class="oa-donut-row"><div class="oa-donut" role="img" aria-label="Top 48 percent, Deep 27 percent, Everyday 18 percent, Fast 7 percent"><svg viewBox="0 0 42 42">${[[47, 0, 's1'], [26, 48, 's2'], [17, 75, 's3'], [6, 93, 's4']].map(([p, s, c]) => `<circle class="oa-donut-seg oa-arc" cx="21" cy="21" r="15.915" pathLength="100" style="--pct:${p};--start:${s};--c:var(--chart-${c})"/>`).join('')}</svg><span class="oa-donut-text"><b>4</b>tiers</span></div>
  <ol class="oa-rank">
    <li><span class="oa-rank-name"><span class="oa-swatch" style="--c:var(--chart-s1)"></span>Top</span><span class="oa-num">$61.60</span><span class="oa-num oa-rank-share">48%</span></li>
    <li><span class="oa-rank-name"><span class="oa-swatch" style="--c:var(--chart-s2)"></span>Deep</span><span class="oa-num">$34.70</span><span class="oa-num oa-rank-share">27%</span></li>
    <li><span class="oa-rank-name"><span class="oa-swatch" style="--c:var(--chart-s3)"></span>Everyday</span><span class="oa-num">$23.10</span><span class="oa-num oa-rank-share">18%</span></li>
    <li><span class="oa-rank-name"><span class="oa-swatch" style="--c:var(--chart-s4)"></span>Fast</span><span class="oa-num">$9.00</span><span class="oa-num oa-rank-share">7%</span></li>
  </ol></div>
</section>`

const filterBar = () => `<div class="oa-filter"><div class="oa-seg" role="group" aria-label="Period"><button aria-pressed="false">7 days</button><button aria-pressed="true">This month</button><button aria-pressed="false">90 days</button></div><button class="oa-btn sm">All projects</button><button class="oa-btn sm">All kinds</button><span class="oa-muted">1 to 21 November · 212 runs</span></div>`

const dashboardPage = () => `<div class="oa-page">
  ${briefing()}
  <div class="oa-work">
    <div class="oa-stack">${needs()}${week()}</div>
    ${rightNow()}
  </div>
  <div class="oa-pair">${pickUp()}${upNext()}</div>
  ${tiles()}
</div>`

const usagePage = () => `<div class="oa-page">
  ${filterBar()}
  ${pace()}
  ${kpiUsage()}
  <div class="oa-hero">${spendChart()}${breakdown()}</div>
  ${efficiency()}
  <div class="oa-pair">${worth()}${tiers()}</div>
</div>`

// ---------- cards ----------
const cards = {
  DashboardPage: { group: 'Pages', height: 1560, width: 1280, page: true, body: dashboardPage(),
    readme: `The whole redesigned Dashboard: Briefing, Needs you, Right now, Your week, Pick up, Up next and Projects in their reading order.

Use it as the reference composition. The work area is two columns from an 880 px container (Needs you and Your week left, Right now right) and one column below. Needs you and Right now are drawn only when they have content; the others follow the person's saved order.

On arrival the Briefing rises first, the bands follow in reading order with at most six stagger steps, then bars grow and figures count up. See \`dashboard.md\` for what is new, retired and kept, and \`motion.md\` for the arrival rules.` },
  UsagePage: { group: 'Pages', height: 1240, width: 1280, page: true, body: usagePage(), script: chartScript,
    readme: `The whole redesigned Usage page: filter bar, Pacing, KPI band, Spend over time beside Where it went, Efficiency, then Runs worth a look beside Cost by tier.

Use it as the reference composition. The hero row is two columns (7 to 5) from an 880 px container. The filter bar is sticky in the app.

Draw motion runs once per filter change the person makes, never for background updates. See \`usage.md\`.` },
  Briefing: { group: 'Dashboard', height: 330, body: briefing(),
    readme: `The Dashboard's personal header: a greeting, the status sentence, what changed since the last visit, quick actions and the plan gauges.

**Provide:** the display name (optional), the status sentence, the last-seen time with counts by outcome since then, up to three quick actions, and up to two \`PlanGauge\` entries.

- Greet with the time of day ("Good morning", "Good afternoon", "Good evening"); add the name only when one is saved.
- The greeting is the page's one \`display\` line.
- The first quick action is the primary button and continues the pinned or most recent project. New chat and New project follow. Customise is last and quiet.
- Omit the "Since" line on a first launch or when nothing changed.
- Setup gaps appear here as one line ("2 things to set up"), not as a section.
- Do not put counts that duplicate Needs you anywhere but the status sentence.
- Arrival: the block rises large; the figures in the "Since" line count up.` },
  NeedsYou: { group: 'Dashboard', height: 200, body: needs(),
    readme: `Open decisions as amber rows that can be answered in place.

**Provide:** each decision's kind, who asks, the full request, where it comes from, and its answer options.

- This is the only amber surface on the Dashboard: \`warning-soft\` fill, \`warning-border\` edge, \`warning-text\` count.
- Offer Allow once and Deny only, and only when the whole request is visible on the row. Each button's accessible name repeats the request.
- A question gets one-click options only for a single choice of 2 to 4 short options.
- A sent answer locks the row until the result arrives.
- A new row rises and rings once; the count pings. Rows already on screen never move for it.
- With no decision the section is not drawn. It cannot be hidden or reordered by Customise.` },
  RightNow: { group: 'Dashboard', height: 340, body: rightNow(),
    readme: `Open runs with their plan progress and the agents working in them.

**Provide:** each open run's title, project, status word, elapsed time, plan steps with states, and its agents (name, role colour, state, activity line, depth).

- The run header is one button that opens the run.
- The plan bar has one segment per step: \`state-done\` when done, a partial \`state-working\` fill for the current step, \`surface-3\` otherwise. Name the current step beside it.
- Indent reports one \`space-4\` step per level.
- A working agent's \`StateMark\` breathes; at most 12 breathe on the page.
- An activity line cross-fades when its text changes, at most once a second. Rows do not reorder while the person is reading.
- With no open run the section is not drawn.` },
  ActivityMap: { group: 'Dashboard', height: 250, body: heat(),
    readme: `A heatmap of when runs started: 14 days across, six four-hour blocks down.

**Provide:** the number of runs started in each four-hour block of each of the last 14 local days.

- Replaces the 14-day bar strip. It answers when the team works, not only how much.
- A cell's strength is its share of the busiest block, mixed from \`surface-3\` toward \`accent-text\`. Today's column is outlined.
- The picture has one text alternative that names the busiest blocks; the footer gives today's count in words.
- The heading link opens Usage on the same 14 days.
- On arrival the columns fade in left to right.` },
  TeamPulse: { group: 'Dashboard', height: 270, body: pulse(),
    readme: `The live org chart in miniature: every agent in an open run as a node on its reporting line.

**Provide:** the agents of the open runs (role colour, state, parent) and the counts for the caption.

- It sits in the Briefing and is the page's signature graphic. It is a picture with a caption; the rows in Right now remain the way to act.
- Nodes take the role colour; the ring takes the state colour. Reporting lines are orthogonal, like the mark.
- Working nodes breathe. When agents message each other a signal dot travels the line between them. These are the only two looping motions.
- On arrival lines trace from the root outward, then nodes pop in.
- Show at most 12 nodes; fold the rest into a count in the caption.
- With no open run it shows the pinned project's team at rest: no halo, no signal.` },
  StatCards: { group: 'Dashboard', height: 300, body: stats(),
    readme: `Your week as four cards: a figure, how it moved, and an area sparkline.

**Provide:** four figures with a label, a value, a movement line and seven daily values; which one is the focus figure.

- Values are the \`stat\` style. The focus figure's sparkline uses \`accent-text\`; the others use \`text-secondary\`.
- Each card is one button that opens Usage on the same week with that metric chosen.
- Movement uses ▲ and ▼ with the amount, never colour alone.
- On arrival cards rise in order, values count up and sparklines wipe in.` },
  KpiBand: { group: 'Usage', height: 150, body: kpiUsage(),
    readme: `Four hairline-separated figures with deltas and sparklines. On Usage, three of them choose the chart metric.

**Provide:** four figures, each with a label, a value, a delta against the previous period and a series for the sparkline; on Usage, which one is pressed.

- Values are \`title-lg\` with tabular numerals. Labels are \`caption\`.
- The pressed tile's label turns \`text-primary\` at weight 600 and its sparkline turns \`accent-text\`; a 2 px \`accent\` bar slides to it over \`dur-slow\`.
- Deltas use ▲ and ▼ with the figure, never colour alone. A rising cost is not coloured as bad.
- An unknown value reads "Not priced" and never counts up.
- On the Dashboard the same band is "Your week": every tile is a link to Usage and none is pressed.
- On arrival values count up and sparklines wipe in.` },
  PickUp: { group: 'Dashboard', height: 210, body: pickUp(),
    readme: `Paused and recently ended runs that can be continued, newest first.

**Provide:** each run's title, state word, when, project, cost if any, and whether it can be continued.

- Replaces the separate Paused and Recently ended lists.
- An unboxed list: no fill at rest, a \`border-default\` hairline between rows, \`surface-2\` on hover.
- Each row leads with a \`StateMark\` and ends with one small button: Continue when the run can be continued, Open otherwise.
- Cap at 4 rows (6 from a 1280 px container), then "Show N more".` },
  UpNext: { group: 'Dashboard', height: 160, body: upNext(),
    readme: `The next schedule firings.

**Provide:** each schedule's next time, name, project and kind.

- Times are \`mono\` in a fixed-width column so names align.
- The badge says how far away the firing is; the next one within the hour takes the accent tone.
- While schedules are paused, show one line saying so in place of the rows.
- With no schedule the section is not drawn.` },
  ProjectTile: { group: 'Dashboard', height: 230, body: tiles(),
    readme: `A project as a tile: name, team, the state of its latest run, folder and spend.

**Provide:** the project's name, client or team size, up to eight role colours, the latest run's state word and caption, the folder name, the spend if any, and whether it is pinned.

- Tiles sit on \`surface-2\` and never take a state tint.
- A pinned tile has an \`accent-border\` edge and an \`accent-faint\` wash, and sorts first.
- The whole tile opens the project; the pin is a separate button after it in tab order.
- Hover lifts the tile 2 px with \`elev-1\`.
- Show the cost only when something was spent.
- On arrival tiles rise with at most six stagger steps.` },
  PlanGauge: { group: 'Shared', height: 110, body: gauges(),
    readme: `A plan window or budget as an arc with its percentage and reset time.

**Provide:** the percentage used, the window or budget name, the reset or amount line, and the level.

- The arc uses \`brand-ui-from\`; from 80% it turns \`warning\`, and \`danger\` when limited. The percentage text changes to the matching text colour, so the level never lives in the arc alone.
- Show the tightest window per connection, at most two gauges, then "+N more".
- Hidden for API keys and wherever the provider reports nothing.
- On arrival the arc traces clockwise and the percentage counts up.` },
  StateMark: { group: 'Shared', height: 80, body: stateMarks(),
    readme: `The 12 px mark that carries an agent's or run's state.

**Provide:** the state and, for an agent, its role colour.

- The fill is the role colour; the ring is the state colour.
- Always pair it with the status word nearby: Running, Needs you, Idle, Finished, Failed.
- Only the working mark moves: one breath every \`dur-pulse\`. Under reduced motion the static halo stays.` },
  Pacing: { group: 'Usage', height: 240, body: pace(),
    readme: `The Usage page's header: the period's spend, its pace against the previous period, a projection, and the limits.

**Provide:** the period label, spend so far, the previous period's spend at the same point, the projection (or the reason there is none), and up to two \`PlanGauge\` entries.

- The spend is the page's one \`figure\`.
- The burn dial fills to spend so far over the projection; the tick shows where the previous period stood at this point. Say what the tick is under the dial.
- Show the projection only once a fifth of the period has passed and every run in it is priced. Otherwise say why it is missing.
- Label the projection "Projected". Never present it as a fact.
- On arrival the figure counts up and the dial traces.` },
  SpendChart: { group: 'Usage', height: 380, body: spendChart(), script: chartScript,
    readme: `Stacked bars of the chosen metric over time, with a metric switch, legend toggles and a crosshair tooltip.

**Provide:** buckets with a value per series, the series order, the chosen metric, and which series are hidden.

- Stacked areas, largest series at the bottom.

- Series take \`chart-s1\` to \`chart-s5\` in order, then \`chart-other\`. Segments are separated by a 1 px \`chart-hatch\` gap.
- Unpriced usage is hatched in \`chart-unknown\` and never drawn as zero.
- A crosshair follows the pointer; with focus on the plot, Left and Right move it a bucket, Home and End jump to the ends. The tooltip and the value text name the date, the total and each series.
- A legend chip toggles its series; a hidden series is struck through with a hollow swatch.
- The Table button shows the same numbers as a table.
- The areas wipe in left to right, once per filter change the person makes.` },
  Breakdown: { group: 'Usage', height: 290, body: breakdown(),
    readme: `Where the spend went, ranked, by Project, Model, Role or Connection.

**Provide:** the chosen grouping and its top rows (name, value, share, colour).

- A proportional ribbon leads; the rows below explain it. Show the top five rows; fold the rest into Other.
- The tab underline slides to the selected tab over \`dur-slow\`; the tab body fades and rises.
- Each row's bar fills from the left on arrival. When the order changes, rows glide to their new place.
- A row click narrows the page to that item. It never scrolls the page.` },
  Efficiency: { group: 'Usage', height: 150, body: efficiency(),
    readme: `Four efficiency measures, each with a one-sentence reading.

**Provide:** four measures with a label, a value and a plain reading of what the value means.

- The reading is a sentence a person can act on, not a definition.
- A measure without enough runs reads "Not enough runs yet" in place of its value.
- Definitions live in a tooltip on the label.` }
}

for (const [name, c] of Object.entries(cards)) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preview.html'), doc(c))
  writeFileSync(join(dir, 'README.md'), c.readme + '\n')
}

// ---------- cover ----------
mkdirSync(join(root, 'Cover'), { recursive: true })
writeFileSync(join(root, 'Cover', 'preview.html'), `<!-- @dsCard height=288 -->
<style>
  .cv { position: relative; width: 960px; height: 288px; overflow: hidden; background: var(--surface-0); font-family: var(--font-sans); }
  .cv svg { position: absolute; inset: 0; width: 960px; height: 288px; }
  .cv .violet { fill: var(--brand-from); }
  .cv .blue { fill: var(--brand-to); }
  .cv .ink { fill: var(--text-primary); }
  .cv .deep { fill: var(--accent-active); }
  .cv .tile { rx: var(--radius-xl); }
  .cv .node { fill: var(--surface-0); }
  .cv .line { stroke: var(--surface-0); stroke-width: 8px; stroke-linecap: round; fill: none; }
  .cv .text { position: absolute; left: var(--space-8); bottom: var(--space-6); max-width: 440px; }
  .cv h1 { margin: 0; font-size: 112px; line-height: 0.95; font-weight: 600; letter-spacing: -0.03em; color: var(--text-primary); }
  .cv p { margin: var(--space-5) 0 0; font-size: 14px; line-height: 20px; color: var(--text-secondary); }
</style>
<div class="cv">
  <!--
    Blocks: brand-from 192x192, brand-to 96x96, accent-active 112x96 (bleeds right), text-primary 224x80 (bleeds right).
    Arrangement: one large slab with three satellites on a space-4 gutter, right of x = 480.
    Pattern: the org chart, the motif of the mark itself (a lead and its reports joined by reporting lines), cut out of the blocks in the ground colour.
    Scales: gutters space-4, insets space-12, corners radius-xl, discs r 12 to 24 on a space-8 pitch.
  -->
  <svg viewBox="0 0 960 288" aria-hidden="true">
    <rect class="violet tile" x="528" y="48" width="192" height="192" />
    <rect class="blue tile" x="736" y="48" width="96" height="96" />
    <rect class="deep tile" x="848" y="48" width="128" height="96" />
    <rect class="ink tile" x="736" y="160" width="240" height="80" />
    <path class="line" d="M624 120 V152 M576 152 H672 M576 152 V176 M672 152 V176" />
    <circle class="node" cx="624" cy="104" r="24" />
    <circle class="node" cx="576" cy="192" r="20" />
    <circle class="node" cx="672" cy="192" r="20" />
    <path class="line" d="M776 200 H936" />
    <circle class="node" cx="776" cy="200" r="12" />
    <circle class="node" cx="808" cy="200" r="12" />
    <circle class="node" cx="840" cy="200" r="12" />
    <circle class="node" cx="872" cy="200" r="12" />
    <circle class="node" cx="904" cy="200" r="12" />
    <circle class="node" cx="936" cy="200" r="12" />
  </svg>
  <div class="text">
    <h1>OrgAI</h1>
    <p>Run a team of agents. See what needs you.</p>
  </div>
</div>
`)
console.log('built', Object.keys(cards).length, 'cards + cover')
