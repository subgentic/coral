// A phone's goal row does not say its title twice (walk 47, #17032): a goal whose description is its title shows the title once, no second line; a goal with a different description keeps it.
// Real goals on the isolated server, 390 px as touch. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'goalsrepeat-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const P = '#team-panel-goals';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B });
        check((await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Build the recipe book', outcome: 'Build the recipe book', done_when: 'it is done' })).status === 201, 'made the goal whose description is its title');
        check((await api('POST', '/goals', { subscriber_id: 'Operator', title: 'Write the docs', outcome: 'A short guide a newcomer can follow.', done_when: 'it is done' })).status === 201, 'made the goal with its own description');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/team/' + B + '/goals' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`document.querySelectorAll('${P} tbody tr').length >= 2`, 'the goal rows', 15000);
        await ev(framesJs(6));
        const rows = await ev(`[...document.querySelectorAll('${P} tbody tr')].map(r => ({ title: (r.querySelector('.dt-mail-title') || {}).textContent || '', ask: (r.querySelector('.dt-mail-ask') || {}).textContent || '' }))`);
        const same = rows.find(r => r.title === 'Build the recipe book'), own = rows.find(r => r.title === 'Write the docs');
        check(!!same && same.ask === '', 'a goal whose description is its title shows no second line: ' + JSON.stringify(same));
        check(!!own && own.ask === 'A short guide a newcomer can follow.', 'a goal with its own description keeps it: ' + JSON.stringify(own));
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('goals_phone_no_repeat_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
