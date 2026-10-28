// Open folder says what you get and leaves its actions in view (#10077, Beta Tester #10071): the dialog says it adds the folder to the list and that an agent or a terminal starts in it with one click; after it
// the folder is open in the list with its menu showing, Add Agent and Add Custom Agent say what each does; Add Terminal opens the new terminal (and its Files tab does not talk about git); the New terminal dialog
// opens in that folder, not the home folder, and says what tmux does. A terminal is launched for real (no agent CLI is needed). 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa10077-'));
    const dir = path.join(tmp, 'qa-work'); fs.mkdirSync(dir);
    const real = fs.realpathSync(dir);
    let launched = null;
    const shot = require('./helpers/scene_shots')(Page, 'open-folder');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => { const real = window.fetch; window.__launchBody = null;
            window.fetch = async (u, o = {}) => { const r = await real(u, o); if (new URL(String(u), location.href).pathname === '/api/sessions/launch' && (o.method || 'GET') === 'POST') { window.__launchBody = await r.clone().json().catch(() => null); } return r; };
            return true; })()`);

        console.log('1. the dialog says what you get');
        await ev(`document.getElementById('welcome-open-folder').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('open-folder-modal')).display !== 'none'`, 'the Open folder dialog');
        const help = await ev(`document.querySelector('#open-folder-modal .open-folder-help').textContent`);
        assert.match(help, /Adds this folder to your list/, help); assert.match(help, /agent or a terminal/, help); assert.doesNotMatch(help, /pinned|unpin/i, 'no sidebar jargon: ' + help);

        console.log('2. after it, the folder is open with its menu showing and each choice explained');
        await ev(`(() => { const i = document.getElementById('open-folder-dir'); i.value = ${JSON.stringify(real)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('open-folder-submit').click(); return true; })()`);
        await waitFor(`!!document.querySelector('#live-sessions-list .session-group-header[data-group-name="qa-work"] .sidebar-kebab-menu') && getComputedStyle(document.querySelector('#live-sessions-list .session-group-header[data-group-name="qa-work"] .sidebar-kebab-menu')).display !== 'none'`, "the new folder's menu showing", 10000);
        const head = await ev(`(() => { const h = document.querySelector('#live-sessions-list .session-group-header[data-group-name="qa-work"]'); return { expanded: h.getAttribute('aria-expanded') ?? h.querySelector('.group-chevron')?.getAttribute('aria-expanded'), menu: h.querySelector('.sidebar-kebab-menu').textContent.replace(/\\s+/g, ' ') }; })()`);
        assert.notEqual(head.expanded, 'false', 'the folder is open in the list');
        assert.match(head.menu, /Add Agent.*default agent/, head.menu); assert.match(head.menu, /Add Custom Agent.*persona, prompt and permissions/, head.menu);
        await shot('menu-showing');
        const toast = await ev(`[...document.querySelectorAll('.toast, [role=status]')].map(e => e.textContent).join(' | ')`);
        assert.doesNotMatch(toast, /Pinned/, 'the toast has no sidebar jargon: ' + toast);

        console.log('3. Add Terminal opens the new terminal, and its Files tab says nothing about git');
        await ev(`[...document.querySelectorAll('#live-sessions-list .session-group-header[data-group-name="qa-work"] .sidebar-kebab-menu .overflow-menu-item')].find(b => /^Add Terminal/.test(b.textContent.trim())).click(); true`);
        await waitFor(`!!window.__launchBody && !!window.__launchBody.session_name`, 'the launch answer', 15000);
        launched = await ev(`window.__launchBody`);
        await waitFor(`import((window.__coralStatic || '/static/') + 'state.js').then(m => !!m.state.currentSession && m.state.currentSession.name === ${JSON.stringify(launched.session_name)})`, 'the new terminal opened', 15000);
        await waitFor(`/No changes to list/.test(document.getElementById('changed-files-title').textContent)`, "the Files tab's terminal wording", 10000);
        const files = await ev(`document.getElementById('changed-files-list').textContent`);
        assert.doesNotMatch(files, /git/i, 'no git talk for a shell: ' + files);

        console.log('4. the New terminal dialog opens in the folder and explains tmux');
        await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('terminal'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-terminal')).display !== 'none'`, 'the terminal step');
        assert.equal(await ev(`document.getElementById('launch-terminal-dir').value`), real, 'the folder from the list, not the home folder');
        assert.match(await ev(`document.getElementById('launch-terminal-backend-help').textContent`), /keeps the terminal running if you close the page/);
        await shot('terminal-dialog');
        console.log('PASS open folder, its actions and the terminal');
    } finally {
        if (launched) { try { await ev(`fetch('/api/sessions/live/' + encodeURIComponent(${JSON.stringify(launched.session_name)}) + '/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: 'terminal', session_id: ${JSON.stringify(launched.session_id || '')} }) }).then(() => true)`); } catch { /* the runner's own cleanup follows */ } }
        try { await ev(`fetch('/api/pinned-folders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(real)} }) }).then(() => true)`); } catch { /* the isolated server goes away with the run */ }
        fs.rmSync(tmp, { recursive: true, force: true });
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
