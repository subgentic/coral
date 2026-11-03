// The real artifact preview's Details (#12725, the UI Reviewer: the test must open the real preview): through the team page's Artifacts tab, a stored artifact opens with Details closed even with the old browser-wide switch ON, the
// facts (Task, MIME, Producer...) are chips in one wrapped row, who can read this and the Guides switch are one row (stacked tight on a phone), the Guides checkbox is beside its label, and the open panel is at most a quarter of the
// window. 1280 and 390 px; the artifacts, the readers and the private routes are stubbed in the page. Isolated dev server.
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
            if (m === 'GET' && /^\\/api\\/artifacts\\/[0-9a-f]{64}\\/private$/.test(url.pathname)) return j({ id: ${JSON.stringify(HEX)}, private: false });
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
            await ev(`localStorage.setItem('coral-details-open', '1'); true`); // the old browser-wide switch is ON: the preview must still open closed
            await goTab(ev, settle, 'Artifacts'); await waitFor(`!!window.__tp.rows() && window.__tp.rows().length >= 1`, 'the artifact row', 10000);
            await ev(`[...window.__tp.table().querySelectorAll('button')].find(x => /^(?!Select).*Design review/.test(window.__na.name(x))).click(); true`);
            await waitFor(`!!window.__tp.pane() && /The design review text\\./.test(window.__na.text(window.__tp.pane()))`, 'the content in the pane', 10000);
            await waitFor(`!!document.querySelector('#detail-pane .details-toggle:not([hidden])')`, 'the Details button');
            const closed = await ev(`(() => { const t = document.querySelector('#detail-pane .details-toggle'), p = document.querySelector('#detail-pane .detail-details'); return { expanded: t.getAttribute('aria-expanded'), hidden: p.hidden }; })()`);
            assert.deepEqual([closed.expanded, closed.hidden], ['false', true], `${label}: the real preview opens with Details closed though the old switch is on`);
            await ev(`document.querySelector('#detail-pane .details-toggle').click(); true`);
            await waitFor(`!!document.querySelector('#detail-pane .artifact-readers-body p') && !!document.querySelector('#detail-pane .artifact-private-field input')`, `${label}: the readers and the Guides switch`, 8000);
            const L = await ev(`(() => { const p = document.getElementById('detail-pane'), panel = p.querySelector('.detail-details'), r = e => e.getBoundingClientRect(), chips = [...p.querySelectorAll('.detail-facts .detail-chip')], readers = p.querySelector('.artifact-readers'), priv = p.querySelector('.artifact-private'), box = p.querySelector('.artifact-private-field input'), t = p.querySelector('.artifact-private-title');
                return { dl: !!p.querySelector('.detail-details dl.facts'), chips: chips.map(c => c.textContent.trim().slice(0, 18) + ':' + Math.round(r(c).height)), sameRow: Math.abs(r(readers).top - r(priv).top) <= 12 && r(readers).right <= r(priv).left + 2, stacked: r(priv).top >= r(readers).bottom - 2, beside: r(box).right <= r(t).left + 1 && Math.abs(r(box).top - r(t).top) <= 16, guidesHead: !!p.querySelector('.artifact-private-head'), panelH: Math.round(r(panel).height), win: innerHeight, wide: Math.round(r(panel).width) }; })()`);
            assert.ok(!L.dl && L.chips.length >= 2 && L.chips.every(c => Number(c.split(':').pop()) <= (mobile ? 48 : 34)), `${label}: the facts are chips, one line each: ${JSON.stringify(L)}`);
            assert.ok(L.beside && !L.guidesHead, `${label}: the Guides checkbox is beside its label, with no heading of its own: ${JSON.stringify(L)}`);
            if (!mobile) assert.ok(L.sameRow, `${label}: who can read this and the Guides switch are one row: ${JSON.stringify(L)}`); else assert.ok(L.stacked, `${label}: where the row is too narrow they stack tight: ${JSON.stringify(L)}`);
            const W = await ev(`(() => { const panel = document.querySelector('#detail-pane .detail-details'), pr = panel.getBoundingClientRect(); return { scrollW: panel.scrollWidth, clientW: panel.clientWidth, outside: [...panel.querySelectorAll('.detail-chip')].filter(c => c.getBoundingClientRect().right > pr.right + 1).length }; })()`);
            assert.ok(W.scrollW <= W.clientW + 1 && W.outside === 0, `${label}: nothing in the panel runs past its edge: ` + JSON.stringify(W));
            assert.ok(L.panelH <= L.win * 0.25 + 2, `${label}: open, the panel is at most a quarter of the window: ${JSON.stringify(L)}`);
            await shot(`preview-details-open-${w}`);
            await ev(`document.querySelector('#detail-pane .detail-close').click(); true`);
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
    console.log('PASS the real artifact preview: closed on open, chips, readers and Guides in one row, capped');
})().catch(e => { console.error(e); process.exit(1); });
