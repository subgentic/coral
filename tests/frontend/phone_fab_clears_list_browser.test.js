// The phone's "+ New" button never covers the last agent card (#12634, coral-hub's beta pass): the Agents list was padded 40 px over the bottom bar, the extended button sits 16 px over the bar and is 56 px high, so the last card's
// Wake or its row, scrolled all the way up, stayed under the button. Now the list ends clear of it. 390 x 700 and 320 x 560 (a short, narrow phone), eight agents, real scroll to the end. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[390, 700], [320, 560]]) {
            const at = `${w} x ${h}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            const names = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];
            await ev(`for (const n of ${JSON.stringify(names)}) window.__m.add(n, 'A', 2, { sleeping: false, session_id: n + '-id', board_project: 'team-a' }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).length >= ${names.length}`, at + 'the agents', 10000);
            await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'), r = await import((window.__coralStatic || '/static/') + 'render.js'); r.renderLiveSessions(s.state.liveSessions); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('phone-nav')).display !== 'none' && document.querySelectorAll('#mobile-session-list .session-group-item').length >= 1 && getComputedStyle(document.getElementById('phone-fab')).display !== 'none'`, at + 'the home, its cards and the + New button', 10000);
            await ev(framesJs(10));
            const r = await ev(`(async () => { const list = document.getElementById('mobile-agent-list'); let sc = list; while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement; sc = sc || document.scrollingElement; sc.scrollTop = sc.scrollHeight; await new Promise(r => setTimeout(r, 200)); // sleep-ok: the list settles after the jump
                const kids = [...document.querySelectorAll('#mobile-session-list .session-group-item')].filter(c => c.getClientRects().length), last = kids[kids.length - 1], f = document.getElementById('phone-fab').getBoundingClientRect(), l = last.getBoundingClientRect(); return { n: kids.length, lastBottom: Math.round(l.bottom), fabTop: Math.round(f.top), fabLeft: Math.round(f.left), lastRight: Math.round(l.right), scrolls: sc.scrollHeight > sc.clientHeight + 4 }; })()`);
            check(at + 'the list scrolls (eight agents on a short phone)', r.scrolls, JSON.stringify(r));
            const need = await ev(`(() => { const f = document.getElementById('phone-fab').getBoundingClientRect(), pad = parseFloat(getComputedStyle(document.getElementById('mobile-agent-list')).paddingBottom); return { pad: Math.round(pad), fromFabTopToBottom: Math.round(innerHeight - f.top) }; })()`);
            check(at + 'the list ends clear of the + New button even where the list reaches the screen\'s bottom (the Hub\'s page does): its bottom padding is at least the button\'s top edge to the screen\'s bottom', need.pad >= need.fromFabTopToBottom, JSON.stringify(need));
            check(at + 'scrolled to the end, the last card is above the + New button', r.lastBottom <= r.fabTop, JSON.stringify(r));
        }
    } finally { await client.close(); }
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    console.log('phone_fab_clears_list_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
