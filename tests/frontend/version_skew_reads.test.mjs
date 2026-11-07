// #14317: a v2.0.59 shell on a v2.0.58 computer behind a Hub. The computer's connector refuses a query key its release does not list, and the Hub hands that to the shell as 403 {code: 'path_not_allowed'}
// (pkg/hubproxy/handler.go). Each read that sends a newer key is asked again once without it, the computer is remembered (its next reads cost one call), and a 403 that is anything else keeps its meaning.
// The stubbed computer is v2.0.58's own table: GET /api/team-artifacts lists board,by,cursor,goal,kept,kind,limit,offset,origin,q,read,since,sort,starred,tag,task,team,until,versions=newest; the versions route lists nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' }), hex = n => n.toString(16).padStart(64, '0');
const OLD_LIST = new Set('board,by,cursor,goal,kept,kind,limit,offset,origin,q,read,since,sort,starred,tag,task,team,until,versions'.split(','));
const art = (n, over = {}) => ({ id: hex(n), board_id: 'dev', name: 'Plan ' + n + '.md', produced_by: 'Writer', session_id: 'w', available: true, tags: ['for review'], created_at: '2026-11-06T10:00:00Z', uri: 'coral://artifacts/' + hex(n), goal_id: 7, ...over });
let hideServer = false; // some Hub routes answer the refusal with no server member (HideServerID): the fallback keys on the code only
const refusal = server => Response.json({ error: 'path not allowed', code: 'path_not_allowed', ...(hideServer ? {} : { server }) }, { status: 403 });
let calls = [], mode = 'old', rows = [art(1), art(2), art(3)];
globalThis.fetch = window.fetch = async input => {
    const u = new URL(String(input), location.href); calls.push(u);
    const m = /^\/api\/remote\/([^/]+)(\/.*)$/.exec(u.pathname), server = m ? m[1] : 'local', path = m ? m[2] : u.pathname;
    if (mode === 'owner') return Response.json({ code: 'owner_only', error: 'owner_only' }, { status: 403 });
    if (mode === 'localmode') return Response.json({ error: 'local_mode', mode: 'view' }, { status: 403 });
    if (path === '/api/team-artifacts') {
        if (server.startsWith('old') || mode === 'old') for (const k of u.searchParams.keys()) if (!OLD_LIST.has(k)) return refusal(server);
        const want = u.searchParams.get('digest');
        const list = want ? rows.filter(a => want.split(',').includes(a.id)) : rows;
        return Response.json({ artifacts: list, total: list.length, has_more: false, teams: [] });
    }
    if (/^\/api\/artifacts\/[0-9a-f]{64}\/versions$/.test(path)) { if (u.search && server === 'old') return refusal(server); return Response.json([{ version: 1, digest: hex(1) }, { version: 2, digest: hex(2) }]); }
    return Response.json({});
};
const skew = await importUi('query_skew'), reviews = await importUi('inbox_reviews');
const reset = () => { calls = []; skew._resetForTests(); mode = 'old'; hideServer = false; rows = [art(1), art(2), art(3)]; };
const keysOf = u => [...u.searchParams.keys()].sort().join(',');

test('a refused newer key is asked again once without it, and the computer is remembered', async () => {
    reset();
    const q = new URLSearchParams({ tag: 'for review', versions: 'newest', starred_first: 'true', facets: 'team,by,goal', limit: '50' });
    const a = await skew.fetchSkewed('old', '/api/team-artifacts', q);
    assert.equal(a.response.status, 200);
    assert.deepEqual(a.dropped.sort(), ['facets', 'starred_first']);
    assert.equal(calls.length, 2, 'one refused call, one plain');
    assert.equal(keysOf(calls[1]), 'limit,tag,versions', 'the retry carries only keys the older table lists');
    calls = [];
    const b = await skew.fetchSkewed('old', '/api/team-artifacts', q);
    assert.equal(b.response.status, 200); assert.equal(calls.length, 1, 'the next read is sent plain at once: one call, not two'); assert.equal(keysOf(calls[0]), 'limit,tag,versions');
    calls = [];
    mode = 'new'; // a different computer that accepts the keys is sent them whole
    const c = await skew.fetchSkewed('new', '/api/team-artifacts', q);
    assert.equal(c.response.status, 200); assert.deepEqual(c.dropped, []); assert.equal(calls.length, 1); assert.ok(calls[0].searchParams.has('starred_first') && calls[0].searchParams.has('facets'));
});

