// The Needs you page title is never cut (#12149, Beta Tester on v2.0.31): at 1280x900, dark theme, the Inbox sidebar open and the alert banner showing, a Needs you with ten items and its six filter chips ("All 10 of 13",
// "Permission", "Question", "Needs input 9", "For review 1", "Welcome 3") cut the title to "Nee…" because the title shrank to give the chips room. The title keeps its width; the search box and the chips give way.
// Real Welcome items, nine questions to the Operator and one file for review, stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const team = 'title-' + Date.now().toString(36), S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 900], [1440, 900], [1100, 800]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', 'dark'); fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const items = [{ id: hex(1), name: 'sprout-design.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Lead Developer', review_question: 'Ship it?' }];
                window.__asks = Array.from({ length: 9 }, (_, i) => ({ board: '${team}', kind: 'ask', id: 100 + i, asker: 'Orchestrator', text: '@Operator Sprout question number ' + (i + 1) + ': which way should it go?', at: new Date(Date.now() - (i + 1) * 60000).toISOString() }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (String(url) === '/api/operator-asks') return json(window.__asks);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`import(${S} + 'state.js').then(m => { m.state.settings = { ...m.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; return true; })`); // the three Welcome items of a new Coral
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 9`, at + 'the rows are there', 15000);
            await ev(framesJs(4));
            const m = await ev(`(() => { const t = document.getElementById('group-table-title'); if (!t) return null; const r = document.createRange(); r.selectNodeContents(t); return { text: t.textContent.trim(), w: Math.round(t.getBoundingClientRect().width), need: Math.ceil(r.getBoundingClientRect().width), cut: t.scrollWidth > t.clientWidth + 1, chips: [...document.querySelectorAll('${T} .goals-chips button, ${T} .list-bar-chips button')].map(c => c.textContent.trim()), kids: [...(t.closest('.gt-toolbar') || t.parentElement).children].map(c => c.tagName + '.' + String(c.className).slice(0, 28) + ':' + Math.round(c.getBoundingClientRect().width)), over: document.documentElement.scrollWidth - innerWidth }; })()`);
            check(!!m, at + 'the page has its title');
            if (m) {
                check(m.text === 'Needs you' && !m.cut && m.w >= m.need, at + 'the title is whole and not cut: ' + JSON.stringify(m));
                check(m.over <= 1, at + 'and nothing scrolls the page sideways: ' + JSON.stringify(m));
            }
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_title_whole_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
