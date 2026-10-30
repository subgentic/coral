// OPERATOR (#11063): "Show model flag, should also show the thinking level." With Show model on, the row's line reads "Opus 5.5 · High": the level the newest turn ran at (thinking_actual), else the level the agent was
// started with (thinking), the same rule as the chat bar's thinking chip (model_labels.js sessionLevel). No level on record: the model alone, never a word for it. Still one quiet line (no extra line, truncated
// with an ellipsis when narrow). At 1280 px (the sidebar's panel) and 390 px (the phone's), and at 200% text. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const BASE_ROW = { session_id: 'l1', name: 'coral-go', display_name: 'Worker', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', working_directory: '/work/coral', repo_name: 'coral' };
    const CASES = [
        ['a level the newest turn ran at', { thinking_actual: 'high' }, 'Opus 5.5 · High'],
        ['only the level it was started with', { thinking: 'xhigh' }, 'Opus 5.5 · Extra high'],
        ['both: what it ran at wins', { thinking: 'low', thinking_actual: 'max' }, 'Opus 5.5 · Max'],
        ['no level on record', {}, 'Opus 5.5'],
    ];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, h, mobile, list] of [['1280', 1280, 800, false, '#live-sessions-list'], ['390', 390, 844, true, '#mobile-session-list']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`try { localStorage.removeItem('coral-show-summary'); localStorage.setItem('coral-show-model', 'true'); } catch (e) {} true`);
            for (const [what, extra, want] of CASES) {
                const row = { ...BASE_ROW, ...extra };
                await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([row])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
                if (mobile) await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`);
                await waitFor(`!!document.querySelector('${list} .session-group-item .session-model')`, `${tag}: ${what}: the model line`, 6000);
                const got = await ev(`(() => { const li = document.querySelector('${list} .session-group-item'); const m = li.querySelector('.session-model'); return { text: m.textContent, lines: li.querySelectorAll('.session-model').length, oneLine: m.getBoundingClientRect().height < parseFloat(getComputedStyle(m).fontSize) * 2 }; })()`);
                assert.equal(got.text, want, `${tag}: ${what}: the line reads ${JSON.stringify(want)}, not ${JSON.stringify(got.text)}`);
                assert.ok(got.lines === 1 && got.oneLine, `${tag}: ${what}: still one line: ${JSON.stringify(got)}`);
            }
            // a long model name and a level at 200% text: one line, cut with an ellipsis, not wrapped onto a second line
            await ev(`document.documentElement.style.fontSize = '200%'; true`);
            const row = { ...BASE_ROW, model: 'claude-opus-5-5', thinking_actual: 'xhigh' };
            await ev(`(async () => { T.state.liveSessions = ${JSON.stringify([row])}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            if (mobile) await ev(`import((window.__coralStatic || '/static/') + 'mobile.js').then(m => { m.syncMobileAgentList(); return true; })`);
            const big = await ev(`(() => { const m = document.querySelector('${list} .session-group-item .session-model'); const cs = getComputedStyle(m); return { nowrap: cs.whiteSpace === 'nowrap', ellipsis: cs.textOverflow === 'ellipsis', h: Math.round(m.getBoundingClientRect().height), fs: parseFloat(cs.fontSize) }; })()`);
            assert.ok(big.nowrap && big.ellipsis && big.h < big.fs * 2, `${tag}: at 200% text the line is one line, truncated: ${JSON.stringify(big)}`);
            await ev(`document.documentElement.style.fontSize = ''; true`);
            console.log(`${tag}: Show model reads model · level, the model alone with none, one line`);
        }
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
