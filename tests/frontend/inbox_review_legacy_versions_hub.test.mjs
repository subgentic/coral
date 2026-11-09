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
    [hex(7), make(7, '2026-11-06T14:00:00Z')],
    [hex(8), make(8, '2026-11-06T15:00:00Z')],
    [hex(9), make(9, '2026-11-06T16:00:00Z')],
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
assert.equal(legacyRead.query, '?team=dev&tag=for+review&versions=all&q=Plan.md&by=Writer&limit=50', 'the captured tunnel request is team-scoped and has only the supported query keys');
assert.deepEqual(decisions.slice(0, 3), [
    { id: hex(3), decision: 'approve', quiet: false },
    { id: hex(1), decision: 'ignore', quiet: true },
    { id: hex(2), decision: 'ignore', quiet: true },
]);
assert.ok(!files.get(hex(1)).tags.includes('for review') && !files.get(hex(2)).tags.includes('for review'), 'quiet cleanup keeps older versions out of Needs you');

const unknownUploader = { ...latest(3, 2), produced_by: '' };
await reviews.legacyEarlierVersions(unknownUploader);
const unknownByRead = requests.at(-1);
assert.equal(new URLSearchParams(unknownByRead.query).has('by'), false, 'unknown uploader omits by= rather than sending an empty value');

const longName = 'é'.repeat(101); // 202 UTF-8 bytes, but only 101 JavaScript characters.
const longReadStart = requests.length;
const longOut = await actions.approveRow('@m1/dev', { ...latest(8, 7), name: longName });
assert.deepEqual(longOut.earlier, { settled: 0, failed: 1, reason: 'The file name exceeds Coral Hub’s 200-byte search limit; earlier versions could not be checked.' });
assert.equal(requests.slice(longReadStart).some(r => new URLSearchParams(r.query).get('versions') === 'all'), false, 'an over-limit filename is never truncated or queried');
assert.ok(files.get(hex(7)).tags.includes('for review'), 'an over-limit name does not mark any earlier version settled');
actions.sayApproved(longName, longOut);
assert.ok([...document.querySelectorAll('.toast')].some(t => t.textContent.includes('200-byte search limit') && t.textContent.includes('may remain in Needs you')), 'the successful approval still explains the incomplete earlier-version settlement');

for (const [label, changes] of [
    ['q control', { name: 'Plan\u0001.md' }],
    ['q Unicode space', { name: 'Plan\u00a0.md' }],
    ['q Unicode line separator', { name: 'Plan\u2028.md' }],
    ['by control', { produced_by: 'Writer\u0001' }],
    ['by Unicode space', { produced_by: 'Writer\u00a0' }],
    ['by comma', { produced_by: 'Writer, QA' }],
    ['team comma', { team: '@m1/dev,qa' }],
]) {
    const before = requests.length;
    await assert.rejects(reviews.legacyEarlierVersions({ ...latest(3, 2), ...changes }), /cannot safely search/ , label);
    assert.equal(requests.length, before, label + ' is refused before any possibly split or partial read');
}

refuseAll = true;
const refusedRow = latest(6, 5);
const refused = await actions.approveRow(refusedRow.team, refusedRow);
assert.deepEqual(refused.earlier, { settled: 0, failed: 1, reason: "Earlier versions aren't available through Coral Hub." });
assert.ok(decisions.some(d => d.id === hex(6) && d.decision === 'approve'), 'a refused lookup does not block the approved current version');
assert.ok(files.get(hex(5)).tags.includes('for review'), 'a refused expansion does not mark an earlier version settled');
actions.sayApproved('Plan.md', refused);
assert.ok([...document.querySelectorAll('.toast')].some(t => t.textContent.includes("Earlier versions aren't available through Coral Hub") && t.textContent.includes('remain in Needs you')), 'the refusal is explained to the Operator');

const deniedRow = latest(9, 7);
const denied = await actions.denyRow(deniedRow.team, deniedRow, 'Needs changes');
assert.deepEqual(denied.earlier, { settled: 0, failed: 1, reason: "Earlier versions aren't available through Coral Hub." });
assert.ok(decisions.some(d => d.id === hex(9) && d.decision === 'deny'), 'a refused lookup does not block the denied current version');
assert.ok(files.get(hex(7)).tags.includes('for review'), 'denying after a refused lookup leaves earlier versions tagged');
actions.sayDenied('Plan.md', denied);
assert.ok([...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Denied Plan.md') && t.textContent.includes('may remain in Needs you')), 'deny says it succeeded and clearly warns that earlier versions may remain');
console.log('inbox_review_legacy_versions_hub: approval settles earlier versions through the Hub; refused expansion stays visible with a clear warning');
