// A permission agent's ask is the start of its own preview line, and there is no Waiting for column (#12649, the Operator: "remove the Waiting for column"): in Needs you with two agents asking to run a command and a question, the table has
// Item, CLI, Folder, Team and Actions and no Waiting for or What was asked, and each agent's row says "Wants to run: ..." under its name, so nothing the column held is lost. 1280 px; derived from needs_mixed_fit_browser (its page stubs).
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
    const R = window.fetch; window.__posts = []; window.__list = []; window.__refuse = null; window.__pwned = 0;
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
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 1`, 'the question', 15000); await ev(framesJs(8));
        await Emulation.setTouchEmulationEnabled({ enabled: false }); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const sessions = [1, 2].map(i => ({ name: 'n' + i, session_id: '0000000' + i + '-0000-4000-8000-00000000000' + i, agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent ' + i, working_directory: '/repo/n' + i, waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: new Date(Date.now() - 60000).toISOString() }));
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(sessions)}; m.updateInboxTab(); return true; })()`);
        await ev(framesJs(30)); check(await ev(`document.querySelectorAll('${T} tbody tr').length`) >= 3, 'seven rows: ' + await ev(`[...document.querySelectorAll('${T} tbody tr')].map(r => r.textContent.slice(0, 20))`));
        for (const width of [1280, 1024]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile: false });  await ev(framesJs(12));
            const r = await ev(`(() => { const box = document.querySelector('${T} .dt-box') || document.querySelector('${T}'), table = box.querySelector('table'), b = box.getBoundingClientRect(), w = e => Math.round(e.getBoundingClientRect().width), vis = e => e && e.getClientRects().length > 0;
                const act = table.querySelector('thead th[data-key=review]'), wait = table.querySelector('thead th[data-key=waiting]'), item = table.querySelector('thead th[data-key=agent]');
                return { width: ${width}, box: Math.round(b.width), table: w(table), scrolls: box.scrollWidth > box.clientWidth + 1, item: w(item), actionsIn: vis(act) && act.getBoundingClientRect().right <= b.right + 1, waitingIn: !vis(wait) || wait.getBoundingClientRect().right <= b.right + 1, shown: [...table.querySelectorAll('thead th')].filter(vis).map(t => t.dataset.key) }; })()`);
            if (width === 1280) {
                const info = await ev(`(() => ({ heads: [...document.querySelectorAll('${T} thead th')].filter(t => t.getClientRects().length && t.getBoundingClientRect().width > 4).map(t => t.textContent.trim().replace(/[↕↑↓]/g, '')), agents: [...document.querySelectorAll('${T} tbody tr')].filter(r => /^\\s*A\\s*Agent/.test(r.textContent) || /Agent [12]/.test(r.textContent)).map(r => r.querySelector('td').innerText.replace(/\\n+/g, ' | ').trim()) }))()`);
                if (info.heads.includes('Waiting for') || info.heads.includes('What was asked')) failures.push('no Waiting for or What was asked column without proposals: ' + JSON.stringify(info.heads));
                if (info.agents.length !== 2 || !info.agents.every(x => /Wants to run: go test/.test(x))) failures.push('each agent says what it wants to run under its name: ' + JSON.stringify(info.agents));
                continue;
            }
            await shot('mixed-' + width);
            check(!r.scrolls && r.table <= r.box + 2, 'agents, proposals and a question in one table fit the panel at ' + width + ' px, no sideways scroll: ' + JSON.stringify(r));
            check(r.actionsIn && r.waitingIn, 'Actions (and Waiting when it is shown) stay inside the panel, at ' + width + ' px: ' + JSON.stringify(r));
            check(r.item >= 100, 'the Item column keeps room at ' + width + ' px: ' + JSON.stringify(r));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_mixed_fit_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
