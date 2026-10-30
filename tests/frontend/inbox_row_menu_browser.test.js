// The phone Inbox row's ⋯ menu (#137104): a Needs you row for a wait the Operator may dismiss (a permission, a question or a plan) has a 44 px ⋯ button at its right that opens the one menu, whose first action is
// Dismiss (Lead's dismiss-wait route, #11352); the row stays one line at 56 px, the button is the row's own control (a press never opens the row), it has a name, opens with a tap or the keyboard, and Escape gives the
// focus back to it. A row whose wait is not the agent's own kind (a sign-in) has no ⋯, and a desktop keeps its table and its Dismiss button. 390 and 360 px with touch, light and dark; isolated dev server, the Inbox's census world.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { axName } = require('./helpers/ax_tree');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const iso = ms => new Date(Date.now() - ms).toISOString();
const AGENTS = [
    { name: 'ag-one', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent One', working_directory: '/repo/a', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./pkg/...', waiting_since: iso(300000), board_project: 'team-a', sleeping: false },
    { name: 'ag-two', session_id: '00000002-0000-4000-8000-000000000002', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent Two', working_directory: '/repo/b', waiting_for_input: true, waiting_kind: 'question', waiting_since: iso(120000), board_project: 'team-b', sleeping: false },
    { name: 'ag-three', session_id: '00000003-0000-4000-8000-000000000003', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Agent Three', working_directory: '/repo/c', waiting_for_input: true, waiting_kind: 'login', waiting_since: iso(60000), board_project: 'team-c', sleeping: false },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const failures = [];
    const check = (name, ok, detail) => { if (ok) console.log('PASS ' + name); else { failures.push(name); console.log('FAIL ' + name + (detail ? ' - ' + detail : '')); } };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 300)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const key = async (k, code, vk) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    const T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [360, 780, true], [1280, 820, false]]) for (const theme of ['dark', 'light']) {
            const at = `${w}px ${theme}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await setTheme(ev, theme);
            await ev(INBOX_WORLD);
            await ev(`(() => { window.__dismissed = []; const real = window.fetch; window.fetch = (u, o = {}) => { const p = String(u); if (/\\/dismiss-wait$/.test(p)) { window.__dismissed.push({ url: p, body: JSON.parse(o.body || '{}') }); return Promise.resolve(new Response(JSON.stringify({ dismissed: true }), { status: 200, headers: { 'content-type': 'application/json' } })); } return real(u, o); }; return true; })()`);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); state.liveSessions = ${JSON.stringify(AGENTS)}; m.updateInboxTab(); return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .dt-table tbody tr').length === 3 && document.querySelector('${T}').getClientRects().length > 0`, at + 'the three waiting agents', 10000);
            if (!mobile) {
                check(at + 'a desktop has no ⋯ and keeps its Dismiss button', await ev(`document.querySelectorAll('${T} .dt-mail-more').length === 0 && document.querySelectorAll('${T} .inbox-dismiss').length >= 1`));
                continue;
            }
            const rows = await ev(`[...document.querySelectorAll('${T} tr.dt-mailed')].map(tr => { const b = tr.querySelector('.dt-mail-more-toggle'), r = b && b.getBoundingClientRect(), box = tr.getBoundingClientRect(); return { title: tr.querySelector('.dt-mail-title').textContent, h: Math.round(box.height), more: !!b, w: r ? Math.round(r.width) : 0, bh: r ? Math.round(r.height) : 0, name: b && b.getAttribute('aria-label'), popup: b && b.getAttribute('aria-haspopup'), expanded: b && b.getAttribute('aria-expanded'), inline: !!tr.querySelector('.inbox-dismiss'), sameLine: Math.abs(tr.querySelector('.dt-mail-title').getBoundingClientRect().top - tr.querySelector('.dt-mail-snippet').getBoundingClientRect().top) < 4, inside: !!(b && !b.closest('.dt-mail-open')) }; })`);
            const by = Object.fromEntries(rows.map(x => [x.title, x]));
            check(at + 'a permission and a question row have a ⋯; a sign-in row has none', by['Agent One']?.more && by['Agent Two']?.more && !by['Agent Three']?.more, JSON.stringify(rows));
            check(at + 'the ⋯ is a 44 px target, named for its row, a menu button, closed, and not inside the row button', [by['Agent One'], by['Agent Two']].every(x => x.w >= 44 && x.bh >= 44 && x.popup === 'menu' && x.expanded === 'false' && x.inside && /^More actions for Agent (One|Two)$/.test(x.name)), JSON.stringify(rows));
            check(at + 'every row is still one line at 56 px', rows.every(x => x.h === 56 && x.sameLine), JSON.stringify(rows.map(x => [x.title, x.h, x.sameLine])));
            check(at + 'the inline Dismiss under the line is gone on a phone (the menu holds it)', rows.every(x => !x.inline), JSON.stringify(rows.map(x => [x.title, x.inline])));
            check(at + 'no sideways scroll', await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
            const ax = await axName(client, `${T} tr.dt-mailed:nth-of-type(1) .dt-mail-more-toggle`).catch(() => null);
            await ev(`document.querySelector('${T} tr.dt-mailed .dt-mail-more-toggle').setAttribute('data-menu-probe', '1'); true`);
            // a tap opens the menu: Dismiss first, on the screen, focused; the row itself did not open
            const url0 = await ev(`location.href`);
            await ev(`document.querySelector('[data-menu-probe]').click(); true`);
            await waitFor(`!document.querySelector('[data-menu-probe]').parentElement.querySelector('.menu').hidden`, at + 'the menu opens', 4000);
            const menu = await ev(`(() => { const t = document.querySelector('[data-menu-probe]'), m = t.parentElement.querySelector('.menu'), r = m.getBoundingClientRect(), items = [...m.querySelectorAll('[role=menuitem]')]; return { expanded: t.getAttribute('aria-expanded'), items: items.map(i => i.textContent), focus: document.activeElement === items[0], role: m.getAttribute('role'), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight, itemH: Math.round(items[0].getBoundingClientRect().height), url: location.href }; })()`);
            check(at + 'the menu opens: Dismiss is its first action, focused, a 44 px row', menu.expanded === 'true' && menu.items[0] === 'Dismiss' && menu.focus && menu.role === 'menu' && menu.itemH >= 44, JSON.stringify(menu));
            check(at + 'the menu is whole on the screen (not cut by the list)', menu.left >= 0 && menu.right <= menu.vw && menu.top >= 0 && menu.bottom <= menu.vh, JSON.stringify(menu));
            check(at + 'the press on the ⋯ did not open the row', menu.url === url0);
            await shot(`inbox-row-menu-${w}-${theme}`);
            // Escape closes it and gives the focus back to the button
            await key('Escape', 'Escape', 27);
            await waitFor(`document.querySelector('[data-menu-probe]').getAttribute('aria-expanded') === 'false'`, at + 'Escape closes the menu', 4000);
            check(at + 'Escape closes it and the focus is on the ⋯ again', await ev(`document.activeElement === document.querySelector('[data-menu-probe]')`));
            // the keyboard opens it from the button (Enter), and Dismiss is a real press
            await key('Enter', 'Enter', 13);
            await waitFor(`document.querySelector('[data-menu-probe]').getAttribute('aria-expanded') === 'true'`, at + 'Enter opens the menu', 4000);
            await ev(`document.querySelector('[data-menu-probe]').parentElement.querySelector('[role=menuitem]').click(); true`);
            await waitFor(`window.__dismissed.length === 1`, at + 'Dismiss posts to the dismiss-wait route', 6000);
            const sent = await ev(`window.__dismissed[0]`);
            check(at + 'Dismiss asks the route for that agent only', /\/api\/sessions\/live\/ag-one\/dismiss-wait$/.test(sent.url) && sent.body.session_id === AGENTS[0].session_id, JSON.stringify(sent));
            check(at + 'the menu is closed after the choice', await ev(`document.querySelector('[data-menu-probe]') ? document.querySelector('[data-menu-probe]').getAttribute('aria-expanded') === 'false' : true`));
        }
    } catch (e) { console.log('ERROR ' + (e.stack || e)); failures.push('error'); }
    await client.close();
    if (failures.length) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
    console.log('inbox_row_menu_browser: all ok');
})();
