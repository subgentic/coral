// What the Inbox could not read is not "nothing waiting" (#13841): a computer that refuses a kind's read (403), has no such route (404) or fails makes the Inbox say "Not everything is shown" and name the kind, and only a 200 with
// an empty list clears it. Through a Hub the skills that wait are one read of /api/needs-you?kind=skill, shown as plain text (hidden and reordering characters written out) to approve at the computer, with the count the
// computer gave. The reads are stubbed. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        // the note's words from the gap module: a refused read names its kind, a computer is named when it is not this one, a 200 clears it
        const words = await ev(`(async () => { const g = await import(${S} + 'needs_incomplete.js'); const out = {};
            out.none = g.incompleteNote();
            g.readOutcome('questions', 'local', false); out.q = g.incompleteNote();
            g.readOutcome('skills', 'build-box', false); out.two = g.incompleteNote();
            g.readOutcome('questions', 'local', true); g.readOutcome('skills', 'build-box', true); out.cleared = g.incompleteNote(); return out; })()`);
        check(words.none === '' && words.cleared === '', 'nothing refused: no note: ' + JSON.stringify(words));
        check(/^Not everything is shown: questions could not be read\.$/.test(words.q), 'a refused read says so and names its kind: ' + words.q);
        check(/questions, skills from build-box could not be read/.test(words.two), 'another computer is named: ' + words.two);
        // the real readers: a 403 and a 404 are gaps, a 200 with an empty list is nothing waiting
        const reads = await ev(`(async () => { const g = await import(${S} + 'needs_incomplete.js'), sk = await import(${S} + 'needs_skills.js'), original = window.fetch; const out = {};
            const answer = (status, body) => { window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname; if (p === '/api/skills') return Promise.resolve(new Response(JSON.stringify(body), { status })); return original(u, o); }; };
            answer(404, {}); await sk.loadPendingSkills(); out.notFound = g.incompleteNote();
            answer(200, { skills: [] }); await sk.loadPendingSkills(); out.empty = g.incompleteNote() + '|' + sk.skillCount();
            window.fetch = original; return out; })()`);
        check(/skills could not be read/.test(reads.notFound), 'a 404 on the skills read is a gap, not "no skills": ' + JSON.stringify(reads));
        check(reads.empty === '|0', 'a 200 with an empty list is nothing waiting and clears the note: ' + JSON.stringify(reads));
        // through a Hub: one read of /api/needs-you?kind=skill gives the rows and the count, as plain text with no controls
        const hub = await ev(`(async () => { const g = await import(${S} + 'needs_incomplete.js'), sk = await import(${S} + 'needs_skills.js'), original = window.fetch; const out = {}; const seen = [];
            window.fetch = (u, o) => { const url = new URL(String(u), location.origin); seen.push(url.pathname + url.search); if (url.pathname === '/api/needs-you') return Promise.resolve(new Response(JSON.stringify({ count: 9, counts: { skill: 3 }, items: [{ kind: 'skill', from: 'Dev', line: 'Dev published skill dep\\u202Eloy', team: 'ops', id: 'skill:7', at: '2026-11-06T01:00:00Z' }] }), { status: 200 })); return original(u, o); };
            await sk.loadPendingSkills({ hub: true, sources: ['hub'], urlOf: p => p }); const rows = sk.skillRows(); window.fetch = original;
            return { seen, n: rows.length, count: sk.skillCount(), line: rows[0] && sk.skillLine(rows[0].skillReview), summary: rows[0] && rows[0].waiting_summary, hub: rows[0] && rows[0].skillReview.hub, id: rows[0] && rows[0].session_id, note: g.incompleteNote() }; })()`);
        check(hub.seen.length === 1 && hub.seen[0] === '/api/needs-you?kind=skill', 'one read, of the one list of what waits: ' + JSON.stringify(hub.seen));
        check(hub.n === 1 && hub.count === 3 && hub.hub === true, 'the rows and the count the computer gave: ' + JSON.stringify(hub));
        check(/dep<U\+202E>loy/.test(hub.line) && !/\u202e/.test(hub.line), 'the line is plain text, the reordering character written out: ' + JSON.stringify(hub.line));
        check(/approve at the computer/.test(hub.summary) && hub.id === 'skill_review:hub:7' && hub.note === '', 'it says approve at the computer: ' + JSON.stringify(hub));
        // a failed hub read (a server error) keeps the rows and says it is not everything; a refused one (403: access was taken away) drops them and still says so (the Orchestrator's decision on #13841)
        const refused = await ev(`(async () => { const g = await import(${S} + 'needs_incomplete.js'), sk = await import(${S} + 'needs_skills.js'), original = window.fetch; const out = {};
            const answer = status => { window.fetch = (u, o) => (String(u).includes('/api/needs-you') ? Promise.resolve(new Response('{}', { status })) : original(u, o)); };
            answer(500); await sk.loadPendingSkills({ hub: true, sources: ['hub'], urlOf: p => p }); out.failed = { n: sk.skillRows().length, note: g.incompleteNote() };
            answer(403); await sk.loadPendingSkills({ hub: true, sources: ['hub'], urlOf: p => p }); out.refused = { n: sk.skillRows().length, note: g.incompleteNote(), count: sk.skillCount() };
            window.fetch = original; return out; })()`);
        check(refused.failed.n === 1 && /skills from hub could not be read/.test(refused.failed.note), 'a failed hub read keeps the rows and says not everything is shown: ' + JSON.stringify(refused.failed));
        check(refused.refused.n === 0 && refused.refused.count === 0 && /skills from hub could not be read/.test(refused.refused.note), 'a refused hub read drops the rows and still says so: ' + JSON.stringify(refused.refused));
        // the proposal and question readers: a populated snapshot, then a refusal, a missing route, a server error, a network failure, a body that is not JSON and one that is not a list: every one keeps the rows and says
        // not everything is shown; only a valid 200 with an empty list clears both (#13841, the UI Reviewer's cases)
        const readers = await ev(`(async () => { const g = await import(${S} + 'needs_incomplete.js'), pr = await import(${S} + 'proposals_state.js'), qa = await import(${S} + 'operator_asks.js'), original = window.fetch; const out = [];
            g.readOutcome('skills', 'hub', true); // the hub case above left its gap: start clean
            const proposal = { id: 11, board_id: 'team-a', kind: 'task', title: 'Fix it', proposer: 'Dev', state: 'pending', created_at: new Date().toISOString(), payload: { title: 'Fix it', body: 'x' } }, ask = { board: 'team-a', board_label: 'A', kind: 'ask', id: 5, asker: 'Orchestrator', text: '@Operator ok?', at: new Date().toISOString() };
            let mode = 'ok';
            const respond = (rows, key) => { if (mode === 'ok') return Response.json(key ? { [key]: rows } : rows); if (mode === 'empty') return Response.json(key ? { [key]: [] } : []); if (mode === '403') return new Response('{}', { status: 403 }); if (mode === '401') return new Response('{}', { status: 401 }); if (mode === '404') return new Response('{}', { status: 404 }); if (mode === '500') return new Response('{}', { status: 500 }); if (mode === 'junk') return new Response('<html>', { status: 200 }); if (mode === 'notlist') return Response.json(key ? { [key]: 'nope' } : { rows: 1 }); throw new TypeError('network'); };
            window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname; if (p === '/api/proposals') return Promise.resolve().then(() => respond([proposal], 'proposals')); if (p === '/api/operator-asks') return Promise.resolve().then(() => respond([ask], null)); return original(u, o); };
            const read = async () => { await pr.refreshProposals(true); await qa.refreshOperatorAsks(true); };
            for (const m of ['ok', '403', 'ok', '401', 'ok', '404', '500', 'network', 'junk', 'notlist', 'empty', 'ok']) { mode = m; await read(); out.push({ m, proposals: pr.proposalItems().length, asks: qa.operatorAsks().length, note: g.incompleteNote() }); }
            window.fetch = original; return out; })()`);
        const by = (m, i) => readers.filter(r => r.m === m)[i || 0];
        check(by('ok', 0).proposals === 1 && by('ok', 0).asks === 1 && by('ok', 0).note === '', 'a 200 with rows: drawn, no warning: ' + JSON.stringify(by('ok', 0)));
        // access taken away (401, 403) drops that computer's rows and still says so; every other failure keeps them (the Orchestrator's decision on #13841, following Security)
        for (const m of ['403', '401']) { const r = by(m); check(r.proposals === 0 && r.asks === 0 && /^Not everything is shown: .*proposals/.test(r.note) && /questions/.test(r.note), `${m}: access taken away: no rows, and the note says so: ` + JSON.stringify(r)); }
        for (const m of ['404', '500', 'network', 'junk', 'notlist']) { const r = by(m); check(r.proposals === 1 && r.asks === 1 && /^Not everything is shown: .*proposals/.test(r.note) && /questions/.test(r.note), `${m}: the rows stay and the Inbox says it is not everything: ` + JSON.stringify(r)); }
        check(by('empty').proposals === 0 && by('empty').asks === 0 && by('empty').note === '', 'a valid 200 with an empty list clears the rows and the warning: ' + JSON.stringify(by('empty')));
        check(by('ok', 3).proposals === 1 && by('ok', 3).note === '', 'and a 200 with rows again draws them: ' + JSON.stringify(by('ok', 3)));
        await ev(framesJs(1));
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the Inbox says what it could not read, and a Hub reads the skills that wait');
})().catch(e => { console.error(e); process.exit(1); });
