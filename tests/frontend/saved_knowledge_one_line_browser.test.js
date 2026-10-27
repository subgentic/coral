// #8981 (Goal #79 audit items 4, 11, 13, 17): the Inbox's Saved table and the team's Knowledge table are ONE line per row, wide or narrow: Saved is the message, when it was saved and its Done action (the server and
// the state leave a folded row); Knowledge is the entry and when it was updated (From leaves a folded row). The tasks lists are one line at 1280 already (36 px rows) and #8936 makes a folded task row one line.
// Real board and saved message on the isolated dev server (removed again); the Knowledge answer is stubbed. 1280 and 390.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const { removeBoards } = require('./helpers/board_cleanup');
const { clearSaved } = require('./helpers/saved_cleanup');
const BASE = require('./test_base').BASE;
const board = 'saved-line-' + Date.now().toString(36);
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const raw = (m, p, b) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }${b ? `, body: ${JSON.stringify(JSON.stringify(b))}` : ''} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await clearSaved(raw).catch(() => {});
        assert.equal((await raw('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status, 200);
        const ids = [];
        for (let i = 1; i <= 3; i++) { const m = await raw('POST', `/api/board/${board}/messages`, { content: `Message ${i}: a long body that must not make a second line under the title in the Saved table`, subscriber_id: 'Boss' }); const id = m.body.id || (m.body.message || {}).id; ids.push(id);
            assert.ok((await raw('POST', '/api/saved', { kind: 'board', ref: board, key: String(id), title: `Saved message ${i} with a title long enough to be cut with an ellipsis`, snippet: `The snippet of message ${i}, which used to be a second line under its title` })).status < 300); }
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin);
            if (/\\/knowledge$/.test(url.pathname)) return Promise.resolve(new Response(JSON.stringify({ exists: true, index: '# Index', created_at: new Date().toISOString(), agents: [{ name: 'Backend Dev', content: 'notes' }, { name: 'QA Engineer', content: 'notes' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); }; })()` }); // the team's Knowledge answer, from the first script of every page
        const measure = () => ev(`[...document.querySelectorAll('.dt-table tbody tr:not(.dt-group)')].filter(r => r.getClientRects().length > 0).map(r => { const v = e => !!e && e.getClientRects().length > 0, mid = e => { const b = e.getBoundingClientRect(); return b.y + b.height / 2; };
            const title = r.querySelector('button.dt-primary'), others = [...r.querySelectorAll('td')].filter(td => v(td) && td.dataset.key !== 'message' && td.dataset.key !== 'entry' && td.textContent.trim()).map(td => ({ key: td.dataset.key, d: Math.abs(mid(td) - mid(title)) }));
            const box = r.closest('.dt-box'); return { h: Math.round(r.getBoundingClientRect().height), title: v(title), off: others.filter(o => o.d > 8).map(o => o.key), keys: others.map(o => o.key), scrolls: box.scrollWidth - box.clientWidth }; })`);
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            for (const [name, where, folder] of [['Saved', '/', 'saved'], ['Knowledge', `/team/${board}/knowledge`, null]]) {
                const at = `${width} ${name}: `;
                try {
                    await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                    await Page.navigate({ url: BASE + where }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
                    if (folder) { await ev(`window.switchNavTab('hub-inbox'); true`); await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(folder)})).then(() => true)`); }
                    await waitFor(`document.querySelectorAll('.dt-table tbody tr:not(.dt-group)').length >= ${name === 'Saved' ? 3 : 1}`, at + 'the rows', 15000);
                    const rows = await measure();
                    assert.ok(rows.length >= 1, at + 'rows');
                    for (const r of rows) {
                        assert.ok(r.title, at + 'the title is on the row');
                        assert.deepEqual(r.off, [], at + 'every other cell shares the title\'s line: ' + JSON.stringify(r));
                        assert.ok(r.h <= 64, at + 'one line (a folded compact row is about 61 px; two lines were 76 and more): ' + r.h + ' px: ' + JSON.stringify(r)); assert.ok(r.scrolls <= 1, at + 'no sideways scroll');
                    }
                    if (width === 390 && name === 'Saved') { // 200% text: the narrow container rule must not let the title wrap (#8981, the 20 rem rule)
                        await ev(`document.documentElement.style.fontSize = '32px'; true`); await new Promise(r => setTimeout(r, 600)); // sleep-ok: the table's fold observer settles
                        const big = await ev(`[...document.querySelectorAll('.dt-table tbody tr:not(.dt-group)')].filter(r => r.getClientRects().length).map(r => { const t = r.querySelector('button.dt-primary'), c = getComputedStyle(t); return { nowrap: c.whiteSpace, ellipsis: c.textOverflow, h: Math.round(t.getBoundingClientRect().height), lh: parseFloat(c.lineHeight) || parseFloat(c.fontSize) * 1.3 }; })`);
                        for (const r of big) { assert.equal(r.nowrap, 'nowrap', at + '200% text: the title stays on one line: ' + JSON.stringify(r)); assert.equal(r.ellipsis, 'ellipsis', at + '200% text: cut with an ellipsis'); assert.ok(r.h < 70, at + '200% text: one line high: ' + JSON.stringify(r)); }
                        await ev(`document.documentElement.style.fontSize = ''; true`);
                    }
                    const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'out'));
                    if (dir) { fs.mkdirSync(dir, { recursive: true }); for (const theme of ['light', 'dark']) { await setTheme(ev, theme); fs.writeFileSync(path.join(dir, `${name.toLowerCase()}-one-line-${width}-${theme}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
                    console.log(`PASS ${at}one line per row`);
                } catch (e) { failures.push(at + e.message); console.error(failures.at(-1)); }
            }
        }
        assert.deepEqual(failures, []);
    } finally { await clearSaved(raw).catch(() => {}); await removeBoards(ev, [board]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
