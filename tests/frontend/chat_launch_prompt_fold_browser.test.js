// #17069 follow-up: the launch prompt ("You were automatically joined to message board ...") is folded to one line ("Coral's start instructions") instead of filling
// the first chat screen. Clicking the toggle expands it. A user message that merely contains "joined to message board" but does not start with the exact prefix stays a normal bubble.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const LAUNCH = 'You were automatically joined to message board "alpha". Your role is: Orchestrator.\n\nUse the coral-board CLI to communicate:\n  coral-board read\n  coral-board post "msg"';
const NOT_LAUNCH = 'I noticed we joined to message board "alpha" earlier. The build is green.';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);

        await ev(`import((window.__coralStatic || '/static/') + 'live_chat.js').then(m => { window.__lc = m; return true; })`);
        const fresh = () => ev(`(() => { document.getElementById('nt-box')?.remove(); const b = document.createElement('div'); b.id = 'nt-box'; b.className = 'chat-messages chat-prose';
            b.style.cssText = 'position:absolute;left:0;top:0;width:860px;height:600px;overflow:auto;background:var(--bg-primary);z-index:99999;padding:12px'; document.body.appendChild(b); return true; })()`);
        const render = msgs => ev(`window.__lc.renderTranscript(${JSON.stringify(msgs)}, document.getElementById('nt-box'), 'claude')`);

        // 1. the launch prompt is folded, not a user bubble
        await fresh();
        await render([{ type: 'user', content: LAUNCH }, { type: 'assistant', text: 'Hello.' }]);
        await waitFor(`document.querySelector('#nt-box .chat-launch-prompt')`, 'launch prompt card renders', 5000);
        const card = await ev(`(() => {
            const lp = document.querySelector('#nt-box .chat-launch-prompt');
            if (!lp) return null;
            const label = lp.querySelector('.chat-system-label');
            const toggle = lp.querySelector('.chat-system-toggle');
            return { label: label?.textContent, open: lp.classList.contains('open'), ariaExpanded: toggle?.getAttribute('aria-expanded'), hasBubble: !!document.querySelector('#nt-box .chat-bubble.human') };
        })()`);
        assert.ok(card, 'the launch prompt renders as a card');
        assert.match(card.label, /start instructions/i, 'the label says "start instructions"');
        assert.equal(card.open, false, 'the card starts collapsed');
        assert.equal(card.ariaExpanded, 'false', 'aria-expanded is false');
        assert.equal(card.hasBubble, false, 'no user bubble is drawn for the launch prompt');

        // 2. clicking the toggle expands it and fills the text
        await ev(`document.querySelector('#nt-box .chat-system-toggle').click(); true`);
        const expanded = await ev(`(() => {
            const lp = document.querySelector('#nt-box .chat-launch-prompt');
            const toggle = lp.querySelector('.chat-system-toggle');
            const text = lp.querySelector('.chat-system-text');
            return { open: lp.classList.contains('open'), ariaExpanded: toggle?.getAttribute('aria-expanded'), hasText: text?.textContent.length > 0, filled: lp.dataset.filled };
        })()`);
        assert.equal(expanded.open, true, 'the card is open after a click');
        assert.equal(expanded.ariaExpanded, 'true', 'aria-expanded is true');
        assert.ok(expanded.hasText, 'the full text is filled in');
        assert.equal(expanded.filled, '1', 'data-filled is set');

        // 3. a message that contains but does not start with the prefix is a normal bubble
        await fresh();
        await render([{ type: 'user', content: NOT_LAUNCH }]);
        const notFolded = await ev(`({ bubble: !!document.querySelector('#nt-box .chat-bubble.human'), card: !!document.querySelector('#nt-box .chat-launch-prompt') })`);
        assert.equal(notFolded.bubble, true, 'a non-launch message is a normal user bubble');
        assert.equal(notFolded.card, false, 'no launch-prompt card for a non-launch message');

        console.log('PASS chat launch prompt is folded to one line (#17069)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
