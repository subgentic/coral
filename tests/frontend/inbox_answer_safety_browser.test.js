// The Inbox's answer buttons are safe on a stale row (#10400, Security Reviewer): a row never offers a choice that lasts ("Yes, and don't ask again", "allow all edits this session", ...) for each CLI's own
// words; a click re-reads the card and sends nothing when the ask changed since the row was drawn (it says so and draws the choices again); the server's 409 says the same; and a viewer through the Hub has none.
// The chat reply and the answer route are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SETS = {
    claude: ['Yes', "Yes, and don't ask again for: npm test:*", 'Yes, allow all edits during this session (shift+tab)', 'No'],
    codex: ['Yes, proceed (y)', "Yes, and don't ask again for commands that start with `touch` (p)", 'No, and tell Codex what to do differently (esc)'],
    antigravity: ['Yes, run command', "Yes, and always allow in this conversation for commands that start with 'printf'", 'Yes, and always allow access to the folder', 'No, cancel'],
};
const SHOWN = { claude: ['Yes', 'No'], codex: ['Yes, proceed (y)', 'No, and tell Codex what to do differently (esc)'], antigravity: ['Yes, run command', 'No, cancel'] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__posts = []; window.__ask = 'ask-1'; window.__status = 200; window.__opts = ${JSON.stringify(SETS.claude)};
            const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__posts.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify(window.__status === 200 ? { ok: true } : { error: 'The prompt changed.' }), { status: window.__status, headers: { 'content-type': 'application/json' } })); }
                if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Do you want to proceed?', ask_id: window.__ask, options: window.__opts.map((label, i) => ({ n: i + 1, label, action: 'select' })) } }), { headers: { 'content-type': 'application/json' } }));
                return real(u, o); };
            true`);
        let n = 0;
        const draw = async () => ev(`(async () => { const m = await import(${MOD} + 'inbox_answer.js'); const cell = m.answerCell({ name: 'claude-x${++n}', session_id: 'sess-${n}', agent_type: 'claude', waiting_since: 't${n}' }); document.body.append(cell); window.__cell = cell; return true; })()`);
        const labels = () => ev(`[...window.__cell.querySelectorAll('button')].map(b => b.textContent)`);
        for (const [cli, opts] of Object.entries(SETS)) {
            await ev(`window.__opts = ${JSON.stringify(opts)}; true`); await draw();
            await waitFor(`window.__cell.querySelectorAll('button').length > 0`, `${cli}: the choices`, 5000);
            assert.deepEqual(await labels(), SHOWN[cli], `${cli}: only the one-time yes and the no, the lasting ones are left to Open`);
        }
        // the ask changes between the draw and the click: nothing is sent
        await ev(`window.__opts = ${JSON.stringify(SETS.claude)}; window.__posts = []; true`); await draw();
        await waitFor(`window.__cell.querySelectorAll('button').length === 2`, 'claude choices', 5000);
        await ev(`window.__ask = 'ask-2'; window.__cell.querySelector('button').click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /That question changed; look at it again/.test(e.textContent))`, 'the stale click says so', 5000);
        assert.deepEqual(await ev(`window.__posts`), [], 'a stale row sends nothing');
        await waitFor(`window.__cell.querySelectorAll('button').length === 2 && !window.__cell.querySelector('button').disabled`, 'the choices are drawn again', 5000);
        // the same ask: the id rides along; the server's 409 is said the same way
        await ev(`window.__cell.querySelector('button').click(); true`);
        await waitFor(`window.__posts.length === 1`, 'the answer is sent', 5000);
        assert.equal(await ev(`window.__posts[0].ask_id`), 'ask-2', 'the ask the row shows rides along');
        await ev(`window.__posts = []; window.__status = 409; window.__ask = 'ask-2'; true`); await draw();
        await waitFor(`window.__cell.querySelectorAll('button').length === 2`, 'again', 5000);
        await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__cell.querySelector('button').click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /That question changed; look at it again/.test(e.textContent))`, 'a 409 says the same', 5000);
        console.log('PASS Inbox answers: no lasting choice on a row (Claude, Codex, Antigravity), a changed ask sends nothing, a 409 says so');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
