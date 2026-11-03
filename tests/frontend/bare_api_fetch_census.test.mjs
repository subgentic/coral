// Through Coral Hub a bare /api path is the Hub's own: it has no teams, sessions, files or questions (#12612, #12617: operator_asks.js read /api/operator-asks bare and no agent's question reached Needs you; #12581: artifact names). A call on
// data that lives on a computer has to go through serverFetch (or boardFetch) with the server the data is from, which adds /api/remote/<id> for another computer. This census reads every page script for a fetch() whose address is a bare /api path on such data
// and fails on one it does not know: a new call must take its server, or be added to fixtures/bare_api_fetch_baseline.json with the reason it is this computer's alone (a thing the page only shows for this computer, or the Hub's own).
// It fails too on an entry whose call is gone, so the list only gets shorter. CORAL_UPDATE_BARE_FETCH=1 rewrites the counts (the reasons are kept). node bare_api_fetch_census.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const baselinePath = path.join(here, 'fixtures', 'bare_api_fetch_baseline.json');
// The page's own server's: the Hub's account and sign-in, the settings and system routes of the machine the page is served from, the connection to a Hub, the server list, the theme and analytics beacon. Everything else under /api is data a
// computer holds (teams, sessions, files, folders, pins, jobs, workflows, skills, views, token usage), and a call on it has to say which computer: a list of what is NOT a computer's, so a new route is a computer's until it is listed here (#12653: the
// first version listed what was, and pinned-folders was missed).
const OWN = /^\/api\/(account|auth|cloud|health|servers|settings|system(?!\/artifact-store)|themes|tracking|update|webhooks|editions|hub)(\/|\?|$|`|')/;
const COMPUTER = { test: u => !OWN.test(u) };
const call = /(?<![A-Za-z0-9_.$])fetch\(\s*(?:[^\x22'`(),]*\?\s*)?([\x22'`])(\/api\/[^\x22`'\s]*)/g;
// Count a conditional fetch once, at its first literal; the call still needs an explicit computer.
assert.deepEqual([...`fetch("/api/tags"); fetch(edit ? '/api/jobs/1' : '/api/jobs'); fetch(\`/api/notes\`); obj.fetch('/api/no')`.matchAll(call)].map(m => m[2]), ['/api/tags', '/api/jobs/1', '/api/notes']);

const found = {};
(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8').split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n'); // a comment that shows a call is not a call
        for (const m of src.matchAll(call)) if (COMPUTER.test(m[2])) (found[e.name] ||= []).push(m[2].replace(/\$\{[^}]*\}/g, '{}'));
    }
})(root);

const known = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
if (process.env.CORAL_UPDATE_BARE_FETCH) {
    const next = { about: known.about, files: {} };
    for (const [f, urls] of Object.entries(found)) next.files[f] = { count: urls.length, reason: (known.files[f] || {}).reason || 'TODO: why this is this computer\'s alone' };
    fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
    console.log('bare_api_fetch_census: baseline rewritten');
    process.exit(0);
}
const problems = [];
for (const [f, urls] of Object.entries(found)) {
    const k = (known.files || {})[f];
    if (!k) problems.push(`${f}: ${urls.length} bare fetch(es) of computer data not in the baseline (${[...new Set(urls)].join(', ')}): use serverFetch(server, path) with the server the data is from, or add it with the reason it is this computer's alone`);
    else if (urls.length > k.count) problems.push(`${f}: ${urls.length} bare fetches, the baseline allows ${k.count} (${[...new Set(urls)].join(', ')})`);
    else if (urls.length < k.count) problems.push(`${f}: ${urls.length} bare fetches, the baseline says ${k.count}: the call is gone, lower the baseline (CORAL_UPDATE_BARE_FETCH=1)`);
}
for (const f of Object.keys(known.files || {})) if (!found[f]) problems.push(`${f}: in the baseline but has no bare fetch of computer data now: remove the entry`);
for (const [f, k] of Object.entries(known.files || {})) if (!k.reason || /^TODO/.test(k.reason)) problems.push(`${f}: the baseline entry has no reason`);
if (problems.length) { console.error('bare /api fetches of computer data:\n' + problems.map(x => '  ' + x).join('\n')); process.exit(1); }
console.log(`bare_api_fetch_census: ok (${Object.values(found).reduce((n, u) => n + u.length, 0)} deliberate bare calls in ${Object.keys(found).length} files; every other call on computer data takes its server)`);
