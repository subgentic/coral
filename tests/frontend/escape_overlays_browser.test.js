// Escape with the focus on the page closes whatever is open over it, and the page stays where it was (#12290, the operator's "a Needs you row will not open" bug; the Hermes Agent Investigation's review): the viewer's
// comments panel (a side panel at 1280) and its bottom sheet (390), the question dialog and New goal. Each is opened twice, so a close that leaves it half open (the bug: the viewer "open" but invisible, every later open a
// no-op) is seen on the second open. The viewer's is a plain page element: Escape is dispatched on body, as a key pressed with the focus on the page's own text. The question dialog and New goal are native modal dialogs,
// which the browser closes itself on a real key press (a synthetic keydown on body does nothing to a native dialog and proves nothing), so theirs is a real key event through the protocol. 1280 and 390 px.
// Drives Chrome over CDP through agent_view_harness.js; the file routes and the question route are stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`;
    const pageEscape = () => ev(`document.activeElement && document.activeElement.blur(); document.body.focus(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); true`);
    const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    const realEscape = async () => { await Input.dispatchKeyEvent({ type: 'rawKeyDown', ...key }); await Input.dispatchKeyEvent({ type: 'keyUp', ...key }); };
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a route change would land within a frame or two of the key; the page must still be where it was after it
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(() => { const asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: '@Operator which way?\\n\\nA longer second paragraph.', at: new Date().toISOString() }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`/\\/inbox/.test(location.pathname)`, `${w}: on the Inbox`, 8000);
            const where = await ev(`location.pathname`);
            const stays = async (what, round, closed) => {
                await settle(500);
                const path = await ev(`location.pathname`);
                assert.equal(path, where, `${w}: ${what}, round ${round}: Escape closes it and the page stays where it was (it went to ${path}, from ${where})`);
                assert.ok(await ev(closed), `${w}: ${what}, round ${round}: it is closed`);
            };

            for (let round = 1; round <= 2; round++) { // the viewer with its comments panel (a side panel at 1280, the bottom sheet at 390) open
                await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
                await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') && document.querySelector('.artifact-viewer-body').textContent.includes('Release plan')`, `${w}: comments, round ${round}: the viewer opens`, 8000);
                await waitFor(`(() => { const t = document.querySelector('.ac-toggle'); if (!t || t.hidden) return false; if (t.getAttribute('aria-expanded') !== 'true') t.click(); return t.getAttribute('aria-expanded') === 'true'; })()`, `${w}: comments, round ${round}: the comments panel is open before Escape`, 6000);
                await pageEscape();
                await stays('the viewer with its comments open', round, `!document.querySelector('.artifact-viewer') || document.querySelector('.artifact-viewer').hidden`);
            }
            for (let round = 1; round <= 2; round++) { // the question dialog (native)
                await waitFor(`!!document.querySelector('button[aria-label="Answer the question of Orchestrator"]')`, `${w}: question, round ${round}: the question's row`, 10000);
                await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
                await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, `${w}: question, round ${round}: the dialog opens`, 4000);
                await realEscape();
                await stays('the question dialog', round, `!document.querySelector('dialog.inbox-ask-dialog[open]')`);
            }
            for (let round = 1; round <= 2; round++) { // New goal (native)
                await ev(`import(${S} + 'goals_view.js').then(m => { m.openCreate({ project: 'team-a' }); return true; })`);
                await waitFor(`!!document.querySelector('dialog.goals-dialog[open]')`, `${w}: New goal, round ${round}: the dialog opens`, 4000);
                await realEscape();
                await stays('New goal', round, `!document.querySelector('dialog.goals-dialog[open]')`);
            }
        }
    } finally { await client.close(); }
    console.log('escape_overlays_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
