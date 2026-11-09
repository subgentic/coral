// An edit made in Dropbox that became the newest version (#14714, auto-sync), as a person sees it at 1280 and 390: the version list says "Edited
// in Dropbox" on that version (and not on the others), and the file's own Dropbox block offers Undo this edit, whose confirm says the edit stays in
// Dropbox's history, opens on Cancel, sends the confirm, and is gone once the newest version is no longer an edit. The server's answers are the
// page's fetch (artifact_versions_stub, with v3 marked edited in Dropbox). Screenshots go to CORAL_SCREENSHOT_DIR. Drives Chrome over CDP through
// agent_view_harness.js against the isolated dev server.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await sleep(300); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${name}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const inner = window.fetch; window.__undo = []; window.__state = { connected: true, in_dropbox: 0, removed: false, undo: true };
                const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                    if (/\\/api\\/artifacts\\/[0-9a-f]{64}\\/versions$/.test(p)) return inner(u, o).then(r => r.json()).then(rows => json(rows.map(r => r.version === 3 ? { ...r, edited_in_dropbox: true, uploader: 'unknown writer in Dropbox', role: '' } : r)));
                    if (p === '/api/dropbox/artifact/${H3}') return json(window.__state);
                    if (p === '/api/dropbox/undo/${H3}' && m === 'POST') { window.__undo.push(o.body); window.__state = { connected: true, in_dropbox: 0, removed: false, undo: false }; return json({ undone: true }); }
                    return inner(u, o); };
                return true; })()`);

            console.log(`${tag}: the version list`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer('${H3}', { filename: 'release-plan.md' }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .av-current')`, 'the version bar', 8000);
            await ev(`document.querySelector('#artifact-viewer .av-current').click(); true`);
            await waitFor(`!!document.querySelector('#artifact-viewer .av-option[data-version="3"]')`, 'the list', 4000);
            const who = await ev(`[...document.querySelectorAll('#artifact-viewer .av-option')].map(o => o.dataset.version + ':' + (o.querySelector('.av-who') || {}).textContent)`);
            check(`${tag}: v3 says Edited in Dropbox`, who.some(x => /^3:Edited in Dropbox · /.test(x)), JSON.stringify(who));
            check(`${tag}: the other versions do not`, who.filter(x => !x.startsWith('3:')).every(x => !/Dropbox/.test(x)), JSON.stringify(who));
            check(`${tag}: no sideways scroll with the list open`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-edited-version-${w}`);
            await ev(`document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.closeArtifactViewer ? window.closeArtifactViewer() : (document.getElementById('artifact-viewer').hidden = true); true`);

            console.log(`${tag}: Undo this edit`);
            await ev(`(async () => { const m = await import(${S} + 'artifact_dropbox.js');
                const host = document.createElement('div'); host.id = 'dbx-host'; host.className = 'detail-details';
                host.style.cssText = 'position:fixed;inset:auto 0 0 0;max-height:80vh;overflow:auto;padding:16px;background:var(--bg-secondary,#222);z-index:99999';
                document.body.append(host);
                let shown = null; const block = m.dropboxBlock('${H3}', 'local', { onShown: fn => { shown = fn; }, remove: b => b.remove() });
                host.append(block); await shown(); window.__block = block; return true; })()`);
            await waitFor(`/This version is an edit made in Dropbox/.test(window.__block.textContent)`, 'the block', 6000);
            const btn = t => `Array.from(window.__block.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(t)})`;
            check(`${tag}: Undo this edit is offered for the newest version from Dropbox`, await ev(`!!${btn('Undo this edit…')}`));
            await ev(`${btn('Undo this edit…')}.focus(); ${btn('Undo this edit…')}.click(); true`);
            check(`${tag}: the confirm says the edit stays in Dropbox's history`, await ev(`/This removes the edited version here\\. The edit stays in your Dropbox history\\./.test(window.__block.textContent)`));
            check(`${tag}: it opens with the keyboard on Cancel`, (await ev(`document.activeElement && document.activeElement.textContent`)) === 'Cancel');
            check(`${tag}: no sideways scroll`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-undo-confirm-${w}`);
            await ev(`${btn('Undo this edit')}.click(); true`);
            await waitFor(`/The edit was undone/.test(window.__block.textContent) || !window.__block.isConnected`, 'the answer', 6000);
            check(`${tag}: it sent the confirm once`, (await ev(`window.__undo.join('|')`)) === '{"confirm":true}', await ev(`window.__undo.join('|')`));
            check(`${tag}: Undo is gone once the newest is not an edit`, await ev(`!window.__block.isConnected || !${btn('Undo this edit…')}`));
            await ev(`document.getElementById('dbx-host').remove(); true`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Dropbox edit version checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
