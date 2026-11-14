// The comment box (#16399, the Beta Tester's re-walk #16383): (1) the Approve hint above the buttons keeps its line when it is hidden (the file stopped waiting for review while a comment was typed), so the Comment button
// does not move up under the pointer; (2) the way to send is said once: one line under the box ("Enter starts a new line. Press Ctrl+Enter to send."; ⌘ Return on a Mac), and the count beside the buttons is only the count.
// The box is made by the composer module itself, with the panel's styles loaded. 1280 and 390 px, light and dark.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1280, 800, false, 'dark'], [1280, 800, false, 'light'], [390, 800, true, 'dark'], [390, 800, true, 'light']]) {
            const at = `${w} ${theme}: `, check = (ok, msg) => { if (!ok) problems.push(at + msg); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => { const m = await import(${S} + 'settings_core.js'); m.applyTheme('${theme}'); await import(${S} + 'artifact_comments.js'); const c = await import(${S} + 'artifact_comment_composer.js');
                const st = { composing: { draft: null, anchor: null, parentId: null }, hint: () => 'To approve, use Approve on the file: writing here does not approve it.', hintOn: () => true, hex: 'a'.repeat(64), server: 'local', board: 'team-a' };
                const host = document.createElement('div'); host.id = 'box-host'; host.style.cssText = 'position:fixed;left:8px;top:60px;width:' + Math.min(360, innerWidth - 16) + 'px;z-index:9999;background:var(--bg-primary)'; document.body.append(host);
                host.append(c.createComposer({ st, render() {}, run() {}, ownHex: () => 'a'.repeat(64) }).composer()); return true; })()`);
            await waitFor(`!!document.querySelector('#box-host .ac-send')`, 'the box', 8000);
            const m = () => ev(`(() => { const q = s => document.querySelector('#box-host ' + s), r = e => Math.round(e.getBoundingClientRect().top); return { send: r(q('.ac-send')), hintHidden: q('.ac-hint').hidden, hintTop: r(q('.ac-hint')), count: q('.ac-counter:not(.ac-sendhint)').textContent, how: q('.ac-sendhint').textContent, text: q('.ac-composer').innerText }; })()`);
            const shown = await m();
            await ev(`document.querySelector('#box-host .ac-hint').hidden = true; true`);
            const hidden = await m();
            check(shown.hintHidden === false && hidden.hintHidden === true, 'the hint was shown, then hidden');
            check(shown.send === hidden.send, `the Comment button stays where it was when the hint goes (${shown.send} px, then ${hidden.send} px)`);
            check(/^\d+ \/ \d+$/.test(shown.count), `the count is only the count: ${JSON.stringify(shown.count)}`);
            check(/^Enter starts a new line\. Press (Ctrl\+Enter|⌘ Return) to send\.$/.test(shown.how), `one sentence says how to send: ${JSON.stringify(shown.how)}`);
            check(!/Return sends|⌘ Enter|on a Mac/.test(shown.text), `the shortcut is not said a second time, in another spelling: ${JSON.stringify(shown.text)}`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('comment_box_stable_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
