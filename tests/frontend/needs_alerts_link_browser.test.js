// A lasting way to turn alerts on (#11837, moment 11): the one-time banner was dismissed and two questions waited 14 and 29 minutes unseen. Needs you carries a quiet line, "Get an alert when an agent waits for you
// while you are in another tab. [Turn on alerts]", for as long as this browser could turn alerts on and has not: with nothing waiting and with rows, on a desktop and a phone; the button asks the browser (the
// same call as the banner's and Settings > Notifications), the line goes when alerts are on, and it is not there when alerts are on already or the browser blocks them. The browser's Notification is a page stub.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], team = 'alerts-' + Date.now().toString(36), T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const STUB = `(() => { const perm = () => localStorage.getItem('__perm') || 'default'; class N { constructor() {} close() {} static get permission() { return perm(); } static async requestPermission() { localStorage.setItem('__perm', 'granted'); return 'granted'; } } window.Notification = N; })();`;
    const link = () => ev(`(() => { const p = document.querySelector('${T} .inbox-alerts-link'); return p ? { text: p.textContent.replace(/\\s+/g, ' ').trim(), button: !!p.querySelector('button'), shown: p.getClientRects().length > 0, inside: !!p.closest('${T}') } : null; })()`);
    const open = async (w, mobile, withRows) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        if (withRows) {
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })), hex = n => n.toString(16).padStart(64, '0');
                const items = [1, 2].map(i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - i * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'Ready?', uri: 'coral://artifacts/' + hex(i) }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin); if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); return original(url, opts); }; return true; })()`);
        }
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        if (withRows) await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 2`, 'two rows', 15000);
        await ev(framesJs(6));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, mobile] of [[1280, false], [390, true]]) for (const withRows of [false, true]) {
            const at = `${w} px, ${withRows ? 'with rows' : 'nothing waiting'}: `;
            await open(w, mobile, false); await ev(`localStorage.removeItem('__perm'); localStorage.removeItem('coral-desktop-notify'); true`);
            await open(w, mobile, withRows);
            const l = await link();
            check(!!l && l.button && l.shown && l.inside, at + 'the line is under Needs you: ' + JSON.stringify(l));
            check(!!l && /^Get an alert when an agent waits for you while you are in another tab\. Turn on alerts$/.test(l.text), at + 'it says: ' + (l && l.text));
            if (withRows) await shot(`needs-alerts-link-${w}`);
            await ev(`document.querySelector('${T} .inbox-alerts-link button').click(); true`);
            await waitFor(`!document.querySelector('${T} .inbox-alerts-link')`, at + 'the line goes when alerts are on', 6000).catch(() => {});
            check(!(await link()) && (await ev(`localStorage.getItem('coral-desktop-notify')`)) === '1', at + 'alerts are on and the line is gone');
            await open(w, mobile, withRows);
            check(!(await link()), at + 'with alerts on, a later visit has no line');
            await ev(`localStorage.removeItem('coral-desktop-notify'); localStorage.setItem('__perm', 'denied'); true`);
            await open(w, mobile, withRows);
            check(!(await link()), at + 'with the browser blocking alerts the line is not offered');
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_alerts_link_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
