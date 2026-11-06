// Phone Needs you, the mobile pass's four findings (#11894, #11891): a question shows up to two lines, not one; a goal proposal's row is laid out like the other rows (who proposed it leads, the same type, a plain second
// line) and the Goals tab counts the goal waiting for approval; a long press selects a goal row instead of opening its card; and the card says Done when once (not again under "Also sets") with Approve first and wide,
// the other three buttons in one row under it. A question and the four proposals are page stubs (the proposals' routes as in proposals_browser). 390 px.
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
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const rowOf = re => `[...document.querySelectorAll('${T} tbody tr')].find(r => ${re}.test(r.textContent))`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(INBOX_WORLD); await ev(STUB);
        await ev(`window.__asks = [{ board: 'team-a', kind: 'ask', id: 41, asker: 'Lead Developer', text: 'Which port should the test server use for the integration run, and should it be the same one the dashboard is on?', at: new Date(Date.now() - 300000).toISOString() }]; true`);
        await ev(`(() => { const original = window.fetch; window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin); if (u.pathname === '/api/operator-asks') return Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })); return original(url, opts); }; return true; })()`);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = []; m.updateInboxTab(); return true; })()`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 5`, 'rows', 15000); await ev(framesJs(8));
        // (1) a question shows up to two lines
        const q = await ev(`(() => { const n = (${rowOf('/Which port/')}).querySelector('.inbox-review-name'), cs = getComputedStyle(n), lh = parseFloat(cs.lineHeight) || 1.4 * parseFloat(cs.fontSize); return { lines: Math.round(n.getBoundingClientRect().height / lh), clamp: cs.webkitLineClamp, text: n.textContent.length }; })()`);
        check(q.lines === 2 && q.clamp === '2', 'a long question shows two lines, not one: ' + JSON.stringify(q));
        // (4) a goal proposal's row is laid out like the other rows: who proposed it leads, the same name type; Goals counts it
        const r = await ev(`(() => { const pr = ${rowOf('/Ship the beta/')}, ask = ${rowOf('/Which port/')}, st = e => e && { fs: getComputedStyle(e).fontSize, fw: getComputedStyle(e).fontWeight }, from = pr.querySelector('.inbox-review-from'), line = pr.querySelector('.inbox-proposal-line'); return { from: from && from.textContent, fromSt: st(from), askFrom: st(ask.querySelector('.inbox-review-from')), nameSt: st(pr.querySelector('.inbox-review-name')), askName: st(ask.querySelector('.inbox-review-name')), lineSt: st(line), lineText: line && line.textContent }; })()`);
        check(r.from === 'Orchestrator' && JSON.stringify(r.fromSt) === JSON.stringify(r.askFrom) && r.fromSt.fs === r.askName.fs, 'a goal proposal row leads with who proposed it, in the same type as the other rows (a question row (#13829) has the agent name first too, its ask under it): ' + JSON.stringify(r));
        check(r.lineText === 'Proposes a goal' && Number(r.lineSt.fw) <= 400, 'its second line is plain ("Proposes a goal"), not bold: ' + JSON.stringify(r));
        const goals = await ev(`[...document.querySelectorAll('#inbox-nav-list button, .view-list-item')].filter(b => /Goals/.test(b.textContent)).map(b => b.textContent.replace(/\\s+/g, ' ').trim())`);
        check(goals.length > 0 && goals.every(t => /Goals\s*1$/.test(t)), 'the Goals tab counts the goal waiting for approval: ' + JSON.stringify(goals));
        // (3) the card: Done when once, Approve first and as wide as the card
        await ev(`${rowOf('/Ship the beta/')}.querySelector('.dt-primary, .inbox-review-name, td').click(); true`);
        await waitFor(`!!document.querySelector('dialog[open] .proposal-buttons')`, 'the card', 8000); await ev(framesJs(6));
        const card = await ev(`(() => { const d = document.querySelector('dialog[open]'), b = [...d.querySelectorAll('.proposal-buttons button')].filter(x => x.getClientRects().length), ap = b.find(x => x.textContent === 'Approve'), rest = b.filter(x => x !== ap), box = d.getBoundingClientRect(); return { also: /Also sets/.test(d.textContent), doneWhen: (d.textContent.match(/Done when/g) || []).length, apW: Math.round(ap.getBoundingClientRect().width), cardW: Math.round(box.width), first: rest.every(x => ap.getBoundingClientRect().top < x.getBoundingClientRect().top), restRows: new Set(rest.map(x => Math.round(x.getBoundingClientRect().top))).size }; })()`);
        check(!card.also && card.doneWhen === 1, 'the card says Done when once, not again under "Also sets": ' + JSON.stringify(card));
        check(card.first && card.apW >= card.cardW * 0.8 && card.restRows === 1, 'Approve is first and wide, the other three share one row under it: ' + JSON.stringify(card));
        await shot('needs-phone-proposal-card');
        await ev(`[...document.querySelectorAll('dialog[open] .proposal-buttons button')].find(b => b.textContent === 'Close').click(); true`);
        await waitFor(`!document.querySelector('dialog[open]')`, 'the card closes', 4000);
        // (5) a long press selects the goal row, it does not open its card
        const pt = await ev(`(() => { const r = (${rowOf('/Ship the beta/')}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        const touch = (type, x, y) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
        await touch('touchStart', pt.x, pt.y); await ev(`new Promise(r => setTimeout(r, 900))`); await touch('touchEnd', pt.x, pt.y); await ev(framesJs(6)); // sleep-ok: the press is held
        const sel = await ev(`({ dialog: !!document.querySelector('dialog[open]'), selected: ${rowOf('/Ship the beta/')}.classList.contains('dt-selected'), bar: !!document.querySelector('.dt-select-bar, .dt-bar [class*=selected], .gt-toolbar .dt-bar') })`);
        check(!sel.dialog && sel.selected, 'a long press selects the goal row and opens no card: ' + JSON.stringify(sel));
        const bar = await ev(`[...document.querySelectorAll('.gt-toolbar button, .dt-bar button')].filter(b => b.getClientRects().length).map(b => ({ name: (b.getAttribute('aria-label') || b.title || b.textContent).trim(), off: b.disabled || b.getAttribute('aria-disabled') === 'true' }))`);
        check(bar.some(b => /^Approve/.test(b.name) && b.off) && bar.some(b => /^Dismiss/.test(b.name) && b.off), 'with a proposal selected the bar cannot Approve or Dismiss it (they are for files and questions): ' + JSON.stringify(bar));
        await shot('needs-phone-proposals'); 
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_phone_proposals_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
