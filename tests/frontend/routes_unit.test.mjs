// The dashboard's route grammar (#3532, routes.js): parse and build round-trip, the @server
// marker vs a name written %40, legacy hashes, and hostile segments (Security's section 7 and
// coral-hub Security's condition): a crafted path never becomes a route, so no /api path is
// built from it.
import assert from 'node:assert/strict';
import { parse, build, fromLegacyHash, valid, normalize, chatsQuery, inboxFolderPath } from '../../coral-go/pkg/frontend/static/routes.js';

const S = '6f9a3c1e-0000-4000-8000-000000000001';
const rt = (path, route) => {
    const u = new URL(path, 'http://x');
    assert.deepEqual(parse(u.pathname, u.search), route, `parse ${path}`);
    assert.equal(build(route), path, `build ${JSON.stringify(route)}`);
};

// Round trips, one per family.
rt('/agents', { view: 'agents' });
rt(`/agents/${S}`, { view: 'agents', server: null, id: S, sub: null });
rt(`/agents/@m2/${S}/files`, { view: 'agents', server: 'm2', id: S, sub: 'files' });
rt('/chats', { view: 'chats', query: '' });
rt('/chats/@m2', { view: 'chats', server: 'm2', query: '' });
rt('/chats/@m2?page=2&q=battle', { view: 'chats', server: 'm2', query: 'page=2&q=battle' });
rt(`/chats/@m2/${S}`, { view: 'chats', server: 'm2', id: S });
rt('/chats?page=2&q=battle', { view: 'chats', query: 'page=2&q=battle' }); // the query in the Chats tab's canonical key order
rt(`/chats/${S}`, { view: 'chats', id: S });
rt('/team/coral-go-team', { view: 'team', server: null, id: 'coral-go-team', sub: null });
rt('/team/@m2/settings', { view: 'team', server: 'm2', id: 'settings', sub: null });
rt('/team/m2/settings', { view: 'team', server: null, id: 'm2', sub: 'settings' });
rt('/team/%40m2/settings', { view: 'team', server: null, id: '@m2', sub: 'settings' });
rt('/team/a%2Fb', { view: 'team', server: null, id: 'a/b', sub: null });
// The team page's tabs and its item pages (#7453)
for (const tab of ['goals', 'tasks', 'agents', 'artifacts', 'knowledge', 'settings']) rt(`/team/qa/${tab}`, { view: 'team', server: null, id: 'qa', sub: tab });
// The Board tab's path word is board; the page still names it messages, and the old /messages address reads as the same tab (#8652)
rt('/team/qa/board', { view: 'team', server: null, id: 'qa', sub: 'messages' });
assert.deepEqual(parse('/team/qa/messages'), { view: 'team', server: null, id: 'qa', sub: 'messages' }, 'the old address is the Board tab');
assert.equal(build(parse('/team/qa/messages')), '/team/qa/board', 'and is written as /board');
rt('/team/@m2/qa/goals/12', { view: 'team', server: 'm2', id: 'qa', sub: 'goals', item: 12 });
rt('/team/qa/tasks/7', { view: 'team', server: null, id: 'qa', sub: 'tasks', item: 7 });
rt('/team/qa/board/104094', { view: 'team', server: null, id: 'qa', sub: 'messages', item: 104094 }); // a message of the Board tab (#7921)
assert.deepEqual(parse('/team/qa/messages/104094'), { view: 'team', server: null, id: 'qa', sub: 'messages', item: 104094 }, 'a message link of the old address still opens it');
for (const bad of ['/team/qa/goals/0', '/team/qa/goals/x', '/team/qa/goals/12/y', '/team/qa/settings/3', '/team/qa/agents/3', '/team/qa/files', '/team/qa/board/0', '/team/qa/board/x']) assert.equal(parse(bad), null, bad);
// The Inbox folders' pages (#8652): needs, saved and the chat folders; goals, tasks and boards belong to other page families, a bare /inbox to Coral Hub
rt('/inbox/needs', { view: 'inbox-folder', folder: 'needs' });
rt('/inbox/saved', { view: 'inbox-folder', folder: 'saved' });
rt('/inbox/artifacts', { view: 'inbox-folder', folder: 'artifacts' }); // every team's artifacts (Goal #62)
rt('/inbox/chats/all', { view: 'inbox-folder', folder: 'chats' });
for (const f of ['active', 'starred', 'notes', 'archived', 'cli-claude', 'cli-agy', 'tag-7']) rt(`/inbox/chats/${f}`, { view: 'inbox-folder', folder: `chats-${f}` });
assert.deepEqual(parse('/inbox/chats'), { view: 'inbox-folder', folder: 'chats' }, 'a bare /inbox/chats is All chats');
assert.equal(build(parse('/inbox/chats')), '/inbox/chats/all', 'and is written in full');
for (const bad of ['/inbox', '/inbox/', '/inbox/other', '/inbox/needs/x', '/inbox/saved/1', '/inbox/artifacts/x', '/inbox/chats/nonsense', '/inbox/chats/tag-0', '/inbox/chats/cli-', '/inbox/chats/cli-Claude', '/inbox/chats/all/x', '/inbox/chats-group']) assert.equal(parse(bad), null, bad);
assert.equal(inboxFolderPath('needs'), '/inbox/needs'); assert.equal(inboxFolderPath('artifacts'), '/inbox/artifacts'); assert.equal(inboxFolderPath('chats-cli-codex'), '/inbox/chats/cli-codex'); assert.equal(inboxFolderPath('chats-group'), '/inbox/boards'); assert.equal(inboxFolderPath('nope'), '', 'a folder with no path');
assert.equal(valid({ view: 'inbox-folder', folder: 'saved' }), true); assert.equal(valid({ view: 'inbox-folder', folder: 'goals' }), false, 'goals is not this family');
rt('/board/@m2/qa', { view: 'board', server: 'm2', id: 'qa' });
rt('/workflows', { view: 'workflows' });
rt('/workflows/7', { view: 'workflows', id: 7 });
rt('/workflows/7/runs/3', { view: 'workflows', id: 7, run: 3 });
// Automations (Goal #74): Workflows and Jobs as one screen. A folder, a job or a workflow under its own folder, and a workflow's run page.
rt('/automations', { view: 'automations', folder: null });
for (const folder of ['running', 'failed', 'jobs', 'workflows']) rt(`/automations/${folder}`, { view: 'automations', folder });
rt('/automations/jobs/4', { view: 'automations', folder: 'jobs', id: 4 });
rt('/automations/workflows/7', { view: 'automations', folder: 'workflows', id: 7 });
rt('/automations/workflows/7/runs/3', { view: 'automations', folder: 'workflows', id: 7, run: 3 });
for (const bad of ['/automations/other', '/automations/running/4', '/automations/failed/4', '/automations/jobs/0', '/automations/jobs/x', '/automations/jobs/4/runs/3', '/automations/workflows/7/runs/x', '/automations/workflows/7/runs/3/x', '/automations/jobs/1%2F..'])
    assert.equal(parse(bad), null, `${bad} is not an Automations route`);
