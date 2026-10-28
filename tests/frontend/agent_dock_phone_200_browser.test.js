// The agent's Files, Browse and Activity tabs on a phone and at 200% text (task 7652, items 1, 2, 3, 4 and 6 of the real-content report on the Files, Browse, Notes, Activity and Agent UI tabs):
//   1. a Files row keeps its whole name: Copy, Preview, Edit and Share as artifact are behind one More button that opens them on a line under the row;
//   2. a file opened on a phone is a screen of its own (the phone-full preview) with a Back button, and Back returns to the list;
//   3. Browse's folder is its name on one line (the whole path as its title), the two buttons never share its row when they do not fit;
//   4. Activity's summaries keep their words at 200% (the time goes under them) and the Time and Count switch is 44 px;
//   6. the panel's tab strip scrolls the open tab into view.
// The routes are stubbed on the page. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { TOUCH_AREA } = require('./helpers/touch_area');

const FILES = [
    { filepath: 'docs/guide.md', status: 'D', additions: 0, deletions: 3 }, { filepath: 'internal/store/store_test.go', status: 'A', additions: 9, deletions: 0 },
    { filepath: 'internal/store/store.go', status: 'M', additions: 6, deletions: 3 }, { filepath: 'main.go', status: 'M', additions: 4, deletions: 3 }, { filepath: 'README.md', status: 'M', additions: 1, deletions: 2 },
];
const EVENTS = [
    { id: 6, event_type: 'notification', tool_name: '', summary: 'Claude needs your permission to use Bash', created_at: '2026-10-25T11:36:53Z' },
    { id: 5, event_type: 'tool_use', tool_name: 'Bash', summary: 'Ran: go test ./internal/store/... -run TestAdd -count=1 -v', created_at: '2026-10-25T11:36:53Z' },
    { id: 4, event_type: 'tool_use', tool_name: 'Edit', summary: 'Edit internal/store/store.go', created_at: '2026-10-25T11:36:52Z' },
];
const ROOT = '/work/demo/projects/queue-service';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const orig = window.fetch; const json = b => Promise.resolve(new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = String(url && url.url || url);
                if (/\\/api\\/sessions\\/live\\/[^/]+\\/files\\?/.test(u)) return json({ files: ${JSON.stringify(FILES)}, diff_mode: 'previous_commit' });
                if (/\\/api\\/sessions\\/live\\/[^/]+\\/events\\?/.test(u)) return json(${JSON.stringify(EVENTS)});
                if (/\\/search-files\\?/.test(u) && /view=explorer/.test(u)) return json({ entries: [{ name: 'internal', type: 'dir', path: 'internal' }, { name: 'main.go', type: 'file', path: 'main.go' }], root: ${JSON.stringify(ROOT)} });
                return orig(url, opts); }; return true; })()`);
        await ev(`window.__m.add('dock-a', 'A', 3, { sleeping: false, session_id: 'dock-a-id' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'dock-a')`, 'the agent', 10000);
        await ev(`window.selectLiveSession('dock-a', 'claude', 'dock-a-id', 'local'); true`);
        const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        const openTab = async tab => {
            await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) { const b = document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'); if (b) b.click(); } window.switchAgenticTab(${JSON.stringify(tab)}, 'top'); return true; })()`);
        };
        for (const zoom of ['100', '200']) {
            const at = `390 px, ${zoom}% text: `;
            await ev(`document.documentElement.style.fontSize = ${JSON.stringify(zoom === '200' ? '32px' : '')}; true`);

            console.log(at + 'Files');
            await openTab('files');
            await waitFor(`document.querySelectorAll('#changed-files-list .file-item').length === 5`, at + 'the five changed files', 10000);
            const rows = await ev(`[...document.querySelectorAll('#changed-files-list .file-item')].map(r => { const n = r.querySelector('.file-name'), more = r.querySelector('.file-more-btn'), b = more && (${TOUCH_AREA})(more); return { name: n.textContent, cut: n.scrollWidth > n.clientWidth + 1, more: !!more && b.w >= 43.5 && b.h >= 43.5, label: more && more.getAttribute('aria-label'), actionsShown: getComputedStyle(r.querySelector('.file-action-btns')).display !== 'none' }; })`);
            for (const r of rows) {
                assert.equal(r.cut, false, `${at}${r.name} is shown whole`); assert.ok(r.more, `${at}${r.name} has a 44 px More button`);
                assert.equal(r.actionsShown, false, `${at}${r.name}: Copy, Preview, Edit and Share as artifact are closed`); assert.ok(/^More for /.test(r.label), `${at}named: ${r.label}`);
            }
            await shot(`files-${zoom}`);
            await ev(`document.querySelector('#changed-files-list .file-more-btn').click(); true`);
            await shot(`files-more-${zoom}`);
            const opened = await ev(`(() => { const r = document.querySelector('#changed-files-list .file-item'); const b = r.querySelector('.file-more-btn'), a = r.querySelector('.file-action-btns'), n = r.querySelector('.file-path-wrap').getBoundingClientRect(), ar = a.getBoundingClientRect(); return { expanded: b.getAttribute('aria-expanded'), shown: getComputedStyle(a).display !== 'none' && ar.height > 0, under: ar.top >= n.bottom - 1, buttons: a.querySelectorAll('button').length, inside: ar.right <= innerWidth + 1 }; })()`);
            assert.deepEqual(opened, { expanded: 'true', shown: true, under: true, buttons: 4, inside: true }, at + 'More opens the four (Copy, Preview, Edit, Share as artifact: #10357) on a line under the name');
            await ev(`document.querySelector('#changed-files-list .file-more-btn').click(); true`);
            assert.equal(await ev(`document.querySelector('#changed-files-list .file-more-btn').getAttribute('aria-expanded')`), 'false', at + 'and closes them');

            console.log(at + 'the viewer is a screen of its own');
            await ev(`document.querySelector('#changed-files-list .file-item').click(); true`);
            await waitFor(`document.getElementById('preview-pane').classList.contains('preview-phone-full')`, at + 'the file opens full screen', 8000);
            const full = await ev(`(() => { const p = document.getElementById('preview-pane').getBoundingClientRect(), b = document.getElementById('preview-full-back').getBoundingClientRect(); return { covers: p.left <= 1 && p.right >= innerWidth - 1 && p.height >= innerHeight * 0.9, back: b.width >= 43.5 && b.height >= 43.5, name: document.getElementById('preview-full-back').textContent.trim() }; })()`);
            await shot(`viewer-${zoom}`);
            assert.deepEqual([full.covers, full.back], [true, true], at + 'it covers the screen and has a 44 px Back: ' + JSON.stringify(full));
            const depth = () => ev(`(history.state && history.state.coralOverlay) || 0`);
            assert.equal(await depth(), 1, at + 'the full-screen viewer is one history entry');
            await ev(`history.back(); true`);
            await waitFor(`!document.getElementById('preview-pane').classList.contains('preview-phone-full')`, at + 'one Back closes the viewer', 5000);
            assert.equal(await depth(), 0, at + 'and leaves no entry behind');
            assert.deepEqual(await ev(`(() => { const a = document.activeElement; return { more: !!a && a.classList.contains('file-more-btn'), path: a && a.dataset.path }; })()`), { more: true, path: 'docs/guide.md' }, at + 'Back returns the keyboard to the row that opened the file (its More button)');
            // the list is drawn again on every poll: the focused More button keeps the focus
            await ev(`document.querySelector('#changed-files-list .file-more-btn').focus(); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'changed_files.js').then(m => m.loadChangedFiles('dock-a', 'dock-a-id')).then(() => true)`);
            assert.equal(await ev(`document.activeElement.classList.contains('file-more-btn') && document.activeElement.dataset.path`), 'docs/guide.md', at + 'after the list is drawn again the focus is still on the More button');
            await ev(`import((window.__coralStatic || '/static/') + 'preview_pane.js').then(m => { m.closeAllTabs(); return true; })`);

            console.log(at + 'Browse');
            await openTab('browse');
            await waitFor(`document.querySelectorAll('#file-explorer-view .explorer-item').length === 2`, at + 'the tree', 10000);
            const root = await ev(`(() => { const r = document.querySelector('#file-explorer-view .explorer-root'), a = document.querySelector('#file-explorer-view .team-artifact-actions'), rb = r.getBoundingClientRect(), ab = a.getBoundingClientRect(), lh = parseFloat(getComputedStyle(r).lineHeight) || parseFloat(getComputedStyle(r).fontSize) * 1.3; return { text: r.textContent, title: r.title, oneLine: rb.height <= lh * 1.6, apart: ab.top >= rb.bottom - 1 || ab.left >= rb.right - 1 }; })()`);
            await shot(`browse-${zoom}`);
            assert.equal(root.text, 'queue-service', at + "the folder's name (the stack's Browse header), not its path"); assert.equal(root.title, ROOT, at + 'the whole path is its title');
            assert.ok(root.oneLine && root.apart, at + 'one line, and the buttons do not sit on its words: ' + JSON.stringify(root));

            console.log(at + 'Activity');
            await openTab('activity');
            await ev(`import((window.__coralStatic || '/static/') + 'agentic_state.js').then(m => m.loadAgentEvents('dock-a', 'dock-a-id')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#agentic-state-events .event-item').length === 3`, at + 'the events', 10000);
            const act = await ev(`(() => { const items = [...document.querySelectorAll('#agentic-state-events .event-item')]; const pills = [...document.querySelectorAll('.activity-chart-mode button')];
                return { cut: items.map(i => { const s = i.querySelector('.event-summary'); return s.scrollWidth > s.clientWidth + 1 || s.scrollHeight > s.clientHeight + 1; }), under: items.map(i => { const s = i.querySelector('.event-summary').getBoundingClientRect(), t = i.querySelector('.event-time').getBoundingClientRect(); return t.top >= s.bottom - 1; }),
                    pills: pills.map(p => { const r = p.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }) }; })()`);
            await shot(`activity-${zoom}`);
            if (zoom === '200') { assert.deepEqual(act.cut, [false, false, false], at + 'every summary keeps its words'); assert.deepEqual(act.under, [true, true, true], at + 'the time is under the summary'); }
            if (act.pills.length) for (const [w, h] of act.pills) assert.ok(w >= 43 && h >= 43, `${at}the Time and Count switch is 44 px: ${w}x${h}`);

            console.log(at + 'the tab strip shows the open tab');
            await openTab('agent-ui');
            const strip = await ev(`(() => { const t = document.getElementById('agentic-tab-agent-ui'), s = t.parentElement; const tr = t.getBoundingClientRect(), sr = s.getBoundingClientRect(); return { active: t.classList.contains('active'), inside: tr.left >= sr.left - 1 && tr.right <= sr.right + 1 }; })()`);
            assert.deepEqual(strip, { active: true, inside: true }, at + 'the open tab is wholly inside its strip');
        }
        console.log('PASS agent dock on a phone and at 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