test('only the connector refusal is retried: owner_only, local_mode and a request with no newer key keep their meaning', async () => {
    reset(); mode = 'owner';
    let r = await skew.fetchSkewed('old', '/api/team-artifacts', new URLSearchParams({ starred_first: 'true' }));
    assert.equal(r.response.status, 403); assert.equal(calls.length, 1, 'owner_only is not asked again'); assert.equal(skew.knownOlder('old', '/api/team-artifacts'), false, 'and the computer is not marked older');
    reset(); mode = 'localmode'; r = await skew.fetchSkewed('old', '/api/team-artifacts', new URLSearchParams({ waiting: '1' }));
    assert.equal(r.response.status, 403); assert.equal(calls.length, 1);
    reset(); r = await skew.fetchSkewed('old', '/api/team-artifacts', new URLSearchParams({ nonsense: '1' }));
    assert.equal(r.response.status, 403); assert.equal(calls.length, 1, 'a key that is not one of the newer ones is never dropped');
});

test('a computer that was refused is asked with the keys again after ten minutes', async () => {
    reset(); await skew.fetchSkewed('old', '/api/team-artifacts', new URLSearchParams({ facets: 'team' }));
    assert.equal(skew.knownOlder('old', '/api/team-artifacts'), true);
    assert.equal(skew.knownOlder('old', '/api/team-artifacts', Date.now() + 9 * 60 * 1000), true);
    assert.equal(skew.knownOlder('old', '/api/team-artifacts', Date.now() + 11 * 60 * 1000), false);
});

test('the per-team review read (Needs you) shows the files from a v2.0.58 computer, not an empty list', async () => {
    reset(); rows = [art(1), art(2)];
    const found = await reviews.reviewsOfGoal('@old/dev', 7);
    assert.deepEqual(found.map(a => a.hex).sort(), [hex(1), hex(2)].sort());
    assert.ok(calls.some(u => u.searchParams.has('starred_first')), 'the whole read was tried first');
    assert.ok(!calls.at(-1).searchParams.has('starred_first'), 'the one that answered was plain');
});

test('an owner-only computer still ends the read quietly, but another 403 is an error', async () => {
    reset(); mode = 'owner';
    assert.deepEqual(await reviews.reviewsOfGoal('@old/dev', 7), [], 'owner_only: no rows, as before');
    reset(); mode = 'localmode';
    await assert.rejects(reviews.reviewsOfGoal('@old/dev', 7), /Could not read review artifacts/, 'a refusal that is not owner_only is no longer an empty list');
});

test('a digest read on a v2.0.58 computer keeps only the files asked for', async () => {
    reset(); rows = [art(1), art(2), art(3)];
    const one = await reviews.reviewOfTeam('@old/dev', hex(2));
    assert.equal(one.hex, hex(2));
    assert.ok(calls.length >= 2 && !calls.at(-1).searchParams.has('digest'), 'the plain list answered');
});