assert.equal(build({ view: 'automations', folder: 'nowhere', id: 3 }), '/automations', 'a folder that is not one builds the tab alone');
assert.equal(build({ view: 'automations', folder: 'jobs', id: 4, run: 3 }), '/automations/jobs/4', 'only a workflow has a run page');
rt('/jobs', { view: 'jobs' });
rt('/analytics', { view: 'analytics' });
// Each Analytics page has its own path (#8606); Overview is /analytics
for (const v of ['provider', 'model', 'thinking', 'team', 'agent', 'branch', 'task', 'calls', 'per-commit', 'task-time']) rt(`/analytics/${v}`, { view: 'analytics', sub: v });
assert.deepEqual(parse('/analytics/overview'), { view: 'analytics' }, '/analytics/overview is Overview');
assert.equal(build({ view: 'analytics', sub: 'overview' }), '/analytics', 'Overview has the bare path');
assert.equal(build({ view: 'analytics', sub: 'agent-detail' }), '/analytics/agent', 'an agent page is under By agent');
for (const bad of ['/analytics/agent-detail', '/analytics/x/y', '/analytics/provider/model', '/analytics/..%2Fapi']) assert.equal(parse(bad), null, bad);
rt('/docs/board', { view: 'docs', id: 'board' });
rt('/docs/README', { view: 'docs', id: 'README' });
rt('/servers/m2', { view: 'servers', id: 'm2' });
assert.deepEqual(parse('/'), { view: 'agents' }, '/ is home');

