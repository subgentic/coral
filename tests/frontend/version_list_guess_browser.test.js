// The Versions dialog does not call a same-name guess a series (#18644, #18634): sample-report.md uploaded twice without --new-version-of is two uploads of one name, not v1 and v2.
//   - no series (the file's versions answer 404): the title says "Uploads named", a line says they are not versions of one file, the rows are "Upload" and "Upload (newest)" with Open and nothing else:
//     no v-number, no Compare, no Restore (even when the caller can ask for one);
//   - a real series (the versions answer two rows): v1 and v2 (newest) with Compare with v1 and Restore on v1, as before.
// Driven through agent_view_harness.js against the isolated dev server, at 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const A = 'a'.repeat(64), B = 'b'.repeat(64);
    const entries = () => ev(`[...document.querySelectorAll('.version-list-dialog[open] .version-list-entry')].map(li => ({ name: li.querySelector('.version-list-name').textContent, v: li.dataset.version || null, open: li.querySelector('.version-list-open').getAttribute('aria-label'), compare: li.querySelector('.version-list-compare')?.textContent || null, restore: !!li.querySelector('.version-list-restore') }))`);
    const open = hex => ev(`import((window.__coralStatic || '/static/') + 'artifact_version_list.js').then(m => m.openVersionList({ hex: '${hex}', server: '', board: 'guess-18644', name: 'sample-report.md', current: { hex: '${B}', at: '2026-11-14T21:40:00Z', produced_by: 'Writer' }, earlier: [{ hex: '${A}', at: '2026-11-14T21:10:00Z', produced_by: 'Writer' }], open() {}, restore: async () => {} })).then(() => true)`);
    const close = () => ev(`document.querySelector('.version-list-dialog[open] .inbox-ask-buttons button').click(); true`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const real = window.fetch; window.__series = false;
            window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname;
                if (p.startsWith('/api/artifacts/') && p.endsWith('/versions')) return Promise.resolve(window.__series
                    ? new Response(JSON.stringify([{ version: 1, digest: '${A}', at: '2026-11-14T21:10:00Z', uploader: 'Writer' }, { version: 2, digest: '${B}', at: '2026-11-14T21:40:00Z', uploader: 'Writer' }]), { status: 200, headers: { 'content-type': 'application/json' } })
                    : new Response('{}', { status: 404 }));
                return real(u, o); }; return true; })()`);

        console.log('1. no series: uploads of the same name, no v-numbers, no Compare, no Restore');
        await open(B);
        await waitFor(`document.querySelectorAll('.version-list-dialog[open] .version-list-entry').length === 2`, 'the list rows', 8000);
        assert.equal(await ev(`document.querySelector('.version-list-dialog[open] h2').textContent`), 'Uploads named sample-report.md');
        assert.match(await ev(`document.querySelector('.version-list-dialog[open] .version-list-guess').textContent`), /not versions of one file/);
        const guess = await entries();
        assert.deepEqual(guess.map(e => e.name), ['Upload', 'Upload (newest)']);
        assert.ok(guess.every(e => e.v === null && e.compare === null && !e.restore && /^Open the upload of /.test(e.open)), JSON.stringify(guess));
        assert.ok(!/\bv\d/.test(await ev(`document.querySelector('.version-list-dialog[open]').textContent`)), 'no v-number anywhere in the dialog');
        await close();

        console.log('2. a real series: v1 and v2 (newest) with Compare and Restore, as before');
        await ev(`window.__series = true; true`);
        await open('c'.repeat(64)); // another file's hex: the page reuses one read per file, so the 404 above would answer again
        await waitFor(`document.querySelectorAll('.version-list-dialog[open] .version-list-entry').length === 2`, 'the series rows', 8000);
        assert.equal(await ev(`document.querySelector('.version-list-dialog[open] h2').textContent`), 'Versions of sample-report.md');
        assert.equal(await ev(`document.querySelector('.version-list-dialog[open] .version-list-guess').hidden`), true, 'no guess line over a real series');
        const real = await entries();
        assert.deepEqual(real.map(e => e.name), ['v1', 'v2 (newest)']);
        assert.equal(real[1].compare, 'Compare with v1');
        assert.deepEqual(real.map(e => e.restore), [true, false]);
        console.log('\nPASS versions dialog: a same-name guess is uploads, a series is versions');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message || e); process.exitCode = 1; });
