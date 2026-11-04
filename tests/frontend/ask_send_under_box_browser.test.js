// Send reply is on the row right under the reply box (#13148, the Operator: "The send reply is too far away from text input"): box, then a row with Add image on the left and Send reply on the right, the pictures
// note under it; Close and Dismiss stay in the dialog's footer; Ctrl or Cmd+Enter in the box sends. 1280, 390 and 390 at 200% text; the question route and the reply route are stubbed (as in ask_reply_image_browser).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, fs16] of [[1280, 800, false, 16], [390, 844, true, 16], [390, 844, true, 32]]) {
            const tag = `${w} px${fs16 === 32 ? ' 200% text' : ''}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.style.fontSize = '${fs16}px'; (() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: 'Which of the two designs should we build first, and should the other wait?', at: new Date(Date.now() - 7 * 60000).toISOString() }];
                window.__posts = []; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push(body); window.__asks = []; return json({ id: 99 }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 1`, `${tag}: a row of Needs you`, 10000);
            await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]') && !!document.querySelector('dialog.inbox-ask-dialog .ac-add-image')`, `${tag}: the dialog with Add image`, 8000);
            const g = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), r = e => e && e.getBoundingClientRect(), box = d.querySelector('.inbox-ask-box'), send = d.querySelector('.inbox-ask-send'), add = d.querySelector('.ac-add-image'),
                note = d.querySelector('.ac-images-hint'), foot = d.querySelector('.inbox-ask-foot'), close = [...d.querySelectorAll('button')].find(b => b.textContent.trim() === 'Close');
                return { sendInFoot: !!(foot && foot.contains(send)), closeInFoot: !!(foot && close && foot.contains(close)), gap: Math.round(r(send).top - r(box).bottom), sameRow: add ? Math.abs((r(add).top + r(add).bottom) / 2 - (r(send).top + r(send).bottom) / 2) <= 4 : null,
                    addLeftOfSend: add ? r(add).right <= r(send).left + 1 : null, noteBelow: note ? r(note).top >= r(send).bottom - 2 : null, sendH: Math.round(r(send).height), sendW: Math.round(r(send).width), sendRight: Math.round(r(send).right), dlgRight: Math.round(r(d).right), within: r(send).right <= innerWidth && r(send).left >= 0 }; })()`);
            check(`${tag}: Send reply is not in the footer`, g.sendInFoot === false, JSON.stringify(g));
            check(`${tag}: Close stays in the footer`, g.closeInFoot === true);
            check(`${tag}: Send reply is right under the box (under 90 px)`, g.gap >= 0 && g.gap <= 90, JSON.stringify(g));
            check(`${tag}: Add image is left of it, on the same row`, g.sameRow === true && g.addLeftOfSend === true, JSON.stringify(g));
            check(`${tag}: the pictures note is under that row`, g.noteBelow !== false, JSON.stringify(g));
            check(`${tag}: Send reply is inside the screen`, g.within, JSON.stringify(g));
            if (mobile) check(`${tag}: a 44 px target`, g.sendH >= 43.5, JSON.stringify(g));
            await shot(`ask-send-${w}${fs16 === 32 ? '-200' : ''}`);
            // Ctrl+Enter sends
            await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog .inbox-ask-box'); b.value = 'the first one'; b.dispatchEvent(new Event('input', { bubbles: true })); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`window.__posts.length === 1`, `${tag}: Ctrl+Enter sends the reply`, 6000).catch(() => check(`${tag}: Ctrl+Enter sends the reply`, false));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Send reply under the reply box:\n  ' + problems.join('\n  '));
    console.log('PASS Send reply sits under the reply box, Add image left of it, Close in the footer, Ctrl+Enter sends; 1280, 390, 200% text');
})().catch(e => { console.error(e); process.exit(1); });
