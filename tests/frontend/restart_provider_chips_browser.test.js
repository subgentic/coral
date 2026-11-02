// Restart with changes, the provider chips (#12169, the Hermes tester on f01c32aaa): with six providers the group's six equal columns left each chip less room than "not installed" needs, so the words were
// clipped ("install", "installe") at 1400 px. The chips keep their words whole: the group wraps to a second row rather than squeeze them (these chips are radios with names, for all six providers: none has a letter badge). Drives the real Restart dialog of a stubbed live agent; every provider but Claude is "not installed". 1400, 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { stubCliChecks } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1400, 900, false], [1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await stubCliChecks(ev, ['codex', 'agy', 'pi', 'opencode', 'hermes']);
            await ev(`(async () => { const st = await import(${S} + 'state.js'), rf = await import(${S} + 'restart_flow.js');
                st.state.currentSession = { type: 'live', name: 'Agent X', display_name: 'Agent X', session_id: 'aaaaaaaa-1212-4000-8000-000000000001', agent_type: 'claude' };
                rf.restartSession(); return true; })()`);
            await waitFor(`!!document.querySelector('#restart-modal .acf-agent-pick') && document.querySelector('#restart-modal .acf-agent-pick').dataset.probed === '1'`, at + 'the Restart dialog drew its provider chips', 15000);
            await ev(`import(${S} + 'restart_flow.js').then(m => { m.restartStage('agent'); return true; })`);
            await waitFor(`(() => { const g = document.querySelector('#restart-modal .acf-agent-pick'); return !!g && g.getClientRects().length > 0; })()`, at + 'the Settings step shows the chips', 8000);
            const m = await ev(`(() => { const g = document.querySelector('#restart-modal .acf-agent-pick'), gr = g.getBoundingClientRect();
                const chips = [...g.querySelectorAll('.launch-agent-opt')].map(l => { const name = l.querySelector('.launch-agent-name')?.textContent.trim(), miss = l.querySelector('.launch-agent-missing');
                    let clipped = false, text = '';
                    if (miss && miss.textContent.trim()) { text = miss.textContent.trim(); const r = document.createRange(); r.selectNodeContents(miss); const tr = r.getBoundingClientRect(); const lr = l.getBoundingClientRect();
                        clipped = r.getClientRects().length > 1 || miss.scrollWidth > miss.clientWidth + 1 || tr.right > lr.right + 1 || tr.right > gr.right + 1 || tr.left < gr.left - 1; }
                    return { name, text, clipped, inside: l.getBoundingClientRect().right <= gr.right + 1 && l.getBoundingClientRect().left >= gr.left - 1, w: Math.round(l.getBoundingClientRect().width) }; });
                return { chips, group: { w: Math.round(gr.width), over: g.scrollWidth - g.clientWidth }, page: document.scrollingElement.scrollWidth - innerWidth }; })()`);
            check(m.chips.length === 6, at + 'six chips: ' + JSON.stringify(m.chips.map(c => c.name)));
            for (const c of m.chips) {
                if (c.text) check(c.text === 'not installed' && !c.clipped, at + c.name + ' says "not installed" whole: ' + JSON.stringify(c));
                check(c.inside, at + c.name + "'s chip is inside the group (the row wraps, nothing runs past its end): " + JSON.stringify(c));
            }
            check(m.group.over <= 1 && m.page <= 1, at + 'nothing scrolls sideways: ' + JSON.stringify(m.group) + ' page ' + m.page);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('restart_provider_chips_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
