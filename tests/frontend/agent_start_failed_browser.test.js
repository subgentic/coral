// An agent whose start was refused because its CLI is missing (#353): the server marks it asleep with sleep_reason "cli_missing". The row and header say "Failed to start", the composer says
// "<name> failed to start: the Codex CLI was not found. Set Settings > CLI paths > Codex to its codex.exe." as text only (an agent name that is markup stays text), with Restart and Wake. A plain sleeping agent and an Ended one keep their words; a running agent is untouched.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await ev(`(() => {
            window.__m.add('failed-a', 'F', 3, { sleeping: true, sleep_reason: 'cli_missing', agent_type: 'codex' });
            window.__m.add('nap-b', 'N', 3, { sleeping: true });
            window.__m.add('ended-c', 'E', 3, { sleeping: true, sleep_reason: 'agent_exited' });
            window.__m.add('evil-d', 'D', 3, { sleeping: true, sleep_reason: 'cli_missing', agent_type: 'codex', display_name: '<img src=x onerror="window.__pwned=1">' });
            window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
        const label = await ev(`(async () => { const r = await import((window.__coralStatic||'/static/') + 'render.js'); const s = id => window.T.state.liveSessions.find(x => x.session_id === id);
            return { failed: r.sessionStateInfo(s('failed-a-id')), nap: r.sessionStateInfo(s('nap-b-id')), ended: r.sessionStateInfo(s('ended-c-id')) }; })()`);
        assert.deepEqual([label.failed.key, label.failed.label, label.failed.pill], ['sleeping', 'Failed to start', 'Failed to start'], 'still asleep (counts and filters unchanged), and the words are Failed to start');
        assert.equal(label.nap.label, 'Sleeping'); assert.equal(label.ended.label, 'Ended');
        const composer = id => ev(`(async () => { window.selectLiveSession('x', 'codex', '${id}', 'local'); await window.__coralReady.agentSelected('${id}');
            const bar = document.getElementById('sleeping-composer'); const t = document.getElementById('sleeping-composer-text');
            return { shown: !bar.hidden, text: t.textContent, imgs: t.querySelectorAll('img').length, children: t.children.length, restart: !document.getElementById('sleeping-restart-btn').hidden, wake: !document.getElementById('sleeping-wake-btn').hidden }; })()`);
        let c = await composer('failed-a-id');
        assert.equal(c.shown, true); assert.equal(c.restart, true, 'Restart is offered'); assert.equal(c.wake, true, 'and Wake, to try again once the setting is fixed');
        assert.match(c.text, /failed to start: the Codex CLI was not found\. Set Settings > CLI paths > Codex to its codex(\.exe)?\.$/, c.text);
        c = await composer('nap-b-id'); assert.match(c.text, /is sleeping$/, 'a plain sleeping agent keeps its words: ' + c.text);
        c = await composer('ended-c-id'); assert.match(c.text, /has ended$/, 'an ended one too: ' + c.text);
        // An agent name that is markup is text: no element is made, and nothing runs.
        c = await composer('evil-d-id');
        assert.equal(c.imgs, 0, 'no <img> was made from an agent name'); assert.equal(c.children, 0, 'the line has no child elements');
        assert.ok(c.text.includes('<img src=x onerror='), 'the name is shown as text: ' + c.text);
        assert.equal(await ev(`window.__pwned === undefined`), true, 'the handler never ran');
        console.log('PASS agent start failed: the state says Failed to start with the fix, as text only');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
