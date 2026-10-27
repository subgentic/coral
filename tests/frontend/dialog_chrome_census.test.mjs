// Dialog chrome is one thing (#9456, the visual audit's item 8): no dialog has a Close X (Cancel, Close or Done at the foot and Escape close it; five dialogs had an X and sixteen had none), and
// every dialog's title, and every confirm question's, is sentence case ("Delete workflow", not "Delete Workflow"). This reads the templates and the scripts: a Close X (.modal-close-btn) anywhere fails,
// and so does a title whose later words start with a capital unless it is a name (Coral, Hub, Claude, ...).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (d, ext, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, ext, out); else if (p.endsWith(ext)) out.push(p); } return out; };
const NAMES = new Set(['Coral', 'Hub', 'Claude', 'Codex', 'Antigravity', 'Git', 'GitHub', 'Pi', 'Mobile']); // product and provider names
export const problem = title => { const w = title.trim().split(/\s+/); return w.slice(1).find(x => /^[A-Z]/.test(x) && !NAMES.has(x.replace(/[^A-Za-z]/g, ''))); };

assert.equal(problem('Delete workflow'), undefined);
assert.equal(problem('Delete Workflow'), 'Workflow');
assert.equal(problem('Coral Mobile'), undefined);
assert.equal(problem('Sleep Team'), 'Team');

const problems = []; let titles = 0;
for (const f of [...walk(path.join(FE, 'templates'), '.html'), ...walk(path.join(FE, 'static'), '.js')]) {
    const text = fs.readFileSync(f, 'utf8'), rel = path.relative(FE, f);
    if (/\bmodal-close-btn\b/.test(text)) problems.push(`${rel}: a Close X (.modal-close-btn): dialogs close with Cancel, Close or Done and Escape, never an X`);
    if (f.endsWith('.html')) for (const m of text.matchAll(/<h[1-4][^>]*\bid="[^"]*(?:title|heading)[^"]*"[^>]*>([^<{]+)</g)) { if (!/class="modal\b/.test(text.slice(Math.max(0, m.index - 600), m.index))) continue; titles++; const bad = problem(m[1]); if (bad) problems.push(`${rel}: the dialog title "${m[1].trim()}" is not sentence case ("${bad}")`); }
    if (f.endsWith('.js')) for (const m of text.matchAll(/(?:showConfirmModal|confirmWith)\??\.?\(\s*(['"])([^'"]+)\1/g)) { titles++; const bad = problem(m[2]); if (bad) problems.push(`${rel}: the confirm title "${m[2]}" is not sentence case ("${bad}")`); }
}
assert.ok(titles >= 30, `only ${titles} dialog titles found: the scan is broken`);
assert.deepEqual(problems, [], problems.join('\n'));
console.log(`dialog_chrome_census: ok (${titles} dialog and confirm titles are sentence case; no dialog has a Close X)`);
