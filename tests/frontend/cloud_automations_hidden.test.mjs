// The Hub does not serve Automations (#9368): in cloud mode the top tab, the hamburger and view-list row, the Customize list and the addresses /automations, /jobs and /workflows are all gone, and a local
// server shows them. The tab and its rows are hidden by data-local-only (cloud.css) and the filters in nav_tabs.js and tab_customize.js; the addresses go through cloudRedirect (routes.js) and the route helper in app_routes.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudRedirect, parse, HIDDEN_IN_CLOUD } from '../../coral-go/pkg/frontend/static/routes.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// the addresses: a hub opens the Agents home for every Automations address; a local server is unchanged
for (const url of ['/automations', '/automations/jobs', '/automations/jobs/3', '/automations/workflows/2/runs/5', '/jobs', '/workflows', '/workflows/4']) {
    const route = parse(url);
    assert.ok(route && HIDDEN_IN_CLOUD.includes(route.view), `${url} parses to a hidden view`);
    assert.deepEqual(cloudRedirect(route, true), { view: 'agents' }, `${url} opens the Agents home on the Hub`);
    assert.equal(cloudRedirect(route, false), route, `${url} is unchanged on a local server`);
}
for (const url of ['/agents', '/analytics', '/docs']) { const route = parse(url); assert.equal(cloudRedirect(route, true), route, `${url} is unchanged on the Hub`); }
assert.equal(cloudRedirect(null, true), null);

// the markup and the filters that hide the tab and its rows
assert.match(read('templates/index.html'), /<button[^>]*data-local-only[^>]*id="nav-tab-automations"|<button[^>]*id="nav-tab-automations"[^>]*data-local-only/, 'the Automations tab is data-local-only');
assert.match(read('static/css/cloud.css'), /body\.cloud-mode \[data-local-only\]\s*\{\s*display:\s*none\s*!important/, 'cloud mode hides data-local-only');
assert.match(read('static/nav_tabs.js'), /cloud && el\.hasAttribute\('data-local-only'\)/, 'the hamburger, the phone list and the More menu leave out a local-only tab on the Hub');
assert.match(read('static/tab_customize.js'), /data-local-only'\) && document\.body\.classList\.contains\('cloud-mode'\)/, 'the Customize list leaves it out on the Hub');
assert.match(read('static/app_routes.js'), /cloudRedirect\(\{ view \}, isCloud\(\)\)/, 'the route helper sends a hidden view home on the Hub');
console.log('cloud_automations_hidden: ok (7 addresses redirect on the Hub and stay on a local server; the tab and its rows are hidden by data-local-only)');
