// #18645: Compare shows its changes in red and green (the viewer's .av-add / .av-del): Source changes tints added and removed lines, Rendered side by side tints the blocks only one version has, with a text label too. Both themes, 390 and 1440.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    const tinted = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const c = getComputedStyle(e).backgroundColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; })()`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, height, mobile] of [[390, 844, true], [1440, 900, false]]) for (const theme of ['light', 'dark']) {
            await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await install(); await coralReady(ev); await setTheme(ev, theme);
            const at = `${width}-${theme}`;
            await ev(`(() => {
                const real = window.fetch;
                window.fetch = (u, opts) => {
                    const p = new URL(String(u), location.origin).pathname;
                    if (p.startsWith('/api/artifacts/') && p.endsWith('/versions')) return Promise.resolve(new Response(JSON.stringify([{ version: 1, digest: 'a'.repeat(64), at: '2026-11-14T21:10:00Z', role: 'Orchestrator' }, { version: 2, digest: 'b'.repeat(64), at: '2026-11-14T21:40:00Z', role: 'operator' }]), { status: 200, headers: { 'content-type': 'application/json' } })); // a real series: a same-name guess offers no Compare (#18644)
                    if (p.startsWith('/api/artifacts/')) return Promise.resolve(new Response(p.includes('bbbb') ? '# Notes\\n\\nSame paragraph.\\n\\nNext meeting: Friday\\n' : '# Notes\\n\\nSame paragraph.\\n\\nOld line to drop\\n', { headers: { 'content-type': 'text/markdown' } }));
                    return real(u, opts);
                }; return true;
            })()`);
        await ev(`import((window.__coralStatic || '/static/') + 'artifact_version_list.js').then(m => m.openVersionList({ hex: '${'b'.repeat(64)}', server: '', board: 'version-list-18645', name: 'sample-notes.md', current: { hex: '${'b'.repeat(64)}', at: '2026-11-14T21:40:00Z', role: 'operator' }, earlier: Array.from({ length: 5 }, (_, i) => ({ hex: '${'a'.repeat(64)}', at: '2026-11-14T21:' + (10+i) + ':00Z', produced_by: 'Orchestrator' })), open() {} })).then(() => true)`);
            await ev(framesJs(3));
            await ev(`document.querySelector('.version-list-entry:last-child .version-list-compare').click(); true`);
            await waitFor(`!!document.querySelector('.version-compare-source')`, 'source changes');
            assert.ok(await ev(`!!document.querySelector('.version-compare-source .av-add ins') && !!document.querySelector('.version-compare-source .av-del del')`), `${at}: source lines carry the viewer's add and remove marks`);
            assert.ok(await ev(tinted('.version-compare-source .av-add')) && await ev(tinted('.version-compare-source .av-del')), `${at}: added and removed source lines are tinted`);
            assert.ok(await ev(`document.querySelector('.version-compare-source .av-add .sr-only').textContent === 'Added: ' && document.querySelector('.version-compare-source .av-del .sr-only').textContent === 'Removed: '`), `${at}: the marks are also said in words`);
            await shot(`source-${at}`);
            await ev(`[...document.querySelectorAll('.version-compare-tools button')].find(b => b.textContent === 'Rendered side by side').click(); true`);
            await waitFor(`document.querySelectorAll('.version-compare-preview .prose').length === 2 && !!document.querySelector('.version-compare-preview .av-add')`, 'rendered blocks marked');
            const r = await ev(`(() => { const [o, n] = [...document.querySelectorAll('.version-compare-preview')]; const txt = e => e ? e.textContent : ''; return { add: txt(n.querySelector('.av-add')), del: txt(o.querySelector('.av-del')), addsInOld: o.querySelectorAll('.av-add').length, delsInNew: n.querySelectorAll('.av-del').length, marked: n.querySelectorAll('.av-add').length + o.querySelectorAll('.av-del').length }; })()`);
            assert.ok(r.add.includes('Next meeting: Friday') && r.add.startsWith('Added: '), `${at}: the new block is marked added, in words too: ${JSON.stringify(r)}`);
            assert.ok(r.del.includes('Old line to drop') && r.del.startsWith('Removed: '), `${at}: the dropped block is marked removed: ${JSON.stringify(r)}`);
            assert.equal(r.marked, 2, `${at}: the unchanged heading and paragraph are not marked`);
            assert.equal(r.addsInOld + r.delsInNew, 0, `${at}: adds show only in the newer pane, removals only in the older`);
            assert.ok(await ev(tinted('.version-compare-preview .av-add')) && await ev(tinted('.version-compare-preview .av-del')), `${at}: the marked blocks are tinted`);
            await ev(framesJs(3)); await shot(`rendered-${at}`);
        }
        console.log('version_compare_marks: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
