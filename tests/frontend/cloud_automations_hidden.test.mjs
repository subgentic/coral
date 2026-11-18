// #19571: Automations addresses remain available in cloud with the approved
// owner-only, metadata-allow-list server prerequisite. Local routing is unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudRedirect, parse, HIDDEN_IN_CLOUD } from '../../coral-go/pkg/frontend/static/routes.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// The approved cloud Automations page keeps its addresses; local routing stays unchanged.
for (const url of ['/automations', '/automations/jobs', '/automations/jobs/3', '/automations/workflows/2/runs/5', '/jobs', '/workflows', '/workflows/4']) {
    const route = parse(url);
    assert.ok(route && !HIDDEN_IN_CLOUD.includes(route.view), `${url} is available with the approved Hub server prerequisite`);
    assert.equal(cloudRedirect(route, true), route, `${url} stays on Automations through the Hub`);
    assert.equal(cloudRedirect(route, false), route, `${url} is unchanged on a local server`);
}
for (const url of ['/agents', '/analytics', '/docs']) { const route = parse(url); assert.equal(cloudRedirect(route, true), route, `${url} is unchanged on the Hub`); }
assert.equal(cloudRedirect(null, true), null);

// Automations is visible; unrelated local-only navigation remains hidden.
assert.doesNotMatch(read('templates/index.html').match(/<button[^>]*id="nav-tab-automations"[^>]*>/)?.[0] || '', /data-local-only/, 'Automations is available in cloud');
assert.match(read('static/css/cloud.css'), /body\.cloud-mode \[data-local-only\]\s*\{\s*display:\s*none\s*!important/, 'cloud mode hides data-local-only');
assert.match(read('static/nav_tabs.js'), /cloud && el\.hasAttribute\('data-local-only'\)/, 'the hamburger, the phone list and the More menu leave out a local-only tab on the Hub');
assert.match(read('static/tab_customize.js'), /data-local-only'\) && document\.body\.classList\.contains\('cloud-mode'\)/, 'the Customize list leaves it out on the Hub');
assert.match(read('static/app_routes.js'), /cloudRedirect\(\{ view \}, isCloud\(\)\)/, 'the route helper sends a hidden view home on the Hub');
console.log('cloud_automations_hidden: ok (7 addresses available with the approved server prerequisite; unrelated local-only navigation remains hidden)');
