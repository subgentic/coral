// The first real click on a running agent's name in a comment thread, after a reply is typed, lands (#12301, Hermes Agent Investigation's finding on #12299): the reply box lost the focus at the mouse press, the card it belongs to
// folded its actions row (about 22 px) and the thread, scrolled to its end, shifted up under the pointer, so the button came up over something else and the browser sent no click; a second click worked. Now the card with its reply box open keeps its row.
// Real mouse events (CDP Input) at 1280 px with and without a scroll first; the name must not move between the press and the release and the first click must reach the link ("Leave this dialog?" asks, since a reply is typed).
// Hermes's probe, made into a suite: the versions stub (H3), three running agents. At 390 px the sheet is not scrolled to its end and the row is not there, so the case is the desktop panel.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady, framesJs } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`, out = [];
    const frames = n => ev(framesJs(n)); // the page has drawn: the panel and the box settle in a few frames
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const variant of ['scrollThenPress', 'noScroll']) {
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB);
            await ev(`(async () => { const st = await import(${S} + 'state.js'); st.state.liveSessions = ['Security Reviewer', 'QA Engineer', 'Frontend Dev'].map((n, i) => ({ session_id: 'sess-' + i, name: 'a' + i, agent_type: 'claude', board_subscriber_id: n, board_project: 'team-a' })); window.__opened = null; window.__clicks = 0; window.selectLiveSession = (...a) => { window.__opened = a; };
                document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.agent-link')) window.__clicks++; }, true); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') && document.querySelector('.artifact-viewer-body').textContent.includes('Release plan')`, 'viewer', 8000);
            await waitFor(`(() => { const t = document.querySelector('.ac-toggle'); if (!t || t.hidden) return false; if (t.getAttribute('aria-expanded') !== 'true') t.click(); return t.getAttribute('aria-expanded') === 'true'; })()`, 'comments open', 6000);
            await frames(12);
            await ev(`(() => { const b = [...document.querySelectorAll('.artifact-viewer button')].find(b => /^Reply/.test(b.textContent.trim())); b.click(); return true; })()`); await frames(10);
            await ev(`(() => { const t = [...document.querySelectorAll('.artifact-viewer textarea')].find(t => t.getClientRects().length && t.id !== 'artifact-review-text'); t.focus(); t.value = 'half a comment'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            const press = async (scroll) => {
                if (scroll) await ev(`document.querySelector('.artifact-viewer .agent-link.ac-author').scrollIntoView({ block: 'center' }); true`);
                const r = await ev(`(() => { const e = document.querySelector('.artifact-viewer .agent-link.ac-author'); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
                await Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
                const mid = await ev(`(() => { const e = document.querySelector('.artifact-viewer .agent-link.ac-author'); const b = e.getBoundingClientRect(); const at = document.elementFromPoint(${r.x}, ${r.y}); return { stillThere: !!at && !!at.closest('.agent-link'), movedBy: Math.round(b.top + b.height / 2 - ${r.y}) }; })()`);
                await Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
                await frames(10);
                return { ...mid, clicksSeen: await ev(`window.__clicks`), confirm: await ev(`!!document.getElementById('confirm-modal-yes') && document.getElementById('confirm-modal-yes').getClientRects().length > 0`) };
            };
            const a = await press(variant === 'scrollThenPress');
            out.push(`${variant} click 1: ${JSON.stringify(a)}`);
            assert.ok(a.stillThere && a.movedBy === 0 && a.clicksSeen === 1 && a.confirm, `${variant}: the first real click on the agent's name lands (the name must not move under the pointer between the press and the release): ` + JSON.stringify(a));
        }
    } finally { await client.close(); }
    console.log('artifact_comments_click_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
