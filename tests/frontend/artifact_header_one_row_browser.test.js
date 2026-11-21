// #19771 (the Operator: "Too much of the document is getting cut off here. Lets get this all in the top line."): the document viewer's header is ONE top row on a computer: the name (cut with an ellipsis),
// the version picker with Changes, the status, the file pager, Details and the ⋯ menu. The description (who sent it), the version line ("version 3 of release-plan.md") and the file keys help are in Details; the
// caption row under the header is gone. A phone keeps every control: Previous and Next file are items of the ⋯ menu. The routes are stubbed (artifact_versions_stub). 1280, 1024 and 390 px.
const SHOTS_ONLY = !!process.env.HEADER_SHOTS_ONLY; // the same page on a build without the change: only the pictures (the before shots)
const assert = SHOTS_ONLY ? { equal() {}, ok() {}, match() {} } : require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H2, H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const shown = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [1024, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            const list = JSON.stringify([{ hex: H3, filename: 'release-plan.md' }, { hex: H2, filename: 'release-plan.md' }]);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a', from: 'Developer · sample-project', goal: 'Ship it', goalId: 3, goalTeam: 'team-a', fileId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', versionLine: 'version 3 of release-plan.md (file a1b2c3d4e5f60718293a4b5c6d7e8f90)', lineHex: '${H3}', fileList: ${list}, fileIndex: 0 })).then(() => true)`);
            await waitFor(`!!document.querySelector('.av-current') && !!document.querySelector('.artifact-file-navigation') && !document.querySelector('.artifact-file-navigation').hidden`, at + 'the viewer shows its versions and the file pager', 12000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: layout settles
            await shot(`header-one-row-${w}`);
            if (SHOTS_ONLY) { if (!mobile) { await ev(`document.querySelector('.artifact-viewer-details')?.click(); true`); await new Promise(r => setTimeout(r, 300)); await shot(`header-one-row-details-${w}`); } await ev(`document.querySelector('.artifact-viewer-close').click(); true`); continue; } // sleep-ok: layout settles
            // Nothing the header said under or beside the name is outside Details: no description, no caption.
            assert.equal(await ev(shown('.artifact-viewer-from')), false, at + 'the description is not drawn in the header');
            assert.equal(await ev(shown('.artifact-viewer-versionline')), false, at + 'the caption "version N of <name>" is not drawn under the header');
            assert.equal(await ev(`!!document.querySelector('.artifact-viewer-readers .artifact-viewer-from') && !!document.querySelector('.artifact-viewer-readers .artifact-viewer-versionline') && !!document.querySelector('.artifact-viewer-readers .artifact-file-help')`), true, at + 'the description, the version line and the keys help are in Details');
            assert.equal(await ev(`document.querySelector('.artifact-viewer-header').scrollWidth <= document.querySelector('.artifact-viewer-header').clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1`), true, at + 'no sideways scroll');
            if (!mobile) {
                // One row: the name, the version picker and its arrows, Changes, the pager, Details and ⋯ all sit on the same line.
                const tops = await ev(`(() => { const q = s => { const e = document.querySelector(s); return e && e.getClientRects().length ? Math.round((r => r.top + r.height / 2)(e.getBoundingClientRect()) / 20) : null; }; return { title: q('.artifact-viewer-title'), cur: q('.av-current'), prev: q('.av-prev'), changes: q('.av-since'), pager: q('.artifact-file-navigation'), details: q('.artifact-viewer-details'), more: q('.artifact-viewer-more') }; })()`);
                for (const [k, v] of Object.entries(tops)) assert.ok(v !== null, `${at}${k} is drawn`);
                const cs = Object.values(tops); assert.ok(Math.max(...cs) - Math.min(...cs) <= 1, `${at}the header is one row (centers/20px: ${JSON.stringify(tops)})`);
                assert.equal(await ev(`document.querySelector('.artifact-viewer-header').getBoundingClientRect().height < 80`), true, at + 'the header is one row tall');
                // #20241 (the Operator, with a review waiting): every control a pending review adds (the status 'Read, waiting for your decision', Comments (1), Edit text, Refuse, Approve, Request changes) is on, and the header is STILL one row: nothing wraps under the name, nothing is cut or overlaps.
                await ev(`(() => { const h = document.querySelector('.artifact-viewer-header'); const st = h.querySelector('.artifact-review-state'); st.textContent = 'Read, waiting for your decision'; for (const e of h.querySelectorAll('.artifact-review-state,.artifact-review-approve,.artifact-review-changes,.artifact-review-refuse,.artifact-viewer-edit,.ac-toggle,.artifact-viewer-details')) e.hidden = false; document.querySelector('.artifact-viewer').dataset.reviewPending = '1'; for (const e of document.querySelectorAll('.artifact-review-refuse-item,.artifact-viewer-edit-item')) e.hidden = false; const t = h.querySelector('.ac-toggle'); if (t) t.textContent = 'Comments (1)'; return true; })()`);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: layout settles
                await shot(`header-one-row-review-${w}`);
                const full = await ev(`(() => { const h = document.querySelector('.artifact-viewer-header'); const hr = h.getBoundingClientRect(); const kids = [...h.children].filter(e => e.getClientRects().length && getComputedStyle(e).position !== 'absolute'); const rows = new Set(); const items = []; for (const k of kids) for (const b of (k.matches('.artifact-viewer-actions,.artifact-viewer-chips,.artifact-viewer-morewrap') ? [...k.querySelectorAll(':scope > *, :scope > .av-bar > *')] : [k])) { const r = b.getBoundingClientRect(); if (!b.getClientRects().length || !r.width) continue; rows.add(Math.round((r.top + r.height / 2) / 20)); items.push({ c: b.className.split(' ')[0], l: Math.round(r.left), r: Math.round(r.right) }); } return { h: Math.round(hr.height), rows: rows.size, over: items.filter(i => i.r > hr.right + 1 || i.l < hr.left - 1).map(i => i.c) }; })()`);
                await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
                await waitFor(shown('.artifact-review-refuse-item'), at + 'Refuse is an item of the menu', 3000);
                assert.equal(await ev(`['.artifact-review-refuse-item', '.artifact-viewer-edit-item'].every(q => { const e = document.querySelector(q); return e && e.getClientRects().length > 0; }) && !document.querySelector('.artifact-review-refuse').getClientRects().length`), true, at + 'Refuse and Edit text are items of the ⋯ menu while a decision waits (and the Refuse button is not drawn)');
                await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
                if (w >= 1280) assert.equal(await ev(`(e => e.scrollWidth <= e.clientWidth + 1)(document.querySelector('.artifact-review-state'))`), true, at + 'the whole status words are shown, not cut');
                assert.ok(full.h < 80 && full.rows === 1 && !full.over.length, `${at}with a review waiting the header is one row, nothing cut: ${JSON.stringify(full)}`);
                // The description and the keys help show in Details.
                await ev(`document.querySelector('.artifact-viewer-details').click(); true`);
                await waitFor(shown('.artifact-viewer-from'), at + 'Details shows the description', 3000);
                assert.match(await ev(`document.querySelector('.artifact-viewer-from').textContent`), /Developer/, at + 'the description is the sender');
                assert.match(await ev(`document.querySelector('.artifact-viewer-versionline').textContent`), /^version 3 of release-plan\.md/, at + 'the version line is in Details');
                await ev(`document.querySelector('.artifact-file-help').click(); true`);
                assert.match(await ev(`document.querySelector('.artifact-file-help-text').textContent`), /Left.*Right/, at + 'the keys help is under ?');
                await shot(`header-one-row-details-${w}`);
            } else {
                // A phone: the pager is not a row; Previous and Next are items of ⋯, the position is in Details.
                assert.equal(await ev(shown('.artifact-file-navigation')), false, at + 'no pager row on a phone');
                await ev(`document.querySelector('.artifact-viewer-more').click(); true`);
                await waitFor(shown('.artifact-file-next-item'), at + 'Next file is an item of ⋯', 3000);
                assert.equal(await ev(`document.querySelector('.artifact-file-prev-item').disabled`), true, at + 'Previous file is disabled on the first file');
                assert.equal(await ev(`document.querySelector('.artifact-file-next-item').disabled`), false, at + 'Next file is on');
                await shot(`header-one-row-menu-${w}`);
                await ev(`document.querySelector('.artifact-file-next-item').click(); true`);
                await waitFor(`document.querySelector('.artifact-file-position').textContent === '2 of 2'`, at + 'Next file moved to the second file', 8000);
            }
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
        }
        console.log('PASS the viewer header is one row on a computer (name, versions, Changes, status, pager, Details, ⋯), the description, version line and keys help are in Details, a phone has Previous and Next in ⋯');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
