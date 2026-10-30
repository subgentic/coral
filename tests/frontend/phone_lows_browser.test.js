// The phone lows of the Mobile Beta Tester's #11110 pass (#11128): (1) a reminder's "Show all of this reminder" toggle is a 44 px target (it was 16 px) and the reminder's line is no taller for it; (2) Send options > Model and thinking opens
// a sheet that leaves the composer's text box and Send on the screen (it covered them); (3) team Settings' Folder label has its own line over its box and its Change folder button is 44 px (the label was squeezed beside the box).
// 390 px, touch, 100% and 200% text. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const r = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const fs of [16, 32]) {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; window.__m.add('low-a', 'A', 4, { sleeping: false, session_id: 'low-a-id' }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'low-a')`, 'the agent', 10000);
            await ev(`window.selectLiveSession('low-a', 'claude', 'low-a-id', 'local'); true`);
            await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0 && document.querySelectorAll('.chat-bubble').length > 0`, `${fs}: the chat`, 12000);
            // (1) the reminder's toggle
            await ev(`import(${S} + 'pending_messages.js').then(m => m.appendCoralNotice(document.querySelector('.chat-bubble').parentElement, 'Reminder: check your tasks and the board, then carry on with what you were doing before this came in. This one is long on purpose.')).then(() => true)`);
            await waitFor(`!!document.querySelector('.chat-system-toggle')`, `${fs}: the reminder`, 6000);
            const tg = await ev(r('.chat-system-toggle')), pill = await ev(r('.chat-system'));
            assert.ok(tg && tg.w >= 44 && tg.h >= 44, `${fs}: "Show all of this reminder" is a 44 px target: ` + JSON.stringify(tg));
            assert.ok(pill && pill.h <= 56 * (fs / 16), `${fs}: the reminder's line is no taller for it: ` + JSON.stringify(pill));
            // (2) the Model and thinking sheet leaves the composer on screen
            await ev(`import(${S} + 'model_chip.js').then(m => m.updateModelChip({ session_id: 'low-a-id', name: 'low-a', agent_type: 'claude', model: 'claude-sonnet-5-5', sleeping: false, archived: false }, 'local')).then(() => true)`);
            await waitFor(`(document.querySelector('.mobile-send-options-btn') || { getClientRects: () => [] }).getClientRects().length > 0`, `${fs}: the send chevron`, 10000);
            await ev(`document.querySelector('.mobile-send-options-btn').click(); true`);
            await waitFor(`!!document.querySelector('.mobile-send-menu [data-on-click="send-menu-options"]') && document.querySelector('.mobile-send-menu [data-on-click="send-menu-options"]').getClientRects().length > 0`, `${fs}: the chevron menu`, 5000);
            await ev(`document.querySelector('.mobile-send-menu [data-on-click="send-menu-options"]').click(); true`);
            await waitFor(`!document.getElementById('options-chip-menu').hidden`, `${fs}: the options sheet`, 5000);
            await ev(`document.querySelector('#options-chip-menu [data-options-open="model"]').click(); true`);
            await waitFor(`!document.getElementById('model-chip-menu').hidden && document.getElementById('model-chip-menu').getClientRects().length > 0`, `${fs}: the model sheet`, 5000);
            const sheet = await ev(r('#model-chip-menu')), ta = await ev(r('#command-input')), send = await ev(r('.mobile-send-btn'));
            assert.ok(sheet && ta && sheet.b <= ta.t + 1, `${fs}: the sheet ends above the text box: ` + JSON.stringify({ sheet, ta }));
            assert.ok(send && !(Math.min(sheet.r, send.r) - Math.max(sheet.l, send.l) > 1 && Math.min(sheet.b, send.b) - Math.max(sheet.t, send.t) > 1), `${fs}: and does not cover Send: ` + JSON.stringify({ sheet, send }));
            await ev(`document.body.click(); true`);
            // (3) team Settings' Folder: the label over its box, the button 44 px
            await ev(`import(${S} + 'team_home_folder.js').then(m => { const c = m.teamHomeFolderControl('low-team', { canChange: true }); c.style.cssText = 'position:fixed;left:0;right:0;top:60px;z-index:900;background:var(--bg-primary)'; c.id = 'zz-folder'; document.body.append(c); return true; })`);
            await waitFor(`!!document.querySelector('#zz-folder .team-home-folder-form') && !document.querySelector('#zz-folder .team-home-folder-form').hidden`, `${fs}: the folder form`, 5000).catch(async () => { await ev(`document.querySelector('#zz-folder button')?.click(); true`); });
            const lab = await ev(r('#zz-folder .team-home-folder-form label')), box = await ev(r('#zz-folder .team-home-folder-form input')), chg = await ev(r('#zz-folder .team-home-folder-change'));
            if (lab && box) {
                assert.ok(lab.b <= box.t + 1 && lab.w >= box.w - 2, `${fs}: the Folder label has its own line over the box, not squeezed beside it: ` + JSON.stringify({ lab, box }));
                assert.ok(chg && chg.h >= 44, `${fs}: Change folder is a 44 px target: ` + JSON.stringify(chg));
            }
            await ev(`document.getElementById('zz-folder')?.remove(); true`);
            console.log(`   390@${fs}: reminder toggle, model sheet and folder form ok`);
        }
        console.log('PASS the phone lows: reminder toggle, model sheet');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