// ?view=terminal on an agent route (coral-hub, #6752): exactly one view parameter with exactly the value terminal sets terminal: true; anything else is as if there were no query. Agents routes only.
const TERM = { view: 'agents', server: null, id: S, sub: null, terminal: true }, PLAIN = { view: 'agents', server: null, id: S, sub: null };
for (const [q, want, why] of [
    ['?view=terminal', TERM, 'the link'], ['?x=1&view=terminal', TERM, 'other keys are not read'], ['?view=terminal&x=1', TERM, 'other keys are not read, after'],
    ['', PLAIN, 'no query'], ['?', PLAIN, 'an empty query'], ['?view=', PLAIN, 'an empty value'], ['?view=chat', PLAIN, 'another value'], ['?view=Terminal', PLAIN, 'case matters'], ['?view=terminal%20', PLAIN, 'a trailing space'],
    ['?view=terminal&view=terminal', PLAIN, 'a second view, the same'], ['?view=terminal&view=chat', PLAIN, 'a second view, another'], ['?view=chat&view=terminal', PLAIN, 'a second view, first other'],
    ['?view[]=terminal', PLAIN, 'junk key'], ['?VIEW=terminal', PLAIN, 'the key is lower case'], ['?terminal', PLAIN, 'junk'], ['?view', PLAIN, 'no value'],
]) assert.deepEqual(parse(`/agents/${S}`, q), want, `agents ${q || '(none)'}: ${why}`);
assert.deepEqual(parse(`/agents/@m2/${S}/files`, '?view=terminal'), { view: 'agents', server: 'm2', id: S, sub: 'files', terminal: true }, 'a server and a sub tab keep their fields');
assert.deepEqual(parse('/agents', '?view=terminal'), { view: 'agents' }, 'the agents list has no terminal');
for (const path of ['/chats', `/chats/${S}`, '/jobs', '/workflows', '/docs/board', `/team/coral-go-team`, `/board/qa`]) assert.ok(!('terminal' in (parse(path, '?view=terminal') || {})), `${path}: only an agent route reads view=terminal`);
assert.equal(build(TERM), `/agents/${S}`, 'build writes the path without the query');
assert.deepEqual(normalize(TERM), PLAIN, 'a route that went through normalize has lost the flag: it is read from the URL once');

// The Chats query keeps only its own keys and drops page=1.
assert.equal(chatsQuery('?q=x&page=1&page_size=50&debug=1'), 'q=x');

