// probe
// exists, a computer or the Hub is connected), read or dismissed; they are not in the Inbox badge; Hide all welcome items puts them away; an empty Needs you says "Nothing needs you" with a way to Agents; an install
// without the setting never sees them. At 1280 and 390 px, through agent_view_harness.js against the isolated dev server (the settings the page keeps are put in its state; the PUTs are answered here).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            // the page's own state: a new install (the setting on, nothing done), no agents, no computers; the team list and the settings save are answered here
            await ev(`window.__puts = []; window.__teams = []; window.__realFetch = window.__realFetch || window.fetch; window.fetch = (u, o) => { const s = String(u), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (s.includes('/api/board/projects')) return json(window.__teams);
                if (s.includes('/api/settings') && o && o.method === 'PUT') { window.__puts.push(JSON.parse(o.body)); return json({ ok: true }); }
                return window.__realFetch(u, o); };
                T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; T.state.liveSessions = []; T.state.servers = []; true`);
            // a button of the list, pressed once it is there: the list is redrawn when the proposals and the settings are read, so a button found a moment ago may be gone
            const press = async (label, sel = '#group-table-view button', nth = 0) => { await waitFor(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.textContent === ${JSON.stringify(label)}).length > ${nth}`, `${tag}: the ${label} button`, 8000); await ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.textContent === ${JSON.stringify(label)})[${nth}].click(); true`); };
            const open = () => ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            const titles = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-review-name')].map(e => e.firstChild ? e.firstChild.textContent : '')`);
            await open();
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-review-name').length === 5`, `${tag}: five welcome items`, 8000);
            const folderCount = () => ev(`[...document.querySelectorAll('.view-list-item')].filter(r => r.querySelector('.view-list-name, .view-list-label') && /Needs you$/.test(r.querySelector('.view-list-label').textContent.trim())).map(r => (r.querySelector('.view-list-count') || {}).textContent)`);
            const pills = () => ev(`[...document.querySelectorAll('button.goals-chip')].map(e => e.textContent.trim())`);
            const counts = await folderCount();
            check(counts.length > 0 && counts.every(c => c === '5'), `${tag}: the Needs you folder counts the five welcome items the list shows: ` + JSON.stringify(counts));
            check(await ev(`[...document.querySelectorAll('.view-list-item')].filter(r => /Needs you$/.test((r.querySelector('.view-list-label') || {}).textContent || '')).every(r => r.querySelector('.view-list-count') && !r.querySelector('.view-list-count').classList.contains('view-list-alert'))`), `${tag}: the count of welcome items alone is not drawn as an alert`);
            const chips = await pills();
            check(chips.includes('All 5') && chips.includes('Welcome 5') && chips.includes('Needs input 0'), `${tag}: the pills file them under Welcome, not Needs input: ` + JSON.stringify(chips));
            check(await ev(`document.getElementById('nav-tab-hub-inbox-badge').hidden || document.getElementById('nav-tab-hub-inbox-badge').textContent === ''`), `${tag}: the items are still not in the Inbox badge`);
            const names = await ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].map(e => ({ t: e.firstChild ? e.firstChild.textContent : '', ws: getComputedStyle(e).whiteSpace, cut: e.scrollWidth > e.clientWidth + 1, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || 20)) }))`);
            check(names.length === 5 && names.every(n => n.ws === 'normal' && !n.cut), `${tag}: no welcome title is cut: ` + JSON.stringify(names));
            if (mobile) check(names.some(n => n.lines > 1), `${tag}: a long title wraps beside its button: ` + JSON.stringify(names));
            if (mobile) { // the buttons of the five rows line up whatever the title's width (#11536): one left edge and width for the action, one left edge for Dismiss
                const geo = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view tbody tr')]; const box = b => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), Math.round(r.height)]; }; return { actions: rows.map(r => r.querySelector('.inbox-welcome-actions .btn-primary')).filter(Boolean).map(box), dismiss: rows.flatMap(r => [...r.querySelectorAll('.inbox-welcome-actions .btn-quiet')].map(box)) }; })()`);
                check(geo.actions.length === 5 && new Set(geo.actions.map(g => g.join())).size === 1, `${tag}: the five action buttons share one left edge and one size: ` + JSON.stringify(geo.actions));
                check(geo.dismiss.length === 4 && new Set(geo.dismiss.map(g => g.join())).size === 1, `${tag}: the four Dismiss buttons share one left edge and one size: ` + JSON.stringify(geo.dismiss));
                check(geo.actions.every(g => g[2] >= 44) && geo.dismiss.every(g => g[2] >= 44), `${tag}: every button is a 44 px target`);
            }
            await shot(`inbox-welcome-counts-${w}`);
            await press('Hide all welcome items');
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 0`, `${tag}: the items put away`, 8000);
            const after = await folderCount(), chipsAfter = await pills();
            check(after.every(c => c === '0' || c === '' || c == null) && !chipsAfter.some(c => /^Welcome/.test(c)), `${tag}: the count and the Welcome pill go with them: ` + JSON.stringify([after, chipsAfter]));
        }
    } finally { await client.close(); }
    if (found.length) { console.error(found.join('\n')); process.exit(1); }
    console.log('inbox_welcome_counts_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
