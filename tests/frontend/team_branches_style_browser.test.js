// The team page's Branches tab (#17433, walk 30 F5): its repositories sit in padded cards like the other tabs' bodies, not flush left, and the wait for the first read says how long it has been
// ("12 s so far"), not a bare "Reading". Real team on the isolated server, the branches answer stubbed. 1440 and 390 px.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'brstyle-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const STUB = `(() => { const real = window.fetch; window.__brAnswer = { repos: [] }; window.fetch = (u, o) => { const p = new URL(String(u), location.href);
        if (p.pathname === '/api/board/${B}/branches') return Promise.resolve(new Response(JSON.stringify(window.__brAnswer), { status: 200, headers: { 'content-type': 'application/json' } }));
        return real(u, o); }; })()`;
    const P = '#team-panel-branches';
    const reopen = async t => { await ev(`document.querySelector('[role="tab"][aria-controls="team-panel-${t}"]').click(); true`); await waitFor(`!document.getElementById('team-panel-${t}').hidden`, 'the ' + t + ' tab', 8000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B });
        for (const [w, mobile, tag] of [[1440, false, 'desktop'], [390, true, 'phone']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
            await Page.navigate({ url: BASE + '/team/' + B + '/branches' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await waitFor(`!!document.querySelector('${P} .empty-state')`, `${tag}: the waiting text`, 15000);
            await ev(`(() => { const t = Date.now; Date.now = () => t() + 20000; window.__restore = () => { Date.now = t; }; return true; })()`);
            await reopen('goals'); await reopen('branches'); // the tab is opened again: the same page module keeps how long it has waited
            await waitFor(`/\\d+ s so far/.test(document.querySelector('${P} .empty-state')?.textContent || '')`, `${tag}: the wait says how long`, 8000);
            await ev(`window.__restore(); window.__brAnswer = { repos: [{ remote: { host: 'github.com', owner: 'acme', name: 'app' }, base: 'main', worktrees: [{ branch: 'main', head: 'abc', main: true, ahead: 0, behind: 0, changed: 0, untracked: 0 }, { branch: 'feature', head: 'def', ahead: 2, behind: 1, changed: 3, untracked: 1 }] }] }; true`); await reopen('goals'); await reopen('branches');
            await waitFor(`!!document.querySelector('${P} .branches-repo')`, `${tag}: the repository card`, 8000);
            await ev(framesJs(4));
            const m = await ev(`(() => { const host = document.querySelector('${P}'), card = document.querySelector('${P} .branches-repo'), h = getComputedStyle(host), c = getComputedStyle(card), hr = host.getBoundingClientRect(), cr = card.getBoundingClientRect();
                return { padL: parseFloat(h.paddingLeft), padT: parseFloat(h.paddingTop), border: parseFloat(c.borderTopWidth), bg: c.backgroundColor, radius: parseFloat(c.borderTopLeftRadius), inset: Math.round(cr.left - hr.left), fits: cr.right <= hr.right + 0.5 }; })()`);
            check(m.padL >= (mobile ? 16 : 24) && m.padT >= 12, `${tag}: the tab is padded like the others: ` + JSON.stringify(m));
            check(m.border >= 1 && m.radius > 0 && m.bg !== 'rgba(0, 0, 0, 0)' && m.inset >= (mobile ? 16 : 24) && m.fits, `${tag}: the repository is a card inside it: ` + JSON.stringify(m));
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('team_branches_style_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
