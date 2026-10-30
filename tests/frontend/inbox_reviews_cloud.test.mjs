// #11354: through Coral Hub the owner's Inbox reads the For-review rows (it returned early under isCloud() until then), and a non-owner (a guest or a grantee: the machine answers 403 owner_only on the team's
// artifact list) sees no rows and no error. Run: node inbox_reviews_cloud.test.mjs
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'cloud' });
const server = await importUi('server_base');
assert.equal(server.isCloud(), true, 'the page is the Hub-served one');
const { state } = await importUi('state');
state.hub = true; state.servers = [{ id: 'srv1', status: 'online' }]; // through the Hub the boards are the machines' (fetchProjects reads each online server's list)
const M = await importUi('inbox_reviews');

let asOwner = true, reads = [];
const row = i => ({ id: i.toString(16).padStart(64, '0'), name: `File ${i}`, session_id: 'writer', produced_by: 'Writer', tags: ['for review'], available: true, created_at: '2026-10-30T10:00:00Z' });
globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'https://hub.example/');
    reads.push(u.pathname + u.search);
    if (u.pathname.endsWith('/api/board/projects') || u.pathname === '/api/board/projects') return Response.json([{ project: 'a' }]);
    if (u.pathname.endsWith('/artifacts')) {
        if (!asOwner) return Response.json({ code: 'owner_only', error: 'through Coral Hub only the account this computer is linked to can read artifacts' }, { status: 403 });
        assert.equal(u.searchParams.get('tag'), 'for review');
        return Response.json({ artifacts: [row(1), row(2)], has_more: false });
    }
    return Response.json({}, { status: 404 });
};

await M.refreshReviews(true);
assert.ok(reads.some(p => p.includes('/artifacts')), 'the Inbox read the team\'s artifacts under isCloud(): ' + reads.join(', '));
assert.equal(M.reviewItems().length, 2, 'the owner gets the For-review rows through the Hub');
assert.equal(M.reviewErrors().length, 0);

asOwner = false; reads = [];
await M.refreshReviews(true);
assert.equal(M.reviewItems().length, 0, 'a guest or grantee is refused by the machine: no rows');
assert.equal(M.reviewErrors().length, 0, 'and no error is shown for it');
console.log('inbox_reviews_cloud: ok');
