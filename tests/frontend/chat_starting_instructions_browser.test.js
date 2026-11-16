// #17461 and #17510 M6: Coral's launch instructions fold without hiding a person's own text; Send follows the conversation again.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const START = 'You are the frontend worker.\n\nYou were automatically joined to message board "test-team".\n' + 'Use coral-board task list and follow the assigned work.\n'.repeat(30) + '\n```js\nconsole.log("Starting instructions");\n```';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const failures = [];
    const shot = async name => { if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1440, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await setTheme(ev, 'light');
            await ev(`(() => { const a = window.__m.add('starting', 'Conversation ', 18, { sleeping: false }); a.msgs[0] = { type: 'user', content: ${JSON.stringify(START)} }; a.msgs[2] = { type: 'user', content: 'I typed: You were automatically joined to message board "my example".', coral_notice: false }; window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); return true; })()`);
            await select('starting');
            await waitFor(`document.querySelectorAll('#live-history-messages .chat-bubble').length > 5`, 'conversation');
            await ev(`document.getElementById('live-history-messages').scrollTop = 0; true`); await ev(framesJs(3));
            await shot(`startup-${width}`);
            const fold = await ev(`(() => { const c = document.getElementById('live-history-messages'), d = c.querySelector('.chat-starting details'); return { exists: !!d, open: d?.open, label: d?.querySelector('summary')?.textContent, human: [...c.querySelectorAll('.human')].some(b => b.textContent.includes('I typed: You were automatically joined')) }; })()`);
            if (!(fold.exists && !fold.open && /Coral.*Starting instructions/.test(fold.label))) failures.push(`${width}: startup folded and attributed: ${JSON.stringify(fold)}`);
            assert.ok(fold.human, 'explicitly person-authored text remains theirs');
            if (fold.exists) {
                await ev(`document.querySelector('.chat-starting summary').click(); true`);
                assert.ok(await ev(`document.querySelector('.chat-starting details').open && document.querySelector('.chat-starting .message-text').innerText.includes('Use coral-board task list')`), 'the whole instructions open');
                await waitFor(`!!document.querySelector('.chat-starting .code-copy-btn')`, 'code controls load with the first block');
                await ev(`document.querySelector('.chat-starting .code-wrap-btn').click(); true`);
                assert.ok(await ev(`document.querySelector('.chat-starting .code-wrap-btn').getAttribute('aria-pressed') === 'true'`), 'code wrapping still works');
                await ev(`document.querySelector('.chat-starting summary').click(); true`);
            }
            await ev(`document.getElementById('live-history-messages').scrollTop = 0; window.__qaState.autoScroll = false; document.getElementById('command-input').value = 'Please continue from here'; true`);
            await ev(`import((window.__coralStatic || '/static/') + 'controls.js').then(m => m.sendCommand()).then(() => true)`);
            const following = await ev(`window.__qaState.autoScroll`);
            if (!following) failures.push(`${width}: Send restores auto-follow`);
            await ev(framesJs(3));
            const gap = await ev(`(() => { const c = document.getElementById('live-history-messages'); return c.scrollHeight - c.clientHeight - c.scrollTop; })()`);
            assert.ok(gap < 50, `${width}: sent message is at latest (${gap})`);
            await shot(`sent-${width}`);
        }
        assert.deepEqual(failures, []);
        console.log('chat_starting_instructions: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
