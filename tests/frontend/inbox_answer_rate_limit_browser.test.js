// #14728 (the Operator's screenshot, Security's ruling (b)): Codex's "Approaching rate limits" notice has three choices: 1 Switch to <model>, 2 Keep current model, 3 Keep current model (never show again). A list row
// draws a choice as a button only if it is one-time (#10400): 'Switch to ...' changes how the agent runs and is held, and "never show again" is a lasting setting, which was DRAWN as a button because the held words
// did not include 'never'. Now both are held: the row has one button, Keep current model, and says the rest is left to Open agent. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__posts = [];
                const NOTICE = { question: 'Approaching rate limits Switch to gpt-6-luna for lower credit usage?', ask_id: 'rl1', options: [
                    { n: 1, label: 'Switch to gpt-6-luna Fast and affordable model for easier tasks', action: 'select' },
                    { n: 2, label: 'Keep current model', action: 'select' },
                    { n: 3, label: 'Keep current model (never show again) Hide future rate limit reminders about', action: 'select' }] };
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase(), json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__posts.push(JSON.parse(o.body)); return json({ answered: 'x', ok: true }); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return json({ messages: [], total: 0, prompt_options: NOTICE });
                    return real(u, o); };
                true`);
            await ev(`(async () => { const m = await import(${MOD} + 'inbox_answer.js'); const cell = m.answerCell({ name: 'codex-rl', session_id: 'sess-rl', agent_type: 'codex', waiting_since: 'trl', waiting_summary: 'Approaching rate limits', waiting_kind: 'question' }); document.body.append(cell); window.__cell = cell; return true; })()`);
            await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length >= 1`, `${label}: the row draws its choices`, 8000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the choices are read once, then drawn
            const buttons = await ev(`[...window.__cell.querySelectorAll('button:not(.inbox-dismiss)')].map(b => b.textContent.trim())`);
            assert.deepEqual(buttons, ['Keep current model'], `${label}: only the one-time choice is a button (not the model switch, and not "never show again"): ` + JSON.stringify(buttons));
            const note = await ev(`window.__cell.textContent`);
            assert.match(note, /More choices: open the agent/i, `${label}: the row says the rest is left to Open agent: ${note}`);
            assert.equal(await ev(`window.__posts.length`), 0, `${label}: nothing was sent`);
            await ev(`window.__cell.remove(); true`);
        }
        console.log('PASS the Codex rate-limit notice: only Keep current model is a button, the model switch and "never show again" are left to Open agent, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
