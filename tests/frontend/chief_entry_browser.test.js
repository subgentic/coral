// A Chief entry in the menus and the sidebar (#13167, the Operator: they could not find Chief): when a Chief is recorded the Agents sidebar (desktop) and the top-left menu (phone) show its avatar and name and open /chief;
// when none is set up they say "Set up Chief", which opens Settings > Chief; when the machine refuses (not the owner) or cannot be read nothing is shown. 1280 (sidebar) and 390 (the menu). GET /api/chief is stubbed per case.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const CASES = [
    { name: 'set up', status: 200, body: { enabled: true, session_id: 'sid-1', team: 'coral-go-team', name: 'Atlas', avatar: '3', avatar_letter: 'A', fronts: 'coral-go-team' }, want: 'open' },
    { name: 'not set up', status: 200, body: { enabled: false, session_id: '', team: '' }, want: 'setup' },
    { name: 'refused', status: 403, body: { error: 'owner only' }, want: 'none' },
];
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    let stub = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const c of CASES) for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${c.name} at ${w} px`;
            if (stub) await Page.removeScriptToEvaluateOnNewDocument({ identifier: stub });
            stub = (await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.fetch = (u, o) => { if (new URL(String(u && u.url || u), location.origin).pathname === '/api/chief') return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(c.body)}), { status: ${c.status}, headers: { 'content-type': 'application/json' } })); return R(u, o); }; })();` })).identifier;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            let got;
            if (!mobile) {
                await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the sidebar paints Chief's entry when the browser is idle, there is no event for it
                got = await ev(`(() => { const s = document.getElementById('sidebar-chief-slot'), n = s && s.querySelector('a, button'); return { shown: !!s && !s.hidden && !!n, text: n ? n.lastElementChild.textContent.trim() : '', href: n && n.getAttribute('href'), avatar: n ? (n.querySelector('.chief-avatar') || {}).textContent || '' : '', h: n ? Math.round(n.getBoundingClientRect().height) : 0 }; })()`);
            } else {
                await ev(`document.getElementById('top-menu-btn').click(); true`);
                await waitFor(`!document.getElementById('nav-more-menu').hidden`, `${tag}: the menu opens`, 6000);
                got = await ev(`(() => { const m = document.getElementById('nav-more-menu'), n = [...m.querySelectorAll('.nav-more-item')].find(x => /^(Atlas|Set up Chief)$/.test(x.lastElementChild.textContent.trim())); return { shown: !!n, text: n ? n.lastElementChild.textContent.trim() : '', href: n && n.getAttribute('href'), avatar: n ? (n.querySelector('.chief-avatar') || {}).textContent || '' : '', h: n ? Math.round(n.getBoundingClientRect().height) : 0 }; })()`);
            }
            if (c.want === 'open') {
                check(`${tag}: Chief's name links to /chief`, got.shown && /Atlas/.test(got.text) && got.href === '/chief', JSON.stringify(got));
                check(`${tag}: it has Chief's letter on its avatar`, got.avatar === 'A', JSON.stringify(got));
            } else if (c.want === 'setup') {
                check(`${tag}: it says Set up Chief`, got.shown && got.text === 'Set up Chief', JSON.stringify(got));
                await ev(`(() => { const m = document.getElementById('nav-more-menu'), s = document.getElementById('sidebar-chief-slot'); const n = ${mobile} ? [...m.querySelectorAll('.nav-more-item')].find(x => x.lastElementChild.textContent.trim() === 'Set up Chief') : s.querySelector('button'); n.click(); return true; })()`);
                await waitFor(`!!document.querySelector('#settings-pane-chief') && document.querySelector('#settings-pane-chief').hidden === false`, `${tag}: Settings opens on Chief`, 8000).catch(() => check(`${tag}: Set up Chief opens Settings > Chief`, false));
            } else check(`${tag}: nothing is shown when the machine refuses`, !got.shown, JSON.stringify(got));
            if (got.shown && !mobile) check(`${tag}: a 36 px row at least`, got.h >= 35, JSON.stringify(got));
            if (c.want === 'open') await shot(`chief-entry-${w}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Chief entry:\n  ' + problems.join('\n  '));
    console.log('PASS the Chief entry: set up, not set up, refused; the sidebar at 1280 and the menu at 390');
})().catch(e => { console.error(e); process.exit(1); });