// Hostile or malformed segments are never routes.
for (const bad of [
    '/agents/..%2F..%2Fapi%2Fsettings', `/agents/${S}%2F..%2Fx`, `/agents/${S}%3Fx`, '/agents/not-a-uuid', `/agents/${S}/evil`, `/agents/${S}/changes`, `/agents/${S}/team-settings`,
    `/agents/@bad%2Fslug/${S}`, `/agents/@../${S}`, `/agents/@/${S}`,
    '/chats/@../x', '/chats/@bad%2Fslug/x', '/chats/@m2/..%2Fapi', '/chats/@m2/a%3Fb', '/chats/@m2/a/b', '/chats/..%2F..%2Fapi', '/chats/a%2Fb', '/chats/a%3Fb', '/chats/%E0%A4%A', '/chats/' + 'x'.repeat(200), '/chats/a%00b', '/chats/..',
    '/team/%3Cscript%3E%0d%0a', '/team/' + encodeURIComponent('x'.repeat(201)), '/team/a%00b', '/team/%E0%A4%A', '/team/a/b/c', '/team/x/admin',
    '/workflows/1%2F..', '/workflows/0', '/workflows/-1', '/workflows/7/runs/x', '/workflows/abc',
    '/docs/..%2Fsecrets', '/docs/%3Cscript%3E', '/docs/a/b',
    '/servers/..%2F', '/servers/Ab', '/servers/a%2Fb',
    '/jobs/1', '/analytics/x', '/history', '/chat/x', '/random',
]) {
    // Raw, without URL normalization (a browser resolves "/chats/.." to "/" itself; the parser
    // must refuse it anyway).
    const [path, query = ''] = bad.split('?');
    assert.equal(parse(path, query), null, `not a route: ${bad}`);
}
// A team name with markup is a route, but only as text: the router passes it to textContent and
// encodeURIComponent, never innerHTML (checked in the browser suite).
assert.deepEqual(parse('/team/%3Cb%3Ex%3C%2Fb%3E'), { view: 'team', server: null, id: '<b>x</b>', sub: null });

// Legacy hashes map to routes; bad ids in them are dropped by valid().
assert.deepEqual(fromLegacyHash(`#chat/${S}`), { view: 'agents', id: S });
assert.deepEqual(fromLegacyHash(`#chat/m2/${S}`), { view: 'agents', server: 'm2', id: S });
assert.deepEqual(fromLegacyHash(`#session/${S}`), { view: 'chats', id: S });
assert.deepEqual(fromLegacyHash(`#history/${S}`), { view: 'chats', id: S });
assert.deepEqual(fromLegacyHash('#team-view=%40m2%2Fcoral-go-team'), { view: 'team', server: 'm2', id: 'coral-go-team', sub: 'agents' }); // the Team view is the Agents tab (#7453)
assert.deepEqual(fromLegacyHash('#team-settings=qa'), { view: 'team', server: null, id: 'qa', sub: 'settings' });
assert.deepEqual(fromLegacyHash('#servers/m2'), { view: 'servers', id: 'm2' });
assert.deepEqual(fromLegacyHash('#tokens'), { view: 'analytics' });
assert.deepEqual(fromLegacyHash('#agents'), { view: 'agents' });
assert.deepEqual(fromLegacyHash('#workflows'), { view: 'workflows' }, "the audit: /#workflows opens Workflows");
assert.deepEqual(fromLegacyHash('#docs'), { view: 'docs' });
assert.deepEqual(fromLegacyHash('#history'), { view: 'chats', query: '' });
assert.equal(fromLegacyHash('#nonsense'), null);
assert.equal(valid(fromLegacyHash('#chat/..%2F..%2Fapi')), false, 'a bad legacy id is dropped');
assert.equal(valid(fromLegacyHash(`#chat/${S}`)), true);
// An uppercase server marker reads lower-case (QA).
assert.deepEqual(parse(`/agents/@M2/${S}`), { view: 'agents', server: 'm2', id: S, sub: null });
// A board or team named "." or ".." is never a route, from a path, a legacy hash or a view's own
// key: its name would climb out of /api/board/ in boardFetch (coral-hub Security). #3534 refuses
// such names at creation.
for (const n of ['.', '..']) {
    for (const v of ['team', 'board']) {
        assert.equal(normalize({ view: v, server: null, id: n, sub: null }), null, `${v} ${n}`);
        assert.equal(normalize({ view: v, server: 'm2', id: n, sub: null }), null, `${v} @m2/${n}`);
    }
    for (const p of [`/board/${n}`, '/board/%2E%2E', '/board/%2e', `/team/@m2/${n}`, '/team/%2E%2E/settings']) assert.equal(parse(p), null, p);
}
for (const h of ['#board/..', '#board/%2E%2E', '#team-view=..', '#team-settings=.', '#team-view=%40m2%2F..']) {
    assert.equal(normalize(fromLegacyHash(h)), null, h);
}
assert.equal(normalize(fromLegacyHash('#board/...')).id, '...', 'three dots is an ordinary name');
console.log('routes_unit: ok');

