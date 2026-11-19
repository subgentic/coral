// Activity's Important view (#19149, the Operator): a browser that kept nothing opens on Important, which leaves out delivery bookkeeping ('Sent held words to an agent') and keeps what a person did or must act on;
// Everything shows every row; the pills' counts are what the list shows; a kept choice (Everything) survives a reload. The record is stubbed in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, theme, keep) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 }); await Emulation.setTouchEmulationEnabled({ enabled: w < 500 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`(async () => {
            const prefix = window.__coralStatic || '/static/', ago = m => new Date(Date.now() - m * 60000).toISOString(), json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } }));
            const row = (id, action, item_kind, item_id, title, note) => ({ id, at: ago(id), team: 'tm', action, item_kind, item_id: String(item_id), title, note, source: 'dashboard' });
            const rows = [row(5, 'answer', 'question', 5, 'Ship it?', 'yes'), row(4, 'wait_send', 'agent', 'claude-ada', 'site-designer-agy', 'hello'), row(3, 'ignore', 'file', 'a'.repeat(64), 'site-first-look.md', ''), row(2, 'wait_send', 'agent', 'claude-bob', 'claude-bob', 'again'), row(1, 'approve', 'file', 'b'.repeat(64), 'plan.md', '')];
            const original = window.fetch;
            window.fetch = (url, opts = {}) => new URL(String(url), location.origin).pathname === '/api/activity' ? json({ actions: rows, check: { intact: true, rows: rows.length } }) : original(url, opts);
            ${keep ? '' : "localStorage.removeItem('coral-inbox-activity-filters');"}
            const m = await import(prefix + 'settings_core.js'); m.applyTheme('${theme}');
            window.switchNavTab('hub-inbox');
            await (await import(prefix + 'inbox_sidebar.js')).openInboxGroup('activity');
        })()`);
        await waitFor(`document.querySelectorAll('#group-table-view .ac-row').length > 0`, 'the record is drawn');
    };
    const rowsNow = () => ev(`document.querySelectorAll('#group-table-view .ac-row').length`);
    const text = () => ev(`[...document.querySelectorAll('#group-table-view .ac-row')].map(r => r.textContent).join(' | ')`);
    const pressed = () => ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip[aria-pressed="true"]')].map(b => b.dataset.filter)`);
    const pills = () => ev(`[...document.querySelectorAll('.team-tb-pills .goals-chip')].map(b => b.dataset.filter + ':' + b.textContent.replace(/\\s+/g, ' ').trim())`);
    const pick = async key => { assert.ok(await ev(`(() => { const b = document.querySelector('.team-tb-pills .goals-chip[data-filter="${key}"]'); if (!b || !b.getClientRects().length) return false; b.click(); return true; })()`), `the ${key} chip is there to press`); await ev(framesJs(4)); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme] of [[1440, 'dark'], [1440, 'light'], [390, 'dark']]) {
            const tag = `${w}-${theme}`;
            await open(w, theme, false);
            assert.equal(await rowsNow(), 3, `${tag}: a browser that kept nothing opens on Important: the answer, the dismissal and the approval, not the two sends of held words`);
            assert.ok(!/Sent held words/.test(await text()), `${tag}: no 'Sent held words to' row under Important`);
            if (w < 500) { await shot(`important-default-${tag}`); continue; }
            assert.deepEqual(await pressed(), ['important'], `${tag}: Important is the pressed pill`);
            const list = await pills();
            assert.ok(list[0].startsWith('important:Important') && list[1].startsWith('all:Everything'), `${tag}: Important first, then Everything: ${JSON.stringify(list)}`);
            assert.match(list[0], /3\s*$/, `${tag}: Important counts what it shows`); assert.match(list[1], /5\s*$/, `${tag}: Everything counts every row`);
            await shot(`important-default-${tag}`);
            await pick('all');
            assert.deepEqual(await pressed(), ['all'], `${tag}: Everything is pressed`);
            assert.equal(await rowsNow(), 5, `${tag}: Everything shows all five`);
            assert.ok(/Sent held words/.test(await text()), `${tag}: the 'Sent held words to' row is there under Everything`);
            await shot(`important-everything-${tag}`);
            await open(w, theme, true);
            assert.deepEqual(await pressed(), ['all'], `${tag}: a kept Everything is still Everything after a reload`);
            assert.equal(await rowsNow(), 5);
            await pick('important'); assert.equal(await rowsNow(), 3, `${tag}: Important again`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
