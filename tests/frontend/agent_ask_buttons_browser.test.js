// #18668: a single agent's question with 3 options: one button each (not a "Choices:" text list), a click answers with the label through POST /api/agent-asks/<id>/answer,
// the header is the agent's name with no team, and a picture attaches to the agent (POST /api/agent-asks/<id>/images) and rides in the reply. The server calls are stood in (fetch).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const HEX = 'ab'.repeat(32);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 }); await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.__posts = []; window.__pics = []; (() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = String(u); const ok = b => Promise.resolve(new Response(JSON.stringify(b), { status: b.hex ? 201 : 200, headers: { 'Content-Type': 'application/json' } }));
                if ((o.method || 'GET') === 'POST' && /\\/api\\/agent-asks\\/[^/]+\\/answer$/.test(url)) { window.__posts.push({ url, body: JSON.parse(o.body) }); return ok({ ok: true }); }
                if ((o.method || 'GET') === 'POST' && /\\/api\\/agent-asks\\/[^/]+\\/images$/.test(url)) { window.__pics.push(url); return ok({ hex: '${HEX}', uri: 'coral://artifacts/${HEX}', name: 'mock.png', content_type: 'image/png', size: 4 }); }
                if ((o.method || 'GET') === 'POST' && /\\/api\\/agent-asks\\/[^/]+\\/dismiss$/.test(url)) { window.__dismissed = (window.__dismissed || []).concat(url); return ok({ ok: true }); }
                if (/comment-images|goal-images/.test(url)) { window.__pics.push('TEAM ' + url); return Promise.resolve(new Response('{"error":"this team does not exist"}', { status: 404 })); }
                return R(u, o); }; })(); true`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            const open = id => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js'); await m.openAskDialog({ board: '', asker: 'Notes builder', kind: 'agent', id: ${id}, at: new Date(Date.now() - 60000).toISOString(), text: 'Which database should the notes app use?', options: ['Postgres', 'SQLite', 'Something else'] }, undefined, { goal() {}, task() {} }); return true; })()`);
            await open(7);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog textarea')`, `${width}: the question card`, 8000);
            const dlg = `document.querySelector('dialog.inbox-ask-dialog')`;
            assert.deepEqual(await ev(`[...${dlg}.querySelectorAll('.inbox-ask-offers-list button')].map(b => b.dataset.buttonId && b.textContent)`), ['Postgres', 'SQLite', 'Something else'], `${width}: one button per option`);
            assert.equal(await ev(`/Choices/.test(${dlg}.textContent)`), false, `${width}: no "Choices:" text list`);
            assert.equal(await ev(`${dlg}.querySelector('h2').textContent`), 'Notes builder', `${width}: the header is the agent's name, no Team`);
            // a picture attaches to the agent (never the team route) and rides in the reply
            await waitFor(`!!${dlg}.querySelector('.inbox-ask-pick button')`, `${width}: the picture button`, 8000);
            await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['test'], 'mock.png', { type: 'image/png' })); ${dlg}.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`window.__pics.length === 1`, `${width}: the picture goes up`, 8000);
            assert.match(await ev(`window.__pics[0]`), /\/api\/agent-asks\/7\/images$/, `${width}: to the agent, not a team`);
            assert.match(await ev(`${dlg}.textContent`), /shared with Notes builder/, `${width}: the line names the agent`);
            assert.equal(await ev(`/this team/.test(${dlg}.textContent)`), false, `${width}: no "this team" line`);
            await shot('agent-ask-buttons-' + width);
            await waitFor(`[...${dlg}.querySelectorAll('.inbox-ask-offers-list button')].every(b => !b.disabled)`, `${width}: the picture is ready`, 8000);
            await ev(`[...${dlg}.querySelectorAll('.inbox-ask-offers-list button')].find(b => b.textContent === 'SQLite').click(); true`);
            await waitFor(`window.__posts.length === 1`, `${width}: the click answers`, 8000);
            assert.match(await ev(`window.__posts[0].url`), /\/api\/agent-asks\/7\/answer$/, `${width}: through the agent-ask route`);
            assert.equal(await ev(`window.__posts[0].body.answer`), `SQLite\n\ncoral://artifacts/${HEX}`, `${width}: the label, then the picture`);
            assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog')`), false, `${width}: the dialog closes`);
            // a button alone answers with just its label
            await open(8);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog .inbox-ask-offers-list button')`, `${width}: second card`, 8000);
            await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-offers-list button').click(); true`);
            await waitFor(`window.__posts.length === 2`, `${width}: the second click answers`, 8000);
            assert.equal(await ev(`window.__posts[1].body.answer`), 'Postgres', `${width}: the label alone`);
            // Dismiss: the question can be cleared (the agent is told by the server)
            await open(9);
            await waitFor(`!![...document.querySelectorAll('dialog.inbox-ask-dialog button')].find(b => /dismiss/i.test(b.textContent) && !b.hidden)`, `${width}: Dismiss is offered`, 8000);
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog button')].find(b => /dismiss/i.test(b.textContent)).click(); true`);
            await waitFor(`(window.__dismissed || []).length === 1`, `${width}: Dismiss posts`, 8000);
            assert.match(await ev(`window.__dismissed[0]`), /\/api\/agent-asks\/9\/dismiss$/, `${width}: to the agent-ask dismiss route`);
        }
        console.log('\nPASS a single agent question has buttons, the agent name and attachable pictures, and can be dismissed');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
