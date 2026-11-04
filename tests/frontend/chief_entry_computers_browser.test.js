// The Chief entry belongs to the computer shown (#13167, UI Reviewer's MUSTs on dce78ebe3): on one page, switching A -> B -> C -> A changes the sidebar's entry and the menu's with it (configured, Set up, refused: nothing), an answer for the computer
// left is dropped, the menu is drawn at once and Chief's entry joins it when a slow computer answers, and Set up Chief becomes Chief when Settings > Chief saves. The computers are stubbed (/api/remote/<id>/api/chief); the sidebar's ask runs at once
// (window.__chiefAfterMs = 0). 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => { window.__chiefAfterMs = 0; window.__chief = { a: { status: 200, body: { enabled: true, session_id: 's-a', name: 'Atlas', avatar: '3', avatar_letter: 'A' } }, b: { status: 200, body: { enabled: false, session_id: '' }, delay: 700 }, c: { status: 403, body: { error: 'owner only' } } };
    const R = window.fetch; window.fetch = (u, o) => { const m = /^\\/api\\/remote\\/machine-([abc])\\/api\\/chief$/.exec(new URL(String(u && u.url || u), location.origin).pathname);
        if (m) { const c = window.__chief[m[1]]; return new Promise(r => setTimeout(() => r(new Response(JSON.stringify(c.body), { status: c.status, headers: { 'content-type': 'application/json' } })), c.delay || 0)); } return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        const at = id => ev(`T.state.selectedTeam = '@machine-${id}/team'; T.render.renderLiveSessions([]); true`);
        const side = () => ev(`(() => { const s = document.getElementById('sidebar-chief-slot'), n = s && s.querySelector('a, button'); return { shown: !!s && !s.hidden && !!n, text: n ? n.lastElementChild.textContent.trim() : '', href: n && n.getAttribute('href') }; })()`);
        const menu = async () => { await ev(`document.getElementById('top-menu-btn').click(); true`); await waitFor(`!document.getElementById('nav-more-menu').hidden`, 'the menu opens', 6000); };
        const entry = () => ev(`(() => { const m = document.getElementById('nav-more-menu'), n = m.querySelector('[data-chief-entry]'); return { chief: n ? n.lastElementChild.textContent.trim() : null, settings: !!m.querySelector('[data-account-start]') }; })()`);
        const close = () => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

        // the sidebar follows the computer shown
        await at('a'); await waitFor(`(() => { const s = document.getElementById('sidebar-chief-slot'); return !!s && !s.hidden && !!s.querySelector('a'); })()`, 'A: Chief in the sidebar', 8000);
        let g = await side(); check('A: Atlas links /chief/machine-a', /Atlas/.test(g.text) && g.href === '/chief/machine-a', JSON.stringify(g));
        await at('b'); await waitFor(`(() => { const s = document.getElementById('sidebar-chief-slot'); return !!s && !!s.querySelector('button'); })()`, 'B: Set up Chief in the sidebar', 8000);
        g = await side(); check('B: Set up Chief (not A\'s entry)', g.shown && g.text === 'Set up Chief', JSON.stringify(g));
        await at('c'); await waitFor(`document.getElementById('sidebar-chief-slot').hidden === true`, 'C: nothing in the sidebar', 8000);
        await at('a'); await waitFor(`(() => { const s = document.getElementById('sidebar-chief-slot'); return !!s && !s.hidden && !!s.querySelector('a'); })()`, 'A again: Chief in the sidebar', 8000);
        // a late answer for the computer left is dropped: ask B (700 ms), switch to A at once
        await at('b'); await at('a'); await new Promise(r => setTimeout(r, 1200)); // sleep-ok: B's stubbed answer arrives after 700 ms, there is no event to wait on
        g = await side(); check('B answered late after A was shown again: the sidebar still says Atlas', /Atlas/.test(g.text), JSON.stringify(g));
        // the menu follows it too, drawn at once, Chief joins when it answers
        await at('b'); await ev(`window.__chiefSeen = 0; true`);
        await menu(); let e = await entry();
        check('B (slow): the menu is drawn at once, with Settings, before Chief answers', e.settings && e.chief === null, JSON.stringify(e));
        await waitFor(`!!document.querySelector('#nav-more-menu [data-chief-entry]')`, 'B: Chief joins the open menu', 6000);
        e = await entry(); check('B: the menu says Set up Chief', e.chief === 'Set up Chief', JSON.stringify(e));
        await close(); await at('a'); await menu(); await waitFor(`!!document.querySelector('#nav-more-menu [data-chief-entry]')`, 'A: the menu has Chief', 6000);
        e = await entry(); check('A: the menu says Atlas, not B\'s Set up Chief', e.chief === 'Atlas' || /Atlas/.test(e.chief || ''), JSON.stringify(e));
        await close(); await at('c'); await menu(); await new Promise(r => setTimeout(r, 400)); // sleep-ok: nothing to wait for when the answer is a refusal; the entry must stay absent
        e = await entry(); check('C (refused): no Chief entry in the menu', e.chief === null && e.settings, JSON.stringify(e)); await close();
        // Set up Chief becomes Chief once Settings > Chief saves
        await at('b'); await waitFor(`!!document.getElementById('sidebar-chief-slot').querySelector('button')`, 'B: Set up Chief again', 8000);
        await ev(`window.__chief.b = { status: 200, body: { enabled: true, session_id: 's-b', name: 'Bo', avatar: '5' } }; document.dispatchEvent(new Event('coral-chief-changed')); true`);
        await waitFor(`!!document.getElementById('sidebar-chief-slot').querySelector('a')`, 'B: Chief after the save', 8000);
        g = await side(); check('B after Settings > Chief saved: Bo links /chief/machine-b', /Bo/.test(g.text) && g.href === '/chief/machine-b', JSON.stringify(g));
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Chief entry follows the computer shown:\n  ' + problems.join('\n  '));
    console.log('PASS the Chief entry follows the computer shown: A, B, C, A; late answers dropped; the menu drawn at once; refreshed after setup');
})().catch(e => { console.error(e); process.exit(1); });
