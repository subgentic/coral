// #8268: waiting names keep their beginning; the status tag never consumes the name.
// Test-only first revision records both viewport failures before the product fix.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const NAME = 'Senior Backend Reliability Engineer for the Tunnel Subsystem';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(async () => {
                const st = window.__coralStatic || '/static/';
                const ws = await import(st + 'websocket.js'), render = await import(st + 'render.js'), { state } = await import(st + 'state.js');
                if (state.coralWs) { state.coralWs.onclose = null; state.coralWs.onmessage = null; state.coralWs.close(); }
                ws.handleCoralMessage({ type: 'coral_update', servers: [{ id: 'local', label: 'here', status: 'online' }], sessions: [{ name: 'waiting-name', session_id: 'waiting-name', agent_type: 'claude', server: 'local', status: 'idle', display_name: ${JSON.stringify(NAME)}, waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Allow this command?', working_directory: '/repo', board_project: 'team-a' }] });
                render.flushLiveSessionsRender(); window.switchNavTab('agents'); return true;
            })()`);
            const row = `[...document.querySelectorAll('.session-group-item[data-session-id="waiting-name"]')].find(r => r.getBoundingClientRect().width > 0)`;
            await waitFor(`!!(${row})`, 'the waiting agent row');
            for (const narrow of (width === 1280 ? [false, true] : [false])) for (const theme of ['dark', 'light']) {
                if (narrow) await ev(`document.querySelector('.sidebar').style.width = '200px'; true`);
                await setTheme(ev, theme);
                const facts = await ev(`(() => {
                    const r = ${row}, label = r.querySelector('.session-label'), name = r.querySelector('.session-label-name');
                    const tag = [...r.querySelectorAll('.session-state-pill, .session-status-chip')].find(t => t.getBoundingClientRect().width > 0);
                    const l = label.getBoundingClientRect(), n = name.getBoundingClientRect(), t = tag?.getBoundingClientRect();
                    const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT), text = walker.nextNode(), range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(6, text.length)); const first = range.getBoundingClientRect();
                    const clip = name.querySelector('.sln-head') || label, c = clip.getBoundingClientRect(), style = getComputedStyle(label);
                    return { name: name.textContent, title: label.title, aria: r.getAttribute('aria-label'), tag: tag?.textContent.trim(), firstVisible: first.left >= c.left - 1 && first.right <= c.right + 1 && first.width > 0, nameWidth: l.width, ellipsis: style.textOverflow, whiteSpace: style.whiteSpace, tagWhole: !!tag && tag.scrollWidth <= tag.clientWidth + 1, tagBelow: !!t && t.top >= l.bottom - 1, overlap: !!t && t.left < l.right && t.right > l.left && t.top < l.bottom && t.bottom > l.top, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
                })()`);
                const at = `${width}${narrow ? '-narrow' : ''}-${theme}`;
                console.log(at + ': ' + JSON.stringify(facts));
                try {
                    assert.equal(facts.name, NAME); assert.equal(facts.title, '', 'no native title: the hover tip names the agent (#9822)'); assert.ok(facts.aria.startsWith(NAME + ','));
                    assert.ok(facts.firstVisible, 'name beginning remains visible: ' + JSON.stringify(facts));
                    assert.equal(facts.ellipsis, 'ellipsis'); assert.equal(facts.whiteSpace, 'nowrap');
                    // an agent row is one line, the dot, the name and at most one chip (#9686): a waiting agent's chip is DRAWN at every width, whole and not over the name; on a phone it sits on the line, not below
                    assert.ok(facts.tag && facts.tagWhole && !facts.overlap && !facts.overflow, 'whole tag and no overlap: ' + JSON.stringify(facts));
                    if (narrow) assert.ok(facts.tagBelow, 'tag below name in narrow layout: ' + JSON.stringify(facts));
                    if (width === 390) assert.ok(!facts.tagBelow, 'on a phone the chip is on the name\'s line: ' + JSON.stringify(facts));
                } catch (error) { failures.push(at + ': ' + error.message); }
                const dir = process.env.CORAL_SCREENSHOT_DIR || (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'out', 'shots-8268') : '');
                if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `waiting-name-${at}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            }
        }
        assert.deepEqual(failures, [], failures.join('\n'));
        console.log('PASS waiting sidebar name keeps its beginning and the status remains whole');
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
