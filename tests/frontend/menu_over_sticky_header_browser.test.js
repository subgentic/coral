// #15047 (the Operator: 'Updated is showing over the docs'): a table's sticky column header painted above the top bar's account menu, covering its Docs item. The menu is in the top bar's layer, which must be
// above every sticky table header and the layers of the page under it. Opens the menu over the team's Artifacts table (its header is stuck at the top of its scroller), at 1280 and 390 px, and asks the
// browser what is at each menu item's centre: it must be that item (elementFromPoint), for the whole menu; a failure names what covers it and the stacking layers around it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `menu-z-${Date.now() % 100000}`;
const hex = n => n.toString(16).padStart(64, '0');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const MENU = { desktop: { open: `document.querySelector('button[aria-label="Settings menu"][aria-haspopup="menu"]').click()`, menu: 'top-bar-settings-menu', items: '.menu-item' } };
        for (const [w, h, mobile] of [[1280, 800, false], [1100, 800, false], [390, 844, true]]) {
            for (const scenario of ['artifacts', 'needs']) {
                const at = `${w} ${scenario}`;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
                await seed(ev, TEAM);
                await ev(`(() => { const R = window.fetch.bind(window), json = b => Promise.resolve(Response.json(b)), hex = n => n.toString(16).padStart(64, '0');
                    window.__rows = Array.from({ length: 40 }, (_, i) => ({ id: hex(i + 1), name: 'file-' + i + '.md', uri: 'coral://artifacts/' + hex(i + 1), produced_by: 'Dev', session_id: 'p-' + i, created_at: new Date(Date.now() - i * 3600000).toISOString(), media_type: 'text/markdown', size: 1000 + i, available: true, source: 'uploaded', tags: ['for review'], series_id: 's-' + i, version: 1, review_question: 'Does file ' + i + ' look right?' }));
                    window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${TEAM}': window.__rows })); if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(u.pathname)) return json({ artifacts: window.__rows, total: window.__rows.length, has_more: false }); return R(url, opts); }; return true; })()`);
                if (scenario === 'artifacts') { await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Artifacts'); }
                else { await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`); await waitFor(`document.querySelectorAll('.inbox-needs-results .dt-row').length >= 2`, `${at}: rows`, 15000); }
                await settle(600);
                await ev(`(() => { const sc = [...document.querySelectorAll('main *, #inbox-page *, #team-panel-artifacts *')].find(e => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (sc) sc.scrollTop = 150; window.scrollTo(0, 0); return true; })()`);
                await settle(300);
                const opener = await ev(`(() => { const b = document.querySelector('button[aria-label="Settings menu"][aria-haspopup="menu"]'); return !!(b && b.getClientRects().length); })()`);
                if (!opener) { console.log(`skip ${at}: no settings menu button at this width`); continue; }
                await ev(`document.querySelector('button[aria-label="Settings menu"][aria-haspopup="menu"]').click(); true`);
                await waitFor(`(() => { const m = document.getElementById('top-bar-settings-menu'); return !!m && m.style.display !== 'none' && m.getClientRects().length > 0; })()`, `${at}: the account menu opens`, 6000);
                await settle(300);
                const covered = await ev(`(() => { const m = document.getElementById('top-bar-settings-menu'); const out = []; for (const it of m.querySelectorAll('.menu-item')) { const r = it.getBoundingClientRect(); if (!r.width || !r.height) continue; const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!at || !(it === at || it.contains(at))) { const chain = []; for (let e = at; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.position !== 'static' || cs.zIndex !== 'auto') chain.push(e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 24) + ' ' + cs.position + ' z' + cs.zIndex); } out.push((it.textContent || '').trim().slice(0, 20) + ' under ' + (at ? at.tagName.toLowerCase() + '.' + String(at.className).slice(0, 24) : 'nothing') + ' [' + chain.slice(0, 5).join(' < ') + ']'); } } return out; })()`);
                console.log(`${covered.length ? 'FAIL' : 'ok  '} ${at}: ${covered.length ? JSON.stringify(covered) : 'every menu item is what is at its centre'}`);
                if (covered.length) problems.push(`${at}: ${JSON.stringify(covered)}`);
            }
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL menu items covered:\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('menu_over_sticky_header_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
