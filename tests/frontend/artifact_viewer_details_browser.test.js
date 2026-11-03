// The file viewer's Details (#12725, the Operator: the details header "fills half the screen with no clear way to collapse it"): Details is a visible button in the header row, beside the ⋯ menu (it was an entry inside
// the menu), the viewer opens with it closed every time (one open Details no longer keeps every file's header expanded: the open state was one switch for the whole browser), and open, it is at most a quarter of the window,
// so the file keeps the rest. 1440 and 390 px; the file's bytes are a stubbed fetch (as artifact_viewer_slim_footer_browser does it). Isolated dev server.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const HEX = 'd'.repeat(64);

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic||'/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const tag = mobile ? 'phone' : 'desktop';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired();
            await coralReady();
            await ev(`(() => { try { localStorage.removeItem('coral-details-open'); } catch {} const real = window.fetch; window.fetch = (input, init) => { const u = String(input && input.url ? input.url : input); if (u.includes('/api/artifacts/' + ${JSON.stringify(HEX)}) && !/\\/(readers|private)/.test(u)) return Promise.resolve(new Response('# Plan\\n\\n' + Array.from({ length: 80 }, (_, i) => 'Line ' + (i + 1) + ' of the plan.').join('\\n\\n'), { status: 200, headers: { 'Content-Type': 'text/markdown' } })); if (/\\/api\\/artifacts\\/[0-9a-f]{64}\\/readers/.test(u)) return Promise.resolve(new Response(JSON.stringify({ machine_owner: 'chris', owners: [{ kind: 'operator', id: 'chris', records: 3, teams: [{ id: 'coral-go-team', label: 'coral-go-team' }, { id: 'hub-team', label: 'hub-team' }], reason: 'it was uploaded here' }, { kind: 'hub_user', id: 'u-4812', records: 1, teams: [{ id: 'coral-go-team' }] }], linked_teams: [{ id: 'coral-hub', label: 'coral-hub' }, { id: 'docs', label: 'docs' }], note: 'A Coral control, not an operating-system boundary.' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                if (/\\/api\\/artifacts\\/[0-9a-f]{64}\\/private/.test(u)) return Promise.resolve(new Response(JSON.stringify({ id: ${JSON.stringify('d'.repeat(64))}, private: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return real(input, init); }; return true; })()`);
            const open = () => ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', mediaType: 'text/markdown', from: 'Orchestrator', goal: 'Distributed teams, one team across several Corals', goalId: 92, goalTeam: 'coral-go-team', task: 'Hub pass: ' + 'a long task title '.repeat(12) }))`);
            const state = () => ev(`(() => { const d = document.getElementById('artifact-viewer'), b = d.querySelector('.artifact-viewer-details, .details-toggle'), panel = d.querySelector('.artifact-viewer-readers'), hdr = d.querySelector('.artifact-viewer-header'), r = x => x && x.getBoundingClientRect();
                return { btn: !!b, inHeader: !!b && hdr.contains(b), inMenu: !!b && !!b.closest('.artifact-viewer-menu'), btnShown: !!b && b.getClientRects().length > 0 && !b.hidden, btnH: b ? Math.round(r(b).height) : 0, expanded: b && b.getAttribute('aria-expanded'), panelShown: !!panel && !panel.hidden && panel.getClientRects().length > 0, panelH: panel && !panel.hidden ? Math.round(r(panel).height) : 0, win: innerHeight }; })()`);
            await open();
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body') && document.querySelector('#artifact-viewer .details-toggle') && !document.querySelector('#artifact-viewer .details-toggle').hidden`, `${tag}: the Details button`, 8000);
            let s = await state();
            assert.ok(s.btnShown && s.inHeader && !s.inMenu, `${tag}: Details is a visible button in the header row, not in the menu: ${JSON.stringify(s)}`);
            assert.ok(s.btnH >= (mobile ? 44 : 28), `${tag}: it is a target (${s.btnH} px)`);
            assert.equal(s.expanded, 'false', `${tag}: closed to begin with`);
            const closed = await ev(`(() => { const v = document.getElementById('artifact-viewer'), g = v.querySelector('.artifact-viewer-goal'); return { goalShown: !!g && g.getClientRects().length > 0, above: Math.round(v.querySelector('.artifact-viewer-body').getBoundingClientRect().top - v.querySelector('.artifact-viewer-content').getBoundingClientRect().top) }; })()`);
            const fromPos = await ev(`(() => { const v = document.getElementById('artifact-viewer'), f = v.querySelector('.artifact-viewer-from'), t = v.querySelector('.artifact-viewer-title'), h = v.querySelector('.artifact-viewer-header'), r = e => e.getBoundingClientRect(); return { inHeader: !!f && h.contains(f), shown: !!f && f.getClientRects().length > 0, sameRow: Math.abs(r(f).top - r(t).top) <= 20, text: f.textContent.slice(0, 20) }; })()`);
            assert.ok(fromPos.inHeader && fromPos.shown && /Orchestrator/.test(fromPos.text), `${tag}: the From line is in the header row, not a line of its own: ` + JSON.stringify(fromPos));
            if (!mobile) assert.ok(fromPos.sameRow, `${tag}: and on the title's row: ` + JSON.stringify(fromPos));
            assert.ok(!closed.goalShown, `${tag}: closed, the goal is not in the header: ` + JSON.stringify(closed));
            assert.ok(closed.above <= (mobile ? 150 : 130), `${tag}: closed, the header is one title row and one line above the file (${closed.above} px)`);
            await ev(`document.querySelector('#artifact-viewer .details-toggle').click(); true`);
            s = await state();
            assert.ok(s.panelShown && s.expanded === 'true', `${tag}: the button opens it: ${JSON.stringify(s)}`);
            assert.ok(s.panelH <= s.win * 0.25 + 2, `${tag}: open, it is at most a quarter of the window (${s.panelH} of ${s.win}): ${JSON.stringify(s)}`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-readers-body p') && !!document.querySelector('#artifact-viewer .artifact-private-field input')`, `${tag}: the readers and the guides block are in it`, 8000);
            const L = await ev(`(() => { const v = document.getElementById('artifact-viewer'), r = e => e.getBoundingClientRect(), chips = [...v.querySelectorAll('.detail-chips .detail-chip')], box = v.querySelector('.artifact-private-field input'), title = v.querySelector('.artifact-private-title'), panel = v.querySelector('.artifact-viewer-readers'), hdr = v.querySelector('.artifact-viewer-body');
                return { chips: chips.map(c => c.textContent.trim().slice(0, 12) + ':' + Math.round(r(c).height)), readers: [...v.querySelectorAll('.artifact-readers-body p')].map(p => p.textContent.slice(0, 30)), besideLabel: r(box).right <= r(title).left + 1 && Math.abs(r(box).top - r(title).top) <= 16, boxW: Math.round(r(box).width), above: Math.round(r(hdr).top - v.querySelector('.artifact-viewer-content').getBoundingClientRect().top), panelScrolls: panel.scrollHeight >= panel.clientHeight }; })()`);
            assert.ok(L.chips.length === 2 && L.chips[0].startsWith('Goal:') && L.chips[1].startsWith('Task:'), `${tag}: the goal and the task are chips: ` + JSON.stringify(L));
            assert.ok(L.chips.every(c => Number(c.split(':').pop()) <= (mobile ? 48 : 34)), `${tag}: each chip is one line: ` + JSON.stringify(L.chips));
            const B = await ev(`(() => { const v = document.getElementById('artifact-viewer'), panel = v.querySelector('.artifact-viewer-readers'), pr = panel.getBoundingClientRect(); return { scrollW: panel.scrollWidth, clientW: panel.clientWidth, outside: [...panel.querySelectorAll('.detail-chip')].filter(c => c.getBoundingClientRect().right > pr.right + 1).map(c => c.textContent.slice(0, 12)), titled: [...panel.querySelectorAll('.detail-chip')].every(c => !!c.title), page: document.documentElement.scrollWidth <= innerWidth }; })()`);
            assert.ok(B.scrollW <= B.clientW + 1 && B.outside.length === 0 && B.page, `${tag}: a long goal and a long task stay inside the panel, no sideways scroll for metadata: ` + JSON.stringify(B));
            assert.ok(B.titled, `${tag}: and the whole words are in each chip's title`);
            assert.ok(L.readers.length >= 4 && /the Operator/.test(L.readers[0]), `${tag}: who can read this is listed: ` + JSON.stringify(L.readers));
            const row = await ev(`(() => { const v = document.getElementById('artifact-viewer'), a = v.querySelector('.artifact-readers').getBoundingClientRect(), b = v.querySelector('.artifact-private').getBoundingClientRect(); return { sameRow: Math.abs(a.top - b.top) <= 12 && a.right <= b.left + 2, stacked: b.top >= a.bottom - 2 }; })()`);
            if (!mobile) assert.ok(row.sameRow, `${tag}: who can read this and the Guides switch are one row: ` + JSON.stringify(row)); else assert.ok(row.sameRow || row.stacked, `${tag}: tight on a phone: ` + JSON.stringify(row));
            assert.ok(L.besideLabel && L.boxW <= 24, `${tag}: the Guides checkbox is beside its label (${L.boxW} px wide): ` + JSON.stringify(L));
            await shot(`viewer-details-open-${w}`);
            await ev(`document.querySelector('#artifact-viewer .details-toggle').click(); true`);
            s = await state();
            assert.ok(!s.panelShown && s.expanded === 'false', `${tag}: the same button closes it: ${JSON.stringify(s)}`);
            await ev(`document.querySelector('#artifact-viewer .details-toggle').click(); true`); // left open, then the viewer is closed and opened again
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await open();
            await waitFor(`document.querySelector('#artifact-viewer .details-toggle') && !document.querySelector('#artifact-viewer .details-toggle').hidden`, `${tag}: the Details button again`, 8000);
            s = await state();
            assert.ok(!s.panelShown && s.expanded === 'false', `${tag}: opened again, it is closed (an open Details is not remembered into the next file): ${JSON.stringify(s)}`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        }
        console.log('PASS the file viewer: Details is a header button, closed on every open and at most a quarter of the window');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
