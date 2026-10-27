// #4396: the Artifacts table says where a row came from (stubbed data; it does not wait for the server side of C1); the agent's tab is the team page's table since #7622, the details are in the sheet a row opens.
//  - provenance "unverified": the link text with "Link not verified", no size, no type; its sheet says why and has no Open, Download or Copy link; never merged with a real row of the same id
//  - source "shared": "Sent to <server>/<board>"; source "received": "From <server>", "not scanned" in the sheet; neither shows a producer
//  - a legacy row (no provenance) renders as before: a missing object has no actions
//  - the words are in the page (screen readers read them with the name), the rows keep their keyboard order, and the table fits a 390 px phone at 200% text
// Run against an isolated Coral dev server and headless Chrome via CDP. CORAL_SCREENSHOT_DIR=<dir> saves screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const SHOTS = process.env.CORAL_SCREENSHOT_DIR;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => {
        const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const settle = () => ev('new Promise(resolve => setTimeout(resolve, 250))'); // sleep-ok: the panel rebuilds after the stubbed list answers; there is no completion event
    const shot = async name => {
        if (!SHOTS) return;
        fs.mkdirSync(SHOTS, { recursive: true });
        const { data } = await Page.captureScreenshot({ format: 'png' });
        fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
    };
    const ROWS = '#agentic-panel-artifacts-view tbody tr';
    const rowOf = name => `[...document.querySelectorAll('${ROWS}')].find(r => r.querySelector('.dt-primary').textContent === ${JSON.stringify(name)})`;
    const until = async expr => { for (let i = 0; i < 300; i++) { if (await ev(expr)) return; await ev('new Promise(r => setTimeout(r, 20))'); } throw new Error('timed out waiting for ' + expr); };
    // open a row's sheet and read it: its facts as label/value, its actions, whether it is open
    const sheetOf = async name => {
        await ev(`(${rowOf(name)}).querySelector('.artifact-details').click(); true`);
        await until(`!document.getElementById('agentic-detail-pane').hidden && document.querySelector('#agentic-detail-pane .detail-title').textContent === ${JSON.stringify(name)}`);
        return ev(`(() => { const a = document.getElementById('agentic-detail-pane'); return { facts: [...a.querySelectorAll('.detail-facts > *')].map(c => c.tagName + ':' + c.textContent), actions: [...a.querySelectorAll('.detail-foot .btn')].map(b => b.textContent) }; })()`);
    };
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await ev(`(async () => {
            const {state} = await import((window.__coralStatic||'/static/')+'state.js');
            const files = await import((window.__coralStatic||'/static/')+'changed_files.js');
            state.currentSession = { type:'live', name:'test-ui', session_id:'ui-a', board_project:'design-team' };
            const {showView} = await import((window.__coralStatic||'/static/')+'utils.js'); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = '680px';
            const hex = 'a'.repeat(64), other = 'c'.repeat(64), sent = 'd'.repeat(64), got = 'e'.repeat(64);
            window.__items = [
                { id: hex, name: 'Design review.md', media_type: 'text/markdown', size: 1800, task_id: 11, task_title: 'Review', created_at: '2026-10-02T15:00:00Z', uri: 'coral://artifacts/' + hex, available: true, source: 'completion', provenance: 'uploaded', produced_by: 'Worker A', session_id: 'w-a' },
                { id: 'uri:coral://artifacts/' + hex, name: 'Design review.md', task_id: 12, task_title: 'Cites the same id', created_at: '2026-10-02T15:10:00Z', uri: 'coral://artifacts/' + hex, available: false, source: 'completion', provenance: 'unverified' },
                { id: 'uri:coral://artifacts/' + other, name: "Another team's report.pdf", task_id: 13, created_at: '2026-10-02T15:20:00Z', uri: 'coral://artifacts/' + other, available: false, source: 'completion', provenance: 'unverified' },
                { id: 'shared:' + sent + ':1', name: 'Test report.txt', media_type: 'text/plain', size: 900, task_id: 0, created_at: '2026-10-02T16:00:00Z', uri: 'coral://artifacts/' + sent, available: true, source: 'shared', shared_to: 'homelab/qa', sent_by: 'Orchestrator', produced_by: null, session_id: null },
                { id: 'received:' + got, name: 'Their logs.txt', media_type: 'text/plain', size: 2048, task_id: 0, created_at: '2026-10-02T17:00:00Z', uri: 'coral://artifacts/' + got, available: true, source: 'received', received_from: 'homelab (ab12cd34)', from_board: 'platform', also_received_from: ['laptop (cd34ef56)/platform', 'office-mac-studio (12ab34cd)/design-review-board', 'cloud-runner-17 (99aa88bb)/ops'], sent_by: 'Orchestrator (platform)', produced_by: null, session_id: null },
                { id: hex.replace(/a/g, 'b'), name: 'Their logs (cited).txt', media_type: 'text/plain', size: 2048, task_id: 14, created_at: '2026-10-02T17:30:00Z', uri: 'coral://artifacts/' + hex.replace(/a/g, 'b'), available: true, source: 'completion', provenance: 'received', produced_by: 'Worker A' },
                { id: 'old', name: 'Earlier screenshot.png', media_type: 'image/png', task_id: 9, created_at: '2026-10-01T10:00:00Z', uri: 'coral://artifacts/' + 'f'.repeat(64), available: false, source: 'completion' },
            ];
            const real = window.fetch;
            window.fetch = async (url, options) => {
                const u = String(url);
                if (u.includes('/api/board/') && u.includes('/artifacts?')) return new Response(JSON.stringify({ session_id: new URL(String(u), location.origin).searchParams.get('session_id') || undefined, project: decodeURIComponent(u.split('/')[3]), artifacts: window.__items, has_more: false, truncated: false }), { headers: { 'Content-Type': 'application/json' } });
                if (u.includes('/api/')) return new Response(JSON.stringify({ files: [] }), { headers: { 'Content-Type': 'application/json' } });
                return real(url, options);
            };
            files.initFileSearch(); files.syncFilesViewerSession();
        })()`);
        await ev(`localStorage.removeItem('coral-agentic-tab-top'); document.getElementById('agentic-tab-artifacts').click()`);
        await until(`document.querySelectorAll('${ROWS}').length === 7`); // every row is listed: the unverified one is not merged into the real row with the same id
        assert.equal(await ev(`document.querySelectorAll('${ROWS}').length`), 7);

        console.log('1. An unverified row says so and offers nothing to open');
        const unvNames = ['Design review.md', "Another team's report.pdf"];
        const unv = await ev(`[...document.querySelectorAll('${ROWS}')].filter(r => r.querySelector('.team-artifact-badge-unverified')).map(r => ({ name: r.querySelector('.dt-primary').textContent, badge: r.querySelector('.team-artifact-badge').textContent, cells: [...r.querySelectorAll('td')].slice(1, 3).map(c => c.textContent), tags: r.querySelectorAll('.dt-tag:not(.team-artifact-badge)').length }))`); // the one-line dock row (#8793): Name, Size, Created; the file type is in the preview, not on the row
        assert.equal(unv.length, 2);
        for (const r of unv) {
            assert.equal(r.badge, 'Link not verified');
            assert.equal(r.cells[0], '—', 'no size'); assert.equal(r.tags, 0, 'no type chip');
        }
        const un = await ev(`(() => { const r = document.querySelector('${ROWS} .team-artifact-badge-unverified').closest('tr'); r.querySelector('.dt-primary').click(); return r.querySelector('.dt-primary').textContent; })()`);
        await until(`document.querySelector('#agentic-detail-pane .detail-title').textContent === ${JSON.stringify(un)}`);
        const unSheet = await ev(`(() => { const a = document.getElementById('agentic-detail-pane'); return { facts: [...a.querySelectorAll('.detail-facts > *')].map(c => c.textContent), actions: a.querySelectorAll('.detail-foot .btn').length }; })()`);
        assert.equal(unSheet.actions, 0, 'nothing to open, download or copy');
        assert.ok(!unSheet.facts.some(f => /MIME|^Size/.test(f)), 'no MIME or size: ' + JSON.stringify(unSheet.facts));
        assert.ok(unSheet.facts.some(f => /this team has not uploaded|Link not verified/.test(f)), 'the sheet says why: ' + JSON.stringify(unSheet.facts));
        await shot('origin-desktop');

        console.log('2. The real row with the same id is still managed');
        const real = await sheetOf('Design review.md').catch(() => null);
        const realRow = await ev(`(() => { const r = [...document.querySelectorAll('${ROWS}')].find(r => r.querySelector('.dt-primary').textContent === 'Design review.md' && !r.querySelector('.team-artifact-badge')); return r ? { size: r.querySelectorAll('td')[1].textContent, tags: r.querySelectorAll('.dt-tag:not(.team-artifact-badge)').length, badge: false } : null; })()`);
        assert.ok(realRow && /\d/.test(realRow.size) && realRow.size !== '—' && realRow.tags === 0 && realRow.badge === false, 'a real file shows its size and no type chip on the one-line row: ' + JSON.stringify(realRow));
        void real;

        console.log('3. A shared row and a received row are labelled and never show a producer');
        const shRow = await ev(`${rowOf('Test report.txt')}.querySelector('.team-artifact-badge').textContent`);
        assert.equal(shRow, 'Sent to homelab/qa');
        const sh = await sheetOf('Test report.txt');
        assert.ok(sh.actions.includes('Open') && sh.actions.includes('Download'), 'it opens: ' + sh.actions);
        const shText = sh.facts.join('|');
        assert.doesNotMatch(shText, /Producer/); assert.match(shText, /DT:Sent to\|DD:homelab\/qa/); assert.match(shText, /DT:Sent by\|DD:Orchestrator/);
        assert.equal(await ev(`${rowOf('Their logs.txt')}.querySelector('.team-artifact-badge').textContent`), 'From homelab (ab12cd34)');
        const rc = await sheetOf('Their logs.txt');
        assert.ok(rc.actions.includes('Open'));
        const rcText = rc.facts.join('|');
        assert.doesNotMatch(rcText, /Producer/);
        assert.match(rcText, /DT:Board \(claimed by the sender\)\|DD:platform/); assert.match(rcText, /DT:Checked\|DD:Not scanned/); assert.match(rcText, /DT:Sent by\|DD:Orchestrator \(platform\)/);
        // A file received again from other Corals lists each later sender on a line of its own, worded as the first
        // source is, after the Board line (#4454 item 3).
        const at = rc.facts.indexOf('DT:Also received from'), board = rc.facts.indexOf('DT:Board (claimed by the sender)');
        assert.ok(at > 0 && at > board, 'Also received from comes after the Board line: ' + JSON.stringify(rc.facts));
        assert.deepEqual(rc.facts.slice(at + 1, at + 2), ['DD:laptop (cd34ef56), board platform (claimed by the sender)\noffice-mac-studio (12ab34cd), board design-review-board (claimed by the sender)\ncloud-runner-17 (99aa88bb), board ops (claimed by the sender)']);

        assert.equal(await ev(`${rowOf('Their logs (cited).txt')}.querySelector('.team-artifact-badge').textContent`), 'Received file', 'a task result citing a received file is labelled');
        assert.ok((await sheetOf('Their logs (cited).txt')).actions.includes('Open'), 'and still opens');

        console.log('4. A legacy row renders as before');
        assert.equal(await ev(`!!${rowOf('Earlier screenshot.png')}.querySelector('.team-artifact-badge')`), false);
        assert.equal((await sheetOf('Earlier screenshot.png')).actions.length, 0, 'a missing object has no actions');

        console.log('5. The words are in the page for a screen reader, and the keyboard order is unchanged');
        const ax = await ev(`(() => { const r = ${rowOf('Their logs.txt')}; const b = r.querySelector('.team-artifact-badge'); return { hidden: !!b.closest('[aria-hidden=true]'), after: !!(r.querySelector('.dt-primary').compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
        assert.equal(ax.hidden, false); assert.equal(ax.after, true);
        const stops = await ev(`[...document.querySelectorAll('${ROWS}')].map(r => r.querySelectorAll('button, a[href], summary').length - r.querySelectorAll('[data-task-link]').length)`);
        assert.ok(stops.every(n => n === 2), 'every row has two stops, its name and its Details link, and a third when the file has a task (its Task link, #8617): ' + JSON.stringify(stops));
        await ev(`document.querySelector('#agentic-detail-pane .detail-close').click(); true`);

        console.log('6. A 390 px phone at 200% text: the table fits and the words stay in their row');
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await ev(`document.getElementById('agentic-state').style.width = ''; document.documentElement.style.fontSize = '32px'; (document.getElementById('popout-panel-toggle-btn') || document.getElementById('panel-toggle-btn')).click(); true`); await settle();
        await ev(`window.switchAgenticTab('artifacts', 'top'); true`); await settle();
        assert.ok(await ev(`[...document.querySelectorAll('.team-artifact-badge')].filter(b => b.getBoundingClientRect().width > 0).length`) >= 4, 'the badges are on screen on the phone (the drawer is open)');
        const fit = await ev(`(() => { const s = document.querySelector('#agentic-panel-artifacts-view .dt-box'); const sr = s.getBoundingClientRect(); const out = [...document.querySelectorAll('#agentic-panel-artifacts-view .team-artifact-badge')].filter(b => { const r = b.getBoundingClientRect(); return r.right > sr.right + 1 || r.left < sr.left - 1; }).length; return { fits: s.scrollWidth <= s.clientWidth + 1, docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth, out, badge: parseFloat(getComputedStyle(document.querySelector('.team-artifact-badge')).fontSize) }; })()`);
        assert.equal(fit.fits, true, 'no horizontal scroll in the table'); assert.ok(fit.docOver <= 0, 'no sideways scroll'); assert.equal(fit.out, 0, 'every badge stays inside the table');
        assert.ok(fit.badge >= 20, 'the badge text grows with the root font: ' + fit.badge);
        await shot('origin-phone-200');
        console.log('PASS');
    } catch (e) {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    } finally {
        try { await client.close(); } catch (_) {}
    }
})();