test('the version bar read drops ?board= on a computer whose versions route takes no query', async () => {
    reset();
    const a = await skew.fetchSkewed('old', `/api/artifacts/${hex(1)}/versions`, { board: 'dev' }, { kind: 'versions', keys: skew.VERSIONS_KEYS });
    assert.equal(a.response.status, 200); assert.deepEqual(a.dropped, ['board']); assert.equal(calls.at(-1).search, '', 'the retry has no query');
    calls = [];
    const b = await skew.fetchSkewed('old', `/api/artifacts/${hex(1)}/versions`, { board: 'dev' }, { kind: 'versions', keys: skew.VERSIONS_KEYS });
    assert.equal(b.response.status, 200); assert.equal(calls.length, 1, 'remembered: one call');
});
test('the filtered Needs you view lists a v2.0.58 computer, and its attention count is blank, never the plain total', async () => {
    reset(); rows = [art(1), art(2), art(3)];
    const { state } = await importUi('state'); state.hub = true; state.servers = [{ id: 'old', label: 'Old box', status: 'online' }];
    const f = { q: 'plan', server: 'old' }; // the one computer on the older release
    await reviews.queryReviews(f);
    const shown = reviews.queriedReviews(f);
    assert.deepEqual((shown || []).map(a => a.hex).sort(), [hex(1), hex(2), hex(3)].sort(), 'the three files are listed');
    const st = reviews.reviewQueryState();
    assert.equal(st.error, '', 'no "could not be asked"');
    assert.equal(st.attentionTotal, null, 'the computer cannot count what waits: no number, not the plain total of 3');
    const NEW = ['digest', 'facets', 'muted', 'starred_first', 'waiting'], newer = calls.filter(u => u.pathname.startsWith('/api/remote/old/') && NEW.some(k => u.searchParams.has(k)));
    assert.equal(newer.length, 1, 'the older computer is sent the newer keys once (the first read); the count read after it, and every later one, are plain');
    state.hub = false; state.servers = [];
});
test('the refusal with no server member is retried the same way (keyed on the code only)', async () => {
    reset(); hideServer = true;
    const r = await skew.fetchSkewed('old', '/api/team-artifacts', new URLSearchParams({ starred_first: 'true', tag: 'for review' }));
    assert.equal(r.response.status, 200); assert.deepEqual(r.dropped, ['starred_first']); assert.equal(calls.length, 2);
    reset(); hideServer = true; rows = [art(1), art(2)];
    assert.equal((await reviews.reviewsOfGoal('@old/dev', 7)).length, 2, 'the per-team review read lists the files');
});

test('needs_skills: a computer below v2.0.58 refuses the skills read, which clears its rows and shows the note (pinned, with the no-server body)', async () => {
    reset(); hideServer = true;
    const skills = await importUi('needs_skills'), gaps = await importUi('needs_incomplete');
    const urlOf = (path, server) => `/api/remote/${server}${path}`;
    const keep = globalThis.fetch; // put back below: the tests after this one use the shared stub
    globalThis.fetch = window.fetch = async input => {
        const u = new URL(String(input), location.href); calls.push(u);
        if (u.pathname === '/api/remote/old/api/needs-you') return refusal('old');
        return Response.json({});
    };
    try { await skills.loadPendingSkills({ hub: true, sources: ['old'], urlOf }); } finally { globalThis.fetch = window.fetch = keep; }
    assert.deepEqual(skills.skillRows(), [], 'no rows are drawn from that computer');
    assert.deepEqual(gaps.readGaps().filter(g => g.kind === 'skills').map(g => g.source), ['old'], 'the Inbox is told it could not read them');
    assert.match(gaps.incompleteNote(), /skills from old could not be read/);
});
test('the Inbox badge count: a v2.0.58 computer has no number (never the plain total), is asked once, and a later refresh does not ask it again', async () => {
    reset(); mode = 'new';
    const { state } = await importUi('state'); state.hub = true; state.servers = [{ id: 'old2', label: 'Second old box', status: 'online' }]; // its own computer: reads left over from the tests above go to 'old'
    const counts = await importUi('review_counts');
    await counts.refreshCounts(true);
    assert.equal(counts.countSummary().sources.find(r => r.server === 'old2').total, null, 'that computer cannot count what waits');
    assert.equal(counts.countedUnread(), null, 'one computer is unknown, so the badge states no number');
    const settle = () => new Promise(r => setTimeout(r, 50)), countReads = () => calls.filter(u => u.pathname.startsWith('/api/remote/old2/') && u.searchParams.has('waiting'));
    await settle(); assert.equal(countReads().length, 1, 'one count read, refused');
    await counts.refreshCounts(true); await settle();
    assert.equal(countReads().length, 1, 'a refresh does not ask it again while it is known to refuse');
    state.hub = false; state.servers = [];
});
test.after(() => dom.window.close());
