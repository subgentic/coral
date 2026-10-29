// A team's home folder is a row of Team settings (#10815): it shows the folder the team's agents start in, says that running agents stay where they are and the new folder applies the next time each
// one starts, and its Change folder button saves it through PUT /api/teams/detail/<team>/home-folder: a refusal is said in the server's words under the field and the shown folder stays; an accepted
// folder replaces the shown one. The row is not a field of the settings form: it does not make the settings unsaved. Real isolated board seeded by the team page helpers; the team record's routes are
// answered in the page. 1280 and 390. Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, openSettings } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-thf-${Date.now() % 100000}`;

// The team's record and its home-folder route, answered here: a folder that does not start with / is refused the way the server refuses it.
const STUB = `(() => {
    const prev = window.fetch;
    window.__thf = { puts: [], folder: '/Users/test/old-home' };
    const json = (b, status) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    window.fetch = (url, opts = {}) => {
        const u = String(url), method = (opts.method || 'GET').toUpperCase();
        if (/\\/api\\/teams\\/detail\\/[^/]+\\/home-folder$/.test(u) && method === 'PUT') {
            const body = JSON.parse(opts.body); window.__thf.puts.push(body.working_dir);
            if (!body.working_dir.startsWith('/')) return Promise.resolve(json({ error: 'The folder must be an absolute path.', field: 'working_dir' }, 400));
            window.__thf.folder = body.working_dir;
            return Promise.resolve(json({ ok: true, working_dir: body.working_dir, applies: 'next start' }, 200));
        }
        if (/\\/api\\/teams\\/detail\\/[^/]+$/.test(u) && method === 'GET') return Promise.resolve(json({ name: ${JSON.stringify(TEAM)}, working_dir: window.__thf.folder }, 200));
        return prev(url, opts);
    };
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM); await settle(800);
            await openSettings(ev, settle);
            await waitFor(`!!document.querySelector('.team-settings-modal .team-home-folder')`, `${label}: the home folder row`, 8000);
            await waitFor(`document.querySelector('.team-settings-modal .team-home-folder-current').textContent === '/Users/test/old-home'`, `${label}: the folder is shown`, 8000);

            const row = await ev(`(() => { const r = document.querySelector('.team-settings-modal .team-home-folder'); const li = r.closest('.sv-row'); return { label: li ? li.textContent : '', note: r.querySelector('.team-home-folder-note').textContent, input: !!r.querySelector('input[name=home_folder]'), btn: (r.querySelector('.team-home-folder-change') || {}).textContent }; })()`);
            assert.match(row.label, /Home folder/, `${label}: the row is named Home folder`);
            assert.match(row.note, /Running agents stay where they are/, `${label}: it says running agents stay: ${row.note}`);
            assert.match(row.note, /next time each one starts/, `${label}: and when the new folder applies: ${row.note}`);
            assert.equal(row.btn, 'Change folder', `${label}: the button says what it does`);

            // a refusal: the server's words under the field, the shown folder stays
            await ev(`(() => { const i = document.querySelector('.team-home-folder input[name=home_folder]'); i.value = 'relative/dir'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.team-home-folder-change').click(); return true; })()`);
            await waitFor(`document.querySelector('.team-home-folder .board-rename-error').textContent !== ''`, `${label}: the refusal is said`, 6000);
            assert.equal(await ev(`document.querySelector('.team-home-folder .board-rename-error').textContent`), 'The folder must be an absolute path.', `${label}: in the server's words`);
            assert.equal(await ev(`document.querySelector('.team-home-folder-current').textContent`), '/Users/test/old-home', `${label}: the folder shown is unchanged`);

            // an accepted folder replaces the shown one
            await ev(`(() => { const i = document.querySelector('.team-home-folder input[name=home_folder]'); i.value = '/Users/test/coral-hub'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.team-home-folder-change').click(); return true; })()`);
            await waitFor(`document.querySelector('.team-home-folder-current').textContent === '/Users/test/coral-hub'`, `${label}: the new folder is shown`, 6000);
            assert.deepEqual(await ev(`window.__thf.puts`), ['relative/dir', '/Users/test/coral-hub'], `${label}: each Change folder made one request`);
            assert.equal(await ev(`document.querySelector('.team-home-folder .board-rename-error').textContent`), '', `${label}: no error stays`);
            assert.equal(await ev(`!!(document.getElementById('team-settings-workspace').hasUnsaved && document.getElementById('team-settings-workspace').hasUnsaved())`), false, `${label}: the settings are not made unsaved by it`);
            await ev(`window.__thf.puts.length = 0; window.__thf.folder = '/Users/test/old-home'; true`);
            await ev(`(() => { const m = document.querySelector('.team-settings-modal'); const c = [...m.querySelectorAll('.sv-bar button')].find(b => /cancel/i.test(b.textContent)); if (c) c.click(); return true; })()`); await settle(300);
        }
        console.log('PASS the home folder row of Team settings');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
