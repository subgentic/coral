// Phone Needs you, the mobile pass's four findings (#11894, #11891), on the Needs you list (article.nl-row, #22094): a question's title shows all its lines, not one; a goal proposal's row is laid out like the other rows (who
// proposed it is the title .nl-title in the same type as the question's, its meta line .nl-meta in the same type, the proposal in a plain line .nl-other-text) and the Goals tab counts the goal waiting for approval; selecting a goal row
// (Select in the phone title bar, then its check) opens no card and the selection bar offers no Approve and cannot Dismiss it; and the card says Done when once (not again under "Also sets") with Approve first and wide, the other
// three buttons in one row under it. A question and the four proposals are page stubs (the proposals' routes as in proposals_browser). 390 px.
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const fs = require('node:fs');
const HEX = '71c21f0b' + 'a'.repeat(56);
const LONGBODY = ('A long body. ' + 'It goes on and on with detail that nobody reads until they must decide. '.repeat(50)).slice(0, 2986) + 'THE END OF IT.'; // 3,000 characters, on one line
const PROPOSALS = [
    { id: 11, board_id: 'team-a', kind: 'task', title: 'Fix the <b>login</b> page', proposer: 'Backend Dev', state: 'pending', created_at: new Date(Date.now() - 600000).toISOString(), payload: { title: 'Fix the <b>login</b> page', body: 'It fails on Safari. @Orchestrator please look <img src=x onerror="window.__pwned=1">', priority: 'high', assigned_to: 'QA Engineer', blocked_by: [3], draft: true, goal_id: 5, remind_at: new Date(Date.now() + 86400000).toISOString(), workflow: { instructions: 'Read the plan first.\n<b>then</b> run the deploy\u202E script.\nSee coral://artifacts/' + HEX + ').', required_outputs: ['a report', 'the diff\u200B'] } } },
    { id: 12, board_id: 'team-a', kind: 'goal', title: 'Ship the beta', proposer: 'Orchestrator', state: 'pending', created_at: new Date(Date.now() - 3600000).toISOString(), payload: { title: 'Ship the beta', outcome: LONGBODY, done_when: 'The release is out' } },
    { id: 13, board_id: 'team-b', kind: 'task', title: 'An old idea', proposer: 'QA Engineer', state: 'expired', created_at: new Date(Date.now() - 9 * 86400000).toISOString(), payload: { title: 'An old idea', body: 'Nobody decided.' } },
    { id: 14, board_id: 'team-b', kind: 'goal', title: 'Being made right now', proposer: 'Lead Developer', state: 'approving', created_at: new Date(Date.now() - 120000).toISOString(), payload: { title: 'Being made right now', outcome: 'x' } },
];

const STUB = `(() => {
    const R = window.fetch; window.__posts = []; window.__list = ${JSON.stringify(PROPOSALS)}; window.__refuse = null; window.__pwned = 0;
    const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = (o.method || 'GET').toUpperCase();
        if (url.pathname === '/api/proposals' && m === 'GET') return json({ proposals: window.__list.filter(p => ['pending', 'approving', 'expired'].includes(p.state)) });
        const d = url.pathname.match(/^\\/api\\/board\\/([^/]+)\\/proposals\\/(\\d+)\\/(approve|reject)$/);
        if (d && m === 'POST') { const id = Number(d[2]); window.__posts.push({ board: d[1], id, action: d[3], body: JSON.parse(o.body || '{}') });
            if (window.__refuse) return json({ error: window.__refuse, code: 'waits_for_goal' }, 409);
            const p = window.__list.find(x => x.id === id); if (p) p.state = d[3] === 'approve' ? 'approved' : 'rejected';
            return json(d[3] === 'approve' ? { proposal_id: id, state: 'approved', created_id: 77 } : { proposal_id: id, state: 'rejected' }); }
        return R(u, o); };
    return true;
})()`;


