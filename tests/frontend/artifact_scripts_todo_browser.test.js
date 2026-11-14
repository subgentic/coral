// A todo page with inline script + localStorage in the artifact viewer (#16735): the "Run scripts…" offer is visible even when
// the sandbox notice is hidden (returning user), and with scripts on the bar mentions storage limits and holds an "Open in browser" link.
// Real Chrome against an isolated Coral, artifact and trust routes stubbed. Fixture: a one-file todo page with an Add button and localStorage.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HTML = `<!doctype html><html><head><title>Todo</title></head><body>
<h1>Todo</h1><input id="task"><button id="add" onclick="addTask()">Add</button><ul id="list"></ul>
<script>function addTask(){var i=document.getElementById('task');if(!i.value)return;var l=document.createElement('li');l.textContent=i.value;document.getElementById('list').appendChild(l);i.value='';try{localStorage.setItem('todos',JSON.stringify([].slice.call(document.querySelectorAll('#list li')).map(function(x){return x.textContent})))}catch(e){}}try{JSON.parse(localStorage.getItem('todos')||'[]').forEach(function(t){var l=document.createElement('li');l.textContent=t;document.getElementById('list').appendChild(l)})}catch(e){}</script>
</body></html>`;
const HEX = crypto.createHash('sha256').update(HTML).digest('hex');

(async () => {
    const { client, Page, Runtime, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => {
            window.__trust = new Set(); window.__body = ${JSON.stringify(HTML)}; window.__bodyHex = ${JSON.stringify(HEX)};
            const orig = window.fetch.bind(window);
            const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
                const t = /\\/api\\/artifacts\\/([a-f0-9]{64})\\/trust-preview/.exec(url);
                if (t) { if (method === 'PUT') window.__trust.add(t[1]); if (method === 'DELETE') window.__trust.delete(t[1]);
                    return json({ id: t[1], trusted: window.__trust.has(t[1]) }); }
                if (/\\/api\\/artifacts\\/[a-f0-9]{64}\\/(versions|comments)/.test(url)) return json(/comments/.test(url) ? { comments: [], locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} } : []);
                if (/\\/api\\/artifacts\\/[a-f0-9]{64}/.test(url)) return Promise.resolve(new Response(window.__body, { status: 200, headers: { 'Content-Type': 'text/html' } }));
                return orig(u, o); };
        })()`);
        // mark the sandbox note as seen so the notice is hidden on next open
        await ev(`(() => { try { localStorage.setItem('coral-sandbox-note', '1'); } catch {} return true; })()`);

        const open = async () => {
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${HEX}', { filename: 'todo.html', mediaType: 'text/html', sourceNamed: false })).then(() => true)`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`, 'the HTML preview', 10000);
        };
        const q = sel => ev(`(() => { const e = document.querySelector('#artifact-viewer ${sel}'); return !!e && !e.hidden && e.getClientRects().length > 0; })()`);
        const text = sel => ev(`(document.querySelector('#artifact-viewer ${sel}') || {}).textContent || ''`);
        const click = sel => ev(`document.querySelector('#artifact-viewer ${sel}').click(); true`);

        // 1. the sandbox notice is hidden (returning user), but the Run scripts offer is still visible
        await open();
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-ask')`, 'the Run scripts offer', 5000);
        const notice = await ev(`(() => { const n = document.querySelector('#artifact-viewer .artifact-linked-notice'); return n ? n.hidden : null; })()`);
        assert.equal(notice, true, 'the sandbox notice is hidden for a returning user');
        assert.ok(await q('.artifact-scripts-ask'), 'the Run scripts… button is visible even with the notice hidden (#16735)');
        await shot('todo-offer');

        // 2. turn scripts on: the bar mentions storage and has Open in browser
        await click('.artifact-scripts-ask'); await click('.artifact-scripts-go');
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-bar')`, 'the scripts-on bar', 10000);
        const barText = await text('.artifact-scripts-bar');
        assert.ok(/no storage/.test(barText), 'the scripts-on bar mentions that storage is not available: ' + barText);
        const openLink = await ev(`(() => { const a = document.querySelector('#artifact-viewer .artifact-scripts-open'); return a ? { href: a.href, target: a.target, text: a.textContent } : null; })()`);
        assert.ok(openLink, 'the Open in browser link is present');
        assert.equal(openLink.text, 'Open in browser');
        assert.equal(openLink.target, '_blank');
        assert.ok(/run=1/.test(openLink.href), 'the link points to the ?run=1 endpoint: ' + openLink.href);
        await shot('todo-scripts-on');

        // 3. the ⋯ menu's Run scripts… item works when the notice is hidden
        await click('.artifact-scripts-off');
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-ask')`, 'back to the offer', 10000);
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); true`);
        const item = await ev(`(() => { const i = document.querySelector('#artifact-viewer .artifact-viewer-scripts-item'); return i ? { hidden: i.hidden, text: i.textContent } : null; })()`);
        assert.ok(item && !item.hidden, 'the Run scripts… menu item is shown');
        await click('.artifact-viewer-scripts-item');
        assert.ok(await q('.artifact-scripts-sure'), 'the menu item opens the confirmation even when the notice is hidden');
        await shot('todo-menu-confirm');

    } finally { await client.close(); }
    console.log('artifact_scripts_todo_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
