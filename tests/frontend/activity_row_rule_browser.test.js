// #17452: Activity is a compact log with its own URL; the original #14423 (the Operator, from a screenshot of Activity): one rule for a row, the VERB in YOU DID, the OBJECT in ON and the detail on its own line under it. An answer names its question and shows the answer clean (no repeated
// verb, no raw @mention); a dismissed question does not say "Dismissed Dismissed by"; a long note is whole; Starred and Unstarred show the file's name (an older row falls back to "a file"). 1280 and 390 px, the record is stood in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const LONG = 'Not now: the build is red, the release notes are not written and I want to look at the whole diff before anyone ships this to the beta testers tomorrow morning.';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const failures = [];
        for (const width of [1440, 1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const now = Date.now(), at = n => new Date(now - n * 60000).toISOString(), /* one reading of the clock: rows that share a time share it exactly, so the order between them is the table's, not a millisecond's (#15446) */ base = { actor: 'operator', team: 'coral-hub', source: 'local', version: '', hint: '', surface: '' };
                window.__rows = [
                    { id: 9, action: 'dismiss', item_kind: 'question', item_id: '5', title: '', note: 'Dismissed by the operator', at: at(6), ...base },
                    { id: 8, action: 'answer', item_kind: 'question', item_id: '6', title: 'Orchestrator', note: '@Orchestrator 1 is fine for now', at: at(6), ...base },
                    { id: 7, action: 'answer', item_kind: 'question', item_id: '7', title: '@Operator Which of the two designs should ship in v2.0.61?', asker: 'Orchestrator', note: '@Orchestrator Option 2', at: at(7), ...base },
                    { id: 6, action: 'answer', item_kind: 'question', item_id: '8', title: '', note: 'Yes', at: at(7), team: 'coral-go-team', actor: 'operator', source: 'local', version: '', hint: '', surface: '' },
                    { id: 5, action: 'dismiss', item_kind: 'question', item_id: '9', title: 'Ship it?', note: ${JSON.stringify(LONG)}, at: at(9), ...base },
                    { id: 4, action: 'file_unstar', item_kind: 'file', item_id: 'a'.repeat(64), version: 'a'.repeat(64), title: 'release-plan.md', note: '', at: at(40), ...base },
                    { id: 3, action: 'file_star', item_kind: 'file', item_id: 'b'.repeat(64), version: 'b'.repeat(64), title: '', note: '', at: at(41), ...base },
                    { id: 2, action:'file_tags',item_kind:'file',item_id:'c'.repeat(64),title:'tagged-plan.md',note:'',at:at(42),...base },
                    { id: 1, action:'file_share',item_kind:'file',item_id:'d'.repeat(64),title:'shared-plan.md',note:'',at:at(43),...base },
                ];
                const real = window.fetch; window.fetch = (u, o) => new URL(String(u), location.origin).pathname === '/api/activity' ? Promise.resolve(new Response(JSON.stringify({ actions: window.__rows, check: { intact: true, rows: 9 } }), { headers: { 'Content-Type': 'application/json' } })) : real(u, o);
                localStorage.removeItem('coral-inbox-activity-filters'); window.switchNavTab('hub-inbox'); return import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('activity')).then(() => true); })()`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.list-row-activity').length === 9`, `${width}: the nine rows`, 15000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the columns settle
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/activity-rule-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const measured = await ev(`({ path: location.pathname, rows: [...document.querySelectorAll('.list-row-activity')].map(tr => { const title = tr.querySelector('[data-key="item"]'), action = tr.querySelector('[data-key="action"]'), who = tr.querySelector('[data-key="who"]'); return { height: tr.getBoundingClientRect().height, title: title.getBoundingClientRect().x, action: action.getBoundingClientRect().x, who: who.getBoundingClientRect().x, chip: !!action.querySelector('.chip'), expanded: tr.querySelector('button')?.getAttribute('aria-expanded') }; }) })`);
            if (measured.path !== '/inbox/activity') failures.push(`${width}: Activity URL: ${measured.path}`);
            if (!measured.rows.every(r => Math.abs(r.height - 44) < 2 && r.title < r.action && r.action < r.who && !r.chip && r.expanded === 'false')) failures.push(`${width}: compact title/outcome/who rows: ${JSON.stringify(measured.rows)}`);
            if (measured.rows.every(r => r.expanded === 'false')) {
                await ev(`document.querySelector('.list-row-activity [data-key="item"] button').click()`);
                await waitFor(`document.querySelector('.list-row-activity [data-key="item"] button').getAttribute('aria-expanded') === 'true'`, 'row detail opens');
                assert.ok(await ev(`!document.querySelector('.activity-folder .dt-detail').hidden`), 'detail visible');
                const text = await ev(`document.querySelector('.activity-folder').textContent`);
                assert.ok(text.includes('Your answer: 1 is fine for now') && text.includes('Your answer: Option 2') && text.includes(LONG), 'answers and whole long notes retained in details');
                await ev(`document.querySelector('.list-row-activity [data-key="item"] button').click()`);
                const route = await ev(`(async () => { const r = await import((window.__coralStatic || '/static/') + 'routes.js'); return ['needs','saved','activity','artifacts','chats'].map(folder => r.parse(r.build({ view: 'inbox-folder', folder }))?.folder); })()`);
                assert.deepEqual(route, ['needs','saved','activity','artifacts','chats']);
                const times = await ev(`(async () => { const { activityTime } = await import((window.__coralStatic || '/static/') + 'inbox_activity.js'); const now = new Date(2026, 10, 15, 18, 0); return [new Date(2026,10,15,17,29), new Date(2026,10,15,16,27), new Date(2026,10,14,12,23), new Date(2026,10,12,12,0)].map(d => activityTime(d.toISOString(), now)); })()`);
                assert.deepEqual(times, ['31 min', '4:27 PM', 'Yesterday 12:23 PM', 'Nov 12']);
                const outcomes = await ev(`(async () => { const p = window.__coralStatic || '/static/', a = await import(p + 'inbox_activity.js'), f = await import(p + 'operator_activity_filters.js'); const words = []; for (const action of f.ACTIONS) { const node = a.spec({...f.EMPTY, action}, {}).node(); words.push(...[...node.querySelectorAll('.activity-decision')].map(n => n.textContent.replace('✓', '').trim())); } return words; })()`);
                assert.ok(outcomes.every(w => w.split(/\s+/).length <= 2), 'outcomes are one or two plain words');
                await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('saved')).then(() => true)`);
                await waitFor(`location.pathname === '/inbox/saved'`, 'Saved URL');
                await ev(`history.back(); true`);
                await waitFor(`location.pathname === '/inbox/activity' && !!document.querySelector('.activity-folder')`, 'Back restores Activity');
                await Page.reload(); await Page.loadEventFired(); await install();
                await waitFor(`location.pathname === '/inbox/activity' && /Activity/.test(document.querySelector('#group-table-view')?.textContent || '')`, 'reload restores Activity');
            }
        }
        assert.deepEqual(failures, []);
        console.log('activity_row_rule: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
