// Threads on the board (#12502, #12491: the Operator, "move under the thread"): a reply sits under the message it answers however late it was posted, at 1280 and 390 px; a "Replying to" strip names the
// message and the post carries reply_to while it is there (even when the typed @name is deleted), and its Cancel drops the link; a reply that arrives while the board is open moves up under its message.
// Isolated dev server; with CORAL_SCREENSHOT_DIR set it saves a picture of each width.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const base = 'thr-' + Date.now().toString(36); let B = base;
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const post = async (who, content, extra = {}) => { const r = await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content, ...extra }); assert.equal(r.status, 200, `${who} posts: ${JSON.stringify(r)}`); return r.body.id || (r.body.message && r.body.message.id); };
    const order = () => ev(`[...document.querySelectorAll('#mb-messages > .mb-message')].map(r => r.dataset.messageId + (r.classList.contains('mb-thread-reply') ? 'r' : ''))`);
    const rows = async () => (await ev(`fetch('/api/board/${B}/messages/all?limit=50').then(r => r.json())`));
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + `/team/${B}/messages` }); await Page.loadEventFired(); await install(); await coralReady();
        await waitFor(`document.querySelectorAll('#mb-messages > .mb-message').length >= 4`, 'the board rows', 15000);
        await settle(400);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        const boards = [];
        for (const [w, h, mobile] of [[1280, 800, false], [390, 800, true]]) {
            B = `${base}-${w}`; boards.push(B); // each width has its own board
            for (const id of ['Orchestrator', 'Backend Dev', 'Lead Developer']) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: id })).status, 200);
            const q1 = await post('Orchestrator', '@Backend Dev which hub do we ship to: self-hosted or the hosted one?', { ask: true });
            const q2 = await post('Orchestrator', '@Backend Dev should the tag wait for Windows?', { ask: true });
            const m3 = await post('Lead Developer', 'Self-hosted build is up.');
            const r1 = await post('Backend Dev', 'The self-hosted hub.', { reply_to: q1 });
            console.log(`${w} px: the reply sits under its question, the others keep their order`);
            await open(w, h, mobile);
            assert.deepEqual(await order(), [`${q1}`, `${r1}r`, `${q2}`, `${m3}`], 'rows in thread order');
            await shot(`board-threads-${w}`);

            console.log(`${w} px: Reply shows the strip; the post carries reply_to though the typed name is deleted`);
            await ev(`(() => { const row = document.querySelector('#mb-messages > .mb-message[data-message-id="${q2}"]'); row.querySelector('.mb-row-toggle').click(); return true; })()`); await settle(200);
            await ev(`document.querySelector('#mb-messages > .mb-message[data-message-id="${q2}"] .mb-row-actions').querySelectorAll('button').forEach(b => { if (b.textContent === 'Reply') b.click(); }); true`); await settle(200);
            const strip = await ev(`(document.querySelector('#mb-board .mb-reply-strip') || {}).textContent || null`);
            assert.match(strip, /Replying to Orchestrator: .@Backend Dev should the tag wait for Windows/, 'the strip names the message: ' + strip);
            await ev(`(() => { const i = document.getElementById('mb-post-input'); i.value = 'No, ship it.'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#mb-board .mb-post-send-btn').click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#mb-messages > .mb-message').length >= 5`, 'the reply row', 10000);
            const sent = (await rows()).find(m => /No, ship it/.test(m.content));
            assert.equal(Number(sent && sent.reply_to), Number(q2), 'reply_to is the message the strip named: ' + JSON.stringify(sent));
            assert.equal(await ev(`!!document.querySelector('#mb-board .mb-reply-strip')`), false, 'the strip is gone after the post');
            const o = await order();
            assert.deepEqual(o.slice(0, 4), [`${q1}`, `${r1}r`, `${q2}`, `${sent.id}r`], 'the new reply sits under the second question: ' + o);

            console.log(`${w} px: Cancel reply drops the link`);
            await ev(`document.querySelector('#mb-messages > .mb-message[data-message-id="${q1}"] .mb-row-toggle').click(); true`); await settle(200);
            await ev(`document.querySelector('#mb-messages > .mb-message[data-message-id="${q1}"] .mb-row-actions').querySelectorAll('button').forEach(b => { if (b.textContent === 'Reply') b.click(); }); true`); await settle(200);
            await ev(`document.querySelector('#mb-board .mb-reply-strip-clear').click(); true`); await settle(100);
            assert.equal(await ev(`!!document.querySelector('#mb-board .mb-reply-strip')`), false, 'the strip is gone');
            await ev(`(() => { const i = document.getElementById('mb-post-input'); i.value = 'A plain note ' + ${w}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#mb-board .mb-post-send-btn').click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#mb-messages > .mb-message').length >= 6`, 'the plain post', 10000);
            const plain = (await rows()).find(m => m.content === 'A plain note ' + w);
            assert.ok(plain && !plain.reply_to, 'a cancelled reply carries no reply_to: ' + JSON.stringify(plain));

            console.log(`${w} px: a reply that arrives while the board is open moves up under its message`);
            const late = await post('Backend Dev', 'Late answer to the first question ' + w, { reply_to: q1 });
            await waitFor(`!!document.querySelector('#mb-messages > .mb-message[data-message-id="${late}"]')`, 'the late reply row', 30000);
            const after = await order();
            assert.equal(after[after.indexOf(`${r1}r`) + 1], `${late}r`, 'the late reply follows the first reply of its thread: ' + after);
            await shot(`board-threads-after-${w}`);
        }
        console.log('PASS threads on the board');
    } finally { await removeBoards(ev, [`${base}-1280`, `${base}-390`]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
