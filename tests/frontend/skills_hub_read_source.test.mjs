// #19627 (the Skills page through the Hub, coral-hub's Operator yes): on a Hub's page the Skills tab is shown (not hidden, not local-only), reads ONE chosen computer's list and skill through serverFetch, and
// draws no Import, Approve, Reject, Remove or Use in a team. Source reading: the page's text is what carries these rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importUi, installDom } from './helpers/jsdom_env.mjs';
installDom({ mode: 'cloud' });
const R = await importUi('routes');
assert.ok(!R.HIDDEN_IN_CLOUD.includes('skills'), 'Skills is not a hidden view in a Hub page');
assert.deepEqual(R.cloudRedirect({ view: 'skills' }, true), { view: 'skills' }, 'a /skills address stays on Skills in a Hub page');
assert.deepEqual(R.HIDDEN_IN_CLOUD, [], 'nothing is hidden in a Hub page: Skills was the last view the Hub did not serve');

const root = new URL('../../coral-go/pkg/frontend/', import.meta.url);
const html = readFileSync(new URL('templates/index.html', root), 'utf8');
assert.ok(/<button[^>]*id="nav-tab-skills"/.test(html), 'the nav tab exists');
assert.ok(!/<button[^>]*data-local-only[^>]*id="nav-tab-skills"/.test(html), 'the Skills nav tab is not local-only');

const src = readFileSync(new URL('static/skills_tab.js', root), 'utf8');
assert.match(src, /serverFetch\(id, path\)/, 'a Hub page reads through the chosen computer');
assert.match(src, /readJson\('\/api\/skills'\)/, 'the list is read through readJson');
assert.match(src, /readJson\(`\/api\/skills\/\$\{encodeURIComponent\(id\)\}`\)/, 'a skill is read through readJson');
// every write stays a requestJson call guarded away from a Hub page: none of the POST/DELETE calls is through readJson or serverFetch
for (const m of src.matchAll(/requestJson\('(POST|DELETE)'/g)) assert.ok(m[1], 'writes are requestJson');
assert.ok(!/serverFetch\([^)]*method/.test(src), 'no write goes through the Hub');
assert.match(src, /\.\.\.\(cloud\(\) \? \[\] : \[importBtn, input\]\)/, 'no Import control in a Hub page');
assert.match(src, /s\.status === 'approved' && !cloud\(\)/, 'no Use in a team in a Hub page');
assert.match(src, /s\.status === 'pending' && !cloud\(\)/, 'no approval banner in a Hub page');
assert.match(src, /return page; \/\/ no scanner lines, no approve, no remove/, 'a Hub page returns before the scanner, approve and remove sections');
console.log('skills_hub_read_source: ok');
