// An empty Needs you stays what it says while a background read runs (#14906, inbox_local's Linux retry-pass: the hint under 'You are all caught up' was there, gone and there again within a few ms): once the page has been read, a refresh of
// it (the poll, a computer's list arriving, an Inbox redraw) is not 'loading' as far as the empty line goes. The line and its hint are drawn again only if their words change; a first read, a source that has not answered yet,
// still says Loading. Nothing waits here: the answer of a second read is held for 600 ms and the line and its hint must be the very same nodes the whole time. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.__artDelay = 0; window.__artCalls = 0;
            window.fetch = (u, o) => { const url = new URL(String(u), location.href); if (url.pathname === '/api/team-artifacts') { window.__artCalls++; if (window.__artDelay) return real(u, o).then(r => new Promise(res => setTimeout(() => res(r), window.__artDelay))); } return real(u, o); }; })();` });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`/You are all caught up/.test(document.getElementById('group-table-view').innerText) && !!document.querySelector('#group-table-view .empty-state-hint')`, `${at}the empty Needs you with its hint`, 15000);
            await ev(`(() => { const g = document.getElementById('group-table-view'); window.__line = g.querySelector('.empty-state-line'); window.__hint = g.querySelector('.empty-state-hint'); window.__gone = []; window.__artDelay = 600;
                new MutationObserver(() => { const l = g.querySelector('.empty-state-line'), hi = g.querySelector('.empty-state-hint'); if (l !== window.__line || hi !== window.__hint) window.__gone.push([Math.round(performance.now()), l === window.__line ? 'line same' : l ? 'line NEW' : 'line NONE', hi === window.__hint ? 'hint same' : hi ? 'hint NEW' : 'hint NONE']); }).observe(g, { childList: true, subtree: true });
                import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)); return true; })()`);
            await waitFor(`window.__artCalls >= 2`, `${at}a second read is out`, 8000);
            await ev(`document.dispatchEvent(new CustomEvent('coral:reviews-settled')); true`); // an Inbox redraw while the read is out (the poll, a computer's list arriving)
            await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the held answer lands at 600 ms: the line must not have blinked
            const r = await ev(`({ gone: window.__gone, sameLine: window.__line === document.querySelector('#group-table-view .empty-state-line') && window.__line.isConnected, sameHint: window.__hint === document.querySelector('#group-table-view .empty-state-hint') && window.__hint.isConnected })`);
            check(r.gone.length === 0 && r.sameLine && r.sameHint, `${at}the empty line and its hint stay the same nodes while a refresh is out: ${JSON.stringify(r)}`);
            await ev(`window.__artDelay = 0; true`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('needs_empty_steady_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