// The views' own keys (#3532 part 2).
{
    const { liveRoute, keyRoute, routeKey } = await import('../../coral-go/pkg/frontend/static/routes.js');
    const u = '0b5e2f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
    assert.equal(build(liveRoute('local', u)), `/agents/${u}`);
    assert.equal(build(liveRoute(null, u, 'files')), `/agents/${u}/files`);
    assert.equal(build(liveRoute('m2', u)), `/agents/@m2/${u}`);
    assert.equal(build(keyRoute('team', '@m2/qa', 'settings')), '/team/@m2/qa/settings');
    assert.equal(build(keyRoute('board', '@odd')), '/board/%40odd');
    assert.equal(build(keyRoute('team', 'a/b')), '/team/a%2Fb');
    assert.equal(build(keyRoute('team', 'qa', 'goals', 5)), '/team/qa/goals/5');
    assert.equal(build(keyRoute('team', 'qa', 'settings', 5)), '/team/qa/settings', 'only goals, tasks and messages have an item');
    for (const k of ['qa', '@m2/qa', '@odd', 'a/b', '@m2/@x', '@x!/y']) {
        assert.equal(routeKey(normalize(keyRoute('board', k))), k, k);
        assert.equal(routeKey(normalize(keyRoute('team', k))), k, k);
    }
    assert.equal(normalize(liveRoute('local', 'not-a-uuid')), null);
}

// #8571: Inbox goals have their own address; segments receive the same validation as team routes.
for (const team of ['release-team', '@odd', 'team with spaces', 'a/b']) {
    const r = {view:'inbox-goals',sub:'goals',id:team,item:17};
    assert.deepEqual(parse(build(r)), r);
}
assert.deepEqual(parse('/inbox/goals'), {view:'inbox-goals',sub:'goals'});
assert.equal(build({view:'inbox-goals',sub:'goals'}), '/inbox/goals');
for (const bad of ['/inbox/goals/x/0','/inbox/goals/x/-1','/inbox/goals/x/NaN','/inbox/goals/%00/1','/inbox/goals/../1','/inbox/goals/%2e%2e/1','/inbox/goals/x/1/extra','/inbox/goals/%ZZ/1']) assert.equal(parse(bad),null,bad);

// #8633: task and board detail paths stay in the Inbox, including qualified team names.
for (const team of ['release-team', '@m2/remote-team', '@odd', 'team with spaces', 'a/b']) {
    for (const sub of ['tasks', 'boards']) {
        const r = {view:'inbox-'+sub,sub,id:team,...(sub==='tasks'?{item:17}:{})};
        assert.deepEqual(parse(build(r)),r);
    }
}
for (const sub of ['tasks', 'boards']) {
    assert.deepEqual(parse('/inbox/'+sub),{view:'inbox-'+sub,sub});
    assert.equal(build({view:'inbox-'+sub,sub}),'/inbox/'+sub);
}
for (const bad of ['/inbox/tasks/x/0','/inbox/tasks/x/-1','/inbox/tasks/x/NaN','/inbox/tasks/%00/1','/inbox/tasks/%2e%2e/1','/inbox/tasks/x/1/extra','/inbox/boards/%ZZ','/inbox/boards/%2e%2e','/inbox/boards/x/extra']) assert.equal(parse(bad),null,bad);
