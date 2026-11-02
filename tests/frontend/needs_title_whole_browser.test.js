// The Needs you page title stays whole beside the filter chips (#12455, Mobile Beta Tester #12450 item 4): at 1280 and 1100 px with the sidebar open the chips took the room and the title read "Nee…". The chips scroll
// sideways or give way first; the title (an h2 with an ellipsis for a long name) is never what gives. Many chips are drawn here (a Needs you page with every kind of item has seven or eight).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const ago = min => new Date(Date.now() - min * 60000).toISOString();
    const trust = { why: 'a prompt is open: Quick safety check: Is this a project you trust?', what: 'board message', at: ago(0), since: ago(12) };
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [1280, 1100]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => { const st = await import(${S} + 'state.js'); st.state.liveSessions = [{ session_id: 'd1', name: 'coral-d1', display_name: 'Security Reviewer', agent_type: 'claude', model: 'claude-opus-5-5', server: 'local', board_unread: 5, working: false, context_pct: null, skipped_send: ${JSON.stringify(trust)} }]; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view tbody tr') && !!document.querySelector('.inbox-folder-head h2') && !!document.querySelector('.goals-chips-row')`, `${w}: the page and its chips`, 15000);
            // a Needs you page with every kind of item has more chips than the one stubbed row makes (seven or eight, 700 px or more): a filler of that width is put in the chip row, the layout is read in the same step (the page
            // would redraw its own chips between steps), and the filler is taken out again
            const m = await ev(`(() => { const h = document.querySelector('.inbox-folder-head h2'), head = h.parentElement, bar = head.parentElement, row = bar.querySelector('.goals-chips-row'), field = bar.querySelector('.inbox-pill-field'), host = row && row.getClientRects().length ? row : field, r = e => e.getBoundingClientRect();
                const filler = document.createElement('span'); filler.style.cssText = 'flex: none; width: 760px; height: 20px; display: inline-block'; if (host) host.append(filler); // the chips at 1280; below 46 rem (1100 px) the select takes their place and has no row to fill
                const range = document.createRange(); range.selectNodeContents(h);
                const out = { text: h.textContent.trim(), need: Math.ceil(range.getBoundingClientRect().width), w: Math.round(r(h).width), cut: h.scrollWidth > h.clientWidth + 1, headW: Math.round(r(head).width), bar: Math.round(r(bar).width), host: host ? host.className.toString().slice(0, 30) : 'none', page: document.documentElement.scrollWidth - document.documentElement.clientWidth, over: Math.round([...bar.children].filter(c => c.getClientRects().length).reduce((n, c) => Math.max(n, r(c).right), 0) - r(bar).right) };
                filler.remove(); return out; })()`);
            check(m.text === 'Needs you' && !m.cut && m.w >= m.need, `${w} px: the title is whole beside the chips: ` + JSON.stringify(m));
            check(m.page <= 0 && m.over <= 1, `${w} px: no sideways page scroll, nothing in the toolbar past its end: ` + JSON.stringify(m));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exitCode = 1; } else console.log('PASS the Needs you title is whole beside the chips');
})().catch(e => { console.error(e); process.exitCode = 1; });
