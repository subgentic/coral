// #18768: a single agent's question that asks to open a page (coral-agent ask --open analytics) shows a primary "Open Analytics" button next to the reply buttons. Clicking it goes to the Analytics page
// and answers nothing: the question is still open (no answer posted) and the card can be opened again with Done / Skip / Stop. Same at phone width. The server calls are stood in (fetch).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 }); await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.__posts = []; (() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = String(u);
                if ((o.method || 'GET') === 'POST' && /\\/api\\/agent-asks\\/[^/]+\\/answer$/.test(url)) { window.__posts.push(url); return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; })(); true`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            const open = (id, page) => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js'); await m.openAskDialog({ board: '', asker: 'Getting started', kind: 'agent', id: ${id}, at: new Date(Date.now() - 60000).toISOString(), text: 'Open Analytics and look around.', options: ['Done', 'Skip this step', 'Stop the tour']${page ? `, open_page: '${page}'` : ''} }, undefined, {}); return true; })()`);
            const dlg = `document.querySelector('dialog.inbox-ask-dialog')`;
            const words = () => ev(`[...${dlg}.querySelectorAll('.inbox-ask-offers-list button')].map(b => b.textContent)`);

            await open(1, 'analytics');
            await waitFor(`!!${dlg} && !!${dlg}.querySelector('.inbox-ask-open-page')`, `${width}: the Open Analytics button`, 8000);
            assert.deepEqual(await words(), ['Open Analytics', 'Done', 'Skip this step', 'Stop the tour'], `${width}: the page button, then the reply buttons`);
            assert.equal(await ev(`${dlg}.querySelector('.inbox-ask-open-page').classList.contains('btn-primary')`), true, `${width}: it is the primary button`);
            await shot('agent-ask-open-page-' + width);
            await ev(`${dlg}.querySelector('.inbox-ask-open-page').click(); true`);
            await waitFor(`location.pathname === '/analytics'`, `${width}: Analytics opens`, 8000);
            assert.equal(await ev(`!!${dlg}`), false, `${width}: the card closes to show the page`);
            assert.deepEqual(await ev(`window.__posts`), [], `${width}: nothing was answered`);

            // the question is still open: opened again it offers Done / Skip / Stop, and Done answers
            await open(1, 'analytics');
            await waitFor(`!!${dlg} && !!${dlg}.querySelector('.inbox-ask-open-page')`, `${width}: the card again`, 8000);
            await ev(`[...${dlg}.querySelectorAll('.inbox-ask-offers-list button')].find(b => b.textContent === 'Done').click(); true`);
            await waitFor(`window.__posts.length === 1`, `${width}: Done still answers`, 8000);
            assert.match(await ev(`window.__posts[0]`), /\/api\/agent-asks\/1\/answer$/, `${width}: through the agent-ask route`);

            // a question with no page has no such button, and a name that is not a page of Coral draws none
            for (const page of [null, 'https://example.com', '/analytics']) {
                await open(2, page);
                await waitFor(`!!${dlg} && !!${dlg}.querySelector('.inbox-ask-offers-list')`, `${width}: a card with ${page}`, 8000);
                assert.deepEqual(await words(), ['Done', 'Skip this step', 'Stop the tour'], `${width}: no page button for ${page}`);
                await ev(`${dlg}.querySelector('.btn-quiet').click(); true`).catch(() => {});
                await ev(`(() => { const d = ${dlg}; if (d) { d.close(); d.remove(); } return true; })()`);
            }
        }
        console.log('\nPASS the Open Analytics button opens Analytics, answers nothing, and the question stays open');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
