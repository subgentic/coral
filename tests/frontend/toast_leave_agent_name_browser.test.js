// #10797 (Desktop tester #10793): toasts do not stay and stack. A plain toast leaves after a few seconds; one with an action (Copy link, Undo) after it is used or 30 s, and holds while focus is on it; any toast that was on
// screen before the page changed is gone when it does. And in the Inbox's Artifacts a file shared by an agent that belongs to no team names the agent where the Team column said "No team". 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const WORLD = `(() => {
    const real = window.fetch;
    const at = m => new Date(Date.now() - m * 60000).toISOString();
    const row = (n, name, board, team, sid) => ({ id: String(n).padStart(64, '0'), name, media_type: 'text/plain', size: 1000 * n, created_at: at(n * 5), task_id: 0, task_title: '', source: 'upload', uri: 'coral://artifacts/' + String(n).padStart(64, '0'), available: true, inline: false, reference_count: 1, board_id: board, team, session_id: sid });
    const A = [row(1, 'plan.txt', 'alpha', 'alpha', null), row(2, 'pasted-screenshot.txt', '', 'No team', 'helper-sid')];
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/team-artifacts' && m === 'GET') return json({ artifacts: A, limit: 100, offset: 0, has_more: false, truncated: false, total: 2, all: 2, teams: [{ board_id: 'alpha', team: 'alpha', all: 1 }, { board_id: '', team: 'No team', all: 1 }] });
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            // toasts: the delay each kind is given, and what a page change does
            const t = await ev(`(async () => { const n = await import((window.__coralStatic || '/static/') + 'notifications.js');
                const real = window.setTimeout, delays = []; window.setTimeout = (fn, ms, ...a) => { if (a[0] !== 'pin-watch') delays.push(ms); return real(fn, ms, ...a); };
                const made = (msg, action) => { delays.length = 0; const el = n.showToast(msg, false, undefined, action ? { action: { label: action, onClick() {} } } : {}); return { el, ms: delays.filter(d => ![0, 100, 900].includes(d)) }; };
                const plain = made('Saved.'), act = made('Link copied', 'Copy link');
                const res = { plain: plain.ms, action: act.ms };
                for (const e of document.querySelectorAll('.toast')) e.dataset.at = String(Date.now() - 5000); // both were on screen before the page changed
                const fresh = made('Created.').el; // and one that comes with the change itself
                document.dispatchEvent(new CustomEvent('coral:route-changed'));
                res.old = [plain.el, act.el].map(e => e.isConnected); res.fresh = fresh.isConnected;
                window.setTimeout = real; document.querySelectorAll('.toast').forEach(e => e.remove()); return res; })()`);
            assert.deepEqual(t.plain, [4000], at + 'a plain toast has its short timer: ' + JSON.stringify(t));
            assert.deepEqual(t.action, [30000], at + 'a toast with an action leaves after 30 s: ' + JSON.stringify(t));
            assert.deepEqual(t.old, [false, false], at + 'toasts shown before the page changed are gone with it: ' + JSON.stringify(t));
            assert.equal(t.fresh, true, at + 'a toast that comes with the change is kept: ' + JSON.stringify(t));
            // the Artifacts folder: the agent's name, not "No team"
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${WORLD}`);
            await ev(`window.__m.add('helper', 'A', 6, { sleeping: false, session_id: 'helper-sid' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); window.switchNavTab('hub-inbox'); true`);
            if (!mobile) {
                await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]')`, at + 'the Artifacts folder', 10000);
                await ev(`document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]').click(); true`);
            } else await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'two rows', 10000);
            const rowText = await ev(`(() => { const r = [...document.querySelectorAll('#group-table-view tbody tr')].find(x => !/plan/i.test(x.textContent)); return r ? r.textContent.replace(/\\s+/g, ' ') : ''; })()`);
            const name = await ev(`(() => { const a = window.__qaState.liveSessions.find(s => s.session_id === 'helper-sid'); return a ? (a.display_name || a.name) : ''; })()`);
            assert.ok(name && rowText.includes(name) && !/No team/.test(rowText), at + `the row names the agent (${name}), not "No team": ` + rowText);
        }
        console.log('\nPASS Toasts leave, and a no-team file names its agent');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
