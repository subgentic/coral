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
            await ev(`window.__posts = []; window.__offer = false;
                const NOTICE = () => ({ question: 'Approaching rate limits Switch to gpt-6-luna for lower credit usage?', ask_id: 'rl1', options: [
                    { n: 1, label: 'Switch to gpt-6-luna Fast and affordable model for easier tasks', action: 'select' },
                    { n: 2, label: 'Keep current model', action: 'select' },
                    { n: 3, label: 'Keep current model (never show again) Hide future rate limit reminders about', action: 'select' }], ...(window.__offer ? { rate_limit_offer: { model: 'gpt-6-luna' } } : {}) });
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase(), json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__posts.push(JSON.parse(o.body)); return json({ answered: 'x', ok: true }); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return json({ messages: [], total: 0, prompt_options: NOTICE() });
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
        // #14774 part (a): the server offers the whole notice to the person's own dashboard (rate_limit_offer with the model): all three are buttons, and 1 and 3 ask once more before anything is sent
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await ev(`window.__offer = true; window.__posts = []; (async () => { const m = await import(${MOD} + 'inbox_answer.js'); const cell = m.answerCell({ name: 'codex-rl2', session_id: 'sess-rl2', agent_type: 'codex', waiting_since: 'trl2', waiting_summary: 'Approaching rate limits', waiting_kind: 'question' }); document.body.append(cell); window.__cell = cell; return true; })()`);
            await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 3`, `${label}: with the offer all three choices are buttons`, 8000);
            const three = await ev(`[...window.__cell.querySelectorAll('button:not(.inbox-dismiss)')].map(b => b.textContent.trim())`);
            assert.equal(three.length, 3, `${label}: ` + JSON.stringify(three));
            assert.match(three[0], /^Switch to gpt-6-luna/, `${label}: choice 1 names the model`);
            assert.equal(three[1], 'Keep current model', label);
            assert.match(three[2], /^Keep current model \(never show again\)/, label);
            assert.doesNotMatch(await ev(`window.__cell.textContent`), /More choices/i, `${label}: nothing is held back`);
            const geo = await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')].map(b => { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), vw: innerWidth }; })`);
            assert.ok(geo.every(g => g.l >= 0 && g.r <= g.vw), `${label}: the three are on the screen: ` + JSON.stringify(geo));
            // choice 1 asks once more, naming the model, and sends nothing until confirmed; Cancel puts the three back
            await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')][0].click(); true`);
            await waitFor(`!!window.__cell.querySelector('.inbox-rate-limit-confirm')`, `${label}: choice 1 asks once more`, 5000);
            const c1 = await ev(`window.__cell.querySelector('.inbox-rate-limit-confirm').textContent`);
            assert.match(c1, /gpt-6-luna/, `${label}: ` + c1);
            assert.match(c1, /changes the model/i, label);
            assert.equal(await ev(`window.__posts.length`), 0, `${label}: nothing sent by the first click`);
            assert.deepEqual(await ev(`[...window.__cell.querySelectorAll('button')].map(b => b.textContent.trim())`), ['Switch to gpt-6-luna', 'Cancel'], label);
            assert.equal(await ev(`document.activeElement && document.activeElement.textContent`), 'Cancel', `${label}: the safe choice has the keyboard`);
            const name1 = await ev(`[...window.__cell.querySelectorAll('button')].find(b => b.textContent === 'Switch to gpt-6-luna').getAttribute('aria-label')`);
            assert.ok(name1.startsWith('Switch to gpt-6-luna'), `${label}: the accessible name starts with the visible words (WCAG 2.5.3): ` + name1);
            await ev(`[...window.__cell.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click(); true`);
            await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 3`, `${label}: Cancel draws the three again`, 5000);
            assert.equal(await ev(`window.__posts.length`), 0, `${label}: Cancel sent nothing`);
            // choice 3 says in plain words what it does, then the confirm sends it once, with the model it drew
            await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')][2].click(); true`);
            await waitFor(`!!window.__cell.querySelector('.inbox-rate-limit-confirm')`, `${label}: choice 3 asks once more`, 5000);
            assert.match(await ev(`window.__cell.querySelector('.inbox-rate-limit-confirm').textContent`), /This stops the reminder for good\./, label);
            assert.equal(await ev(`document.activeElement && document.activeElement.textContent`), 'Cancel', `${label}: after choice 3 the safe choice has the keyboard too`);
            const name3 = await ev(`[...window.__cell.querySelectorAll('button')].find(b => b.textContent === 'Never show again').getAttribute('aria-label')`);
            assert.ok(name3.startsWith('Never show again'), `${label}: the accessible name starts with the visible words: ` + name3);
            assert.equal(await ev(`window.__posts.length`), 0, `${label}: nothing sent by the first click`);
            await ev(`[...window.__cell.querySelectorAll('button')].find(b => b.textContent === 'Never show again').click(); true`);
            await waitFor(`window.__posts.length === 1`, `${label}: the confirm sends the answer`, 5000);
            const sent = await ev(`window.__posts[0]`);
            assert.equal(sent.n, 3, label);
            assert.equal(sent.rate_limit_model, 'gpt-6-luna', `${label}: the answer names the model the row drew`);
            await ev(`window.__cell.remove(); window.__offer = false; true`);
        }
        console.log('PASS the Codex rate-limit notice: without the offer only Keep current model is a button; with it all three, and choices 1 and 3 ask once more, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
