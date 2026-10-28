// #9681 (security check on #9679 slice 1, 8d60ca83a): the Servers page's unencrypted-key warning moved from the Tags column, which a narrow list drops, to beside the name. Every case where it must show
// and where it must not, against the server record's fields (what GET /api/servers answers: id, label, url, status, allow_private, warning; the server sets warning only for a registered server reached
// over plain http at an address that is not this computer, remote_servers.go remoteURLWarning). The view shows it when the record has one: on a remote server's row, whatever its status, at every width,
// after a sort and after the record changes; never on this hub's own row (it has no key and no page); its words are only a tooltip and the button's name, never markup. 1280, 700 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const W = 'the key crosses the network unencrypted; use https or a tunnel';
const MATRIX = [
    { id: 'local', label: 'studio-mac', local: true, status: 'online', warning: W }, // not a record the server sends (the hub has no key to send): the hub's own row never shows a warning
    { id: 'https', label: 'Secure', url: 'https://secure.example.net:8420', status: 'online' },
    { id: 'lan', label: 'LAN box', url: 'http://192.168.1.50:8420', status: 'online', allow_private: true, warning: W },
    { id: 'unreach', label: 'Unreachable LAN', url: 'http://10.0.0.7:8420', status: 'unreachable', allow_private: true, warning: W, last_seen: '2026-10-13T00:00:00Z' },
    { id: 'unauth', label: 'Wrong key', url: 'http://10.0.0.8:8420', status: 'unauthorized', allow_private: true, warning: W },
    { id: 'offline', label: 'Offline LAN', url: 'http://10.0.0.9:8420', status: 'offline', allow_private: true, warning: W },
    { id: 'loop', label: 'Tunnel end', url: 'http://127.0.0.1:9000', status: 'online', allow_private: true },
    { id: 'empty', label: 'Empty warning', url: 'https://e.example.net', status: 'online', warning: '' },
    { id: 'nulled', label: 'Null warning', url: 'https://n.example.net', status: 'online', warning: null },
    { id: 'xss', label: 'Markup words', url: 'http://10.0.0.10:8420', status: 'online', allow_private: true, warning: 'the key <img src=x onerror="window.__pwn=1"> crosses the network' },
    { id: 'legacy', label: 'Legacy row', url: 'http://10.0.0.2:8420x', status: 'unreachable', allow_private: true, warning: W }, // a stored URL that does not parse: the server fails closed and sends the warning (#9688)
    { id: 'long', label: 'A very long server name that has to be cut to fit the one line a row gets on a phone and still keep its flag', url: 'http://10.0.0.11:8420', status: 'online', allow_private: true, warning: W },
];
const SHOWS = ['lan', 'unreach', 'unauth', 'offline', 'xss', 'legacy', 'long'];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.__list = ${JSON.stringify(MATRIX)};
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname; const m = (o.method || 'GET').toUpperCase();
                const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/health') return json(200, { status: 'ok', hub: true, version: '1.4.75' });
                if (p === '/api/servers' && m === 'GET') return json(200, window.__list);
                return R(u, o); }; })();` });
        const flags = () => ev(`(() => Object.fromEntries([...document.querySelectorAll('tr[data-key]')].map(tr => { const w = tr.querySelector('.servers-warn'); const r = w && w.getBoundingClientRect(), row = tr.getBoundingClientRect();
            return [tr.getAttribute('data-key'), w ? { count: tr.querySelectorAll('.servers-warn').length, text: (w.querySelector('.servers-warn-word') || w).textContent.trim(), title: w.title, visible: w.getClientRects().length > 0 && r.right <= innerWidth + 0.5 && r.left >= 0, aria: (tr.querySelector('[data-action=open]') || {}).getAttribute && tr.querySelector('[data-action=open]').getAttribute('aria-label'), inButton: !!w.closest('[data-action=open]') } : null]; })))()`);
        const open = async (w, h, mobile) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); s.state.hub = true; s.state.servers = window.__list; s.state.liveSessions = []; return true; })()`);
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`!!document.querySelector('tr[data-key="lan"]')`, 'the servers table');
        };
        for (const [w, h, mobile] of [[1280, 900, false], [700, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await open(w, h, mobile);
            let f = await flags();
            assert.deepEqual(Object.keys(f).sort(), MATRIX.map(s => s.id).sort(), at + 'every record is a row');
            for (const id of SHOWS) {
                assert.ok(f[id], at + `${id}: a remote server with a warning shows it`);
                assert.equal(f[id].text, 'warning', at + `${id}: the flag`);
                assert.equal(f[id].count, 1, at + `${id}: one flag, in the name's cell, not also in the Tags column`);
                assert.equal(f[id].visible, true, at + `${id}: on the screen, by the name, not dropped with a column`);
                assert.equal(f[id].inButton, true, at + `${id}: inside the name's button, so it moves with the name`);
            }
            for (const id of ['https', 'loop', 'empty', 'nulled', 'local']) assert.equal(f[id], null, at + `${id}: ${id === 'local' ? 'the hub\'s own row never shows one, even if its record carried a warning' : 'no warning on the record, none shown'}`);
            assert.equal(f.lan.title, W, at + 'the tooltip is the record\'s words');
            assert.equal(f.lan.aria, `Open LAN box, Online, warning: ${W}`, at + 'and the button\'s name says it, for a screen reader');
            // the words are text, never markup: the markup in the xss record is a tooltip and a name, and nothing was made from it
            assert.equal(f.xss.title, MATRIX.find(s => s.id === 'xss').warning, at + 'markup in the words is only the tooltip text');
            assert.equal(await ev(`window.__pwn === undefined && !document.querySelector('tr[data-key="xss"] img')`), true, at + 'no element or script came from the warning\'s words');
            // a sort moves rows, not flags
            await ev(`document.querySelector('thead th[scope=col] .dt-sort, thead .dt-sort') && [...document.querySelectorAll('thead .dt-sort')].find(b => /status/i.test(b.textContent)).click(); true`);
            await ev(`new Promise(r => setTimeout(r, 120))`); // sleep-ok: the sort redraws the table in a frame
            const after = await flags();
            assert.deepEqual(Object.keys(after).filter(k => after[k]).sort(), SHOWS.slice().sort(), at + 'after a sort the same servers carry the flag');
        }
        // the record changes (a server's URL was moved to https): the flag goes from that row and stays on the others
        await open(1280, 900, false);
        await ev(`window.__list = window.__list.map(s => s.id === 'lan' ? { ...s, url: 'https://192.168.1.50:8420', warning: undefined } : s); window.switchNavTab('agents'); true`);
        await ev(`window.switchNavTab('servers'); true`);
        await waitFor(`!document.querySelector('tr[data-key="lan"] .servers-warn') && !!document.querySelector('tr[data-key="unreach"] .servers-warn')`, 'the changed record redrawn', 8000);
        const changed = await flags();
        assert.equal(changed.lan, null, 'a server whose record no longer has a warning shows none');
        assert.deepEqual(Object.keys(changed).filter(k => changed[k]).sort(), SHOWS.filter(s => s !== 'lan').sort(), 'the others keep theirs');
        // the server's own page keeps its warning line (the words, capitalised, with a full stop) and a server without a warning has none: the flag by the name was added, nothing was taken from the page
        for (const [id, want] of [['lan', 'Warning: The key crosses the network unencrypted; use https or a tunnel.'], ['legacy', 'Warning: The key crosses the network unencrypted; use https or a tunnel.'], ['https', null], ['xss', 'Warning: The key <img src=x onerror="window.__pwn=1"> crosses the network.']]) {
            await open(1280, 900, false);
            await ev(`document.querySelector('tr[data-key="${id}"] [data-action=open]').click(); true`);
            await waitFor(`!!document.querySelector('.servers-view-page, #servers-view .servers-page, [data-server-page]') || !!document.querySelector('.servers-row-warn') || /Test|Edit/.test(document.getElementById('servers-view').textContent)`, `the page of ${id}`, 8000);
            const line = await ev(`(() => { const w = document.querySelector('#servers-view .servers-row-warn'); return w ? w.querySelector('span:not(.material-icons)').textContent.trim() : null; })()`); // the icon's ligature word is not the line's words
            assert.equal(line, want, `the page of ${id} says: ${want}`);
            assert.equal(await ev(`window.__pwn === undefined && !document.querySelector('#servers-view .servers-row-warn img')`), true, `${id}: the page's warning words are text`);
        }
        console.log('   ✓');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
