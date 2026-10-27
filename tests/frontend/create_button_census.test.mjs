// Create buttons are named one way (#9456, the visual audit's item 16): the verb and the thing, "New agent", "New task", "New goal", "New job", "Add member", with no plus sign in front (the sidebar said
// "+ New agent", the Tasks bar "+ Task", the phone list "+ New", the team page "+ Add member"). A phone that drops the label draws a "+" icon with an aria-label, not a plus in the words. This reads the templates
// and the scripts: a button whose words start with "+ " fails unless it is one of the inline adders below, which sit inside a list or a field and are not a page's create action.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (d, ext, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, ext, out); else if (p.endsWith(ext)) out.push(p); } return out; };
export const ALLOW = new Map([
    ['+ Tag', 'adds a tag to the file or the session in front of it: an adder inside the chips, not a page\'s create action'],
    ['+ Add dependency', 'opens the dependency list inside the task dialog: an adder inside a form'],
]);
const LABEL = [/<button\b[^>]*>\s*(\+ [A-Za-z][^<{]*?)\s*</g, /textContent\s*=\s*(['"`])(\+ [A-Za-z][^'"`]*)\1/g, /\bmk\(\s*'button'\s*,\s*'[^']*'\s*,\s*(['"])(\+ [A-Za-z][^'"]*)\1/g];
export const labels = text => { const out = []; for (const re of LABEL) for (const m of text.matchAll(re)) out.push((m[2] || m[1]).trim()); return out; };

assert.deepEqual(labels('<button class="btn">+ New agent</button>'), ['+ New agent']);
assert.deepEqual(labels("b.textContent = '+ Task';"), ['+ Task']);
assert.deepEqual(labels("mk('button', 'artifact-tag-add', '+ Tag')"), ['+ Tag']);
assert.deepEqual(labels('<button>New agent</button> <button><span>+</span> Add</button>'), []);

const problems = []; let seen = 0;
for (const f of [...walk(path.join(FE, 'templates'), '.html'), ...walk(path.join(FE, 'static'), '.js')]) {
    for (const l of labels(fs.readFileSync(f, 'utf8'))) { seen++; if (!ALLOW.has(l)) problems.push(`${path.relative(FE, f)}: the button "${l}" starts with a plus sign: name it "${l.replace(/^\+ /, 'New ')}" or the verb and the thing, with no plus`); }
}
assert.ok(seen >= 3, `the scan saw only ${seen} plus labels: it is broken (the inline adders are three)`);
assert.deepEqual(problems, [], problems.join('\n'));
console.log(`create_button_census: ok (${seen} plus-sign adders, all inline and listed; every create button is the verb and the thing)`);
