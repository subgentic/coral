// A pill stays a pill at any text size (#17651, QA's SHOULD on #17620): the age pill, the inbox pill and the skill source tag take --radius-pill, a token far larger than any pill is tall; the 12px --radius-xl they
// were moved to makes a taller pill (large text) a rounded rectangle. The token is defined once, in variables.css.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const css = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static', 'css');
const read = f => fs.readFileSync(path.join(css, f), 'utf8');
const def = /--radius-pill:\s*(\d+)px/.exec(read('variables.css'));
assert.ok(def && Number(def[1]) >= 500, '--radius-pill is defined in variables.css as a very large radius');
for (const [file, sel] of [['inbox_review_groups.css', '.inbox-age'], ['inbox_review_groups.css', '.inbox-pill'], ['skill_mention.css', '.skill-source']]) {
  const rule = read(file).split('\n').find(l => l.startsWith(sel + ' {'));
  assert.ok(rule, `${sel} is in ${file}`);
  assert.match(rule, /border-radius:\s*var\(--radius-pill\)/, `${sel} is a pill: ${rule.slice(0, 120)}`);
}
console.log('PASS pill radius: the age pill, the inbox pill and the skill tag take --radius-pill');
