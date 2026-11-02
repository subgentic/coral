// The Wake button of a question (a wake: button, #11643) says why a wake was refused (#12049, the operator): the server's 422 carries a sentence (a CLI not installed, a configured path it cannot run, a folder
// Windows will not open) and what to set; the toast showed only 'Could not wake <name> (HTTP 422)'. A refusal with no sentence keeps the status. Stubbed in the page: the team's subscribers, a sleeping agent and the
// wake route. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const failures = [];
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const run = (code, body) => ev(`(async () => {
            const original = window.fetch, json = (b, status) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
                if (p === '/api/board/wake-team/subscribers') return json([{ subscriber_id: 'Security Reviewer', session_name: 'antigravity-sleepy1' }], 200);
                if (p === '/api/sessions/live/sleepy1/wake') return json(${JSON.stringify(body)}, ${code});
                return original(u, o); };
            const st = await import(${S} + 'state.js'); st.state.liveSessions = [{ session_id: 'sleepy1', agent_type: 'antigravity', sleeping: true, name: 'x' }];
            const m = await import(${S} + 'operator_asks.js');
            try { await m.wakeMember({ board: 'wake-team', asker: 'Orchestrator' }, 'Security Reviewer'); return 'no error'; } catch (e) { return e.message; } finally { window.fetch = original; }
        })()`);
        const sentence = 'failed to start: the Antigravity CLI was not found. Set Settings > CLI paths > Antigravity to its agy.';
        const got = await run(422, { error: sentence, code: 'cli_not_found' });
        if (!got.includes(sentence) || /HTTP 422/.test(got)) failures.push('a refusal with a sentence shows the sentence, not the status: ' + got);
        if (!got.startsWith('Could not wake')) failures.push('and says which wake failed: ' + got);
        const bare = await run(500, {});
        if (!/Could not wake .*\(HTTP 500\)/.test(bare)) failures.push('a refusal with no sentence keeps the status: ' + bare);
        const markup = await run(422, { error: 'bad <b>path</b>‮', code: 'cli_path_unusable' });
        if (markup.includes('‮')) failures.push('hidden characters in the sentence are written out: ' + JSON.stringify(markup));
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('wake_refusal_words_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
