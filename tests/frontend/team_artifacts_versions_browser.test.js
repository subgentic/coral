// #11700: the Artifacts list is one row per file (the newest version, a note of how many earlier ones), asked with versions=newest; a computer on an older Coral that refuses the word is asked again without it (stubbed data).
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
    const boot = async old => {
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await ev(`(async () => {
            const {state} = await import((window.__coralStatic||'/static/')+'state.js');
            const files = await import((window.__coralStatic||'/static/')+'changed_files.js');
            state.currentSession = { type:'live', name:'test-ui', session_id:'ui-a', board_project:'design-team' };
            const {showView} = await import((window.__coralStatic||'/static/')+'utils.js'); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = '680px';
            const row = (n, name, extra) => ({ id: n.repeat(64), name, media_type: 'image/png', size: 100, task_id: 5, task_title: 'Design', created_at: '2026-10-31T10:00:00Z', uri: 'coral://artifacts/' + n.repeat(64), available: true, inline: false, source: 'task', reference_count: 1, ...extra });
            window.__urls = [];
            const real = window.fetch;
            window.fetch = async (url, options) => {
                const u = String(url);
                if (u.includes('/api/board/') && u.includes('/artifacts?')) {
                    window.__urls.push(u);
                    if (${old} && u.includes('versions=')) return new Response(JSON.stringify({ error: 'unknown parameter versions' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    const sid = new URL(u, location.origin).searchParams.get('session_id') || undefined;
                    const rows = [row('a', 'design.png', ${old} ? {} : { earlier_versions: 2 }), row('b', 'mockup.png', ${old} ? {} : { earlier_versions: 1 }), row('c', 'notes.png', {})];
                    return new Response(JSON.stringify({ session_id: sid, project: 'design-team', artifacts: rows, total: 3, all: 3, limit: 50, offset: 0, has_more: false }), { headers: { 'Content-Type': 'application/json' } });
                }
                if (u.includes('/api/')) return new Response(JSON.stringify({ files: [] }), { headers: { 'Content-Type': 'application/json' } });
                return real(url, options);
            };
            files.initFileSearch(); files.syncFilesViewerSession();
        })()`);
        await ev(`localStorage.removeItem('coral-agentic-tab-top'); document.getElementById('agentic-tab-artifacts').click()`);
        await until(`document.querySelectorAll('${ROWS}').length === 3`);
    };
    const notes = () => ev(`[...document.querySelectorAll('${ROWS}')].map(r => [r.querySelector('.dt-primary').textContent, (r.querySelector('.team-artifact-badge') || {}).textContent || ''])`);
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });

        console.log('1. The list asks for one row per file, and a file with earlier versions says how many');
        await boot(false);
        const urls = await ev('window.__urls');
        assert.ok(urls.length >= 1 && urls.every(u => /[?&]versions=newest/.test(u)), 'every list read asks for versions=newest: ' + JSON.stringify(urls));
        assert.deepEqual(await notes(), [['design.png', '2 earlier versions'], ['mockup.png', '1 earlier version'], ['notes.png', '']]);
        assert.equal(await ev(`document.querySelector('${ROWS} .team-artifact-badge-received, ${ROWS} .team-artifact-badge-unverified, ${ROWS} .team-artifact-badge-shared')`), null, 'the version note is not an origin badge');
        await shot('versions-desktop');

        console.log('2. A computer that refuses the word is asked again without it, and its list shows whole');
        await boot(true);
        const old = await ev('window.__urls');
        assert.ok(/versions=newest/.test(old[0]), 'asked with it first: ' + JSON.stringify(old));
        assert.ok(old.some(u => !/versions=/.test(u)), 'and a read without it follows: ' + JSON.stringify(old)); // (two loads may start together: each asks with it, then without)
        assert.deepEqual(await notes(), [['design.png', ''], ['mockup.png', ''], ['notes.png', '']]);
        console.log('PASS');
    } catch (e) {
        console.error(e && e.stack || e);
        process.exitCode = 1;
    } finally {
        try { await client.close(); } catch (_) {}
    }
})();
