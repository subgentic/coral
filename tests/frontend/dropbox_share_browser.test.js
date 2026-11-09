// Share via Dropbox (#14944), the dialog as a person sees it at 1280 and 390: the file's More actions offers "Share via Dropbox…" while Dropbox is
// connected; the dialog asks who can open it (Specific people by default, the team on a team account, Anyone with the link); the button names what
// happens; a link needs its box ticked; the link is shown with Copy link and Open in Dropbox (https on www.dropbox.com only); Stop sharing stops
// it; Escape closes and the focus goes back to More actions. The server's answers are the page's fetch. Screenshots go to CORAL_SCREENSHOT_DIR.
// Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;
const LINK = 'https://www.dropbox.com/scl/fi/abc/release-plan.md?rlkey=k&dl=0';

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
            await ev(`(() => { const inner = window.fetch; window.__shareCalls = [];
                const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                    if (p === '/api/dropbox/status') return json({ connected: true, state: 'connected' });
                    if (p === '/api/dropbox/share/${H3}' && m === 'GET') return json({ connected: true, name: 'release-plan.md', size: 14336, version: 3, can_expire: true, team: 'Acme', secret: false, folder: '/Shared from Coral/team-a', shares: [] });
                    if (p === '/api/dropbox/share/${H3}' && m === 'POST') { window.__shareCalls.push(JSON.parse(o.body)); return json({ id: 5, name: 'release-plan.md', folder: '/Shared from Coral/team-a', audience: 'public', link: '${LINK}', expires_at: '2026-12-09T10:00:00Z', version: 3 }); }
                    if (p === '/api/dropbox/share/stop/5' && m === 'POST') { window.__shareCalls.push('stop'); return json({ stopped: 1 }); }
                    return inner(u, o); };
                return true; })()`);

            console.log(`${tag}: the menu item`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer('${H3}', { filename: 'release-plan.md', server: 'local', sourceNamed: true }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-dropbox-share') && !document.querySelector('#artifact-viewer .artifact-viewer-dropbox-share').hidden`, 'the Share via Dropbox item', 8000);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); true`);
            check(`${tag}: More actions offers Share via Dropbox…`, (await ev(`document.querySelector('#artifact-viewer .artifact-viewer-dropbox-share').textContent`)) === 'Share via Dropbox…');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-dropbox-share').click(); true`);
            await waitFor(`!!document.querySelector('#dropbox-share-dialog[open] .dropbox-share-choices')`, 'the dialog', 8000);

            const labels = await ev(`[...document.querySelectorAll('#dropbox-share-dialog .dropbox-share-choice b')].map(b => b.textContent)`);
            check(`${tag}: three choices, as Dropbox offers them`, JSON.stringify(labels) === JSON.stringify(['Specific people', 'People in Acme (your Dropbox team)', 'Anyone with the link']), JSON.stringify(labels));
            check(`${tag}: Specific people is the default`, await ev(`document.querySelector('#dropbox-share-dialog input[value="people"]').checked`));
            const go = `[...document.querySelectorAll('#dropbox-share-dialog .modal-footer button')].pop()`;
            check(`${tag}: no address, no share`, await ev(`${go}.disabled && ${go}.textContent === 'Share with people'`));
            check(`${tag}: it says Dropbox emails the people`, await ev(`/Dropbox emails each one an invitation/.test(document.querySelector('#dropbox-share-dialog').textContent)`));
            await ev(`(() => { const t = document.getElementById('dropbox-share-emails'); t.value = 'ana@example.com, sam@example.com'; t.dispatchEvent(new Event('input')); return true; })()`);
            check(`${tag}: the button says what happens`, (await ev(`${go}.textContent`)) === 'Share with 2 people');
            check(`${tag}: no sideways scroll`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-share-people-${w}`);

            await ev(`(() => { const r = document.querySelector('#dropbox-share-dialog input[value="public"]'); r.click(); return true; })()`);
            check(`${tag}: a public link waits for its box`, await ev(`${go}.disabled && ${go}.textContent === 'Create public link'`));
            check(`${tag}: the box is not ticked`, !(await ev(`document.getElementById('dropbox-share-link-ok').checked`)));
            await ev(`document.getElementById('dropbox-share-link-ok').click(); true`);
            check(`${tag}: ticked, the press is offered`, !(await ev(`${go}.disabled`)));
            await shot(`dropbox-share-public-${w}`);
            await ev(`(() => { const inner = window.fetch; let once = true; window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname; if (once && p === '/api/dropbox/share/${H3}' && o && o.method === 'POST') { once = false; return Promise.resolve(new Response(JSON.stringify({ code: 'limit', error: '20 shares an hour at most; try again later' }), { status: 429, headers: { 'Content-Type': 'application/json' } })); } return inner(u, o); }; return true; })()`);
            await ev(`${go}.focus(); ${go}.click(); true`);
            await waitFor(`!document.querySelector('#dropbox-share-dialog .dropbox-share-say').hidden`, 'the refusal', 6000);
            check(`${tag}: a refusal is said in the alert`, (await ev(`(() => { const a = document.querySelector('#dropbox-share-dialog .dropbox-share-say'); return a.getAttribute('role') + '|' + a.textContent; })()`)) === 'alert|20 shares an hour at most; try again later');
            check(`${tag}: the pressed button has the focus again`, (await ev(`document.activeElement && document.activeElement.textContent`)) === 'Create public link');
            await ev(`${go}.click(); true`);
            await waitFor(`!!document.querySelector('#dropbox-share-dialog .dropbox-share-link')`, 'the link', 6000);
            const sent = await ev(`JSON.stringify(window.__shareCalls.filter(c => c && c.audience === 'public').pop())`);
            check(`${tag}: it sent the press, the audience and no people`, sent === JSON.stringify({ name: 'release-plan.md', audience: 'public', emails: [], expire: true, confirm: true }), sent);
            check(`${tag}: the link is shown`, (await ev(`document.querySelector('#dropbox-share-dialog .dropbox-share-link').value`)) === LINK);
            const open = await ev(`(() => { const a = [...document.querySelectorAll('#dropbox-share-dialog a')].find(a => a.textContent === 'Open in Dropbox'); return a ? [a.href, a.rel, a.target, a.getAttribute('aria-label')].join('|') : ''; })()`);
            check(`${tag}: Open in Dropbox opens the link apart, and says so`, open === `${LINK}|noopener noreferrer|_blank|Open in Dropbox (opens a new tab)`, open);
            check(`${tag}: Copy link is first and has the focus`, (await ev(`document.activeElement && document.activeElement.textContent`)) === 'Copy link');
            check(`${tag}: it says who can open it`, await ev(`/Anyone with this link can view and download this file\\. It expires on/.test(document.querySelector('#dropbox-share-dialog').textContent)`));
            check(`${tag}: no sideways scroll with the link`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-share-link-${w}`);

            await ev(`[...document.querySelectorAll('#dropbox-share-dialog .modal-footer button')].find(b => b.textContent === 'Stop sharing').click(); true`);
            await waitFor(`/Sharing stopped/.test(document.querySelector('#dropbox-share-dialog').textContent)`, 'stopped', 6000);
            check(`${tag}: Stop sharing called the server`, (await ev(`window.__shareCalls.includes('stop')`)));
            await ev(`document.getElementById('dropbox-share-dialog').dispatchEvent(new Event('cancel', { cancelable: true })); document.getElementById('dropbox-share-dialog').close(); true`);
            const back = await waitFor(`document.activeElement && document.activeElement.classList.contains('artifact-viewer-more')`, 'the focus back on More actions', 3000).then(() => true, () => false);
            check(`${tag}: the focus goes back to More actions`, back, await ev(`document.activeElement ? document.activeElement.className : ''`));
            await ev(`window.closeArtifactViewer ? window.closeArtifactViewer() : (document.getElementById('artifact-viewer').hidden = true); true`);

            // The Operator's walk (#198059): the dialog must always close: on a route change, on Escape while a request is still running, and by
            // its own close button.
            console.log(`${tag}: it always closes`);
            const openIt = async () => { await ev(`(async () => { const m = await import(${S} + 'dropbox_share.js'); m.openShareDialog({ hex: '${H3}', filename: 'release-plan.md', opener: document.body }); return true; })()`); await waitFor(`!!document.querySelector('#dropbox-share-dialog[open] .dropbox-share-choices')`, 'the dialog', 6000); };
            await openIt();
            await ev(`document.dispatchEvent(new CustomEvent('coral:route-changed')); true`);
            check(`${tag}: a route change closes it`, await waitFor(`!document.querySelector('#dropbox-share-dialog[open]')`, 'closed on a route change', 2000).then(() => true, () => false));
            await openIt();
            await ev(`(() => { const inner = window.fetch; window.fetch = (u, o) => (new URL(String(u), location.origin).pathname === '/api/dropbox/share/${H3}' && o && o.method === 'POST') ? new Promise(() => {}) : inner(u, o); return true; })()`);
            await ev(`document.getElementById('dropbox-share-link-ok') && (document.querySelector('#dropbox-share-dialog input[value="public"]').click(), document.getElementById('dropbox-share-link-ok').click()); [...document.querySelectorAll('#dropbox-share-dialog .modal-footer button')].pop().click(); true`);
            await ev(`document.getElementById('dropbox-share-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); (() => { const d = document.getElementById('dropbox-share-dialog'); const e = new Event('cancel', { cancelable: true }); d.dispatchEvent(e); if (!e.defaultPrevented) d.close(); })(); true`);
            check(`${tag}: Escape closes it while a request is still running`, await waitFor(`!document.querySelector('#dropbox-share-dialog[open]')`, 'closed by Escape', 2000).then(() => true, () => false));
            await openIt();
            const x = await ev(`(() => { const b = document.querySelector('#dropbox-share-dialog .modal-header button'); return b ? b.getAttribute('aria-label') : ''; })()`);
            check(`${tag}: it has its own close button`, x === 'Close', x);
            if (x) await ev(`document.querySelector('#dropbox-share-dialog .modal-header button').click(); true`);
            check(`${tag}: the close button closes it`, await waitFor(`!document.querySelector('#dropbox-share-dialog[open]')`, 'closed by its button', 2000).then(() => true, () => false));
            await ev(`document.getElementById('dropbox-share-dialog')?.close(); true`);

            console.log(`${tag}: a chat`);
            await ev(`(() => { const inner = window.fetch;
                const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o) => { const p = new URL(String(u), location.origin).pathname, m = (o && o.method) || 'GET';
                    if (p === '/api/dropbox/share-chat/team-a/preview') { window.__shareCalls.push(JSON.parse(o.body)); return json({ connected: true, can_expire: false, team: '', html: '<!doctype html><title>x</title><p>Hello</p><script>parent.__ran = 1</script>', hash: 'h'.repeat(64), size: 2048, included: 3, left_out: 1, name: 'team-a chat.html' }); }
                    if (p === '/api/dropbox/share-chat/team-a' && m === 'POST') { window.__shareCalls.push(JSON.parse(o.body)); return json({ id: 9, name: 'team-a chat.html', folder: '/Shared from Coral/team-a', audience: 'people', people: 1 }); }
                    return inner(u, o); };
                return true; })()`);
            await ev(`(async () => { const m = await import(${S} + 'dropbox_share.js'); m.openChatShareDialog({ project: 'team-a', ids: [3, 1, 2], opener: document.body }); return true; })()`);
            await waitFor(`!!document.querySelector('#dropbox-share-dialog[open] .dropbox-share-preview')`, 'the chat dialog', 6000);
            const pv = await ev(`(() => { const f = document.querySelector('#dropbox-share-dialog .dropbox-share-preview'); return [f.getAttribute('sandbox'), f.hidden, /<p>Hello/.test(f.srcdoc)].join('|'); })()`);
            check(`${tag}: the preview is a sandboxed frame, closed until asked for`, pv === '|true|true', pv);
            check(`${tag}: it says what to check`, await ev(`/Check the preview for private names and paths/.test(document.querySelector('#dropbox-share-dialog').textContent)`));
            check(`${tag}: without a team account, two choices`, (await ev(`document.querySelectorAll('#dropbox-share-dialog .dropbox-share-choice').length`)) === 2);
            check(`${tag}: a plan without expiry says so`, await ev(`/cannot set an expiry/.test(document.querySelector('#dropbox-share-dialog').textContent)`));
            await ev(`[...document.querySelectorAll('#dropbox-share-dialog button')].find(b => b.textContent === 'Open the preview').click(); true`);
            await sleep(300); // sleep-ok: a sandboxed frame's script would have run by now if it could
            check(`${tag}: the preview's script does not run`, !(await ev(`!!window.__ran`)));
            check(`${tag}: no sideways scroll with the preview`, await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
            await shot(`dropbox-share-chat-${w}`);
            await ev(`(() => { const t = document.getElementById('dropbox-share-emails'); t.value = 'ana@example.com'; t.dispatchEvent(new Event('input')); return true; })()`);
            await ev(`[...document.querySelectorAll('#dropbox-share-dialog .modal-footer button')].pop().click(); true`);
            await waitFor(`/Shared with 1 person/.test(document.querySelector('#dropbox-share-dialog').textContent)`, 'shared', 6000);
            const chatSent = await ev(`JSON.stringify(window.__shareCalls.slice(-1)[0])`);
            check(`${tag}: the share sends the ids and the preview's hash`, chatSent === JSON.stringify({ name: 'team-a chat.html', audience: 'people', emails: ['ana@example.com'], expire: true, confirm: true, ids: [3, 1, 2], hash: 'h'.repeat(64) }), chatSent);
            await ev(`document.getElementById('dropbox-share-dialog').close(); true`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Share via Dropbox checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
