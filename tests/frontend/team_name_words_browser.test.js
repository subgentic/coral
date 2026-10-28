// The New team name says what it is in words a newcomer has: the hint under the field is "A project is a team of agents working on one board. Letters, digits, - and _." (the project word tied to the team once, #10660), a bad name is said once, short, on the field,
// and the footer points at it instead of saying it again (#10371, Beta #10367: "board" is a Coral word, and the long error was in the field and in the footer). 1280 px, the real server's launch dialog.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step');
        const hint = await ev(`(document.getElementById('team-board-name').getAttribute('aria-describedby') || '').split(' ').map(id => (document.getElementById(id) || {}).textContent || '')[0]`);
        assert.equal(hint, "A project is a team of agents working on one board. Letters, digits, - and _.", 'the hint under the name: ' + hint);
        assert.doesNotMatch(hint.replace('working on one board', ''), /board/i, 'no other Coral word in it: the one sentence that ties project and team says board, as the Operator\'s words do (#10660)');
        await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'bad name!'; n.dispatchEvent(new Event('input', { bubbles: true })); const d = document.getElementById('launch-team-dir'); d.value = '/work/x'; d.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-team-next').click(); true`);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the validation draws after the click
        const said = await ev(`(() => { const f = document.getElementById('launch-step-team'); const err = [...f.querySelectorAll('.sv-error')].map(e => e.textContent.trim()).filter(Boolean); return { err, footer: (document.getElementById('team-recap') || {}).textContent || '' }; })()`);
        const field = said.err.find(t => /letters, digits/i.test(t));
        assert.equal(field, 'Team name: Use letters, digits, - or _, starting with a letter or digit.', 'the field says it, short: ' + JSON.stringify(said));
        assert.doesNotMatch(said.footer, /letters, digits/i, 'the footer does not say it again: ' + JSON.stringify(said));
        assert.match(said.footer, /team name/i, 'the footer points at the name: ' + JSON.stringify(said));
        console.log('PASS the team name hint and its one error are in plain words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
