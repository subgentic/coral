// A goal's plan card says the goal, not the file's name (#19273, walk 79 item 3, the Orchestrator's decision): a file for review named plan-goal-<n>.md is headed with the title of the goal it serves, or 'Plan' when it
// serves none; any other file keeps its own name. Review rows (a read of the owner list) stubbed in the page, like needs_card_rows_browser. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'plancard-' + Date.now().toString(36);
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = (i, name, extra) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Plan Writer', review_question: 'Ship ' + name + '?', ...extra });
            const items = [item(1, 'plan-goal-1.md', { goal_id: 7, goal_title: 'Ship the installer' }), item(2, 'plan-goal-2.md', {}), item(3, 'notes.md', { goal_id: 7, goal_title: 'Ship the installer' })];
            window.fetch = (url, opts = {}) => { const u0 = new URL(String(url), location.href), page = u0.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(u0, location.href, { '${team}': items }) : null; if (page) return json(page); return original(url, opts); };
            return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} .inbox-review-name').length >= 3`, 'the three review rows', 15000);
        await ev(framesJs(3));
        const names = await ev(`[...document.querySelectorAll('${T} button.inbox-review-name')].map(b => ({ text: b.firstChild ? b.firstChild.textContent.trim() : b.textContent.trim(), label: b.getAttribute('aria-label') }))`);
        const texts = names.map(n => n.text);
        assert.ok(texts.includes('Ship the installer'), 'the plan of a goal is headed with the goal\'s title: ' + JSON.stringify(names));
        assert.ok(texts.includes('Plan'), 'a plan that serves no goal is headed Plan: ' + JSON.stringify(names));
        assert.ok(texts.includes('notes.md'), 'any other file keeps its own name: ' + JSON.stringify(names));
        assert.ok(!texts.some(t => /^plan-goal-\d+\.md$/.test(t)), 'no plan card carries the file name: ' + JSON.stringify(names));
        assert.ok(names.some(n => /^Open Ship the installer/.test(n.label || '')), 'and its button says the same: ' + JSON.stringify(names));
        console.log('PASS a goal\'s plan card says the goal, not plan-goal-1.md');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
