// Renders every board to preview/ with an inline measuring script, and prints the list.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = path.join(__dirname, '..', 'project'), out = path.join(__dirname, '..', 'preview');
const j = JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8'));
const only = process.argv.slice(2);
const names = j.order.map((f) => f.replace('.dc.html', '')).filter((n) => !only.length || only.includes(n));
const args = names.map((n) => n === 'RunLight' ? 'Run:light' : n === 'ComponentsLight' ? 'Components:light' : n);
console.log(cp.execFileSync('node', [path.join(__dirname, 'render.cjs'), ...args]).toString().trim().split('\n').length + ' rendered');
const inject = (h) => `<script>
addEventListener('load', () => { setTimeout(() => {
  const r = document.querySelector('[data-theme]'); const Z = 0.3;
  document.querySelectorAll('*').forEach((e) => { e.style.animation = 'none'; });
  r.style.width = '1440px'; r.style.flexWrap = 'nowrap'; r.style.minHeight = '0px';
  const nat = Math.round(r.scrollHeight);
  r.style.minHeight = '${h}px'; r.style.maxHeight = 'none';
  let over = 0; const bad = [];
  r.querySelectorAll('*').forEach((e) => { const b = e.getBoundingClientRect(); if (b.width && (b.right > 1441 || b.left < -1) && !e.closest('.ff-hall')) { over++; if (bad.length < 3) bad.push(e.tagName + ':' + (e.textContent || '').trim().slice(0, 24)); } });
  let clip = 0; r.querySelectorAll('button, span, div').forEach((e) => { if (e.children.length === 0 && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow === 'visible' && getComputedStyle(e).whiteSpace === 'nowrap' && e.clientWidth > 0) clip++; });
  document.body.style.zoom = Z;
  const t = document.createElement('div');
  t.textContent = 'natural ' + nat + ' / board ${h}' + (nat > ${h} ? '  TOO TALL by ' + (nat - ${h}) : '') + ' | off-page ' + over + ' ' + bad.join(' ; ');
  t.style.cssText = 'position:fixed;left:0;bottom:0;z-index:9999;background:#000;color:#0f0;font:700 26px monospace;padding:6px 10px;max-width:1440px';
  document.body.appendChild(t); document.title = t.textContent;
}, 150); });
</script>`;
const list = [];
names.forEach((n, i) => {
  const file = args[i].replace(':', '-') + '.html', p = path.join(out, file);
  const h = j.boards[n + '.dc.html'].h;
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('</body>', inject(h) + '</body>'));
  list.push(file);
});
console.log(list.join(' '));
