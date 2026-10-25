// The inventory of the right dock, from the running page (#7456: every feature of the dock moves to the team page, the agent page or the detail pane; the operator: nothing may be lost). For each page kind that
// shows the dock (an agent's page; the board's page and the team's page have none since #7457) and for each tab it offers, it opens the tab on an isolated server with a seeded board (messages, tasks, subscribers) and a mock agent, and
// writes every control it shows (a button, link, field, select, summary, tab, menu item, switch) as one row: tab, page, role, name, id, the data-on-* actions. With DOCK_INVENTORY_OUT=<file> it writes the JSON that
// tests/frontend/fixtures/dock_parity.json was made from; without it, it only checks that every tab opens and shows something, so it is cheap to leave in the run. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install, select } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const BOARD = 'dock-inv-' + Date.now().toString(36);
    const out = { generated: new Date().toISOString(), pages: {} };
    const SCAN = `(root) => { const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const name = e => (e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent || '').replace(/\\s+/g, ' ').trim() || e.getAttribute('placeholder') || e.getAttribute('value') || '').slice(0, 80);
        const rows = []; const seen = new Set();
        for (const e of root.querySelectorAll('button, a[href], input, select, textarea, summary, [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=button], [role=link], [tabindex]:not([tabindex="-1"])')) {
            if (!vis(e) || e.closest('[aria-hidden=true]')) continue;
            const role = e.getAttribute('role') || (e.tagName === 'A' ? 'link' : e.tagName === 'BUTTON' ? 'button' : e.tagName === 'SELECT' ? 'combobox' : e.tagName === 'TEXTAREA' ? 'textbox' : e.tagName === 'SUMMARY' ? 'summary' : e.tagName === 'INPUT' ? (e.type === 'checkbox' ? 'checkbox' : e.type === 'radio' ? 'radio' : 'textbox') : 'focusable');
            const actions = [...e.attributes].filter(a => a.name.startsWith('data-on-')).map(a => a.name.slice(8) + ':' + a.value).join(',');
            const row = { role, name: name(e), id: e.id || '', actions, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' };
            const key = [row.role, row.name, row.id, row.actions].join('|'); if (seen.has(key)) continue; seen.add(key); rows.push(row);
        } return rows; }`;
    const tabsNow = () => ev(`[...document.querySelectorAll('#agentic-state #agentic-block-top .agentic-tab[data-tab]')].filter(t => t.getClientRects().length > 0).map(t => ({ tab: t.dataset.tab, label: t.getAttribute('aria-label') || t.title || '', badge: (t.textContent || '').replace(/\\s+/g, ' ').trim() }))`);
    const crawl = async (page) => {
        const tabs = await tabsNow(); out.pages[page] = { tabs: [], controls: {} };
        for (const t of tabs) {
            out.pages[page].tabs.push(t);
            await ev(`document.getElementById('agentic-tab-${t.tab}').click(); true`); await sleep(900); // sleep-ok: a panel fills itself over a few frames and requests; the scan reads what a person would see
            const rows = await ev(`(${SCAN})(document.getElementById('agentic-panel-${t.tab}') || document.getElementById('agentic-state'))`);
            out.pages[page].controls[t.tab] = rows;
            const label = rows.length ? `${rows.length} controls` : 'no controls';
            console.log(`   ${page} / ${t.tab}: ${label}`);
        }
        // the dock's own chrome: the tab strip, its menu, the toggle
        out.pages[page].chrome = await ev(`(${SCAN})(document.getElementById('agentic-state'))`).then(r => r.filter(x => /tab/i.test(x.role) || /agentic-tab|customize|toggle|close/i.test(x.id + ' ' + x.actions)));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
        await api('POST', `/api/board/${BOARD}/subscribe`, { subscriber_id: 'Inv One', job_title: 'Orchestrator', session_name: 'claude-aaaaaaaa-0000-0000-0000-0000000000a1' });
        await api('POST', `/api/board/${BOARD}/subscribe`, { subscriber_id: 'Inv Two', job_title: 'Developer', session_name: 'claude-aaaaaaaa-0000-0000-0000-0000000000a2' });
        for (const t of [['Queued task', 'low'], ['Another task', 'medium'], ['High task', 'high']]) await api('POST', `/api/board/${BOARD}/tasks`, { title: t[0], priority: t[1], created_by: 'Operator' });
        await api('POST', `/api/board/${BOARD}/messages`, { subscriber_id: 'Inv One', content: 'A board message for the inventory.' });
        await ev(`(() => { window.__m.add('inv-a', 'I', 30, { sleeping: false }); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
        console.log('The dock, page by page');
        await select('inv-a'); await waitFor(`document.getElementById('agentic-state').dataset.page === 'agent'`, 'the agent page');
        await crawl('agent');
        // the board's page and the team's page have no dock any more (#7457): what is left of the dock is the agent page's
        await ev(`window.selectBoardProject(${JSON.stringify(BOARD)}); true`); await waitFor(`document.getElementById('agentic-state').dataset.page === 'none' && document.querySelectorAll('#mb-messages .mb-message').length >= 1`, 'the board', 8000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('agentic-state')).display`), 'none', 'the board page has no dock');
        await ev(`window.openTeamPage(${JSON.stringify(BOARD)}); true`); await waitFor(`document.getElementById('agentic-state').dataset.page === 'none' && !!document.getElementById('team-page-view') && getComputedStyle(document.getElementById('team-page-view')).display !== 'none'`, 'the team page', 8000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('agentic-state')).display`), 'none', 'the team page has no dock');
        for (const [p, v] of Object.entries(out.pages)) assert.ok(v.tabs.length > 0, `${p}: the dock offers tabs`);
        if (process.env.DOCK_INVENTORY_OUT) { fs.writeFileSync(process.env.DOCK_INVENTORY_OUT, JSON.stringify(out, null, 1)); console.log('wrote ' + process.env.DOCK_INVENTORY_OUT); }
        console.log('PASS the dock inventory: every tab of every page opens');
    } finally { try { await api('DELETE', `/api/board/${BOARD}`); } catch { /* the run's own board */ } await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
