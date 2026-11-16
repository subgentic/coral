// #18795 (the Operator, rc4h: "the up arrow to show more detail is too hidden. Lets put the text inline with the buttons on the left for desktop. Then have a more link with the up arrow to expand at the end of the text"):
// on a desktop the New agent recap is on the footer's own row, at the left of Back / Cancel / Launch, and ends in a "More ▴" link that opens the detail ("Less ▾" closes it); New team's line is on its footer row too.
// A phone keeps its layout: the recap above the buttons and a lone arrow at its right. Isolated dev server at 1440 and 390 px.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');
const { install: installNT, openNewTeam, T } = require('./helpers/new_team');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const box = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, text: e.textContent.trim() }; })()`);
    const word = () => ev(`getComputedStyle(document.getElementById('launch-recap-toggle'), '::before').content.replace(/["']/g, '')`); // the link's word is drawn by the stylesheet (its name for a screen reader is its aria-label)
    const firstButton = step => ev(`(() => { const a = document.querySelector('#${step} > .modal-actions'); const bs = [...a.querySelectorAll(':scope > .btn')].filter(b => !b.hidden && b.getClientRects().length); const r = a.getBoundingClientRect(); return { left: Math.min(...bs.map(b => b.getBoundingClientRect().left)), top: r.top, bottom: r.bottom, btnTop: Math.min(...bs.map(b => b.getBoundingClientRect().top)) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1440', 1440, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
            await stubModels(ev); await stubCliChecks(ev, []);
            await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
            await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
            await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); return true; })()`);
            await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
            await ev(`(() => { for (let i = 0; i < 2; i++) { if (document.getElementById('launch-modal').getAttribute('data-agent-stage') !== 'agent') document.getElementById('launch-agent-next').click(); } return true; })()`);
            await waitFor(`document.getElementById('launch-modal').getAttribute('data-agent-stage') === 'agent'`, 'the model step', 6000);
            await waitFor(`document.getElementById('launch-recap') && !document.getElementById('launch-recap').hidden && document.getElementById('launch-recap').textContent.length > 5`, `${label}: the recap is drawn`, 6000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the footer is fitted after the recap is drawn
            const recap = await box('#launch-recap'), tog = await box('#launch-recap-toggle'), foot = await firstButton('launch-step-agent');
            if (!mobile) {
                assert.ok(recap.t >= foot.top - 1 && recap.b <= foot.bottom + 1, `${label}: the recap is on the footer row, not above it: ${JSON.stringify({ recap, foot })}`);
                assert.ok(recap.r <= foot.left, `${label}: the recap stops left of the buttons: ${JSON.stringify({ recap, foot })}`);
                assert.match(await word(), /^More/, `${label}: the link says More: ${await word()}`);
                assert.ok(tog.l >= recap.r - 2 && tog.l - recap.r < 40 && tog.t >= foot.top - 1 && tog.b <= foot.bottom + 1, `${label}: the link is at the end of the text, on the same row: ${JSON.stringify({ recap, tog })}`);
                await ev(`document.getElementById('launch-recap-toggle').click(); true`);
                await waitFor(`document.getElementById('launch-recap').hasAttribute('data-open') && /^Less/.test(getComputedStyle(document.getElementById('launch-recap-toggle'), '::before').content.replace(/["']/g, ''))`, `${label}: More opens the detail and says Less`, 4000);
                const open = await box('#launch-recap'), now = await firstButton('launch-step-agent');
                assert.ok(open.b <= now.top + 1, `${label}: the detail opens above the footer row: ${JSON.stringify({ open, now })}`);
                await ev(`document.getElementById('launch-recap-toggle').click(); true`);
                await waitFor(`!document.getElementById('launch-recap').hasAttribute('data-open')`, `${label}: Less closes it`, 4000);
            } else {
                assert.ok(recap.b <= foot.btnTop + 1, `${label}: on a phone the recap stays above the buttons: ${JSON.stringify({ recap, foot })}`);
                assert.match(await word(), /^\u25B4$/, `${label}: the phone keeps its lone arrow: ${await word()}`);
            }
            // New team: the line on the footer row at a desktop width
            await ev(`window.hideLaunchModal(); true`);
            await installNT(ev); await openNewTeam(ev, waitFor); await T(ev, waitFor).to(2, {});
            await waitFor(`document.getElementById('team-recap').textContent.trim().length > 0`, `${label}: New team shows its line`, 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: fitted after it is drawn
            const tr = await box('#team-recap'), tf = await firstButton('launch-step-team');
            if (!mobile) assert.ok(tr.t >= tf.top - 1 && tr.b <= tf.bottom + 1 && tr.r <= tf.left, `${label}: New team's line is on the footer row, left of the buttons: ${JSON.stringify({ tr, tf })}`);
            else assert.ok(tr.b <= tf.btnTop + 1, `${label}: on a phone New team's line stays above the buttons: ${JSON.stringify({ tr, tf })}`);
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('PASS launch_footer_inline_browser');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
