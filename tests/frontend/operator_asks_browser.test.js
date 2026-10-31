// Questions to the Operator in their Needs you (#11417): an agent's `post --ask "@Operator ..."` and `wait --operator "..."` are rows of the Inbox's Needs you (the asker, the question on one line with hidden
// characters written out, counted in the badge), each opens whole in a dialog with a Reply box, and Send posts the board reply as the Operator (reply_to for an ask, the asker's @name for both); a refused post keeps
// the text and says why. The route is stubbed with the server's shape (the Go tests read the real one); a real isolated server serves the page. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const LONG = 'Which of the two \u202edesigns do we ship? ' + 'We have weighed the first against the second at length and the cost of each is clear. '.repeat(4) + 'Reply with 1 or 2. \u202eevil';

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
            await ev(`(() => { window.__asks = [{ board: 'team', kind: 'ask', id: 41, asker: 'Lead', text: ${JSON.stringify(LONG)}, at: '2026-10-31T01:00:00Z' }, { board: 'team', kind: 'wait', id: 7, asker: 'Dev', text: 'may I delete the old table?', at: '2026-10-31T02:00:00Z' }];
                window.__posts = []; window.__failPost = false; const orig = window.fetch.bind(window);
                window.fetch = (u, o) => { const url = String(u); const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    if (url === '/api/operator-asks') return json(window.__asks);
                    if (/^\\/api\\/board\\/[^/]+\\/messages$/.test(url) && o && o.method === 'POST') { const body = JSON.parse(o.body); window.__posts.push({ url, body }); if (window.__failPost) return json({ error: 'too many messages; retry in 20s' }, 429);
                        window.__asks = window.__asks.filter(a => !(body.content.startsWith('@' + a.asker + ' ') && (a.kind === 'wait' || body.reply_to === a.id))); return json({ id: 99 }); }
                    return orig(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'two rows of Needs you', 10000);
            const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(r => ({ text: r.textContent, reply: !!r.querySelector('button[aria-label^="Reply to"]') }))`);
            let rs = await rows();
            assert.ok(rs.every(r => r.reply), at + 'each row has a Reply button: ' + JSON.stringify(rs));
            const lead = rs.find(r => r.text.includes('Lead')), dev = rs.find(r => r.text.includes('Dev'));
            assert.ok(lead && dev, at + 'the askers are named');
            assert.ok(lead.text.includes('Which of the two <U+202E>designs'), at + 'the question is on the row, with the hidden character written out: ' + lead.text.slice(0, 120));
            assert.ok(!lead.text.includes('\u202e'), at + 'a hidden character is written out, never drawn raw');
            assert.ok(dev.text.includes('may I delete the old table?'), at + "the wait's question is on the row");
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '2'`, at + 'the badge counts both', 6000);

            // opens whole
            await ev(`document.querySelector('button[aria-label="Reply to Lead"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the dialog opens', 4000);
            const dlg = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); const r = d.getBoundingClientRect(); const btns = [...d.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().height));
                return { whole: d.querySelector('.inbox-ask-text').textContent, title: d.querySelector('h2').textContent, fits: r.left >= 0 && r.right <= innerWidth + 1, btns, focus: document.activeElement && document.activeElement.className }; })()`);
            assert.equal(dlg.title, 'Lead asks you', at + 'the title');
            assert.ok(dlg.whole.includes('Reply with 1 or 2.') && dlg.whole.includes('<U+202E>evil') && !dlg.whole.includes('\u202e'), at + 'the whole question, marked: ' + dlg.whole.slice(-60));
            assert.ok(dlg.fits, at + 'the dialog fits the screen'); assert.ok(dlg.btns.every(h => h >= 44), at + 'buttons are 44 px tall: ' + dlg.btns); assert.ok(/inbox-ask-box/.test(dlg.focus), at + 'the box has the focus: ' + dlg.focus);

            // empty reply, then a refused post keeps the text, then Send
            const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
            await click('dialog.inbox-ask-dialog .btn-primary');
            await waitFor(`document.querySelector('.inbox-ask-error').textContent === 'Write a reply first.'`, at + 'an empty reply is refused', 3000);
            await ev(`(() => { const b = document.querySelector('.inbox-ask-box'); b.value = 'Ship the second.'; window.__failPost = true; return true; })()`);
            await click('dialog.inbox-ask-dialog .btn-primary');
            await waitFor(`/too many messages/.test(document.querySelector('.inbox-ask-error').textContent)`, at + 'a refused post says why', 4000);
            assert.equal(await ev(`document.querySelector('.inbox-ask-box').value`), 'Ship the second.', at + 'the text stays');
            assert.equal(await ev(`window.__posts.length`), 1);
            await ev(`window.__failPost = false; true`);
            await click('dialog.inbox-ask-dialog .btn-primary');
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'the dialog closes after Send', 4000);
            const post = await ev(`window.__posts[window.__posts.length - 1]`);
            assert.equal(post.url, '/api/board/team/messages'); assert.equal(post.body.subscriber_id, 'Operator'); assert.equal(post.body.as, 'Operator');
            assert.equal(post.body.content, '@Lead Ship the second.', at + 'the asker is @named'); assert.equal(post.body.reply_to, 41, at + 'an ask is answered with reply_to');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'the answered row leaves', 6000);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '1'`, at + 'the badge counts one', 6000);

            // the wait: a plain post to its asker, no reply_to
            await ev(`document.querySelector('button[aria-label="Reply to Dev"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the wait opens', 4000);
            assert.ok((await ev(`document.querySelector('.inbox-ask-sub').textContent`)).includes('waiting for your reply'), at + 'a wait says it is waiting');
            await ev(`document.querySelector('.inbox-ask-box').value = 'yes, delete it'; true`);
            await click('dialog.inbox-ask-dialog .btn-primary');
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'closed', 4000);
            const p2 = await ev(`window.__posts[window.__posts.length - 1]`);
            assert.equal(p2.body.content, '@Dev yes, delete it'); assert.ok(!('reply_to' in p2.body), at + 'a wait has no reply_to');
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 0`, at + 'no rows left', 6000);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').hidden`, at + 'the badge is gone', 6000);

            // Escape closes without sending
            await ev(`window.__asks = [{ board: 'team', kind: 'ask', id: 50, asker: 'Lead', text: 'short question', at: '2026-10-31T03:00:00Z' }]; (async () => (await import(${S} + 'operator_asks.js')).refreshOperatorAsks(true))(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1`, at + 'a new question appears on the next read', 6000);
            const before = await ev(`window.__posts.length`);
            await ev(`document.querySelector('button[aria-label="Reply to Lead"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'opens again', 4000);
            await ev(`document.querySelector('dialog.inbox-ask-dialog').dispatchEvent(new Event('cancel', { cancelable: true })); true`);
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'Escape closes it', 4000);
            assert.equal(await ev(`window.__posts.length`), before, at + 'nothing was sent');
        }
        console.log('PASS operator asks in Needs you: the rows, the badge, the whole question, the reply, and a refused post that keeps the text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
