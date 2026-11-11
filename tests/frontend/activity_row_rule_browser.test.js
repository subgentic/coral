// #14423 (the Operator, from a screenshot of Activity): one rule for a row, the VERB in YOU DID, the OBJECT in ON and the detail on its own line under it. An answer names its question and shows the answer clean (no repeated
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
        for (const width of [1280, 390]) {
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
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 9`, `${width}: the nine rows`, 15000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the columns settle
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/activity-rule-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const text = await ev(`document.querySelector('#group-table-view').textContent.replace(/\\s+/g, ' ')`);
            assert.ok(!/Dismissed\\s*[“"]?Dismissed by/.test(text) && !/Dismissed by/.test(text), `${width}: no "Dismissed Dismissed by": ${text.slice(0, 200)}`);
            assert.ok(!/@Orchestrator/.test(text), `${width}: no raw @mention in an answer`);
            assert.ok(!/You answered/.test(text), `${width}: no repeated verb ("You answered")`);
            assert.ok(text.includes('Your answer: 1 is fine for now') && text.includes('Your answer: Option 2') && text.includes('Your answer: Yes'), `${width}: the answers are shown clean`);
            assert.ok(text.includes('Which of the two designs should ship in v2.0.61?') && text.includes('from Orchestrator'), `${width}: a new answer names its question and who asked`);
            assert.ok(text.includes('Orchestrator’s question'), `${width}: an older answer names the asker's question`);
            assert.ok(text.includes('release-plan.md') && /Unstarred/.test(text) && /Starred/.test(text), `${width}: Starred and Unstarred show the file name`);
            assert.ok(text.includes('a file'), `${width}: an older starred row falls back to "a file"`);
            assert.ok(text.includes(LONG), `${width}: a long note is whole, not cut`);
            if (width === 1280) {
                const cols = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map(tr => ({ did: (tr.querySelector('td[data-key="action"]') || {}).textContent, on: (tr.querySelector('td[data-key="item"] .dt-primary, td[data-key="item"] .activity-item') || {}).textContent, detail: (tr.querySelector('.activity-detail') || {}).textContent || '', cut: tr.querySelector('.activity-detail') ? tr.querySelector('.activity-detail').scrollWidth > tr.querySelector('.activity-detail').clientWidth + 1 : false }))`);
                assert.deepEqual(cols.map(c => c.did), ['Dismissed', 'Answered', 'Answered', 'Answered', 'Dismissed', 'Unstarred', 'Starred', 'Changed the tags', 'Shared'], `${width}: YOU DID is the verb alone: ${JSON.stringify(cols.map(c => c.did))}`);
                assert.deepEqual(cols.map(c => c.on), ['a question', 'Orchestrator’s question', 'Which of the two designs should ship in v2.0.61?', 'a question', 'Ship it?', 'release-plan.md', 'a file', 'tagged-plan.md', 'shared-plan.md'], `${width}: ON is the object alone: ${JSON.stringify(cols.map(c => c.on))}`);
                assert.deepEqual(cols.map(c => c.detail), ['', 'Your answer: 1 is fine for now', 'from Orchestrator · Your answer: Option 2', 'Your answer: Yes', LONG, '', '', '', ''], `${width}: the detail is on its own line: ${JSON.stringify(cols.map(c => c.detail))}`);
                assert.ok(cols.every(c => !c.cut), `${width}: no detail is cut`);
            } else {
                const wrap = await ev(`[...document.querySelectorAll('#group-table-view tbody .dt-mail-ask, #group-table-view tbody .dt-mail-title')].map(e => ({ t: e.textContent.slice(0, 30), cut: e.scrollWidth > e.clientWidth + 1 || getComputedStyle(e).textOverflow === 'ellipsis' }))`);
                assert.ok(wrap.every(w => !w.cut), `${width}: neither the object nor the detail is cut on the phone: ${JSON.stringify(wrap.filter(w => w.cut))}`);
                const asks = await ev(`[...document.querySelectorAll('#group-table-view tbody .dt-mail-ask')].map(e => e.textContent)`);
                assert.ok(asks.some(a => /^Answered \u00b7 from Orchestrator \u00b7 Your answer: Option 2$/.test(a)), `${width}: the phone's second line is the verb and the detail: ${JSON.stringify(asks)}`);
            }
        }
        console.log('activity_row_rule: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
