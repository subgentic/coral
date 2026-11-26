// The team page's Workers (mock v3 idea 2, #21467): the setups the Operator approved for a team. The isolated dev server and a real board; a dashboard write to an Operator-only route is a claimed caller on that server (as in orchestrator_grant_browser), so the workers' routes are a thin layer over fetch
// that answers as the server does (the Go tests in routes/team_workers_test.go and board/workers_store_test.go hold the server side).
// Checked: the rows say name, role and purpose, what each runs as and whether its start is cached; "Add a worker" opens New agent's steps, its last step saves to the team (Save worker, not Launch) and the
// row appears; Edit keeps the name and changes the purpose; Remove (the row menu) asks and takes it off; a name with markup stays text; the section reads at 4.5:1 in both themes and on a phone.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const TEAM = 'wrk-team-' + Date.now().toString(36);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const settle = (ms, quietMs = 120) => require('./helpers/wait').settle(ev, ms, quietMs);
    const layer = () => ev(`(() => { if (!window.__realFetch) window.__realFetch = window.fetch; const R = window.__realFetch;
        window.__wk = { workers: [], calls: [] };
        const json = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'content-type': 'application/json' } }));
        const view = w => ({ ...w, runs_as: w.agent_type === 'claude' ? 'Claude \u00b7 ' + (/sonnet/i.test(w.model || '') ? 'Sonnet' : 'default') : 'Codex', cached: w.agent_type === 'claude' && !!w.instructions });
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin); const m = (o.method || 'GET').toUpperCase();
            const mm = url.pathname.match(/^\\/api\\/board\\/${TEAM}\\/workers(?:\\/([^\\/]+))?$/);
            if (!mm) return R(u, o);
            const name = mm[1] ? decodeURIComponent(mm[1]) : '', body = o.body ? JSON.parse(o.body) : null;
            window.__wk.calls.push({ m, name, body });
            if (m === 'GET' && !name) return json({ workers: window.__wk.workers.map(view), launched: { Dev: 'Worker' }, brief: '', max: 12 });
            if (m === 'POST' && !name) { window.__wk.workers.push(body); return json(view(body)); }
            if (m === 'PUT') { const i = window.__wk.workers.findIndex(w => w.name === name); window.__wk.workers[i] = body; return json(view(body)); }
            if (m === 'DELETE') { window.__wk.workers = window.__wk.workers.filter(w => w.name !== name); return json({ ok: true }); }
            return json({ error: 'no' }, 404); }; return true; })()`);
    const put = (w) => ev(`window.__wk.workers.push(${JSON.stringify(w)}); true`);
    const mine = () => ev(`window.__wk.workers`);
    const open = async () => {
        await ev(`document.getElementById('wk-host')?.remove(); (async () => { const a = await import(${S} + 'team_agents_page.js'); const host = document.createElement('main'); host.id = 'wk-host'; host.style.cssText = 'position:fixed;inset:0;z-index:1000;background:var(--bg-primary);overflow:auto'; document.body.append(host); a.showAgents(host, ${JSON.stringify(TEAM)}, {}); })(); true`);
        await waitFor(`!!document.querySelector('#wk-host .workers-card')`, 'the workers panel', 15000);
        await settle(250);
    };
    const rows = () => ev(`Array.from(document.querySelectorAll('#wk-host .workers-card tbody tr')).map(tr => ({ name: tr.querySelector('.workers-name')?.textContent, sub: tr.querySelector('.workers-sub')?.textContent, text: tr.textContent }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const theme of ['dark', 'light']) {
            console.log(theme);
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await require('./helpers/wait').coralReady(ev); await installAudit(ev); await setTheme(ev, theme);
            const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer' }) }).then(r => r.status)`);
            assert.ok(sub < 300, 'subscribe ' + sub);
            await layer();
            await open();
            check(`${theme}: with none the panel says so and offers Add a worker`, /No approved workers yet/.test(await ev(`document.querySelector('#wk-host .workers-card').textContent`)) && !!(await ev(`!!document.querySelector('#wk-host .workers-add:not([disabled])')`)));

            await put({ name: 'Worker', role: 'Developer', purpose: 'for code tasks', agent_type: 'claude', model: 'claude-sonnet-4-5', instructions: 'Be careful.' });
            await put({ name: '<img src=x onerror=window.__pwn=1>', agent_type: 'codex' });
            await open();
            const r = await rows();
            check(`${theme}: a row per worker with its role and purpose`, r.length === 2 && r[0].name === 'Worker' && r[0].sub === 'Developer · for code tasks' && r[1].sub === 'No persona · no purpose said', JSON.stringify(r.map(x => [x.name, x.sub])));
            check(`${theme}: it says what each runs as and whether its start is cached`, /Claude · Sonnet/.test(r[0].text) && /Cached start/.test(r[0].text) && /Codex/.test(r[1].text) && /Not cached/.test(r[1].text), JSON.stringify(r.map(x => x.text)));
            check(`${theme}: a name with markup stays text and nothing ran`, r[1].name.startsWith('<img') && !(await ev(`!!document.querySelector('#wk-host .workers-card img') || !!window.__pwn`)));
            const geo = await ev(`(() => { const c = document.querySelector('#wk-host .workers-card'); const tr = c.querySelector('tbody tr'); const bg = getComputedStyle(c).backgroundColor; return { row: Math.round(tr.getBoundingClientRect().height), bg, fill: getComputedStyle(document.documentElement).getPropertyValue('--card-fill').trim() }; })()`);
            check(`${theme}: rows are the mock's 49px tall and the card wears the card fill (white in light), not the grey pane fill`, geo.row === 49 && (theme !== 'light' || geo.bg === 'rgb(255, 255, 255)'), JSON.stringify(geo));
            const au = await auditRegion(ev, ['#wk-host .workers-card'], { focus: ['#wk-host .workers-add'] });
            check(`${theme}: readable (4.5:1) with a focus ring (${au.checked} checked)`, au.fails.length === 0, JSON.stringify(au.fails.slice(0, 2)));

            // Add a worker: New agent's steps, the last one saves to the team
            await ev(`document.querySelector('#wk-host .workers-add').click(); true`);
            await waitFor(`document.getElementById('launch-modal') && getComputedStyle(document.getElementById('launch-modal')).display !== 'none' && /Add a worker/.test(document.getElementById('launch-agent-title-text')?.textContent || '')`, 'the dialog says Add a worker', 15000);
            await settle(300);
            check(`${theme}: the name field says Worker name and the button says Save worker`, (await ev(`document.querySelector('label[for="launch-agent-name-input"]')?.textContent`)) === 'Worker name' && (await ev(`document.getElementById('launch-agent-go').textContent`)) === 'Save worker');
            await ev(`(() => { const n = document.getElementById('launch-agent-name-input'); n.value = 'Reviewer'; n.dispatchEvent(new Event('input', { bubbles: true })); const p = document.getElementById('launch-worker-purpose'); p.value = 'reviews, no edits'; p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await ev(`document.getElementById('launch-agent-go').click(); true`);
            await waitFor(`Array.from(document.querySelectorAll('#wk-host .workers-card tbody tr')).some(tr => tr.querySelector('.workers-name')?.textContent === 'Reviewer')`, 'Reviewer in the list', 15000);
            const saved = (await mine()).find(w => w.name === 'Reviewer') || {};
            const calls = await ev(`window.__wk.calls.filter(c => c.m === 'POST')`);
            check(`${theme}: Save worker saved it to the team (the dialog closed, nothing was launched)`, saved.purpose === 'reviews, no edits' && calls.length === 1 && !('flags' in calls[0].body) && (await ev(`getComputedStyle(document.getElementById('launch-modal')).display`)) === 'none' && !(await ev(`!!document.querySelector('[data-worker]')`)), JSON.stringify([saved.name, saved.purpose, saved.agent_type]));
            await ev(`window.showLaunchModal(); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-modal')).display !== 'none'`, 'a plain dialog', 5000);
            const plain = await ev(`({ go: document.getElementById('launch-agent-go')?.textContent, host: !!document.querySelector('.launch-worker-purpose-host'), attr: document.getElementById('launch-modal')?.hasAttribute('data-worker') })`);
            await ev(`window.hideLaunchModal(); true`);
            check(`${theme}: a New agent dialog opened next is a plain one again`, plain.go === 'Launch' && !plain.host && !plain.attr, JSON.stringify(plain));

            // Edit: the row menu
            await ev(`document.querySelector('#wk-host .workers-card tbody tr[data-key="Reviewer"] .workers-more-toggle').click(); true`);
            await waitFor(`!!document.querySelector('.workers-menu:not([hidden]) [role=menuitem]')`, 'the row menu', 5000);
            const items = await ev(`Array.from(document.querySelectorAll('.workers-menu:not([hidden]) [role=menuitem]')).map(b => b.textContent)`);
            check(`${theme}: the row menu holds Edit, Launch one now and Remove from this team`, JSON.stringify(items) === JSON.stringify(['Edit', 'Launch one now', 'Remove from this team']), JSON.stringify(items));
            await ev(`Array.from(document.querySelectorAll('.workers-menu:not([hidden]) [role=menuitem]'))[0].click(); true`);
            await waitFor(`/Edit worker/.test(document.getElementById('launch-agent-title-text')?.textContent || '')`, 'Edit worker', 15000);
            await settle(300);
            check(`${theme}: Edit opens with the name and purpose filled`, (await ev(`document.getElementById('launch-agent-name-input').value`)) === 'Reviewer' && (await ev(`document.getElementById('launch-worker-purpose').value`)) === 'reviews, no edits');
            await ev(`(() => { const p = document.getElementById('launch-worker-purpose'); p.value = 'read only'; p.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('launch-agent-go').click(); return true; })()`);
            await waitFor(`Array.from(document.querySelectorAll('#wk-host .workers-card tbody tr')).some(tr => /read only/.test(tr.querySelector('.workers-sub')?.textContent || ''))`, 'the edited purpose', 15000);
            const puts = await ev(`window.__wk.calls.filter(c => c.m === 'PUT')`);
            check(`${theme}: an edit is one PUT to the same name that changes the purpose (no second row)`, puts.length === 1 && puts[0].name === 'Reviewer' && puts[0].body.purpose === 'read only' && (await rows()).filter(x => x.name === 'Reviewer').length === 1);

            // Remove: asks, then takes it off
            await ev(`document.querySelector('#wk-host .workers-card tbody tr[data-key="Reviewer"] .workers-more-toggle').click(); true`);
            await waitFor(`!!document.querySelector('.workers-menu:not([hidden]) [role=menuitem]')`, 'the row menu', 5000);
            await ev(`Array.from(document.querySelectorAll('.workers-menu:not([hidden]) [role=menuitem]'))[2].click(); true`);
            await waitFor(`/Take Reviewer off/.test(document.getElementById('confirm-modal-message')?.textContent || '')`, 'the confirmation', 5000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`!Array.from(document.querySelectorAll('#wk-host .workers-card tbody tr')).some(tr => tr.querySelector('.workers-name')?.textContent === 'Reviewer')`, 'Reviewer gone', 15000);
            check(`${theme}: an agent a worker started carries a From chip on its row`, (await ev(`document.querySelector('#wk-host tr[data-key="Dev"] .team-agent-from')?.textContent`)) === 'From "Worker"', await ev(`Array.from(document.querySelectorAll('#wk-host tr[data-key]')).map(t => t.dataset.key).join(',')`));
            check(`${theme}: Remove from this team asked and took it off`, !(await mine()).some(w => w.name === 'Reviewer'));

            // a phone
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await open();
            const phone = await ev(`(() => { const p = document.querySelector('#wk-host .workers-card'); return { fits: p.getBoundingClientRect().right <= innerWidth + 1, scroll: document.scrollingElement.scrollWidth <= innerWidth + 1, add: !!p.querySelector('.workers-add') }; })()`);
            check(`${theme}: on a phone the panel fits the screen with Add a worker`, phone.fits && phone.scroll && phone.add, JSON.stringify(phone));
            await ev(`document.getElementById('wk-host')?.remove(); true`);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed}/${results.length} checks passed`);
        if (failed) process.exitCode = 1;
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
