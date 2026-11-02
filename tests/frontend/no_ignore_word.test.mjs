// #12514: the operator chose "Dismiss" for the word "Ignore" everywhere a person reads it (#12231, v2.0.36): a row's menu, its toast, a selection bar's button and its name, a dialog. A label, title, aria-label, toast or button text that says "Ignore" in the page's own code is a regression
// (a phone pass read it again in a bar). Scans every page script outside vendor/ for a string literal that starts with the word, outside comments. The internal verb stays (ignoreRow, 'ignore' as a key, data-slot="ignore"): only the visible word is checked. node no_ignore_word.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'vendor') continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(js|html)$/.test(e.name)) files.push(f); } })(root);
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const visible = /(['"`>])Ignore\b/; // a string or markup that opens with the word: 'Ignore', `Ignore ${x}`, >Ignore<
const found = [];
for (const f of files) stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => { if (visible.test(line)) found.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 140)}`); });
if (found.length) { console.error('The word "Ignore" is back in the page (the operator chose "Dismiss", #12231):\n' + found.join('\n')); process.exit(1); }
console.log(`no_ignore_word: ok (${files.length} files)`);
