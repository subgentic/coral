// #14719: a decision may expand a legacy review row through the Hub. If that
// Hub still refuses versions=all, the action reports the incomplete settlement.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'cloud' });
const server = await importUi('server_base');
assert.equal(server.isCloud(), true);
const { state } = await importUi('state');
state.hub = true;
state.servers = [{ id: 'm1', owner: true, status: 'online', effective_mode: 'interact', coral_version: '2.0.62' }];

const hex = n => n.toString(16).padStart(64, '0');
const make = (n, at) => ({
    id: hex(n), board_id: 'dev', name: 'Plan.md', produced_by: 'Writer',
    session_id: 'writer-session', available: true, tags: ['for review', 'internal'],
    created_at: at, media_type: 'text/markdown', size: 10,
});
const files = new Map([
    [hex(1), make(1, '2026-11-06T08:00:00Z')],
    [hex(2), make(2, '2026-11-06T09:00:00Z')],
    [hex(3), make(3, '2026-11-06T10:00:00Z')],
    [hex(4), make(4, '2026-11-06T11:00:00Z')],
    [hex(5), make(5, '2026-11-06T12:00:00Z')],
    [hex(6), make(6, '2026-11-06T13:00:00Z')],
]);
let refuseAll = false;
const requests = [], decisions = [];
globalThis.fetch = window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), path = url.pathname, method = options.method || 'GET';
    requests.push({ path, query: url.search, method });
    if (path.endsWith('/api/team-artifacts') && method === 'GET') {
        if (url.searchParams.get('versions') === 'all' && refuseAll) return Response.json({ error: 'path_not_allowed', code: 'path_not_allowed' }, { status: 403 });
        if (url.searchParams.has('digest')) {
            const file = files.get(url.searchParams.get('digest'));
            return Response.json({ artifacts: file && file.tags.includes('for review') ? [file] : [], has_more: false, total: file ? 1 : 0 });
        }
        if (url.searchParams.get('versions') === 'all') {
            return Response.json({ artifacts: [files.get(hex(1)), files.get(hex(2))], has_more: false, total: 2 });
        }
        return Response.json({ artifacts: [], has_more: false, total: 0 });
    }
    const review = path.match(/\/api\/board\/dev\/artifacts\/([a-f0-9]{64})\/review$/);
    if (review && method === 'POST') {
        const file = files.get(review[1]), body = JSON.parse(options.body);
        decisions.push({ id: review[1], decision: body.decision, quiet: body.quiet === true });
        file.tags = body.quiet ? ['internal', 'superseded'] : ['internal', body.decision === 'approve' ? 'approved' : 'denied'];
        return Response.json({ tags: file.tags, delivered: false, reason: 'no_uploader', review: { state: body.decision } });
    }
    return Response.json({});
};

const reviews = await importUi('inbox_reviews');
const actions = await importUi('artifact_review');
const latest = (n, earlier) => ({
    ...files.get(hex(n)), hex: hex(n), team: '@m1/dev', reviewKey: `@m1/dev:${hex(n)}`,
    earlier_versions: 2, earlier_digests: [hex(earlier)],
});

const acceptedRow = latest(3, 2);
const accepted = await actions.approveRow(acceptedRow.team, acceptedRow);
assert.deepEqual(accepted.earlier, { settled: 2, failed: 0 }, 'approval settles both hidden earlier versions');
const legacyRead = requests.find(r => r.path.endsWith('/api/team-artifacts') && new URLSearchParams(r.query).get('versions') === 'all');
assert.ok(legacyRead, 'the Hub receives the legacy expansion query');
const query = new URLSearchParams(legacyRead.query);
assert.equal(legacyRead.path, '/api/remote/m1/api/team-artifacts');
assert.equal(query.get('team'), 'dev');
assert.equal(query.get('tag'), 'for review');
assert.equal(query.get('versions'), 'all');
assert.equal(query.get('q'), 'Plan.md');
assert.equal(query.get('by'), 'Writer');
assert.equal(query.get('limit'), '50');
assert.deepEqual(decisions.slice(0, 3), [
    { id: hex(3), decision: 'approve', quiet: false },
    { id: hex(1), decision: 'ignore', quiet: true },
    { id: hex(2), decision: 'ignore', quiet: true },
]);
assert.ok(!files.get(hex(1)).tags.includes('for review') && !files.get(hex(2)).tags.includes('for review'), 'quiet cleanup keeps older versions out of Needs you');

refuseAll = true;
const refusedRow = latest(6, 5);
const refused = await actions.approveRow(refusedRow.team, refusedRow);
assert.deepEqual(refused.earlier, { settled: 0, failed: 1, reason: "Earlier versions aren't available through Coral Hub." });
assert.ok(files.get(hex(5)).tags.includes('for review'), 'a refused expansion does not mark an earlier version settled');
actions.sayApproved('Plan.md', refused);
assert.ok([...document.querySelectorAll('.toast')].some(t => t.textContent.includes("Earlier versions aren't available through Coral Hub") && t.textContent.includes('remain in Needs you')), 'the refusal is explained to the Operator');
console.log('inbox_review_legacy_versions_hub: approval settles earlier versions through the Hub; refused expansion stays visible with a clear warning');
