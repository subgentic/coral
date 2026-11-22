// #20715 (the Operator: "The top bar for html reviews is not using our single bar that md uses."): a sandboxed HTML file under review has the same ONE header row a Markdown file has, with the
// same buttons in the same order: the name, the version picker, Changes, the status, Comments, Approve, Request changes, the pager, Details, ⋯. Only the Sandboxed label is the HTML file's own.
// The same stubbed three versions as the Markdown header suite, served as HTML for the second file. 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H2, H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // what a person sees on the header: each visible control, in left-to-right, top-to-bottom order, with its row
    const BAR = `(() => { const h = document.querySelector('.artifact-viewer-header'); const out = []; const walk = e => { for (const k of e.children) { if (!k.getClientRects().length || getComputedStyle(k).visibility === 'hidden') continue; if (k.matches('.artifact-viewer-chips,.artifact-viewer-actions,.artifact-viewer-morewrap,.av-bar,.artifact-file-navigation')) { walk(k); continue; } const r = k.getBoundingClientRect(); if (!r.width) continue; out.push({ w: (k.getAttribute('aria-label') || k.textContent || k.className).trim().replace(/\\s+/g, ' ').slice(0, 24), row: Math.round((r.top + r.height / 2) / 20), x: Math.round(r.left), right: Math.round(r.right) }); } }; walk(h); const hr = h.getBoundingClientRect(); return { h: Math.round(hr.height), over: out.filter(i => i.right > hr.right + 1).map(i => i.w), items: out }; })()`;
    const open = async (name, type, hex) => {
        await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${hex}', { filename: '${name}', mediaType: '${type}', board: 'team-a', fileId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', versionLine: 'version 3 of ${name}', lineHex: '${hex}', fileList: ${JSON.stringify([{ hex, filename: name }, { hex: H2, filename: name }])}, fileIndex: 0 })).then(() => true)`);
        await waitFor(`!!document.querySelector('.av-current') && !!document.querySelector('.artifact-viewer-body').textContent`, name + ': the viewer shows its versions and the file', 12000);
        await waitFor(`!!document.querySelector('.artifact-file-navigation') && !document.querySelector('.artifact-file-navigation').hidden`, name + ': the file pager is on', 12000);
        await ev(`(() => { const h = document.querySelector('.artifact-viewer-header'); h.querySelector('.artifact-review-state').textContent = 'Read, waiting for your decision'; for (const e of h.querySelectorAll('.artifact-review-state,.artifact-review-approve,.artifact-review-changes,.ac-toggle,.artifact-viewer-details')) e.hidden = false; document.querySelector('.artifact-viewer').dataset.reviewPending = '1'; const t = h.querySelector('.ac-toggle'); if (t) t.textContent = 'Comments (1)'; return true; })()`);
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: layout settles
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [1024, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            // the second file: HTML bytes for every digest the stub knows
            await ev(`(() => { const f = window.fetch; window.fetch = (u, o) => { if (/\\/api\\/artifacts\\/[0-9a-f]{64}(\\?v=\\d+)?$/.test(String(u)) && window.__asHtml) return Promise.resolve(new Response('<h1>Built usage-limit view</h1><p>Hello</p>', { status: 200, headers: { 'Content-Type': 'text/html' } })); return f(u, o); }; return true; })()`);
            await open('release-plan.md', 'text/markdown', H3);
            const md = await ev(BAR); await shot(`header-md-${w}`);
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
            await ev(`window.__asHtml = true`);
            await open('release-plan.html', 'text/html', H3);
            await waitFor(`!!document.querySelector('.artifact-linked-preview') && !document.querySelector('.artifact-viewer-sandbox').hidden`, at + 'the HTML file is the sandboxed preview, with its chip', 12000);
            const html = await ev(BAR); await shot(`header-html-${w}`);
            const rows = b => new Set(b.items.map(i => i.row)).size;
            if (!mobile) {
                assert.equal(rows(md), 1, at + 'the Markdown header is one row ' + JSON.stringify(md));
                assert.equal(rows(html), 1, at + 'the HTML header is one row ' + JSON.stringify(html));
                assert.ok(html.h < 80, at + 'the HTML header is one row tall: ' + html.h);
            }
            assert.deepEqual(html.over, [], at + 'nothing runs past the HTML header');
            const words = b => b.items.map(i => i.w).filter(x => x !== 'Sandboxed');
            assert.equal(await ev(`(e => !!e && !e.hidden && !!e.closest('.artifact-viewer-menu') && e.textContent === 'Sandboxed')(document.querySelector('.artifact-viewer-sandbox'))`), true, at + 'the Sandboxed label is an item of the ⋯ menu');
            assert.deepEqual(words(html).filter(x => !/^release-plan|^Built/.test(x)), words(md).filter(x => !/^release-plan|^Built/.test(x)), at + 'the same buttons in the same order as Markdown ' + JSON.stringify(words(html)));
            await ev(`document.querySelector('.artifact-viewer-more').click(); true`); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the menu draws
            await shot(`header-html-menu-${w}`);
            await ev(`document.documentElement.setAttribute('data-theme', 'light'); true`); await new Promise(r => setTimeout(r, 200)); // sleep-ok: the theme paints
            await shot(`header-html-light-${w}`); await ev(`document.documentElement.removeAttribute('data-theme'); true`);
            await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
        }
        console.log('PASS an HTML review has the same one header row and buttons as a Markdown review, at 1280 and 390 px');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
