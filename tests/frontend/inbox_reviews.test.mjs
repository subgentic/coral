// #8628: the Inbox review data source pages, groups producers, and cannot resurrect a review from a stale read (an approved one, #136584).
import assert from 'node:assert/strict';
const M = await import('../../coral-go/pkg/frontend/static/inbox_reviews.js');
const row = (i, team = 'a', session = 'writer') => ({ id: i.toString(16).padStart(64, '0'), name: `File ${i}`, team, session_id: session, produced_by: session, tags: ['for review', 'internal'], available: true, created_at: '2026-10-26T10:00:00Z' });
const groups = M.reviewGroups([...Array.from({length:11},(_,i)=>row(i)),row(20,'b'),row(21,'@remote/a')]);
assert.equal(groups.length,2,'same session on another server is a separate producer');
assert.equal(groups[0].rows.length,10); assert.equal(groups[0].more.length,2,'same agent across teams shares its cap');
assert.equal(groups[1].rows.length,1);
let artifacts = Array.from({length:201},(_,i)=>row(i+1)), writes = [], fail = false, failRead = false;
let release, entered, slow = false, reads = 0;
const started = new Promise(resolve => { entered = resolve; });
globalThis.fetch = async (url, options = {}) => {
    reads++;
    const u = new URL(url, 'http://localhost');
    if(u.pathname==='/api/board/projects')return Response.json([{project:'a'}]);
    if(u.pathname.endsWith('/tags')) {
        if(fail)return Response.json({error:'Try again'}, {status:500});
        const body=JSON.parse(options.body); writes.push(body);
        artifacts=artifacts.filter(a=>a.id!==u.pathname.split('/').at(-2));
        return Response.json(body);
    }
    assert.equal(u.searchParams.get('tag'),'for review');
    if(failRead)return Response.json({}, {status:503});
    const offset=Number(u.searchParams.get('offset')), snapshot={artifacts:artifacts.slice(offset,offset+200),has_more:offset+200<artifacts.length};
    if(slow){slow=false; await new Promise(resolve=>{release=resolve; entered();});}
    return Response.json(snapshot);
};
await M.refreshReviews();
assert.equal(reads,0,'badge updates before opening Inbox must not read projects or artifacts');
await M.refreshReviews(true);
assert.ok(reads>0,'opening Inbox starts review reads');
assert.equal(M.reviewItems().length,201,'reads beyond the first page');
const first=M.reviewItems()[0];
slow=true;
const pending=M.refreshReviews(true);
// Yield the fixture request microtasks, rather than timing the network.
await started;
M.settleReview(first); // the Operator approved it (artifact_review.js approveRow)
release(); await pending;
assert.equal(M.reviewItems().length,200,'an older list cannot resurrect an approved item');
failRead=true; await M.refreshReviews(true);
assert.equal(M.reviewItems().length,200,'failed refresh retains last known rows');
assert.equal(M.reviewErrors().length,1);
failRead=false; artifacts=[]; await M.refreshReviews(true);
assert.equal(M.reviewItems().length,0,'deletion removes rows at next refresh');
console.log('inbox_reviews: ok');

// A discarded scan must not certify its unapplied payload as fresh (#13293).
let token = 100, rows = [row(301)], hold = false, resolveList, sawList;
let heldList = new Promise(resolve => { sawList = resolve; });
globalThis.fetch = async url => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/api/board/projects') return Response.json([{ project: 'a' }]);
    if (u.pathname.endsWith('/status')) return Response.json({ artifacts_rev: token });
    const data = { artifacts: u.searchParams.get('tag') === 'saved' ? [] : rows.slice(), has_more: false, artifacts_rev: token };
    if (hold && u.searchParams.get('tag') !== 'saved') {
        hold = false; sawList(); await new Promise(resolve => { resolveList = resolve; });
    }
    return Response.json(data);
};
await M.refreshReviews(true);
rows.push(row(302)); token++; hold = true;
const discarded = M.refreshReviews(true);
await heldList;
M.settleReview(M.reviewItems()[0]);
resolveList(); await discarded;
assert.ok(!M.reviewItems().some(a => a.id === row(302).id), 'the superseded scan was discarded');
const realNow = Date.now;
Date.now = () => realNow() + 31000;
try { await M.refreshReviews(); } finally { Date.now = realNow; }
assert.ok(M.reviewItems().some(a => a.id === row(302).id), 'a discarded scan cannot suppress the next background read of unapplied rows');
console.log('inbox_reviews: discarded revision is not cached');

// #13293 rebase onto #13304: a source arriving during a revision-triggered
// scan needs one complete rescan, with no lost source or duplicate queued scan.
const { state } = await import('../../coral-go/pkg/frontend/static/state.js');
const feed = await import('../../coral-go/pkg/frontend/static/artifacts_feed.js');
state.hub = true; state.serversKnown = true;
state.servers = [{ id: 'box-1', status: 'online' }];
let projectScans = 0, unblock, inList;
const listStarted = new Promise(resolve => { inList = resolve; });
let pauseFirst = true;
globalThis.fetch = async url => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/api/board/projects') { projectScans++; return Response.json([]); }
    if (u.pathname.endsWith('/projects')) return Response.json([{ project: 'alpha' }]);
    if (u.pathname.endsWith('/status')) return Response.json({ artifacts_rev: 201 });
    const remote = u.pathname.includes('/box-2/') ? 2 : 1;
    if (pauseFirst && remote === 1 && u.searchParams.get('tag') === 'for review') {
        pauseFirst = false; inList(); await new Promise(resolve => { unblock = resolve; });
    }
    return Response.json({ artifacts_rev: 201, has_more: false, artifacts: u.searchParams.get('tag') === 'saved' ? [] : [row(400 + remote)] });
};
const withLateSource = M.refreshReviews(true);
await listStarted;
state.servers.push({ id: 'box-2', status: 'online' });
feed.publishArtifactsRev({ '@box-1/alpha': 201 });
unblock(); await withLateSource;
for (let i = 0; i < 100 && !M.reviewItems().some(a => a.id === row(402).id); i++) await new Promise(setImmediate);
assert.ok(M.reviewItems().some(a => a.id === row(401).id), 'the original source stays');
assert.ok(M.reviewItems().some(a => a.id === row(402).id), 'the source arriving during the scan is included');
await new Promise(setImmediate);
assert.equal(projectScans, 2, 'the source change and queued revision share exactly one rescan');
console.log('inbox_reviews: late source and pending revision coalesce');
