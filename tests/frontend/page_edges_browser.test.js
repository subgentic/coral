// One left edge for the page's content, one inset for an empty state, one width for the toasts, and a phone toast that leaves the page title alone (#9452 items 2, 3 and 14, the visual audit).
//  - the title of the Inbox and Automations folders, Analytics and Docs start at the same x (the content edge, 24 px in the main stage); the bar above a folder's table starts there too
//  - an empty state's words start at that edge on the folders and the artifacts page, and an empty Artifacts, Tasks and Runs page says what fills it (a hint under the line)
//  - two toasts of different lengths are one width
//  - at 390 a toast covers no control (it sits under the app bar, over the list's heading: left as it was)
// PAGE_EDGES_SHOTS=<dir> writes a picture of each screen there (the before/after of the review). Drives Chrome over CDP against the isolated dev server.
const assert = require('node:assert/strict');
// PAGE_EDGES_NO_ASSERT=1 only reports what would fail (to take the pictures of a tree that does not pass yet)
const ok = (cond, message) => { if (!cond) { if (process.env.PAGE_EDGES_NO_ASSERT) console.log('would fail: ' + message); else assert.fail(message); } };
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const TITLE = `(() => { const vis = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const t = [...document.querySelectorAll('main h1, main h2, #main-content h1, #main-content h2, .inbox-folder-head h2, [role=main] h2, .docs-content h1, .cost-dashboard-view h2, h1, h2')].filter(vis).find(e => e.getBoundingClientRect().left > 200);
    return t ? { left: Math.round(t.getBoundingClientRect().left * 10) / 10, text: t.textContent.trim().slice(0, 30) } : null; })()`;
const EMPTY = `(() => { const vis = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const l = [...document.querySelectorAll('.empty-state-line')].find(vis), h = [...document.querySelectorAll('.empty-state-hint')].find(vis);
    return { left: l ? Math.round(l.getBoundingClientRect().left * 10) / 10 : null, line: l ? l.textContent.trim() : null, hint: h ? h.textContent.trim() : null }; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const shots = process.env.PAGE_EDGES_SHOTS;
    const shot = async name => { if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(`${shots}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
    const open = async (path, ready) => { await Page.navigate({ url: BASE + path }); await Page.loadEventFired(); await install(); await waitFor(ready || `(${TITLE}) !== null`, 'the screen ' + path, 15000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const edges = {};
        for (const [name, path] of [['tasks', '/inbox/tasks'], ['artifacts', '/inbox/artifacts'], ['jobs', '/automations/jobs'], ['workflows', '/automations/workflows'], ['analytics', '/analytics'], ['docs', '/docs']]) {
            await open(path);
            edges[name] = await ev(TITLE); ok(edges[name], `${name} has a title`);
            await shot('1280-' + name);
            if (['tasks', 'artifacts', 'jobs', 'workflows'].includes(name)) {
                const e = await ev(EMPTY);
                if (e.line) ok(Math.abs(e.left - edges[name].left) <= 1, `${name}: the empty state's words start at the title's edge (${e.left} and ${edges[name].left})`);
                if (name === 'tasks' || name === 'artifacts') ok(e.hint, `${name}: the empty state says what fills it (${JSON.stringify(e)})`);
            }
        }
        const lefts = Object.values(edges).map(e => e.left), min = Math.min(...lefts), max = Math.max(...lefts);
        ok(max - min <= 1, 'the title of every screen starts at one x: ' + JSON.stringify(edges));
        // the folder's bar (its search row) starts where the table does
        await open('/inbox/tasks');
        const bar = await ev(`(() => { const b = document.querySelector('#group-table-view .list-bar-search-row'), t = document.querySelector('#group-table-view .inbox-folder-head h2'); return b && t ? { bar: Math.round(b.getBoundingClientRect().left * 10) / 10, title: Math.round(t.getBoundingClientRect().left * 10) / 10 } : null; })()`);
        ok(bar && Math.abs(bar.bar - bar.title) <= 1, 'a folder\'s bar starts at the title\'s edge: ' + JSON.stringify(bar));
        // runs: the job page's empty Runs table (needs a job), skipped on an empty server; the table's own empty state carries a hint by the same config
        // toasts: two stacked, one width
        await open('/inbox/tasks');
        await ev(`(async () => { const n = await import(${JSON.stringify((await ev(`window.__coralStatic || '/static/'`)) + 'notifications.js')}); n.showToast('Saved.'); n.showToast('A longer message that says what happened and what to do about it.'); return true; })()`);
        await waitFor(`document.querySelectorAll('#toast-host > .toast').length === 2`, 'two toasts', 5000);
        const widths = await ev(`[...document.querySelectorAll('#toast-host > .toast')].map(t => Math.round(t.getBoundingClientRect().width))`);
        await shot('1280-toasts');
        ok(widths.length === 2, 'two toasts are on screen: ' + JSON.stringify(widths));
        ok(widths.length > 1 && Math.abs(widths[0] - widths[1]) <= 1, 'two toasts are one width: ' + JSON.stringify(widths));
        // a phone: the toast stays where it was, under the app bar, over the list's heading and no control (the audit's own words: "it does not cover a control"); one width is the 1280 check above
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await open('/agents', `!!document.querySelector('.mobile-list-title') && document.querySelector('.mobile-list-title').getClientRects().length > 0`);
        await ev(`(async () => { const n = await import(${JSON.stringify((await ev(`window.__coralStatic || '/static/'`)) + 'notifications.js')}); n.showToast('Saved.'); return true; })()`);
        await waitFor(`!!document.querySelector('#toast-host > .toast')`, 'the toast', 5000);
        await ev(`Promise.all(document.querySelector('#toast-host > .toast').getAnimations().map(a => a.finished.catch(() => {}))).then(() => true)`); // slid in: the box is where it stays
        await shot('390-toast');
        const covered = await ev(`(() => { const t = document.querySelector('#toast-host > .toast'); const r = t.getBoundingClientRect(); const hit = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button]')].filter(e => e.getClientRects().length && !t.contains(e) && getComputedStyle(e).visibility !== 'hidden').filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top; }); return hit.map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase()) + '.' + String(e.className).trim().split(/\\s+/)[0]); })()`);
        ok(covered.length === 0 || process.env.PAGE_EDGES_NO_ASSERT, 'at 390 the toast covers no control: ' + JSON.stringify(covered));
        console.log('   ✓');
    } finally { await Emulation.clearDeviceMetricsOverride().catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
