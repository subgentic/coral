// The Saved for later sidebar closes (#4742, the operator's report: on the home view Saved opened a right-hand sidebar with only the Saved list and no way to close it). Real isolated server.
// On the home view (the full-screen Saved page, #4811) and from an agent's page (the scoped sidebar): Escape in the sidebar closes it with the focus on the page's top tab, closing it again
// (what the sidebar's own close does) leaves it, and the top bar's panel icon says whether it is open. From an agent's page the dock is left as it was: open on the tab it had, or shut.
// A phone's overlay opens and closes the same way. The top bar's bookmark is gone (#9929): Saved is opened by the Inbox's Saved folder, the toast's link and the jump bar, all through saved.js.
//
// Expects CORAL_TEST_URL + CDP_PORT from the runner. Exit 0 / 1.
'use strict';
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);

const results = [];
function check(label, cond, detail) {
    const v = cond ? 'PASS' : 'FAIL';
    results.push(v);
    console.log(`[${v}] ${label}${detail !== undefined ? ' — ' + detail : ''}`);
}
async function httpJson(method, p, body) {
    const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
}

async function run() {
    const launched = [];
    let goAgent = async () => {};
    const client = await CDP({ port: CDP_PORT });
    const { Page, Runtime, Emulation, Input } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const ev = async (x) => { const r = await Runtime.evaluate({ expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const until = (expression, what, timeout = 8000) => waitFor(expression, what, { soft: true, timeout });
    const open = () => ev(`(() => { const d = document.getElementById('agentic-state'); return window.innerWidth <= 767 ? d.classList.contains('mobile-panel-overlay') : !d.classList.contains('collapsed'); })()`);
    const state = () => ev(`(() => ({ saved: document.getElementById('agentic-tab-saved').classList.contains('active'), tab: (document.querySelector('#agentic-block-top .agentic-tab.active') || {}).dataset.tab, panelBtn: document.getElementById('panel-toggle-btn').getAttribute('aria-pressed'), focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName) }))()`);
    // Saved opens through what the toast's link and the jump bar use (on home the Inbox's page, #4811; on an agent's page the sidebar's own Saved tab, scoped to the page) and closes through what Escape and the sidebar's close use.
    const clickDockSaved = () => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'saved.js'), k = await import((window.__coralStatic || '/static/') + 'saved_marks.js'); if (k.savedShowing()) m.closeSaved(); else await m.openSaved(); return true; })()`);
    const clickSaved = clickDockSaved;
    const esc = () => Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }));
    const closed = async what => check(what, await until(`(() => { const d = document.getElementById('agentic-state'); return window.innerWidth <= 767 ? !d.classList.contains('mobile-panel-overlay') : d.classList.contains('collapsed'); })()`, what));
    const opened = async what => check(what, await until(`(() => { const d = document.getElementById('agentic-state'); const o = window.innerWidth <= 767 ? d.classList.contains('mobile-panel-overlay') : !d.classList.contains('collapsed'); return o && document.getElementById('agentic-tab-saved').classList.contains('active'); })()`, what));
    try {
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' });
        await coralReady();
        await ev(`localStorage.removeItem('coral-agentic-collapsed'); true`);

        console.log('Home view: the Saved page (#4811), not a sidebar');
        const page = () => ev(`(() => ({ view: (() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })(), nav: document.querySelector('.top-nav-tab.active').dataset.arg, focus: document.activeElement && document.activeElement.id, dock: getComputedStyle(document.getElementById('agentic-state')).display }))()`);
        await clickSaved(); check('Saved opens the full-screen page with no sidebar (its X is in the hidden dock)', await until(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })() && getComputedStyle(document.getElementById('agentic-state')).display === 'none'`, 'the page'), JSON.stringify(await page()));
        await clickSaved(); check('closing it again leaves it, with the focus on the top tab', await until(`!(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })() && document.activeElement.classList.contains('top-nav-tab')`, 'left'), JSON.stringify(await page()));
        await clickSaved(); check('it opens again', await until(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`, 'the page'));
        await esc(); check('Escape leaves it (the focus is inside the page after opening), the focus on the top tab', await until(`!(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })() && document.activeElement.classList.contains('top-nav-tab')`, 'left by Escape'), JSON.stringify(await page()));
        console.log('Escape is left alone where something else has it');
        // Open it through the page's own opener and wait for the promise it returns: its last step is moving the focus into the page (a list button, or the
        // tab), after the list has loaded, and where that lands depends on the host (#4992). With the promise done there is no focus move left to come, so the
        // field below keeps the focus it is given and Escape comes from the field. (Waiting for the focus to be "inside the page" instead hangs when it lands elsewhere.)
        await ev(`import((window.__coralStatic || '/static/') + 'saved.js').then(m => m.openSaved()).then(() => true)`);
        check('opened', await until(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`, 'the page'));
        await ev(`const i = document.createElement('input'); i.id = 'qa-field'; document.body.appendChild(i); i.focus(); true`);
        await Page.bringToFront();
        check('the field has the focus', await until(`(() => { const i = document.getElementById('qa-field'); i.focus(); return document.activeElement === i; })()`, 'the field focused'));
        await esc(); await new Promise(r => setTimeout(r, 300)); // sleep-ok: proves a negative, a close would come at once
        check('Escape in a text field does not leave the page', (await page()).view);
        await ev(`document.getElementById('qa-field').remove(); true`); await clickSaved();
        check('closed', await until(`!(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`, 'left'));

        console.log('From an agent\'s page');
        const r = await httpJson('POST', '/api/sessions/launch', { working_dir: require('node:os').tmpdir(), agent_type: 'terminal', display_name: 'qa-saved-dock' });
        if (!r.data || !r.data.session_id) throw new Error(`launch: ${r.status} ${JSON.stringify(r.data)}`);
        launched.push(r.data);
        goAgent = async () => { await ev(`window.selectLiveSession(${JSON.stringify(r.data.session_name)}, 'terminal', ${JSON.stringify(r.data.session_id)}, ''); true`); await until(`document.getElementById('live-session-view') && getComputedStyle(document.getElementById('live-session-view')).display !== 'none'`, 'the agent view'); };
        await until(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(x => x.session_id === ${JSON.stringify(r.data.session_id)})`, 'the agent listed', 15000);
        await ev(`window.selectLiveSession(${JSON.stringify(r.data.session_name)}, 'terminal', ${JSON.stringify(r.data.session_id)}, ''); true`);
        await until(`document.getElementById('live-session-view') && getComputedStyle(document.getElementById('live-session-view')).display !== 'none'`, 'the agent view');
        // The agent's dock open on Files: Saved shows, and closing gives Files back with the dock still open.
        await ev(`window.toggleAgenticPanel(true); window.switchAgenticTab('files', 'top'); true`);
        await until(`(document.querySelector('#agentic-block-top .agentic-tab.active') || {}).dataset && document.querySelector('#agentic-block-top .agentic-tab.active').dataset.tab === 'files'`, 'Files active');
        await clickDockSaved(); await opened('Saved shows in the agent\'s open dock');
        await clickDockSaved();
        check('closing it gives the agent\'s tab back and leaves the dock open', await until(`(() => { const d = document.getElementById('agentic-state'); return !d.classList.contains('collapsed') && document.querySelector('#agentic-block-top .agentic-tab.active').dataset.tab === 'files'; })()`, 'Files back'), JSON.stringify(await state()));
        // The dock shut: Saved opens it, the X shuts it again.
        await ev(`window.toggleAgenticPanel(false); true`); await closed('the agent\'s dock shut');
        await clickDockSaved(); await opened('Saved opens the shut dock');
        check('the panel has no title and no X at the top (#7926): its bar starts with Search and the Filters icon', await ev(`!document.getElementById('saved-close') && !document.getElementById('saved-scope') && !document.querySelector('#saved-ui .saved-head') && !!document.querySelector('#saved-bar .list-bar-search') && !!document.querySelector('#saved-bar .list-bar-toggle') && !document.querySelector('#saved-bar .list-bar-sort')`));
        await clickDockSaved(); await closed('closing shuts it again (it was shut before)');
        await clickDockSaved(); await opened('opened'); await esc(); await closed('Escape shuts it again');

        console.log('A coarse pointer wider than a phone (a touch tablet)');
        await Emulation.setDeviceMetricsOverride({ width: 1024, height: 768, deviceScaleFactor: 2, mobile: false });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 }); // the page reads (pointer: coarse)
        await Page.navigate({ url: BASE + '/' }); await coralReady();
        await goAgent();
        await clickDockSaved(); await opened('opened on the tablet');
        await clickDockSaved(); await closed('and closing it shuts it');
        await Emulation.setTouchEmulationEnabled({ enabled: false });

        console.log('A phone');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await coralReady();
        await clickDockSaved(); check('on a phone home Saved opens the full-screen page, not the overlay', await until(`(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })() && !document.getElementById('agentic-state').classList.contains('mobile-panel-overlay')`, 'the page'));
        await clickDockSaved(); check('and again leaves it', await until(`!(() => { const t = document.getElementById('group-table-view'); return t.getClientRects().length > 0 && t.dataset.group === 'hub-inbox:saved'; })()`, 'left'));
        await goAgent();
        await clickDockSaved(); await opened('on an agent Saved opens the overlay');
        // the open tab says its name beside its icon on a phone (#7063): Saved's name is long, so its open tab is the icon and the count, the full words kept as its accessible name (#9647)
        const tab = await ev(`(() => { const b = document.getElementById('agentic-tab-saved'); return { active: b.classList.contains('active'), after: getComputedStyle(b, '::after').content, label: b.getAttribute('aria-label'), w: Math.round(b.getBoundingClientRect().width) }; })()`);
        check('the open Saved tab on a phone is its icon and count, not a wide pill of words, and keeps its name', tab.active && !/Saved for later/.test(tab.after) && tab.w < 120 && /^Saved for later/.test(tab.label), JSON.stringify(tab));
        check('the phone has its own close button and not the desktop X', await ev(`getComputedStyle(document.getElementById('agentic-mobile-close-btn')).display !== 'none'`));
        await clickDockSaved(); await closed('closing it again closes the overlay');
    } finally {
        for (const s of launched) await httpJson('POST', '/api/sessions/live/' + encodeURIComponent(s.session_name) + '/kill', { session_id: s.session_id, agent_type: 'terminal' }).catch(() => {});
        await client.close();
    }
    const failed = results.filter(r => r === 'FAIL').length;
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
    process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
