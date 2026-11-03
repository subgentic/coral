// A Markdown checklist is a checklist (#12770): the shared renderer left "- [ ] first" as the text "[ ] first"; a list item that starts with "[ ]" or "[x]" now has a real read-only checkbox (disabled, checked for x, the
// mark gone from the text), in a task's text and in a goal's description, at 1280 and 390 px; "[ ]" away from the start of an item stays text, and a description without a checklist is still the plain text it was.
// Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const LIST = 'Before we ship:\n\n- [ ] first item\n- [x] done item\n- plain item with [ ] inside\n';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            const t = await ev(`(async () => { const vl = await import(${S} + 'vendor_loader.js'); await vl.loadSafeMarkdown(); const sm = await import(${S} + 'safe_markdown.js'); const { node } = sm.renderSafe(${JSON.stringify(LIST)}, {});
                return { boxes: [...node.querySelectorAll('li > input[type=checkbox]')].map(b => [b.checked, b.disabled, b.getAttribute('aria-label')]), items: [...node.querySelectorAll('li')].map(l => l.textContent.trim()), html: node.innerHTML.includes('[ ] first') }; })()`);
            assert.deepEqual(t.boxes, [[false, true, 'Not done'], [true, true, 'Done']], at + 'two read-only checkboxes, one checked: ' + JSON.stringify(t));
            assert.deepEqual(t.items, ['first item', 'done item', 'plain item with [ ] inside'], at + 'the marks are gone from the text, a "[ ]" inside an item stays: ' + JSON.stringify(t.items));
            // a goal's description
            const g = await ev(`(async () => { const st = await import(${S} + 'state.js'), gv = await import(${S} + 'goal_view.js'); const host = document.createElement('div'); document.body.append(host);
                gv.mountGoal(host, { team: 'local-team', id: 3, back() {}, goal: { id: 3, title: 'G', state: 'active', outcome: ${JSON.stringify(LIST)}, doneWhen: 'Just words, no list [ ] here.', images: [], updatedAt: '2026-11-03T00:00:00Z', rollup: { done: 0, active: 0, blocked: 0, queued: 0 } }, refresh() {}, status: () => ({}) });
                for (let i = 0; i < 60 && !host.querySelector('dd input[type=checkbox]'); i++) await new Promise(r => setTimeout(r, 100));
                const dds = [...host.querySelectorAll('.facts dd')]; return { boxes: [...host.querySelectorAll('dd input[type=checkbox]')].map(b => [b.checked, b.disabled]), plain: dds.filter(d => /Just words/.test(d.textContent)).map(d => d.querySelectorAll('input').length + ':' + d.textContent.trim()), bad: /\\[ \\] first/.test(host.textContent) }; })()`);
            assert.deepEqual(g.boxes, [[false, true], [true, true]], at + "the goal's description shows the checklist as checkboxes: " + JSON.stringify(g));
            assert.ok(!g.bad && g.plain.length === 1 && g.plain[0].startsWith('0:Just words'), at + 'no "[ ]" text left in the checklist, and a plain description stays plain: ' + JSON.stringify(g));
        }
    } finally { await client.close(); }
    console.log('PASS a Markdown checklist is real read-only checkboxes in a task and in a goal description');
})().catch(e => { console.error(e); process.exit(1); });
