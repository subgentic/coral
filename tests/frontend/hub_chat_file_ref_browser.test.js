// #20817: through a Hub a click on an absolute file path in an agent's chat sends the folder-relative path (the tunnel refuses / and ~ at View tier), and a path outside the folder says so with no request.
// Locally nothing changes. Hub-mode is a remote computer (server 'm1') with the page's fetch stubbed. Isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const sceneShots = require('./helpers/scene_shots');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const shot = sceneShots(Page);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.__urls = []; (() => { const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u);
                if (url.includes('/resolve-path')) { window.__urls.push(url); const fp = new URL(url, location.href).searchParams.get('filepath'); if (/^[/~]/.test(fp) && url.includes('/api/remote/')) return Promise.resolve(new Response('{}', { status: 404 })); return Promise.resolve(new Response(JSON.stringify({ filepath: '/work/app/' + fp.replace(/^\\/work\\/app\\//, ''), line: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return real(u, o); }; return true; })()`);
            const click = (server, ref) => ev(`(async () => { const st = (await import(${S} + 'state.js')).state; const m = await import(${S} + 'chat_file_menu.js');
                st.currentSession = { type: 'live', name: 'app-agent', session_id: 's1', display_name: 'Lead Dev', server: ${JSON.stringify(server)}, working_directory: '/work/app' };
                st.liveSessions = [{ name: 'app-agent', server: ${JSON.stringify(server)}, working_directory: '/work/app' }];
                document.querySelectorAll('.chat-file-menu, .toast, [role=status]').forEach(e => e.remove());
                window.__urls.length = 0; const a = document.createElement('a'); a.dataset.fileRef = ${JSON.stringify(ref)}; document.body.appendChild(a);
                await m.showFileRefMenu(a); return { urls: window.__urls.slice(), menu: !!document.querySelector('.chat-file-menu'), text: document.body.innerText }; })()`);
            let r = await click('m1', '/work/app/src/a.js');
            check(r.urls.length === 1 && /filepath=src%2Fa\.js/.test(r.urls[0]), `${at}via a Hub the absolute path inside the folder is sent relative: ` + JSON.stringify(r.urls));
            check(r.menu, `${at}the file menu opens`); await shot('hub-inside-' + w);
            r = await click('m1', '/work/app/src/a.js:12:5');
            check(r.urls.length === 1 && /filepath=src%2Fa\.js(&|$)/.test(r.urls[0]) && !/%3A/i.test(r.urls[0]), `${at}a :line:col suffix is taken off before the request: ` + JSON.stringify(r.urls));
            check(r.text.includes('src/a.js:12') && r.menu, `${at}the line is kept for the viewer`);
            r = await click('m1', '/work/app2/a.js'); await shot('hub-outside-' + w);
            check(r.urls.length === 0, `${at}a sibling folder (/work/app2) sends no request: ` + JSON.stringify(r.urls));
            check(r.text.includes("This file is outside Lead Dev's folder; it opens on that computer only."), `${at}outside words shown`);
            check(!/File not found/.test(r.text), `${at}not 'File not found'`);
            r = await click('m1', '/work/app/../secret');
            check(r.urls.length === 0, `${at}a .. path sends no request`);
            r = await click('local', '/work/app/src/a.js');
            check(r.urls.length === 1 && /filepath=%2Fwork%2Fapp%2Fsrc%2Fa\.js/.test(r.urls[0]), `${at}locally the absolute path is sent unchanged: ` + JSON.stringify(r.urls));
            r = await click('local', '/etc/hosts');
            check(r.urls.length === 1, `${at}locally an outside path still asks the server`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS through a Hub the chat file click sends the folder-relative path; outside says so; local unchanged');
})().catch(e => { console.error(e); process.exit(1); });
