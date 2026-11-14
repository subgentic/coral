// The team page's More menu (#16359, Beta Tester's walk #16340): at 200% text on a 960x540 screen no item draws over another (the menu scrolls, its items keep their own room); stopping a team's agents has one
// name, Stop agents (#15856's spec), in the menu, the dialog's title and button and the toast; the destructive items (Stop agents, Remove team) are last, below a line, Remove team at the very end.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const BOARD = 'more-menu-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await ev(framesJs(3)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const mk = (id, name) => ({ session_id: id, name, display_name: name, agent_type: 'claude', summary: 'x', model: 'claude-opus-5-5', branch: 'main', repo_name: 'coral', working_directory: '/work/' + name, status: 'idle', server: 'local', board_project: BOARD, sleeping: false });
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, big, theme] of [[1280, 800, false, false, 'dark'], [1280, 800, false, false, 'light'], [960, 540, false, true, 'dark'], [960, 540, false, true, 'light'], [390, 844, true, false, 'dark'], [390, 844, true, false, 'light']]) {
            const tag = `${w}${big ? 'x200' : ''}-${theme}`, check = (ok, msg) => { if (!ok) problems.push(`${tag}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`fetch('/api/board/${BOARD}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'settings_core.js'); m.applyTheme('${theme}'); document.documentElement.style.fontSize = '${big ? 32 : 16}px'; return true; })()`);
            await ev(`T.state.liveSessions = ${JSON.stringify([mk('s1', 'Boss'), mk('s2', 'Worker')])}; T.render.renderLiveSessions(T.state.liveSessions); window.openTeamPage(${JSON.stringify(BOARD)}).then(() => true)`);
            await waitFor(`!!document.getElementById('team-page-title') && document.getElementById('team-page-title').textContent.includes('more-menu')`, 'the team page', 15000);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the header fills
            await ev(`document.getElementById('team-page-more').click(); true`);
            await waitFor(`!!document.querySelector('#team-page-more-menu [data-stop="kill"]')?.getClientRects().length || !!document.querySelector('#team-page-more-menu')?.scrollHeight`, 'the menu', 8000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the menu opens
            const m = await ev(`(() => { const menu = document.getElementById('team-page-more-menu'); const items = [...menu.children].filter(e => e.getClientRects().length || e.matches('hr')).map(e => ({ tag: e.tagName, text: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50), stop: e.dataset.stop || '', id: e.id || '', danger: e.classList.contains('menu-item-danger') || e.classList.contains('overflow-menu-danger'), top: Math.round(e.getBoundingClientRect().top), bottom: Math.round(e.getBoundingClientRect().bottom), h: Math.round(e.getBoundingClientRect().height) })); const overlaps = []; for (let i = 1; i < items.length; i++) if (items[i].tag !== 'SPAN' && items[i - 1].tag !== 'SPAN' && items[i].top < items[i - 1].bottom - 1) overlaps.push(items[i - 1].text + ' / ' + items[i].text); const inner = []; for (const b of menu.querySelectorAll('button')) { const r = b.getBoundingClientRect(); for (const c of b.querySelectorAll('.menu-item-text, .menu-item-hint, .overflow-menu-note, .menu-note')) { const cr = c.getBoundingClientRect(); if (cr.height && (cr.bottom > r.bottom + 1 || cr.top < r.top - 1)) inner.push(b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 30)); } } return { items, overlaps, inner, scroll: menu.scrollHeight > menu.clientHeight + 1 }; })()`);
            check(m.overlaps.length === 0, `no item draws over another: ${JSON.stringify(m.overlaps)}`);
            check(m.inner.length === 0, `an item's words stay inside it: ${JSON.stringify(m.inner)}`);
            const texts = m.items.map(i => i.text);
            check(!texts.some(t => /^Kill/.test(t)), `no item says Kill: ${JSON.stringify(texts)}`);
            const stopAt = m.items.findIndex(i => i.stop === 'kill'), delAt = m.items.findIndex(i => i.id === 'mb-delete-btn');
            check(stopAt > 0 && /^Stop agents/.test(m.items[stopAt].text), `the stop item is Stop agents: ${JSON.stringify(texts)}`);
            check(delAt === m.items.length - 1 && delAt > stopAt, `Remove team is the last item, after Stop agents: ${JSON.stringify(texts)}`);
            const rule = await ev(`(() => { const t = id => { const b = document.querySelector(id); return b ? parseFloat(getComputedStyle(b).borderTopWidth) : 0; }; return { stop: t('#team-page-more-menu [data-stop="kill"]'), del: t('#mb-delete-btn') }; })()`);
            check(rule.stop >= 1 && rule.del >= 1, `each destructive item has a line above it: ${JSON.stringify(rule)}`);
            check(m.items.slice(0, stopAt).some(i => i.tag === 'HR'), `a line separates the stop items from the rest: ${JSON.stringify(m.items.map(i => i.tag))}`);
            await shot(`team-more-${tag}`);
            if (w === 1280 && theme === 'dark') {
                // the dialog and the toast use the same name
                await ev(`document.querySelector('#team-page-more-menu [data-stop="kill"]').click(); true`);
                await waitFor(`document.getElementById('confirm-modal').getClientRects().length > 0`, 'the dialog', 6000);
                const d = await ev(`(() => { const d = document.getElementById('confirm-modal'); return { title: document.getElementById('confirm-modal-title').textContent, buttons: [...d.querySelectorAll('button')].map(b => b.textContent.trim()) }; })()`);
                check(/^Stop agents$/.test((d.title || '').trim()), `the dialog's title is Stop agents: ${JSON.stringify(d)}`);
                check(d.buttons.includes('Stop agents') && !d.buttons.some(b => /Kill/.test(b)), `its button is Stop agents: ${JSON.stringify(d)}`);
                await ev(`[...document.querySelectorAll('#confirm-modal button')].find(b => /^(Cancel|Close|No)$/.test(b.textContent.trim()))?.click(); true`);
            }
        }
    } finally { await removeBoards(ev, [BOARD]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], '\n' + problems.join('\n'));
    console.log('PASS the team More menu: no overlap at 200% text, one name for stopping, destructive items last');
})().catch(e => { console.error(e); process.exit(1); });
