// #14780 (coral-hub's beta read, item 1): through the Hub, the proposal dialog says which team a proposal is for in words, never the board's id ('@<computer-id>/docs-team'), and it is centred in the window on a desktop and a phone, as the other dialogs are.
// A proposal of a team on another computer: 'a team on <the computer's name>'; one whose list has the team's name says it. Through the stubbed Hub world (helpers/hub_world.js). 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { setupHubWorld } = require('./helpers/hub_world');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            for (const [label, extra, expect] of [['no team name in the list (another computer)', {}, /a team on Laptop\./], ['the list has the team\'s name', { board_label: 'Docs Team' }, /for Docs Team\./]]) {
                await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'inbox_proposals.js'); const p = ${JSON.stringify({ id: 7, kind: 'task', title: 'Add the docs', proposer: 'Writer', server: 'm1', board_id: '@m1/docs-team', payload: { body: 'Write the docs.' }, ...extra })}; m.openProposalDialog(p, 'view'); return true; })()`);
                await waitFor(`!!document.getElementById('proposal-dialog') && document.getElementById('proposal-dialog').open`, `${at}the dialog opens`);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: styles settle
                const text = await ev(`document.getElementById('proposal-dialog').innerText`);
                const box = await ev(`(() => { const r = document.getElementById('proposal-dialog').getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(innerWidth - r.right), t: Math.round(r.top), b: Math.round(innerHeight - r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
                check(`${at}${label}: the team is said in words`, expect.test(text), JSON.stringify(text.slice(0, 160)));
                check(`${at}${label}: no board id is printed`, !/@m1|m1\/|docs-team/.test(text) || /Docs Team/.test(text) && !/@m1|m1\//.test(text), JSON.stringify(text.match(/@\S+/g)));
                check(`${at}${label}: the dialog is centred (left and right margins equal, top and bottom equal)`, Math.abs(box.l - box.r) <= 2 && Math.abs(box.t - box.b) <= 2 && box.w > 100, JSON.stringify(box));
                if (extra.board_label === undefined) await shot(`hub-proposal-dialog-${w}`);
                await ev(`document.getElementById('proposal-dialog').close(); document.getElementById('proposal-dialog').remove(); true`);
            }
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
