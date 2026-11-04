// #13486: an agent whose Codex refuses its model is BLOCKED, not Idle or Ready for input (follow-up to #13480). The live-list row carries `blocked: {kind: 'model_refused', model}` (absent when nothing blocks); the sidebar row, the
// dot's name and the phone's status line say it, in words and not by colour alone: the row's dot is Stuck's (a shape of its own in forced colours), its chip says "Blocked" (title: the reason with the model), the row's aria-label starts
// the state with the word, and a phone's status line says "Blocked: Codex refuses its model" in one line. A question the agent asks still wins; a sleeping row never carries it; a kind this page does not know is a plain "Blocked";
// a model name is text, never markup. Stubbed rows through the harness (as agent_row_one_line_browser), at 1280 and at 390 px, and at 200% text.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // the same row shape as agent_row_one_line_browser (a row of any other shape is not what that suite proved the list draws); the page treats a blocked key the same whatever the CLI (the server sends it for Codex only)
    const base = o => Object.assign({ name: 'coral-go', display_name: '', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', branch: 'feat/long-branch-name', repo_name: 'coral', working_directory: '/work/coral-project', context_pct: 10, working: false, waiting_for_input: false, not_started: false, stuck: false, sleeping: false, awaiting_user: false, done: false, board_project: '', board_unread: 0 }, o);
    const ROWS = [
        base({ session_id: 'b1', display_name: 'Refused', blocked: { kind: 'model_refused', model: 'gpt-6.1-sol' } }),
        base({ session_id: 'b2', display_name: 'No name', blocked: { kind: 'model_refused', model: '' } }),
        base({ session_id: 'b3', display_name: 'Asking', waiting_for_input: true, waiting_kind: 'question', blocked: { kind: 'model_refused', model: 'gpt-6.1-sol' } }),
        base({ session_id: 'b4', display_name: 'Asleep', sleeping: true, blocked: { kind: 'model_refused', model: 'gpt-6.1-sol' } }),
        base({ session_id: 'b5', display_name: 'Later kind', blocked: { kind: 'usage_limit' } }),
        base({ session_id: 'b6', display_name: 'Hostile', blocked: { kind: 'model_refused', model: '<img src=x onerror=window.__pwned=1>' } }),
        base({ session_id: 'b7', display_name: 'Fine', awaiting_user: true, done: true }),
    ];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, root] of [['1280', 1280, 800, false, '#live-sessions-list'], ['390', 390, 844, true, '#mobile-session-list']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(ROWS)}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            // a list shows five awake agents and folds the rest under "Show N more" (FOLDER_SHOWN in session_rows.js): six awake stub rows put the sixth behind it. Open it, then wait for the last row by its id.
            await waitFor(`document.querySelectorAll('${root} .session-group-item').length >= 5`, `${label}: the first rows`, 6000);
            await ev(`document.querySelector('${root} .folder-more-row .row-btn[aria-expanded="false"]')?.click(); true`);
            await waitFor(`!!document.querySelector('${root} .session-group-item[data-session-id="b7"]')`, `${label}: the sixth awake row (b7) after Show more; rows drawn: ` + (await ev(`[...document.querySelectorAll('${root} .session-group-item')].map(li => li.dataset.sessionId).join(',')`)), 6000);
            const read = () => ev(`(() => { const out = {}; for (const li of document.querySelectorAll('${root} .session-group-item')) { const chip = li.querySelector('.session-state-pill'), dot = li.querySelector('.session-dot'), st = li.querySelector('.session-status-line');
                out[li.dataset.sessionId] = { state: li.dataset.state, aria: li.getAttribute('aria-label') || '', chip: chip && chip.getClientRects().length ? chip.textContent.trim() : null, chipTitle: chip ? chip.getAttribute('title') || '' : '', dotClass: dot ? dot.className : '', status: st && st.getClientRects().length ? st.textContent.trim() : null, h: Math.round(li.getBoundingClientRect().height), imgs: li.querySelectorAll('img').length }; } return out; })()`);
            const at = zoom => `${label}${zoom ? ' at ' + zoom + ' text' : ''}`;
            for (const zoom of ['', '200%']) {
                if (zoom) { await ev(`document.documentElement.style.fontSize = '${zoom}'; true`); await ev(framesJs(3)); }
                const r = await read();
                assert.equal(r.b1.state, 'blocked', `${at(zoom)}: a refused agent's row state is blocked: ${JSON.stringify(r.b1)}`);
                assert.match(r.b1.dotClass, /\bstuck\b/, `${at(zoom)}: its dot is Stuck's (a shape of its own in forced colours), not the idle or ready dot: ${r.b1.dotClass}`);
                assert.doesNotMatch(r.b1.dotClass, /your-turn|stale/, `${at(zoom)}: not Ready for input, not Idle: ${r.b1.dotClass}`);
                assert.ok(/Blocked: Codex refuses its model gpt-6\.1-sol/.test(r.b1.aria), `${at(zoom)}: the row's name says the state, the word first, then why, with the model: ${r.b1.aria}`);
                assert.match(r.b2.aria, /Blocked: Codex refuses its model(,|$)/, `${at(zoom)}: with no model name it says Codex refuses its model and no name: ${r.b2.aria}`);
                if (!mobile) {
                    assert.equal(r.b1.chip, 'Blocked', `${at(zoom)}: the one chip is the word Blocked: ${JSON.stringify(r.b1)}`);
                    assert.ok(/Codex refuses its model gpt-6\.1-sol/.test(r.b1.chipTitle), `${at(zoom)}: the chip's title carries the reason: ${r.b1.chipTitle}`);
                } else {
                    assert.equal(r.b1.status, 'Blocked: Codex refuses its model', `${at(zoom)}: a phone's status line says it without the model name (the name is in the row's label): ${JSON.stringify(r.b1)}`);
                    if (!zoom) assert.ok(r.b1.h <= 100, `${at(zoom)}: the row stays one card (${r.b1.h} px)`);
                }
                assert.equal(r.b3.state, 'needs_input', `${at(zoom)}: a question the agent asks wins over the block: ${JSON.stringify(r.b3)}`);
                if (r.b4) assert.equal(r.b4.state, 'sleeping', `${at(zoom)}: a sleeping agent's row (up to three are rows, more fold into a summary) never says blocked: ${JSON.stringify(r.b4)}`);
                assert.equal(await ev(`T.render.sessionStateInfo(${JSON.stringify(ROWS[3])}).key`), 'sleeping', `${at(zoom)}: the one resolver says a sleeping agent is asleep, whatever its blocked key says`);
                assert.equal(r.b5.state, 'blocked', `${at(zoom)}: a kind this page does not know is still a block: ${JSON.stringify(r.b5)}`);
                if (!mobile) assert.equal(r.b5.chip, 'Blocked', `${at(zoom)}: and says plain Blocked`);
                assert.equal(r.b6.imgs, 0, `${at(zoom)}: a model name is text, never markup: ${JSON.stringify(r.b6)}`);
                assert.equal(await ev(`!!window.__pwned`), false, `${at(zoom)}: nothing in a model name ran`);
                assert.notEqual(r.b7.state, 'blocked', `${at(zoom)}: an agent with no blocked key is not blocked: ${JSON.stringify(r.b7)}`);
                const words = await ev(`(() => { const i = T.render.sessionStateInfo(${JSON.stringify(ROWS[0])}); return { key: i.key, label: i.label, attention: i.attention, dot: i.dot }; })()`);
                assert.deepEqual(words, { key: 'blocked', label: 'Blocked: Codex refuses its model gpt-6.1-sol', attention: true, dot: 'stuck' }, `${at(zoom)}: one resolver says it for every surface`);
            }
            await ev(`document.documentElement.style.fontSize = ''; true`);
            await shot(`agent_blocked_${label}`);
            console.log(`   ok ${label}`);
        }
        console.log('PASS agent_blocked: a Codex agent whose model is refused is Blocked in the row, the dot and the phone line (words and shape, not colour alone)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
