const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'project'), out = path.join(__dirname, '..', 'preview');
fs.mkdirSync(out, { recursive: true });
const tokens = fs.readFileSync(path.join(dir, 'tokens.css'), 'utf8');
const get = (scope, p) => p.trim().split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
const holes = (s, scope) => s.replace(/\s(on[A-Z]\w+)="\{\{[^}]+\}\}"/g, '').replace(/\{\{([^}]+)\}\}/g, (_, p) => { const v = get(scope, p); return typeof v === 'function' || v == null ? '' : String(v); });
function parse(tpl) {
  const root = { kids: [] }, stack = [root]; let i = 0, m; const re = /<(sc-for|sc-if)\b([^>]*)>|<\/(sc-for|sc-if)>/g;
  while ((m = re.exec(tpl))) {
    stack[stack.length - 1].kids.push(tpl.slice(i, m.index)); i = re.lastIndex;
    if (m[1]) { const n = { tag: m[1], attrs: m[2], kids: [] }; stack[stack.length - 1].kids.push(n); stack.push(n); } else stack.pop();
  }
  root.kids.push(tpl.slice(i)); return root;
}
function run(node, scope) {
  return node.kids.map((k) => {
    if (typeof k === 'string') return holes(k, scope);
    if (k.tag === 'sc-for') { const list = get(scope, /list="\{\{([^}]+)\}\}"/.exec(k.attrs)[1]) || [], as = /as="([^"]+)"/.exec(k.attrs)[1]; return list.map((it) => run(k, Object.assign({}, scope, { [as]: it }))).join(''); }
    return get(scope, /value="\{\{([^}]+)\}\}"/.exec(k.attrs)[1]) ? run(k, scope) : '';
  }).join('');
}
for (const [name, theme, stateJson] of process.argv.slice(2).map((a) => a.split(':'))) {
  const src = fs.readFileSync(path.join(dir, name + '.dc.html'), 'utf8');
  const body = /<x-dc>([\s\S]*)<\/x-dc>/.exec(src)[1];
  const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(body)[1];
  const js = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(src)[1];
  class DCLogic { constructor() { this.state = {}; this.props = { theme: theme || 'dark' }; } setState() {} }
  const C = new Function('DCLogic', js + '\nreturn Component;')(DCLogic);
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + tokens + '</style>' + helmet + '</head><body>' + run(parse(body.replace(/<helmet>[\s\S]*?<\/helmet>/, '')), new C().renderVals()) + '</body></html>';
  fs.writeFileSync(path.join(out, name + (theme ? '-' + theme : '') + '.html'), html); console.log(name, html.length);
}
