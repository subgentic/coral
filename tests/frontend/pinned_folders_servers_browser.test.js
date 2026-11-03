// Pinned folders are kept on the computer the folder is on (#12653, coral-hub #156820): pinned_folders.js did a bare fetch of /api/pinned-folders, which through Coral Hub is the Hub's own, so a folder could not be pinned or
// unpinned and none was listed. Now the list is read from every computer the page reads (this one, and each registered computer that is online), each pin carries its computer, a computer that cannot be read keeps its pins, the
// pin and the unpin go to the computer of the folder's menu (the server menu's Open folder names its computer), and two computers' folders of one name are two entries with two keys. A real isolated server serves the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.hub = true; state.servers = [{ id: 'box-1', status: 'online' }, { id: 'box-2', status: 'online' }, { id: 'box-3', status: 'offline' }];
            window.__calls = []; window.__box2 = 'fail'; const orig = window.fetch.bind(window);
            const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u), m = (o && o.method) || 'GET';
                if (/pinned-folders/.test(url)) window.__calls.push(m + ' ' + url + (o && o.body ? ' ' + o.body : ''));
                if (url === '/api/pinned-folders' && m === 'GET') return json({ folders: [{ path: '/work/app', name: 'app', exists: true }] });
                if (url === '/api/remote/box-1/api/pinned-folders' && m === 'GET') return json({ folders: [{ path: '/srv/app', name: 'app', exists: true }] });
                if (url === '/api/remote/box-2/api/pinned-folders' && m === 'GET') return window.__box2 === 'fail' ? json({ error: 'down' }, 502) : json({ folders: [{ path: '/data/db', name: 'db', exists: true }] });
                if (/pinned-folders/.test(url) && (m === 'POST' || m === 'DELETE')) return json({ name: 'x', path: JSON.parse(o.body).path });
                return orig(u, o); }; return true; })()`);
        const read = () => ev(`(async () => { const m = await import(${S} + 'pinned_folders.js'); await m.loadPinnedFolders({ render: false }); return m.pinnedFolders().map(p => p.server + ':' + p.path); })()`);
        let pins = await read();
        assert.deepEqual(pins.sort(), ['box-1:/srv/app', 'local:/work/app'], 'this computer\'s and box-1\'s pins are read; box-2 failed and box-3 is offline: ' + JSON.stringify(pins));
        const calls = await ev(`window.__calls`);
        assert.ok(!calls.some(c => /box-3/.test(c)) && calls.includes('GET /api/remote/box-1/api/pinned-folders') && calls.includes('GET /api/remote/box-2/api/pinned-folders'), 'each online computer is asked through its own path: ' + JSON.stringify(calls));
        await ev(`window.__box2 = 'ok'; true`); pins = await read();
        assert.deepEqual(pins.sort(), ['box-1:/srv/app', 'box-2:/data/db', 'local:/work/app'], 'box-2 answers: ' + JSON.stringify(pins));
        await ev(`window.__box2 = 'fail'; true`); pins = await read();
        assert.deepEqual(pins.sort(), ['box-1:/srv/app', 'box-2:/data/db', 'local:/work/app'], 'a computer that cannot be read keeps its pins: ' + JSON.stringify(pins));

        // one name on two computers: two entries, two keys; a pin is "pinned" only on its own computer
        const keys = await ev(`(async () => { const m = await import(${S} + 'pinned_folders.js'); const e = m.emptyPins([], new Set()); return { keys: e.map(p => p.key).sort(), here: m.isPinnedDir('/srv/app', 'box-1'), there: m.isPinnedDir('/srv/app', 'box-2'), local: m.isPinnedDir('/srv/app') }; })()`);
        assert.equal(new Set(keys.keys).size, 3, 'three entries, three keys: ' + JSON.stringify(keys));
        assert.deepEqual([keys.here, keys.there, keys.local], [true, false, false], 'pinned on its own computer only: ' + JSON.stringify(keys));

        // pin, unpin and the server menu's Open folder go to their own computer
        await ev(`window.__calls = []; (async () => { const m = await import(${S} + 'pinned_folders.js'); await window.pinFolder('/srv/new', 'box-1'); await window.unpinFolder('/work/app'); return true; })()`);
        const sent = await ev(`window.__calls.filter(c => /^(POST|DELETE)/.test(c))`);
        assert.deepEqual(sent, ['POST /api/remote/box-1/api/pinned-folders {"path":"/srv/new"}', 'DELETE /api/pinned-folders {"path":"/work/app"}'], 'the pin goes to box-1, the unpin of this computer\'s to this one: ' + JSON.stringify(sent));
        await ev(`window.__calls = []; (async () => { const m = await import(${S} + 'pinned_folders.js'); window.showOpenFolderModal('box-2'); document.getElementById('open-folder-dir').value = '/data/other'; await window.submitOpenFolder(); return true; })()`);
        const opened = await ev(`window.__calls.filter(c => /^POST/.test(c))`);
        assert.deepEqual(opened, ['POST /api/remote/box-2/api/pinned-folders {"path":"/data/other"}'], 'the server menu\'s Open folder pins on its computer: ' + JSON.stringify(opened));
    } finally { await client.close(); }
    console.log('pinned_folders_servers_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
