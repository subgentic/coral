// #22094 replaces the two-row phone toolbar with a count-triggered tools row and one compact title.
// Retain robot identity/44px, numeric counts, no-primary rule, and clipping checks on the new strip.
// Needs you, guidelines v3 section 4.14 (#17450): counts are numbers (N1), the header is two rows (N2), one Default button per row (N4), a cut list says "Showing 8 of N" (N8). 1440, 1280, 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`try { localStorage.removeItem('coral-inbox-needs-filters'); } catch {} true`);
            await ev(`(() => { for (let i = 0; i < 5; i++) window.__m.add('Agent ' + i, String.fromCharCode(65 + i), 4, { sleeping: false, board_project: 'team-' + (i % 2), session_id: 'sid-' + i }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 5`, 'five agents', 8000);
            await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); const K = ['permission', 'question', 'plan', 'permission', 'question'];
                window.__qaState.liveSessions = window.__qaState.liveSessions.map((s, i) => ({ ...s, waiting_for_input: true, waiting_kind: K[i], waiting_since: ago(3 + i * 40) }));
                (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
            if (mobile) await ev(`document.querySelector('#group-table-view .view-list-item[data-key="needs"]')?.click(); true`); else await ev(`document.querySelector('.view-list-item[data-key="needs"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view .nl-row').length === 5`, 'the five rows', 8000); await settle(400);
            await shot(`needs-${w}`);
            if (mobile) await ev(`document.querySelector('.nl-phone-count').click(); true`);
            const g = await ev(`(() => { const visible = e => !!e && e.getClientRects().length > 0, toolbar = document.querySelector('.needs-ledger-toolbar'), rect = toolbar.getBoundingClientRect(), pills = toolbar.querySelector('.team-tb-pills'); return { pills: [...pills.querySelectorAll('button')].map(b => b.textContent.trim()), clipped: pills.scrollWidth > pills.clientWidth + 1, over: rect.right > innerWidth + 1, primary: document.querySelectorAll('.needs-ledger .btn-primary').length, atLeast: /at least/i.test(document.querySelector('.needs-ledger').textContent), phoneTitle: visible(document.querySelector('.nl-phone-title')), phoneSelect: visible(document.querySelector('.nl-phone-select')) }; })()`);
            const robot = await ev(`(() => { const b = document.querySelector('.inbox-copy-for-agent'), r = b && b.getBoundingClientRect(); return b && { icon: b.querySelector('.material-icons')?.textContent, label: b.getAttribute('aria-label'), title: b.title, text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), popup: b.hasAttribute('aria-haspopup') }; })()`);
            assert.deepEqual({ icon: robot.icon, label: robot.label, title: robot.title, popup: robot.popup }, { icon: 'smart_toy', label: 'Copy Needs you for an agent', title: 'Copy for an agent', popup: false }, `${w}: #22056 Copy for an agent is the robot icon only, a plain header action: ${JSON.stringify(robot)}`); assert.equal(robot.text, 'smart_toy', `${w}: the robot has no words of its own`); if (mobile) assert.ok(robot.w >= 44 && robot.h >= 44, `${w}: a 44 px target: ${robot.w}x${robot.h}`);
            assert.deepEqual(g.pills, ['All','Unread','Questions'], w + ': the approved strip replaces the old kinds strip');
            assert.ok(!g.clipped && !g.over, w + ': toolbar and pills fit without clipping');
            if (mobile) assert.ok(g.phoneTitle && g.phoneSelect, w + ': title and Select remain in the single phone header');
            assert.equal(g.primary, 0, w + ': no blue decision button in the list');
            assert.equal(g.atLeast, false, w + ': counts stay numeric');

        }
        await client.close(); process.exit(0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})();
