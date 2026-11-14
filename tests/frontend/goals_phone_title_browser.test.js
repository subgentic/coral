// The phone Goals list gives a goal's title the whole row (#15343, the operator: "more room for the initial title, 2 lines for the description"): the state and task count ('Active · 118/158') no longer take
// a column beside the title, so a long title shows at least 30 characters, may take a second line, and the outcome under it has two lines before its ellipsis. 390 px as touch, on the team page and in the Inbox; 1280 is unchanged.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'goalstitle-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const TITLE = "A new user's first task is to build a small app with the team and ship it to the hub", OUTCOME = 'The outcome is long on purpose so that it needs more than one line on a phone and more than two lines of words to say it all, and then ends in an ellipsis rather than growing the row without end.';
    const probe = `(() => { const r = [...document.querySelectorAll('ROOT tbody tr:not(.dt-group)')].find(x => x.textContent.includes('first task')), t = r.querySelector('.dt-mail-title'), a = r.querySelector('.dt-mail-ask'), s = r.querySelector('.dt-mail-time'), text = r.querySelector('.dt-mail-text'), rect = e => e.getBoundingClientRect();
        const lines = e => Math.round(rect(e).height / parseFloat(getComputedStyle(e).lineHeight));
        const range = document.createRange(); range.selectNodeContents(t); const shown = (() => { let n = 0; const cs = getComputedStyle(t); const lh = parseFloat(cs.lineHeight) || 16; const rects = [...range.getClientRects()]; return { rects: rects.length, tW: Math.round(rect(t).width), textW: Math.round(rect(text).width) }; })();
        return { tW: shown.tW, textW: shown.textW, tLines: lines(t), aLines: lines(a), tClamp: getComputedStyle(t).webkitLineClamp, aClamp: getComputedStyle(a).webkitLineClamp, aOver: a.scrollHeight > a.clientHeight + 1, side: s.textContent.trim(), titleVisible: Math.floor(rect(t).width / 7.2), sideTop: Math.round(rect(s).top), askBottom: Math.round(rect(a).bottom), titleCut: t.scrollHeight > t.clientHeight + 1 }; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B });
        for (const t of [TITLE, 'Short goal', 'Another long goal title that wraps on a phone, which is fine']) check((await api('POST', '/goals', { subscriber_id: 'Operator', title: t, outcome: OUTCOME })).status < 300, 'create ' + t);
        for (const where of ['team', 'inbox']) {
            const at = `${where} 390 px: `, root = where === 'team' ? '#team-panel-goals' : '#group-table-view';
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + (where === 'team' ? '/team/' + B + '/goals' : '/') }); await Page.loadEventFired(); await install(); await coralReady(ev);
            if (where === 'inbox') { await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`); await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('goals')).then(() => true)`); }
            await waitFor(`document.querySelectorAll('${root} tbody tr:not(.dt-group)').length >= 3`, at + 'the goal rows', 15000);
            await ev(framesJs(6));
            const m = await ev(probe.replace('ROOT', root));
            check(m.tW >= m.textW - 12, at + 'the title takes the whole text column: ' + JSON.stringify(m));
            check(m.titleVisible >= 30 || m.tW >= 216, at + 'the title shows at least 30 characters: ' + JSON.stringify(m));
            check(m.tLines <= 2 && m.tClamp === '2', at + 'the title is at most two lines: ' + JSON.stringify(m));
            check(m.aLines === 2 && m.aClamp === '2' && m.aOver, at + 'the description has two lines and ends in an ellipsis: ' + JSON.stringify(m));
            check(/^Active/.test(m.side) && m.sideTop >= m.askBottom - 2, at + 'the state sits under the description, not beside the title: ' + JSON.stringify(m));
        }
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/team/' + B + '/goals' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await waitFor(`document.querySelectorAll('#team-panel-goals tbody tr:not(.dt-group)').length >= 3`, '1280 px: the goal rows', 15000);
        check(await ev(`!document.querySelector('#team-panel-goals .dt-mail-title')`), '1280 px: a computer keeps its table (no phone rows)');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('goals_phone_title_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
