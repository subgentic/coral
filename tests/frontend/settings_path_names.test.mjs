// Every "Settings > X" a person reads in the product names a real Settings section (#15986): the nav's section titles
// are the truth (data-title in modals.html), so a renamed section cannot leave a sentence pointing at the old one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend');
const modals = fs.readFileSync(path.join(root, 'templates/includes/modals.html'), 'utf8');
const real = new Set([...modals.matchAll(/id="settings-pane-[a-z-]+"[^>]*data-title="([^"]*)"/g)].map(m => m[1]));
if (real.size < 8) { console.error('FAIL: found only ' + real.size + ' section titles'); process.exit(1); }
const files = [];
for (const d of ['static', 'templates']) (function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else if (/\.(js|html)$/.test(e.name)) files.push(f); } })(path.join(root, d));
const SEP = '(?:>|&gt;|›|,)';
const bad = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' ')).split('\n');
  text.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    const code = line.replace(/\s\/\/\s.*$/, '');
    for (const m of code.matchAll(new RegExp('\\bSettings\\s*' + SEP + '\\s*([A-Z].{0,40})', 'g'))) {
      const hit = [...real].find(t => m[1].startsWith(t));  // Camera is iOS's own Settings app (image_attach.js)
      if (!hit && !m[1].startsWith('Camera')) bad.push(`${path.relative(root, f)}:${i + 1}: Settings > ${m[1]}`);
    }
  });
}
if (bad.length) { console.error('FAIL: a Settings path names no section (real: ' + [...real].join(', ') + ')\n' + bad.join('\n')); process.exit(1); }
console.log('PASS settings_path_names: ' + real.size + ' sections, ' + files.length + ' files');
