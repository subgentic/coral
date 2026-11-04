// #13170 (QA Reviewer 2's SHOULD and INFO on #13161's walk): a walk of a team's artifacts advances by what the computer RETURNED, not by what was asked; the saved list is walked to its end; and a page with no cursor after one with a cursor
// goes on by offset from what the walk has, it does not start again. Stand-in computers: an old one (it ignores limit and answers 200 a page, by offset only), a new one (50 a page by cursor), and one that changes under the walk.
import assert from 'node:assert/strict';

globalThis.location = new URL('https://hub.test/');
globalThis.document = { getElementById: () => null, querySelector: () => null, addEventListener() {}, dispatchEvent() {} };
globalThis.window = {};
const { boardArtifactPage, nextArtifactPage } = await import('../../coral-go/pkg/frontend/static/server_base.js');

const files = n => Array.from({ length: n }, (_, i) => ({ id: 'f' + i, name: 'f' + i }));
let asked = [], mode = 'old', total = 450, changeAt = 1;
const page = (u) => {
    const q = new URL(u, 'http://x').searchParams, cursor = q.get('cursor'), offset = Number(q.get('offset') || 0), start = cursor ? Number(cursor.replace('c', '')) : offset;
    asked.push({ cursor, offset, limit: q.get('limit') });
    const per = mode === 'old' ? 200 : 50, list = files(total).slice(start, start + per), more = start + list.length < total;
    if (mode === 'new') return { artifacts: list, has_more: more, ...(more ? { next_cursor: 'c' + (start + list.length) } : {}) };
    if (mode === 'changes') { // a cursor on the first page only: the computer changed under the walk, the next pages carry no cursor
        const first = asked.length === 1;
        return { artifacts: list, has_more: more, ...(more && first ? { next_cursor: 'c' + (start + list.length) } : {}) };
    }
    return { artifacts: list, has_more: more }; // old: offset only
};
globalThis.fetch = async (url) => Response.json(page(String(url)));

const walk = async (team = 'a') => {
    const got = []; asked = [];
    for (let at = { cursor: '', offset: 0 }, pages = 0; pages < 200; pages++) {
        const r = await boardArtifactPage(team, 'for%20review', at);
        const data = await r.json();
        got.push(...data.artifacts.map(a => a.id));
        if (!nextArtifactPage(at, data)) break;
    }
    return got;
};

// an old computer: pages of 200 though 50 was asked, by offset only: the walk advances by 200 (what came back): each file once
mode = 'old'; total = 450;
let got = await walk();
assert.equal(got.length, 450, 'every file');
assert.equal(new Set(got).size, 450, 'none twice (advancing by the 50 asked would read file 50-199 again)');
assert.deepEqual(asked.map(a => a.offset), [0, 200, 400], 'offsets by what came back');
assert.ok(asked.every(a => a.limit === '50'), 'the request still says 50');

// a new computer: 50 a page by cursor
mode = 'new'; total = 120;
got = await walk();
assert.equal(got.length, 120); assert.equal(new Set(got).size, 120);
assert.deepEqual(asked.map(a => a.cursor), [null, 'c50', 'c100']);

// the computer changes under the walk: a cursor on the first page, none on the later ones: the walk goes on by offset from what it has (100 after two pages), not from 0
mode = 'changes'; total = 150;
got = await walk();
assert.equal(new Set(got).size, got.length, 'no file twice: the walk did not start again');
assert.equal(got.length, 150, 'and it reached the end');
assert.deepEqual(asked.map(a => [a.cursor, a.offset]), [[null, 0], ['c50', 0], [null, 100]], 'second page by the cursor, the third by offset 100 (everything it was given so far)');

// the saved list of a team with more than 50 files is walked to its end (Needs you's saved read)
mode = 'new'; total = 120;
const I = await import('../../coral-go/pkg/frontend/static/inbox_reviews.js');
const savedFile = i => ({ id: 's' + i, uri: 'coral://artifacts/' + i.toString(16).padStart(64, 'a'), tags: ['saved', 'for review'], name: 's' + i, available: true, created_at: '2026-11-04T00:00:00Z' });
globalThis.fetch = async (url) => {
    const u = new URL(String(url), 'http://x');
    if (u.pathname === '/api/board/projects') return Response.json([{ project: 'a' }]);
    if (!/\/api\/board\/a\/artifacts$/.test(u.pathname)) return Response.json({});
    const tag = u.searchParams.get('tag'), cursor = u.searchParams.get('cursor'), offset = Number(u.searchParams.get('offset') || 0), start = cursor ? Number(cursor.replace('c', '')) : offset;
    if (tag !== 'saved') return Response.json({ artifacts: [], has_more: false });
    const all = Array.from({ length: 120 }, (_, i) => savedFile(i)), list = all.slice(start, start + 50), more = start + list.length < all.length;
    return Response.json({ artifacts: list, has_more: more, ...(more ? { next_cursor: 'c' + (start + list.length) } : {}) });
};
await I.refreshReviews(true);
assert.equal(I.savedFiles().length, 120, 'all the saved files, three pages of 50 (a walk that stops after one page has 50)');
console.log('artifact_walk: ok');
