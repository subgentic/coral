// A reply to a question can carry pictures (#12173, the operator's comment on #12143): the dialog has Add image (and takes a paste or a drop), each picture shows as a thumbnail with Mark up and Remove once it is stored on the
// question's team, Send waits for one going up, and the reply names every picture by its artifact link (coral://artifacts/<hex>) after the words, which the board and the agents read. The comment composer's tray, reused.
// 1280 and 390 px; the question route and the picture route are stubbed (as in operator_asks_browser), a real isolated server serves the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const OPERATOR_TEXT = '@Operator TEST ITEM, safe to answer any way: this is a test request so you can reproduce the disappearing-inbox issue.\n\nAnswering or approving it **changes nothing** on the team. Please note what else, if anything, disappears from your Inbox when you answer it:\n\n- the row in Needs you\n- the badge\n\nDetails: [the board](https://example.com/board).';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const at = `${w}: `;
            // the server's list, and the posts the page makes
            await ev(`(() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: ${JSON.stringify(OPERATOR_TEXT)}, at: new Date(Date.now() - 7 * 60000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }];
                window.__posts = []; window.__failPost = false; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push({ url, body }); if (window.__failPost) return json({ error: 'too many messages; retry in 20s' }, 429);
                        window.__asks = window.__asks.filter(a => !(body.content.startsWith('@' + a.asker + ' ') && (a.kind === 'wait' || body.reply_to === a.id))); return json({ id: 99 }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'two rows of Needs you', 10000);
            await ev(`(() => { const orig = window.fetch.bind(window); window.__uploads = []; window.fetch = (u, o) => { if (/\\/goal-images/.test(String(u)) && o && o.method === 'POST') { const n = window.__uploads.push({ url: String(u), type: o.body && o.body.type }); return Promise.resolve(new Response(JSON.stringify({ hex: String(n).repeat(64), name: 'shot.png', content_type: 'image/png', size: 120 }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return orig(u, o); }; return true; })()`);
            await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the dialog opens', 4000);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog .ac-add-image')`, at + 'Add image is in the dialog', 6000);
            assert.ok(await ev(`!!document.querySelector('dialog.inbox-ask-dialog .ac-picker input[type=file]') && /png/.test(document.querySelector('dialog.inbox-ask-dialog .ac-picker input[type=file]').accept)`), at + 'the picker takes pictures');
            // pick a picture
            await ev(`(async () => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const g = c.getContext('2d'); g.fillStyle = '#e63946'; g.fillRect(0, 0, 8, 8); g.fillStyle = '#2a9d8f'; g.fillRect(0, 0, 4, 4); const blob = await new Promise(r => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' })); const input = document.querySelector('dialog.inbox-ask-dialog .ac-picker input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog .ac-thumb-ready')`, at + 'the picture is stored and shows as a thumbnail', 8000);
            const t = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); return { thumbs: d.querySelectorAll('.ac-thumb').length, markup: !!d.querySelector('.ac-thumb-markup:not([hidden])'), remove: !!d.querySelector('.ac-thumb-remove'), upload: window.__uploads[0], sendOff: d.querySelector('.btn-primary').disabled }; })()`);
            assert.ok(t.thumbs === 1 && t.markup && t.remove && /\/api\/board\/coral-hub\/goal-images/.test(t.upload.url) && t.upload.type === 'image/png' && !t.sendOff, at + 'a thumbnail with Mark up and Remove, stored on the question\'s team, Send enabled: ' + JSON.stringify(t));
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-box').value = 'see the screenshot'; true`);
            const pv = await ev(`(async () => { const img = document.querySelector('dialog.inbox-ask-dialog .ac-thumb-img'); await img.decode().catch(() => {}); const c = document.createElement('canvas'); c.width = c.height = 8; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 8, 8); const px = g.getImageData(6, 6, 1, 1).data; const r = img.getBoundingClientRect(), t = img.closest('.ac-thumb').getBoundingClientRect(), add = document.querySelector('dialog.inbox-ask-dialog .ac-add-image').getBoundingClientRect(); return { loaded: img.naturalWidth === 8, red: px[0], w: Math.round(r.width), tileH: Math.round(t.height), sameRow: [...img.closest('.ac-thumb').querySelectorAll('button')].every(b => b.getBoundingClientRect().left > r.right - 1), left: Math.round(r.left - add.left) }; })()`);
            assert.ok(pv.loaded && pv.red > 200, at + 'the picture really previews (a coloured thumbnail, not a black box): ' + JSON.stringify(pv));
            assert.ok(pv.w <= 72 && pv.sameRow && pv.tileH <= (w === 390 ? 110 : 72) && Math.abs(pv.left) <= 2, at + 'a compact tile: Mark up and Remove beside the picture, aligned with Add image: ' + JSON.stringify(pv));
            await shot('ask-reply-image-' + w);
            await ev(`document.querySelector('dialog.inbox-ask-dialog .btn-primary').click(); true`);
            await waitFor(`window.__posts.length === 1`, at + 'the reply is posted', 6000);
            const post = await ev(`window.__posts[0].body.content`);
            assert.ok(/^@Orchestrator see the screenshot\n\ncoral:\/\/artifacts\/1{64}$/.test(post), at + 'the reply names the picture by its artifact link after the words: ' + JSON.stringify(post));
        }
    } finally { await client.close(); }
    console.log('ask_reply_image_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
