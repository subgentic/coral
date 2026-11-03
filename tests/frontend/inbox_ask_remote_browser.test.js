// A question that came from another computer through the Hub shows only the plain Reply and Close (#11757, Security's INFO on #11643): the buttons an agent offered are claimed through a route that is not served through Coral Hub, so
// a click there ended in an error. A stub of a remote question and of a local one, the same dialog: the local one offers its buttons (what they do, in the app's words), the remote one has none and still takes a reply. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const open = (extra) => ev(`(async () => { const m = await import(${S} + 'operator_asks.js'); window.__d = m.openAskDialog(${JSON.stringify({ board: 'team-x', kind: 'ask', id: 7, asker: 'Backend Dev', text: 'Ship it or hold?', cut: false, buttons: [{ id: 1, label: 'Hold', action: 'reply', state: 'pending' }, { id: 2, label: 'Look', action: 'open:task', arg: '12', state: 'pending' }], ...extra })}, () => {}); return true; })()`);
    const read = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); return { offers: d.querySelectorAll('.inbox-ask-offer button').length, offersBox: !!d.querySelector('.inbox-ask-offers'), buttons: [...d.querySelectorAll('.inbox-ask-buttons button')].map(b => b.textContent), reply: !!d.querySelector('textarea'), text: d.querySelector('h2').textContent }; })()`);
    const close = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); if (d) { d.close(); d.remove(); } return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');

            await open({});
            let r = await read();
            assert.equal(r.offers, 2, at + 'a question of this computer offers its two buttons');
            assert.deepEqual(r.buttons, ['Close', 'Dismiss', 'Send reply'], at + 'beside the plain Reply and Close, with Dismiss (Send reply on the right, #12599)');
            await close();

            await open({ server: 'box-2' });
            r = await read();
            assert.equal(r.offersBox, false, at + 'a question from another computer has no offered buttons');
            assert.equal(r.offers, 0);
            assert.deepEqual(r.buttons, ['Close', 'Send reply'], at + 'only the plain Reply and Close (Send reply on the right)');
            assert.equal(r.reply, true, at + 'and the Reply box');
            assert.equal(r.text, 'Ship it or hold?', at + 'the question is shown whole: a one-line question is the title of its item (#12143)');
            assert.equal(await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), 0, at + 'nothing scrolls sideways');
            await close();

            await open({ server: '' });
            assert.equal((await read()).offers, 2, at + 'an empty server is this computer: the buttons stay');
            await close();
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS a question from another computer shows only the plain Reply and Close');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
