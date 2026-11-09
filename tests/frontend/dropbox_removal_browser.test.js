// The Dropbox removal confirms (Dropbox stage 6a, #14814), as a person sees them at 1280 and 390: an artifact's Remove from Dropbox and Mark private
// and remove confirms, the typed confirm when another Coral keeps the file only in Dropbox, Send to Dropbox again, and Settings' Disconnect and
// delete the backup. Checks: a destructive confirm opens with the keyboard on Cancel (Enter never removes by accident), or on the typed field when one
// is shown, and that field has a label; nothing scrolls sideways; the words say it is for every Coral that uses the backup. The server's answers are the
// page's fetch. Screenshots go to CORAL_SCREENSHOT_DIR for the Operator. Drives Chrome over CDP through agent_view_harness.js against the isolated
// dev server.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await sleep(300); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const hex = 'a'.repeat(64);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(() => { const real = window.fetch; const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
                window.__state = { connected: true, in_dropbox: 2, removed: false }; window.__posts = [];
                window.__dbx = { app_key_set: true, connected: true, state: 'connected', account_id: 'dbid:AAA', backup: { backed_up: 12 }, filters: { types: [], max_age_days: 0 }, retention: { days: 0 } };
                window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                    if (p === '/api/dropbox/artifact/${hex}') return json(window.__state);
                    if (p === '/api/dropbox/remove/${hex}' && m === 'POST') { window.__posts.push('remove'); return json({ code: 'others_offloaded', others: ['a3f2'], unknown: 0, error: 'x' }, 409); }
                    if (p === '/api/dropbox/status') return json(window.__dbx);
                    if (p === '/api/dropbox/disconnect' && m === 'POST') { window.__posts.push('disconnect'); return json({ code: 'confirm_delete_backup', files: 12, foreign: 2, others: ['a3f2'], unknown: 0 }, 409); }
                    return real(u, o); };
                return true; })()`);

            // The artifact's Dropbox block, in a Details panel of the page (the same module and classes the viewer uses).
            await ev(`(async () => { const m = await import(${S} + 'artifact_dropbox.js');
                const host = document.createElement('div'); host.id = 'dbx-host'; host.className = 'detail-details';
                host.style.cssText = 'position:fixed;inset:auto 0 0 0;max-height:80vh;overflow:auto;padding:16px;background:var(--bg-secondary,#222);z-index:99999';
                document.body.append(host);
                let shown = null; const block = m.dropboxBlock('${hex}', 'local', { onShown: fn => { shown = fn; }, remove: b => b.remove() });
                host.append(block); await shown(); window.__block = block; return true; })()`);
            await waitFor(`/In Dropbox \\(2 files/.test(window.__block.textContent)`, 'the block', 6000);
            const btn = t => `Array.from(window.__block.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(t)})`;

            console.log(`${tag}: Remove from Dropbox`);
            await ev(`${btn('Remove from Dropbox…')}.click(); true`);
            check(`${tag}: the Remove confirm says it is for every Coral and stays out until sent again`, await ev(`/for every Coral that uses this backup.*stays out of the backup until you send it again/.test(window.__block.textContent)`));
            check(`${tag}: it opens with the keyboard on Cancel (Enter never removes by accident)`, (await ev(`document.activeElement && document.activeElement.textContent`)) === 'Cancel', await ev(`document.activeElement && document.activeElement.textContent`));
            check(`${tag}: no sideways scroll`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-remove-confirm-${w}`);
            await ev(`${btn('Remove from Dropbox')}.click(); true`);
            await waitFor(`/Another Coral keeps this file only in Dropbox/.test(window.__block.textContent)`, 'the typed confirm', 6000);
            const typed = await ev(`(() => { const i = window.__block.querySelector('input'); return { label: i && i.getAttribute('aria-label'), focused: document.activeElement === i }; })()`);
            check(`${tag}: another Coral's marker asks for the typed last 4, with a labelled field that has the focus`, typed.label && typed.focused, JSON.stringify(typed));
            await shot(`dropbox-remove-typed-${w}`);
            await ev(`${btn('Cancel')}.click(); true`);

            console.log(`${tag}: Mark private and remove`);
            await ev(`${btn('Mark private and remove…')}.click(); true`);
            check(`${tag}: the Mark private confirm says what it does`, await ev(`/Mark it private and remove it from Dropbox for every Coral that uses this backup/.test(window.__block.textContent)`));
            check(`${tag}: and opens on Cancel`, (await ev(`document.activeElement && document.activeElement.textContent`)) === 'Cancel');
            await shot(`dropbox-private-confirm-${w}`);
            await ev(`${btn('Cancel')}.click(); true`);

            console.log(`${tag}: Send to Dropbox again`);
            await ev(`(async () => { window.__state = { connected: true, in_dropbox: 0, removed: true }; window.__block.remove(); const m = await import(${S} + 'artifact_dropbox.js');
                let shown = null; const block = m.dropboxBlock('${hex}', 'local', { onShown: fn => { shown = fn; }, remove: b => b.remove() }); document.getElementById('dbx-host').append(block); await shown(); window.__block = block; return true; })()`);
            await waitFor(`/Removed from Dropbox/.test(window.__block.textContent)`, 'the removed state', 6000);
            check(`${tag}: a removed artifact says it stays out and offers Send to Dropbox again`, await ev(`/stays out of the backup until you send it again/.test(window.__block.textContent) && !!${btn('Send to Dropbox again')}`));
            await shot(`dropbox-send-again-${w}`);
            await ev(`document.getElementById('dbx-host').remove(); true`);

            console.log(`${tag}: Disconnect and delete the backup`);
            await ev(`window.showSettingsModal('cleanup'); true`);
            await waitFor(`!!document.getElementById('settings-dropbox-delete') && !document.getElementById('settings-dropbox-delete').hidden`, 'the delete button', 8000);
            // Settings fills its rows (the Dropbox block among them) before the dialog is shown: a click before then focuses a field nobody can see,
            // which is what failed 3 of 5 under --stress (QA on #14814). A person clicks a shown dialog, after its own focus has moved in.
            await waitFor(`(() => { const m = document.getElementById('settings-modal'); return !!m && getComputedStyle(m).display !== 'none' && m.contains(document.activeElement); })()`, 'Settings shown with the focus in it', 8000);
            await ev(`document.getElementById('settings-dropbox-delete').scrollIntoView({ block: 'center' }); document.getElementById('settings-dropbox-delete').click(); true`);
            await waitFor(`!document.getElementById('settings-dropbox-delete-confirm').hidden`, 'the delete confirm', 6000);
            const del = await ev(`(() => { const b = document.getElementById('settings-dropbox-delete-confirm'), i = document.getElementById('settings-dropbox-delete-typed'); b.scrollIntoView({ block: 'center' }); return { text: b.textContent, label: i && i.getAttribute('aria-label'), focused: document.activeElement === i }; })()`);
            check(`${tag}: the delete confirm says how many files, those not from this computer and which Corals lose files, and what to type`, /12 files\) for every Coral that uses it/.test(del.text) && /2 of them did not come from this computer/.test(del.text) && /…a3f2/.test(del.text) && /type: delete 2 a3f2/.test(del.text), del.text.slice(0, 300));
            check(`${tag}: its typed field is labelled and has the focus`, del.label && del.focused, JSON.stringify({ label: del.label, focused: del.focused }));
            check(`${tag}: no sideways scroll in Settings`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-delete-backup-${w}`);
            check(`${tag}: nothing was removed or deleted without the typed confirm`, (await ev(`window.__posts.join(',')`)) === 'remove,disconnect');
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Dropbox removal confirm checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
