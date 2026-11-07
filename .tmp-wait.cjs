const { execFileSync } = require('child_process')
const start = Date.now()
function merged() {
  try { execFileSync('git', ['merge-base', '--is-ancestor', '013b748f', 'HEAD'], { stdio: 'ignore' }); return true } catch { return false }
}
function moved() {
  try { return !execFileSync('git', ['rev-parse', '--short', 'worktree-agent-a4ddf598ece542f00'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().startsWith('013b748f') } catch { return true }
}
function tick() {
  const m = merged(), v = moved()
  if (m || v || Date.now() - start > 560000) { console.log('merged=' + m + ' branchMoved=' + v); return }
  setTimeout(tick, 15000)
}
tick()
