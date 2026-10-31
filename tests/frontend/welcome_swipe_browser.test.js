// Swipe a welcome row away on a phone (#11542, the operator; the mockup is #11536): a left drag past 40% of the row (or a flick) dismisses it and says so with Undo; less than that springs back; a vertical drag is the page's;
// the visible Dismiss button stays and works without a toast; "Welcome to Coral" (no Dismiss) is not swipeable; Undo puts the item back and turns the items on again; with reduced motion nothing slides. Real touch gestures
// (CDP Input) at 390 px, the settings save answered in the page. Drives Chrome through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const touch = (type, x, y) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const wait = ms => ev(`new Promise(r => setTimeout(r, ${ms}))`); // sleep-ok: a finger's pace between two moves (12 ms)
    const frames = n => ev(framesJs(n)); // the page has drawn: a spring back or a slide is a few frames
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__puts = []; window.__teams = []; window.__realFetch = window.__realFetch || window.fetch; window.fetch = (u, o) => { const s = String(u), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (s.includes('/api/board/projects')) return json(window.__teams);
            if (s.includes('/api/settings') && o && o.method === 'PUT') { window.__puts.push(JSON.parse(o.body)); return json({ ok: true }); }
            return window.__realFetch(u, o); };
            T.state.settings = { ...T.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; T.state.liveSessions = []; T.state.servers = []; true`);
        await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view .inbox-welcome-name').length === 5`, 'five welcome items', 8000);
        await waitFor(`!!document.querySelector('.inbox-needs-results')._welcomeSwipe`, 'the swipe is attached (lazy, for a touch screen)', 8000);
        const titles = () => ev(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].map(e => e.firstChild.textContent)`);
        const rowOf = title => `[...document.querySelectorAll('#group-table-view tbody tr')].find(tr => (tr.querySelector('.inbox-welcome-name') || {}).firstChild && tr.querySelector('.inbox-welcome-name').firstChild.textContent === ${JSON.stringify(title)})`;
        const geo = title => ev(`(() => { const tr = ${rowOf(title)}; tr.scrollIntoView({ block: 'center' }); const r = tr.getBoundingClientRect(); return { left: r.left, right: r.right, y: r.top + r.height / 2, width: r.width, id: tr.dataset.welcomeId || '', transform: tr.style.transform, transition: tr.style.transition }; })()`);
        const swipe = async (g, dx, dy = 0, steps = 8, pause = 12) => { const x0 = g.right - 24; await touch('touchStart', x0, g.y); for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + dx * i / steps, g.y + dy * i / steps); await wait(pause); } return x0 + dx; };
        const AGENT = 'Start your first agent';

        // the rows with a Dismiss carry the id; Welcome (Got it, no Dismiss) does not
        check((await geo(AGENT)).id === 'agent' && (await geo('Welcome to Coral')).id === '', 'the rows with a Dismiss are swipeable, "Welcome to Coral" is not');

        // a short drag (a sixth of the row, slow): it follows the finger, then springs back, and nothing is dismissed
        let g = await geo(AGENT), end = await swipe(g, -g.width / 6);
        const mid = await ev(`(() => { const tr = ${rowOf(AGENT)}; return { t: tr.style.transform, strip: !!document.querySelector('.inbox-swipe-strip'), stripText: (document.querySelector('.inbox-swipe-strip') || {}).textContent }; })()`);
        check(/translateX\(-/.test(mid.t) && mid.strip && mid.stripText === 'Dismiss', 'while the finger is down the row follows it and "Dismiss" shows behind it: ' + JSON.stringify(mid));
        await touch('touchEnd', end, g.y); await frames(40);
        const back = await geo(AGENT);
        check(back.transform === '' && !(await ev(`!!document.querySelector('.inbox-swipe-strip')`)) && (await titles()).includes(AGENT) && !(await ev(`window.__puts`)).length, 'a short drag springs back and dismisses nothing: ' + JSON.stringify(back));

        // a vertical drag is the page's: nothing slides, nothing is dismissed
        g = await geo(AGENT); end = await swipe(g, -6, 120); await touch('touchEnd', end, g.y + 120); await frames(30);
        check((await geo(AGENT)).transform === '' && (await titles()).includes(AGENT) && !(await ev(`window.__puts`)).length, 'a mostly vertical drag does not swipe the row');

        // a long drag dismisses it, with Undo
        await ev(`window.__said = []; new MutationObserver(recs => { for (const r of recs) { const t = (r.target.textContent || ''); if (t) window.__said.push(t); } }).observe(document.body, { childList: true, characterData: true, subtree: true }); true`); // what is written into the page while it happens: a live region says its words and clears them
        g = await geo(AGENT); end = await swipe(g, -g.width * 0.7); await touch('touchEnd', end, g.y);
        await waitFor(`!(${'[...document.querySelectorAll(\'#group-table-view .inbox-welcome-name\')]'}.some(e => e.firstChild.textContent === ${JSON.stringify(AGENT)}))`, 'the row is dismissed', 6000).catch(() => {});
        check(!(await titles()).includes(AGENT) && (await titles()).length === 4, 'a long drag dismisses the row: ' + JSON.stringify(await titles()));
        const puts = await ev(`window.__puts`);
        check(puts.some(p => String(p.inbox_welcome_done || '').split(',').includes('agent')), 'the dismissal is saved like the button\'s: ' + JSON.stringify(puts));
        const toast = await ev(`(() => { const t = [...document.querySelectorAll('.toast')].find(x => /Dismissed: Start your first agent/.test(x.textContent)); return t ? { text: t.textContent.replace(/\\s+/g, ' ').trim(), undo: !!([...t.querySelectorAll('button')].find(b => b.textContent.trim() === 'Undo')), x: 1} : null; })()`);
        await waitFor(`window.__said.some(t => /Dismissed: Start your first agent\\. Undo is in the notice/.test(t))`, 'the announcement is made', 3000).catch(() => {});
        check(!!toast && toast.undo && (await ev(`window.__said.some(t => /Dismissed: Start your first agent\\. Undo is in the notice/.test(t))`)), 'a toast says it, with Undo, and a polite announcement reads it out: ' + JSON.stringify(toast));

        // Undo puts it back and the items are on
        await ev(`[...document.querySelectorAll('.toast')].find(x => /Dismissed: Start your first agent/.test(x.textContent)).querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); }); true`);
        await waitFor(`[...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.firstChild.textContent === ${JSON.stringify(AGENT)})`, 'Undo brings the row back', 6000).catch(() => {});
        const after = await ev(`window.__puts`);
        check((await titles()).includes(AGENT) && after.some(p => p.inbox_welcome === 'on' && !String(p.inbox_welcome_done).split(',').includes('agent')), 'Undo puts the row back and saves it: ' + JSON.stringify(after.slice(-1)));

        // the visible Dismiss button is the same dismissal, with no Undo toast
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); [...${rowOf('Make a team so agents can work together')}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Dismiss').click(); true`);
        await waitFor(`![...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.firstChild.textContent === 'Make a team so agents can work together')`, 'the Dismiss button dismisses', 6000).catch(() => {});
        check(!(await titles()).includes('Make a team so agents can work together') && !(await ev(`[...document.querySelectorAll('.toast')].some(t => /Undo/.test(t.textContent))`)), 'the Dismiss button still works and offers no Undo');

        // reduced motion: the drag still dismisses, and a short one does not animate back
        await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        g = await geo('Connect a second computer or the Hub'); end = await swipe(g, -g.width / 6); await touch('touchEnd', end, g.y); await frames(20);
        check((await geo('Connect a second computer or the Hub')).transition === 'none', 'with reduced motion the row does not slide back');
        g = await geo('Connect a second computer or the Hub'); end = await swipe(g, -g.width * 0.7); await touch('touchEnd', end, g.y);
        await waitFor(`![...document.querySelectorAll('#group-table-view .inbox-welcome-name')].some(e => e.firstChild.textContent.startsWith('Connect a second computer'))`, 'dismissed with reduced motion', 6000).catch(() => {});
        check(!(await titles()).some(t => t.startsWith('Connect a second computer')), 'with reduced motion a long drag still dismisses');
    } finally { await client.close(); }
    if (found.length) { console.error(found.join('\n')); process.exit(1); }
    console.log('welcome_swipe_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
