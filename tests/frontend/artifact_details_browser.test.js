// Artifact previews put the content first (#7775, the operator: "in the artifacts view, we don't need to see all this detail every time ... reserve the space for the actual content"): under the header comes the content
// itself, and the facts and "Who can read this" are behind ONE closed "Details" button that a person opens, by keyboard too, and that stays open once they did. The same rule in the documents pane (the team page's Artifacts
// and Knowledge) and in the full artifact viewer, at 1280 and 390 px; nothing in Details repeats what the header says (type, size, when). The artifacts, the knowledge and the readers are stubbed in the page. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-det-${Date.now() % 100000}`;
const HEX = 'c'.repeat(64);
const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const BUNDLE = { exists: true, team_name: TEAM, created_at: '2026-10-25T05:00:00Z', index: '---\ntype: Team Knowledge Bundle\ntitle: ' + TEAM + '\ntags: [a, b]\ntimestamp: 2026-10-22T04:22:31Z\n---\n\n# Index\n\nWhat the team knows.\n', agents: [{ name: 'Backend Dev', content: 'Backend knowledge text.' }] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); const j = (b) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const items = [{ id: ${JSON.stringify(HEX)}, name: 'Design review.txt', media_type: 'text/plain', size: 1800, task_id: 11, task_title: 'Review', created_at: new Date(Date.now() - 7 * 60000).toISOString(), uri: 'coral://artifacts/${HEX}', available: true, source: 'completion', provenance: 'uploaded', produced_by: 'Worker A' }];
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = String((o && o.method) || 'GET').toUpperCase();
            if (m === 'GET' && /^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) return j({ project: ${JSON.stringify(TEAM)}, artifacts: items, has_more: false, total: 1 });
            if (m === 'GET' && /^\\/api\\/artifacts\\/[0-9a-f]{64}\\/readers$/.test(url.pathname)) return j({ machine_owner: 'reads, manages and deletes every artifact on this computer', owners: [{ kind: 'operator', id: 'operator', records: 1, teams: [{ label: ${JSON.stringify(TEAM)} }], reason: 'the agents of every team this owner owns read it' }], linked_teams: [], note: 'This is a control on Coral\\'s API, not an operating-system boundary: every agent on this computer runs as the same user and can read Coral\\'s data folder with its own shell.' });
            if (m === 'GET' && /^\\/api\\/artifacts\\/[0-9a-f]{64}$/.test(url.pathname)) return Promise.resolve(new Response('The design review text.', { headers: { 'Content-Type': 'text/plain' } }));
            if (m === 'GET' && /\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname)) return j(${JSON.stringify(BUNDLE)});
            return R(u, o); };
        return true; })()`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await settle(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const geometry = (headSel, docSel) => ev(`(() => { const h = document.querySelector(${JSON.stringify(headSel)}), d = document.querySelector(${JSON.stringify(docSel)}); if (!h || !d) return null; return { gap: Math.round(d.getBoundingClientRect().top - h.getBoundingClientRect().bottom) }; })()`);
    const key = async (k, code, vk, text) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    // What "Who can read this" shows is the server's real text (its length and wording, artifact_readers.go), so a clipped line would show here: every line wraps (white-space normal, no overflow hidden),
    // nothing is wider than its box and no ellipsis cuts a line (how many lines a long text takes depends on the font and the width, so that is not asserted).
    const wrapOf = (scope) => ev(`(() => { const r = document.querySelector(${JSON.stringify(scope + ' .artifact-readers')}), panel = r.parentElement; const ps = [...r.querySelectorAll('.artifact-readers-body p')]; const rb = r.getBoundingClientRect(); return { texts: ps.map(p => p.textContent), clipped: ps.filter(p => p.scrollWidth > p.clientWidth + 1).length, panelSide: panel.scrollWidth - panel.clientWidth, blockSide: r.scrollWidth - r.clientWidth, ws: [...new Set(ps.map(p => getComputedStyle(p).whiteSpace))], overflow: [getComputedStyle(r).overflowX, getComputedStyle(r.querySelector('.artifact-readers-body')).overflowX], ellipsis: [r, r.querySelector('.artifact-readers-body'), ...ps].some(e => getComputedStyle(e).textOverflow === 'ellipsis'), inside: ps.every(p => p.getBoundingClientRect().right <= rb.right + 1 && p.getBoundingClientRect().left >= rb.left - 1) }; })()`);
    const assertWraps = (w, label) => {
        assert.match(w.texts[0], /^On this computer, the Operator reads, manages and deletes every artifact on this computer\.$/, `${label}: the whole first line is there: ${JSON.stringify(w.texts)}`);
        assert.ok(w.texts.some(t => /^Held by the Operator on this computer \(1 record\), on qa-det-\d+\. The agents of every team this owner owns read it\.$/.test(t)), `${label}: the whole second line is there: ${JSON.stringify(w.texts)}`);
        assert.ok(/boundary: every agent on this computer runs as the same user and can read Coral's data folder with its own shell\.$/.test(w.texts[w.texts.length - 1]), `${label}: the note is whole`);
        assert.deepEqual([w.clipped, w.panelSide <= 1, w.blockSide <= 1, w.inside], [0, true, true, true], `${label}: nothing is wider than its box: ${JSON.stringify(w)}`);
        assert.deepEqual(w.ws, ['normal'], `${label}: lines wrap (no nowrap)`); assert.deepEqual(w.overflow, ['visible', 'visible'], `${label}: nothing is cut off by an overflow`);
        assert.ok(!w.ellipsis, `${label}: no line is cut with an ellipsis`);
    };
    const toggle = (scope) => `document.querySelector(${JSON.stringify(scope + ' .details-toggle')})`;
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await ev(`localStorage.removeItem('coral-details-open'); true`);
        await seed(ev, TEAM); await stub();
        if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
        await openTeam(ev, waitFor, TEAM).catch(() => {});
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await open(w, h, mobile);
            await S.run(`${label}: an artifact's pane has the content straight under the header, and Details closed (no facts table, no "Who can read this" on show)`, async () => {
                await goTab(ev, settle, 'Artifacts'); await waitFor(`!!window.__tp.rows() && window.__tp.rows().length >= 1`, 'the artifact row', 10000);
                await ev(`[...window.__tp.table().querySelectorAll('button')].find(x => /Design review/.test(window.__na.name(x))).click(); true`);
                await waitFor(`!!window.__tp.pane() && /The design review text\\./.test(window.__na.text(window.__tp.pane()))`, 'the content in the pane', 10000);
                await waitFor(`!!document.querySelector('#detail-pane .details-toggle:not([hidden])')`, 'the Details button');
                const g = await geometry('#detail-pane .detail-head', '#detail-pane .detail-doc'); assert.ok(g && g.gap >= 0 && g.gap <= 16, `the content's top is within 16 px of the header's bottom: ${JSON.stringify(g)}`);
                const s = await ev(`(() => { const t = ${toggle('#detail-pane')}, p = document.querySelector('#detail-pane .detail-details'); return { expanded: t.getAttribute('aria-expanded'), controls: t.getAttribute('aria-controls') === p.id, hidden: p.hidden, facts: window.__na.text(window.__tp.pane()), sub: document.querySelector('#detail-pane .detail-sub').textContent, exact: document.querySelector('#detail-pane .detail-sub').title, name: window.__na.name(t) }; })()`);
                assert.deepEqual([s.expanded, s.controls, s.hidden], ['false', true, true], 'closed to begin with, the button names its panel'); assert.match(s.name, /^Details/);
                assert.ok(!/Who can read this|MIME|Producer|Worker A/.test(s.facts), 'no facts and no readers on show: ' + s.facts.slice(0, 200));
                assert.ok(/^Text \u00b7 1\.8 KB \u00b7 \d+ min ago$/.test(s.sub), `the header says the type, the size and when: ${s.sub}`); assert.ok(s.exact, 'with the exact time on hover');
                if (mobile) { // the Details button is a 44 px target on a phone, with a touch pointer and with a mouse (#7796)
                    for (const touch of [true, false]) {
                        await Emulation.setTouchEmulationEnabled({ enabled: touch }); await settle(150);
                        const sz = await ev(`(() => { const b = document.querySelector('#detail-pane .details-toggle'); const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
                        assert.ok(sz[0] >= 44 && sz[1] >= 44, `${touch ? 'touch' : 'mouse'}: the pane's Details button is 44 px: ${JSON.stringify(sz)}`);
                        const gg = await geometry('#detail-pane .detail-head', '#detail-pane .detail-doc'); assert.ok(gg && gg.gap <= 16, `${touch ? 'touch' : 'mouse'}: and the content is still straight under the header: ${JSON.stringify(gg)}`);
                    }
                    await Emulation.setTouchEmulationEnabled({ enabled: true });
                }
                await shot(`artifact-details-closed-${w}`);
            });
            await S.run(`${label}: Details opens and closes by keyboard (Enter, Space), shows the facts and "Who can read this", repeats nothing the header says, and stays open for the next artifact`, async () => {
                await ev(`${toggle('#detail-pane')}.focus(); true`);
                await key('Enter', 'Enter', 13, '\r'); await settle(200);
                let s = await ev(`(() => { const t = ${toggle('#detail-pane')}, p = document.querySelector('#detail-pane .detail-details'); return { expanded: t.getAttribute('aria-expanded'), hidden: p.hidden, text: window.__na.text(p), focus: document.activeElement === t }; })()`);
                assert.deepEqual([s.expanded, s.hidden, s.focus], ['true', false, true], 'Enter opens it and the focus stays on the button');
                assert.ok(/MIME\s*text\/plain/.test(s.text) && /Task/.test(s.text) && /Producer\s*Worker A/.test(s.text), 'the facts: ' + s.text.slice(0, 200));
                assert.ok(!/(^|\s)(Type|Size|Created)\s/.test(s.text.replace(/MIME/, '')), 'nothing repeats the header (type, size, time): ' + s.text.slice(0, 200));
                await waitFor(`!!document.querySelector('#detail-pane .detail-details .artifact-readers')`, 'Who can read this inside Details', 8000);
                assert.equal(await ev(`window.__na.text(document.querySelector('#detail-pane .detail-details')).includes('Who can read this')`), true, 'Who can read this is in the same panel');
                assert.deepEqual(await ev(`(() => { const r = document.querySelector('#detail-pane .detail-details .artifact-readers'); return { tag: r.tagName, nested: r.querySelectorAll('details, summary').length, body: r.querySelector('.artifact-readers-body').textContent.length > 0 }; })()`), { tag: 'SECTION', nested: 0, body: true }, 'Who can read this is shown directly: its answer is there, no second disclosure inside the first (#7796)');
                await shot(`artifact-details-open-${w}`);
                await waitFor(`document.querySelectorAll('#detail-pane .artifact-readers-body p').length >= 3`, 'the readers answer', 8000);
                assertWraps(await wrapOf('#detail-pane'), `${label} pane`);
                await shot(`artifact-details-readers-${w}`);
                await key(' ', 'Space', 32, ' '); await settle(200);
                assert.equal(await ev(`document.querySelector('#detail-pane .detail-details').hidden`), true, 'Space closes it');
                await key(' ', 'Space', 32, ' '); await settle(200);
                assert.equal(await ev(`document.querySelector('#detail-pane .detail-details').hidden`), false, 'and opens it');
                await ev(`document.querySelector('#detail-pane .detail-close').click(); true`); await settle(200);
                await ev(`[...window.__tp.table().querySelectorAll('button')].find(x => /Design review/.test(window.__na.name(x))).click(); true`);
                await waitFor(`!!document.querySelector('#detail-pane .details-toggle:not([hidden])')`, 'the Details button again');
                assert.equal(await ev(`${toggle('#detail-pane')}.getAttribute('aria-expanded')`), 'true', 'it stays open for the next one: remembered for the viewer');
                await ev(`${toggle('#detail-pane')}.click(); true`); await settle(100);
                await ev(`document.querySelector('#detail-pane .detail-close').click(); true`);
            });
            await S.run(`${label}: the Knowledge pane has the entry straight under the header and its front matter behind Details`, async () => {
                await ev(`localStorage.removeItem('coral-details-open'); true`);
                await goTab(ev, settle, 'Knowledge'); await waitFor(`!!window.__tp.rows() && window.__tp.rows().length >= 2`, 'the knowledge table', 10000);
                await ev(`[...window.__tp.table().querySelectorAll('button')].find(x => /^Index$/.test(window.__na.name(x))).click(); true`);
                await waitFor(`!!document.querySelector('#detail-pane .knowledge-md')`, 'the entry', 8000);
                const g = await geometry('#detail-pane .detail-head', '#detail-pane .detail-doc'); assert.ok(g && g.gap >= 0 && g.gap <= 16, `the entry's top is within 16 px of the header's bottom: ${JSON.stringify(g)}`);
                assert.equal(await ev(`document.querySelector('#detail-pane .detail-details').hidden`), true, 'the front matter is closed');
                await ev(`${toggle('#detail-pane')}.focus(); true`); await key('Enter', 'Enter', 13, '\r'); await settle(200);
                const t = await ev(`window.__na.text(document.querySelector('#detail-pane .detail-details'))`); assert.ok(/Type\s*Team Knowledge Bundle/.test(t) && /Tags/.test(t), 'the front matter in Details: ' + t.slice(0, 160));
                await ev(`${toggle('#detail-pane')}.click(); document.querySelector('#detail-pane .detail-close').click(); true`);
                await ev(`[...window.__tp.table().querySelectorAll('button')].find(x => /Backend Dev/.test(window.__na.name(x))).click(); true`); await settle(300);
                assert.equal(await ev(`document.querySelector('#detail-pane .details-toggle').hidden`), true, 'an entry without front matter has no Details button');
                await ev(`document.querySelector('#detail-pane .detail-close').click(); true`);
            });
            await S.run(`${label}: the artifact viewer has the content straight under the header and "Who can read this" behind Details`, async () => {
                await ev(`localStorage.removeItem('coral-details-open'); (async () => { const m = await import((window.__coralStatic || '/static/') + 'artifact_viewer.js'); m.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'Design review.txt' }); })(); true`);
                await waitFor(`!!document.querySelector('#artifact-viewer .details-toggle:not([hidden])') && /The design review text\\./.test(document.querySelector('#artifact-viewer .artifact-viewer-body').textContent)`, 'the viewer with its content and Details', 10000);
                const g = await geometry('#artifact-viewer .artifact-viewer-header', '#artifact-viewer .artifact-viewer-body'); assert.ok(g && g.gap >= 0 && g.gap <= 16, `the content's top is within 16 px of the header's bottom: ${JSON.stringify(g)}`);
                assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-readers').hidden`), true, 'closed to begin with');
                if (mobile) {
                    for (const touch of [true, false]) {
                        await Emulation.setTouchEmulationEnabled({ enabled: touch }); await settle(150);
                        const sz = await ev(`(() => { const r = document.querySelector('#artifact-viewer .details-toggle').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
                        assert.ok(sz[0] >= 44 && sz[1] >= 44, `${touch ? 'touch' : 'mouse'}: the viewer's Details button is 44 px: ${JSON.stringify(sz)}`);
                    }
                    await Emulation.setTouchEmulationEnabled({ enabled: true });
                }
                await ev(`${toggle('#artifact-viewer')}.focus(); true`); await key('Enter', 'Enter', 13, '\r'); await settle(200);
                assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-readers').hidden`), false, 'Enter opens it');
                assert.ok(await ev(`window.__na.text(document.querySelector('#artifact-viewer .artifact-viewer-readers')).includes('Who can read this')`), 'Who can read this is inside');
                await waitFor(`document.querySelectorAll('#artifact-viewer .artifact-readers-body p').length >= 3`, 'the readers answer in the viewer', 8000);
                assertWraps(await wrapOf('#artifact-viewer'), `${label} viewer`);
                await key(' ', 'Space', 32, ' '); await settle(200);
                assert.equal(await ev(`document.querySelector('#artifact-viewer .artifact-viewer-readers').hidden`), true, 'Space closes it');
                await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
