// #12722: the asker/team title and complete Markdown question, including one-line questions,
// preserve safe text, reply behavior, and dialog geometry at desktop and phone widths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HOSTILE = '@Operator look at this: <img src=x onerror="window.__pwned=1"> and <script>window.__pwned=2</script>\n\nA second paragraph, with <b onmouseover="window.__pwned=3">bold</b> html.';
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
            await ev(`(() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: ${JSON.stringify(OPERATOR_TEXT)}, at: new Date(Date.now() - 7 * 60000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 42, asker: 'Dev', text: '@Operator may I delete the old table?', at: new Date(Date.now() - 3600000).toISOString() }, { board: 'team', board_label: 'Sprout', kind: 'ask', id: 43, asker: 'QA', text: ${JSON.stringify(HOSTILE)}, at: new Date(Date.now() - 7200000).toISOString() }];
                window.__posts = []; window.__failPost = false; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push({ url, body }); if (window.__failPost) return json({ error: 'too many messages; retry in 20s' }, 429);
                        window.__asks = window.__asks.filter(a => !(body.content.startsWith('@' + a.asker + ' ') && (a.kind === 'wait' || body.reply_to === a.id))); return json({ id: 99 }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 3`, at + 'three rows of Needs you', 10000);
            const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            // the long question
            await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the dialog opens', 4000);
            const d = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), body = d.querySelector('.inbox-ask-text'), box = d.querySelector('textarea'), btns = [...d.querySelectorAll('.inbox-ask-buttons button')].map(b => b.textContent), r = d.getBoundingClientRect();
                return { title: d.querySelector('h2').textContent, meta: d.querySelector('.inbox-ask-sub').textContent, bodyText: body ? body.textContent : '', strong: !!(body && body.querySelector('strong')), items: body ? body.querySelectorAll('li').length : 0, link: body && body.querySelector('a') ? body.querySelector('a').getAttribute('href') : '', mono: body ? getComputedStyle(body).fontFamily : '', pre: !!d.querySelector('pre'), reply: !!box, inItem: !!box && d.contains(box), btns, fits: r.left >= 0 && r.right <= innerWidth + 1, cx: Math.round((r.left + r.right) / 2 - innerWidth / 2), cy: Math.round((r.top + r.bottom) / 2 - innerHeight / 2), sendRight: (() => { const send = d.querySelector('.inbox-ask-send'), box = d.querySelector('textarea'), foot = d.querySelector('.inbox-ask-foot'); return !!send && !foot.contains(send) && send.getBoundingClientRect().top >= box.getBoundingClientRect().bottom - 1; })(), raw: d.textContent.includes('@Operator') }; })()`);
            assert.equal(d.title, 'Orchestrator · coral-hub', at + 'title names the asker and team');
            assert.equal(d.meta, '7 min ago', at + 'metadata shows when it was asked');
            assert.ok(d.strong && d.items === 2 && d.link === 'https://example.com/board', at + 'the words are rendered Markdown (emphasis, a list, a link): ' + JSON.stringify({ strong: d.strong, items: d.items, link: d.link }));
            assert.ok(!d.pre && !/mono/i.test(d.mono) && !d.raw, at + 'not the bordered monospace box, and no raw @Operator anywhere in it: ' + JSON.stringify({ pre: d.pre, mono: d.mono, raw: d.raw }));
            assert.ok(d.bodyText.includes('Answering or approving it changes nothing') && d.bodyText.includes('the badge'), at + 'the whole question is in the body: ' + d.bodyText.slice(0, 80));
            assert.ok(d.reply && d.inItem && d.btns.join('|') === 'Close|Dismiss' && d.fits, at + 'the reply field is in the item, with Close and Dismiss (Send reply is under the box, #13148), and it fits: ' + JSON.stringify({ reply: d.reply, btns: d.btns, fits: d.fits }));
            assert.ok(Math.abs(d.cx) <= 2 && Math.abs(d.cy) <= 30, at + 'the dialog opens centered like the other modals: ' + JSON.stringify({ cx: d.cx, cy: d.cy }));
            assert.ok(d.sendRight, at + 'Send reply is under the reply box, not in the footer (#13148)');
            await shot('ask-item-' + w);
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-primary)').click(); true`);
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'Close closes it', 4000);
            // bidi and zero-width characters in the question remain written out in its body (Security's SHOULD on #12143; hidden characters reshape what the Operator reads before deciding)
            const titles = await ev(`import(${S} + 'operator_asks.js').then(m => ({
                short: m.askParts({ text: '@Operator approve \\u202edeploy\\u200b now?\\nmore' }).body,
                long: m.askParts({ text: '@Operator \\u202e' + 'Which of the two designs do we ship, given what each costs and what the other would cost us? ' + 'x'.repeat(20) }).body,
                heading: m.askParts({ text: '## \\u200bship it?' }).body }))`);
            assert.equal(titles.short, 'approve <U+202E>deploy<U+200B> now?\nmore', at + 'hidden characters in the complete question are written out');
            assert.ok(titles.long.startsWith('<U+202E>Which of the two designs') && !/[\u202e\u200b]/.test(titles.long), at + 'a long first line is cut after they are written out: ' + JSON.stringify(titles.long));
            assert.equal(titles.heading, '## <U+200B>ship it?', at + 'Markdown heading stays in the body, hidden characters visible');
            // a one-line question is shown once in the body
            await ev(`document.querySelector('button[aria-label="Answer the question of Dev"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the second opens', 4000);
            const s = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); return { title: d.querySelector('h2').textContent, body: !!d.querySelector('.inbox-ask-text'), meta: d.querySelector('.inbox-ask-sub').textContent }; })()`);
            assert.ok(s.title === 'Dev · Sprout' && s.body && s.meta, at + 'even a short question lives in the body: ' + JSON.stringify(s));
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-primary)').click(); true`);
            // HTML in a question is written out as text, never run: no <img onerror>, <script> or handler writes to window (the strict Markdown rendering stays pinned)
            await ev(`document.querySelector('button[aria-label="Answer the question of QA"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the hostile question opens', 4000);
            await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: an image that fails to load fires its handler within a few frames; this waits for it
            const hostile = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); return { pwned: typeof window.__pwned, live: d.querySelectorAll('img, script, [onerror], [onmouseover]').length, text: d.textContent }; })()`);
            assert.ok(hostile.pwned === 'undefined' && hostile.live === 0 && hostile.text.includes('<img src=x onerror='), at + 'an <img onerror>, a <script> and an event handler in a question write nothing to window and draw nothing: ' + JSON.stringify({ pwned: hostile.pwned, live: hostile.live }));
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-primary)').click(); true`);
        }
    } finally { await client.close(); }
    console.log('ask_item_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