(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect(); const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view .needs-ledger', S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rowOf = re => `[...document.querySelectorAll('${T} .nl-row')].find(r => ${re}.test(r.textContent))`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(INBOX_WORLD); await ev(STUB);
        await ev(`localStorage.setItem('coral-alerts-offered', '1'); localStorage.setItem('coral-alerts-reoffered', '1'); true`); // alerts were offered and re-offered: no banner moves the rows (#15297, #11893); this suite is not about it
        await ev(`window.__asks = [{ board: 'team-a', kind: 'ask', id: 41, asker: 'Lead Developer', text: 'Which port should the test server use for the integration run, and should it be the same one the dashboard is on?', at: new Date(Date.now() - 300000).toISOString() }]; true`);
        await ev(`(() => { const original = window.fetch; window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin); if (u.pathname === '/api/operator-asks') return Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })); return original(url, opts); }; return true; })()`);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = []; m.updateInboxTab(); return true; })()`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} .nl-row').length >= 5`, 'rows', 15000); await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`); await ev(framesJs(8)); // a goal group starts folded unless it holds a question: open them all
        // (1) a question shows up to two lines
        const q = await ev(`(() => { const n = (${rowOf('/Which port/')}).querySelector('.nl-title'), cs = getComputedStyle(n), lh = parseFloat(cs.lineHeight) || 1.4 * parseFloat(cs.fontSize); return { lines: Math.round(n.getBoundingClientRect().height / lh), clamp: cs.webkitLineClamp, text: n.textContent.length }; })()`);
        check(q.lines >= 3 && q.clamp === 'none', 'a long question shows all its lines, not two (#14574): ' + JSON.stringify(q));
        // (4) a goal proposal's row is laid out like the other rows: who proposed it leads, the same name type; Goals counts it
        const r = await ev(`(() => { const pr = ${rowOf('/Ship the beta/')}, ask = ${rowOf('/Which port/')}, st = e => e && { fs: getComputedStyle(e).fontSize, fw: getComputedStyle(e).fontWeight }, title = pr.querySelector('.nl-title'), line = pr.querySelector('.nl-other-text'); return { from: title && title.textContent, fromSt: st(title), askFrom: st(ask.querySelector('.nl-title')), metaSt: st(pr.querySelector('.nl-meta')), askMeta: st(ask.querySelector('.nl-meta')), lineSt: st(line), lineText: line && line.textContent, proposes: (pr.innerText.match(/Proposes a goal/g) || []).length, lines: pr.querySelectorAll('.nl-other-text').length, lineBelow: !!line && line.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 1 }; })()`);
        check(r.from === 'Orchestrator' && JSON.stringify(r.fromSt) === JSON.stringify(r.askFrom) && JSON.stringify(r.metaSt) === JSON.stringify(r.askMeta), 'a goal proposal row leads with who proposed it, in the same type as the other rows (the title and the meta line as a question row\'s): ' + JSON.stringify(r));
        check(r.proposes === 1 && r.lines === 1 && /Ship the beta/.test(r.lineText || '') && r.lineBelow, 'a phone draws no extra "Proposes a goal" line: the proposer is line one and the proposal one plain line under it, said once (#13911): ' + JSON.stringify(r));
        const goals = await ev(`[...document.querySelectorAll('#inbox-nav-list button, .view-list-item')].filter(b => /Goals/.test(b.textContent)).map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
        check(goals.length > 0 && goals.every(t => /Goals\s*1$/.test(t)), 'the Goals tab counts the goal waiting for approval: ' + JSON.stringify(goals));
        // (3) the card: Done when once, Approve first and as wide as the card
        await ev(`${rowOf('/Ship the beta/')}.querySelector('.nl-title').click(); true`);
        await waitFor(`!!document.querySelector('dialog[open] .proposal-buttons')`, 'the card', 8000); await ev(framesJs(6));
        const card = await ev(`(() => { const d = document.querySelector('dialog[open]'), b = [...d.querySelectorAll('.proposal-buttons button')].filter(x => x.getClientRects().length), ap = b.find(x => x.textContent === 'Approve'), rest = b.filter(x => x !== ap), box = d.getBoundingClientRect(); return { also: /Also sets/.test(d.textContent), doneWhen: (d.textContent.match(/Done when/g) || []).length, apW: Math.round(ap.getBoundingClientRect().width), cardW: Math.round(box.width), first: rest.every(x => ap.getBoundingClientRect().top < x.getBoundingClientRect().top), restRows: new Set(rest.map(x => Math.round(x.getBoundingClientRect().top))).size }; })()`);
        check(!card.also && card.doneWhen === 1, 'the card says Done when once, not again under "Also sets": ' + JSON.stringify(card));
        check(card.first && card.apW >= card.cardW * 0.8 && card.restRows === 1, 'Approve is first and wide, the other three share one row under it: ' + JSON.stringify(card));
        await shot('needs-phone-proposal-card');
        await ev(`[...document.querySelectorAll('dialog[open] .proposal-buttons button')].find(b => b.textContent === 'Close').click(); true`);
        await waitFor(`!document.querySelector('dialog[open]')`, 'the card closes', 4000);
        // (5) selecting the goal row opens no card (the long press of the old table is gone with it, #22094: selection is Select, then the row's check, needs_phone_rows_browser)
        await ev(`document.querySelector('#top-phone-bar .nl-phone-select').click(); true`); await ev(framesJs(2));
        await ev(`${rowOf('/Ship the beta/')}.querySelector('.nl-check').click(); true`); await ev(framesJs(4));
        const sel = await ev(`({ dialog: !!document.querySelector('dialog[open]'), selected: ${rowOf('/Ship the beta/')}.classList.contains('nl-is-selected'), count: document.querySelector('${T} .nl-summary strong')?.textContent })`);
        check(!sel.dialog && sel.selected && sel.count === '1 selected', 'selecting the goal row selects it and opens no card: ' + JSON.stringify(sel));
        const bar = await ev(`[...document.querySelectorAll('${T} .nl-summary button')].filter(b => b.getClientRects().length).map(b => ({ name: (b.getAttribute('aria-label') || b.textContent).trim(), off: b.disabled || b.getAttribute('aria-disabled') === 'true' }))`);
        check(!bar.some(b => /^Approve/.test(b.name)) && bar.some(b => /^Dismiss/.test(b.name) && b.off), 'with a proposal selected the bar offers no Approve (a file action, #15120) and cannot Dismiss it (proposals are approved or rejected): ' + JSON.stringify(bar));
        await shot('needs-phone-proposals'); 
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_phone_proposals_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
