// #8628: the Inbox review data source pages, groups producers, preserves tags,
// keeps failed writes visible, and cannot resurrect a review from a stale read.
import assert from 'node:assert/strict';
const M = await import('../../coral-go/pkg/frontend/static/inbox_reviews.js');
const row = (i, team = 'a', session = 'writer') => ({ id: i.toString(16).padStart(64, '0'), name: `File ${i}`, team, session_id: session, produced_by: session, tags: ['for review', 'internal'], available: true, created_at: '2026-10-26T10:00:00Z' });
const groups = M.reviewGroups([...Array.from({length:11},(_,i)=>row(i)),row(20,'b'),row(21,'@remote/a')]);
assert.equal(groups.length,2,'same session on another server is a separate producer');
assert.equal(groups[0].rows.length,10); assert.equal(groups[0].more.length,2,'same agent across teams shares its cap');
assert.equal(groups[1].rows.length,1);
let artifacts = Array.from({length:201},(_,i)=>row(i+1)), writes = [], fail = false, failRead = false;
let release, entered, slow = false;
const started = new Promise(resolve => { entered = resolve; });
globalThis.fetch = async (url, options = {}) => {
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
await M.refreshReviews(true);
assert.equal(M.reviewItems().length,201,'reads beyond the first page');
const first=M.reviewItems()[0];
fail=true;
await assert.rejects(()=>M.markReviewed(first),/Try again/);
assert.equal(M.reviewItems().length,201,'failed save retains row');
fail=false;
slow=true;
const pending=M.refreshReviews(true);
// Yield the fixture request microtasks, rather than timing the network.
await started;
await M.markReviewed(first);
release(); await pending;
assert.equal(M.reviewItems().length,200,'an older list cannot resurrect a reviewed item');
assert.deepEqual(writes[0].tags,['internal','reviewed']);
failRead=true; await M.refreshReviews(true);
assert.equal(M.reviewItems().length,200,'failed refresh retains last known rows');
assert.equal(M.reviewErrors().length,1);
failRead=false; artifacts=[]; await M.refreshReviews(true);
assert.equal(M.reviewItems().length,0,'deletion removes rows at next refresh');
console.log('inbox_reviews: ok');
