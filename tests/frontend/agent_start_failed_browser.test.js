// An agent whose start was refused because its CLI is missing or can't be run (#353): the server records start_failure (cli_missing, cli_untrusted_mount or cli_path_unusable; the agent's sleep
// reason, when it has one, stays) and sends the fixed sentence for it in start_failure_text. The row and header say "Failed to start", the composer says "<name> <that sentence>" as text only (an agent
// name that is markup stays text), with Restart and Wake, and each of the three reasons says its own words. A plain sleeping agent and an Ended one keep theirs.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const WORDS = {
    cli_missing: 'failed to start: the Codex CLI was not found. Set Settings > CLI paths > Codex to its codex.exe.',
    cli_untrusted_mount: 'failed to start: Windows will not open the folder the Codex CLI is in. Set Settings > CLI paths > Codex to its codex.exe.',
    cli_path_unusable: 'failed to start: the Codex CLI path in Settings > CLI paths can\'t be run. Set Settings > CLI paths > Codex to its codex.exe. Or clear it.',
};

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await ev(`(() => {
            const W = ${JSON.stringify(WORDS)};
            window.__m.add('missing-a', 'M', 3, { sleeping: true, sleep_reason: 'coral_stopped', start_failure: 'cli_missing', start_failure_text: W.cli_missing, agent_type: 'codex' });
            window.__m.add('mount-e', 'U', 3, { sleeping: true, start_failure: 'cli_untrusted_mount', start_failure_text: W.cli_untrusted_mount, agent_type: 'codex' });
            window.__m.add('path-f', 'P', 3, { sleeping: true, start_failure: 'cli_path_unusable', start_failure_text: W.cli_path_unusable, agent_type: 'codex' });
            window.__m.add('nap-b', 'N', 3, { sleeping: true });
            window.__m.add('ended-c', 'E', 3, { sleeping: true, sleep_reason: 'agent_exited' });
            window.__m.add('evil-d', 'D', 3, { sleeping: true, start_failure: 'cli_missing', start_failure_text: W.cli_missing, agent_type: 'codex', display_name: '<img src=x onerror="window.__pwned=1">' });
            window.__m.add('forged-g', 'G', 3, { sleeping: true, start_failure: 'cli_missing', start_failure_text: '<img src=x onerror="window.__pwned=2"> failed to start', agent_type: 'codex' });
            window.__m.add('unknown-h', 'H', 3, { sleeping: true, start_failure: 'something_else', start_failure_text: 'x', agent_type: 'codex' });
            window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
        const label = await ev(`(async () => { const r = await import((window.__coralStatic||'/static/') + 'render.js'); const s = id => window.T.state.liveSessions.find(x => x.session_id === id);
            return { failed: r.sessionStateInfo(s('missing-a-id')), nap: r.sessionStateInfo(s('nap-b-id')), ended: r.sessionStateInfo(s('ended-c-id')), unknown: r.sessionStateInfo(s('unknown-h-id')) }; })()`);
        assert.deepEqual([label.failed.key, label.failed.label, label.failed.pill], ['sleeping', 'Failed to start', 'Failed to start'], 'still asleep (counts and filters unchanged), and the words are Failed to start');
        assert.equal(label.nap.label, 'Sleeping'); assert.equal(label.ended.label, 'Ended'); assert.equal(label.unknown.label, 'Sleeping', 'a reason the page does not know is not a failed start');
        const chip = await ev(`(() => { const e = document.querySelector('.session-group-item[data-session-id="missing-a-id"] .terminal-gone-chip'); return e ? { text: e.textContent, aria: e.getAttribute('aria-label') } : null; })()`);
        assert.ok(chip, 'the failed agent is in view with a chip, not folded into the sleeping row'); assert.equal(chip.text, 'Failed to start'); assert.equal(chip.aria, 'Failed to start. Restart');
        const composer = id => ev(`(async () => { window.selectLiveSession('x', 'codex', '${id}', 'local'); await window.__coralReady.agentSelected('${id}');
            const bar = document.getElementById('sleeping-composer'); const t = document.getElementById('sleeping-composer-text');
            return { shown: !bar.hidden, text: t.textContent, imgs: t.querySelectorAll('img').length, children: t.children.length, restart: !document.getElementById('sleeping-restart-btn').hidden, wake: !document.getElementById('sleeping-wake-btn').hidden }; })()`);
        for (const [id, reason] of [['missing-a-id', 'cli_missing'], ['mount-e-id', 'cli_untrusted_mount'], ['path-f-id', 'cli_path_unusable']]) {
            const c = await composer(id);
            assert.equal(c.shown, true); assert.equal(c.restart, true, 'Restart is offered'); assert.equal(c.wake, true, 'and Wake, to try again once the setting is fixed');
            assert.ok(c.text.endsWith(WORDS[reason]), `${reason} says its own words: ${c.text}`);
        }
        let c = await composer('nap-b-id'); assert.match(c.text, /is sleeping$/, 'a plain sleeping agent keeps its words: ' + c.text);
        c = await composer('ended-c-id'); assert.match(c.text, /has ended$/, 'an ended one too: ' + c.text);
        // An agent name or a sentence that is markup is text: no element is made, and nothing runs.
        for (const id of ['evil-d-id', 'forged-g-id']) {
            c = await composer(id);
            assert.equal(c.imgs, 0, 'no <img> was made'); assert.equal(c.children, 0, 'the line has no child elements');
            assert.ok(c.text.includes('<img src=x onerror='), 'it is shown as text: ' + c.text);
        }
        assert.equal(await ev(`window.__pwned === undefined`), true, 'no handler ever ran');
        console.log('PASS agent start failed: each reason says its own words, from the server, as text only');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
