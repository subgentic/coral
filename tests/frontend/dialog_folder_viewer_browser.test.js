// #9489 (the visual audit part 2, items 1 and 6): the artifact viewer follows the dialog rule (no Close X; a Close button at its foot, Escape) and the folder field's Browse button sits in one place with one label:
// at the input's right, in New agent, New team and Open folder alike. 1280 and 390 px. The artifact's bytes are stubbed at the page's fetch; the rest is the real server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const MD_HEX = 'b'.repeat(64);
const MD = '# Report title\n\nSome **bold** text.\n\n## A second heading\n\n- one\n- two\n';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // the folder row's input and Browse: one row, Browse at the right
    const row = (input, button) => ev(`(() => { const i = document.getElementById(${JSON.stringify(input)}), b = document.getElementById(${JSON.stringify(button)}); if (!i || !b || !i.getClientRects().length) return null; const a = i.getBoundingClientRect(), c = b.getBoundingClientRect(); return { sameRow: Math.abs(a.top + a.height / 2 - (c.top + c.height / 2)) < 6, right: c.left >= a.right - 1, text: b.textContent.trim() }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            // 1. the viewer: no X, Close at the foot
            await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o) => { if (String(u && u.url || u).includes('/api/artifacts/${MD_HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="report.md"' } })); return R(u, o); }; return true; })()`);
            await ev(`(async () => { const u = await import((window.__coralStatic || '/static/') + 'utils.js'); const b = await import((window.__coralStatic || '/static/') + 'board_artifacts.js'); const box = document.createElement('div'); box.id = 'qa-9489'; box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:5'; box.innerHTML = '<div class="mb-message-body">' + u.renderMarkdown('[report.md](coral://artifacts/${MD_HEX})') + '</div>'; document.body.appendChild(box); b.resolveBoardArtifacts(box, 'local'); return true; })()`);
            await waitFor(`!!document.querySelector('#qa-9489 a.board-artifact-link[href^="/api/artifacts/"]')`, at + 'the artifact link', 8000);
            await ev(`document.querySelector('#qa-9489 a.board-artifact-link').click(); true`);
            await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden])')`, at + 'the viewer', 8000);
            const v = await ev(`(() => { const d = document.getElementById('artifact-viewer'), c = d.querySelector('.artifact-viewer-close'), box = d.querySelector('.artifact-viewer-content').getBoundingClientRect(), r = c.getBoundingClientRect(); return { text: c.textContent.trim(), inHeader: !!c.closest('.artifact-viewer-header'), atFoot: r.bottom <= box.bottom + 1 && r.top > box.top + box.height / 2, xs: [...d.querySelectorAll('button')].filter(b => /^[✕×x]$/i.test(b.textContent.trim())).length }; })()`);
            assert.deepEqual([v.text, v.inHeader, v.atFoot, v.xs], ['Close', false, true, 0], at + 'the viewer has a Close button at its foot and no X: ' + JSON.stringify(v));
            await shot(`viewer-${w}`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await waitFor(`!document.querySelector('#artifact-viewer:not([hidden])')`, at + 'Close closes the viewer', 8000);
            // 2. Browse: New agent and New team step 1, and Open folder
            await ev(`window.showLaunchModal(); true`); await waitFor(`!!document.getElementById('launch-modal') && getComputedStyle(document.getElementById('launch-modal')).display !== 'none'`, at + 'the chooser', 8000);
            await ev(`(() => { const c = [...document.querySelectorAll('#launch-modal button')].find(b => /new agent/i.test(b.textContent)); c.click(); return true; })()`);
            await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, at + 'New agent step 1', 8000);
            const a = await row('launch-dir', 'btn-browse');
            assert.ok(a && a.sameRow && a.right && a.text === 'Browse', at + 'New agent: Browse is at the folder input\'s right: ' + JSON.stringify(a));
            await shot(`launch-agent-${w}`);
            await ev(`document.querySelector('#launch-modal .launch-back-btn, #launch-agent-back, [data-on-click="m-select-launch-type"][data-arg="back"]').click(); true`);
            await ev(`(() => { const c = [...document.querySelectorAll('#launch-modal button')].find(b => /new team/i.test(b.textContent)); if (c) c.click(); return true; })()`);
            await waitFor(`!!document.getElementById('launch-team-dir') && document.getElementById('launch-team-dir').getClientRects().length > 0`, at + 'New team step 1', 8000);
            const t = await row('launch-team-dir', 'btn-browse-team');
            assert.ok(t && t.sameRow && t.right && t.text === 'Browse', at + 'New team: the same: ' + JSON.stringify(t));
            await shot(`launch-team-${w}`);
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); window.showOpenFolderModal(); true`);
            await waitFor(`!!document.getElementById('open-folder-modal') && getComputedStyle(document.getElementById('open-folder-modal')).display !== 'none'`, at + 'Open folder', 8000);
            const o = await row('open-folder-dir', 'open-folder-browse');
            assert.ok(o && o.sameRow && o.right && o.text === 'Browse', at + 'Open folder: the same: ' + JSON.stringify(o));
            assert.equal(await ev(`document.querySelector('label[for="open-folder-dir"]').textContent.trim()`), 'Folder', at + 'its label has no colon');
            await shot(`open-folder-${w}`);
        }
        console.log('PASS viewer without an X and one Browse placement');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
