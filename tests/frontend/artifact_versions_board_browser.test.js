// The version bar asks for ITS OWN team's series (#13999, #14015): bytes two teams hold are two series on the computer, and GET /api/artifacts/<hex>/versions answers a request with no team with 409 ambiguous_series, naming the boards.
// So the viewer passes the team it is opened from as ?board=<name>; a direct link with no team gets the 409, which is no version bar and one quiet note (not an error toast), and the viewer stays usable; a file in one team's series, or
// with a team, is as it was. The same bytes on two teams with different series (and uploaders) are stubbed at the page's fetch. 1280 and 390 px. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H1, H2, H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
    // the stub's versions route is replaced: board=alpha and board=beta each hold their own series of the SAME bytes; no board is ambiguous
    const ROUTE = `(() => { const prev = window.fetch; window.__vreads = [];
        const rowsFor = (who, only) => (only ? [['${H2}', 1], ['${H3}', 2]] : [['${H1}', 1], ['${H2}', 2], ['${H3}', 3]]).map(([d, v], _, all) => ({ digest: d, version: v, versions: all.length, is_latest: v === all.length, name: 'release-plan.md', size: 9000 + v, media_type: 'text/markdown', at: new Date(Date.now() - (4 - v) * 3600000).toISOString(), uploader: 'x', role: who }));
        window.fetch = (u, o) => { const url = new URL(String(u), location.origin), m = /^\\/api\\/artifacts\\/([0-9a-f]{64})\\/versions$/.exec(url.pathname);
            if (m) { const board = url.searchParams.get('board') || ''; window.__vreads.push(board);
                const json = (b, status) => Promise.resolve(new Response(JSON.stringify(b), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
                if (board === 'alpha') return json(rowsFor('QA Engineer'));
                if (board === 'beta') return json(rowsFor('Backend Dev', true));
                if (board === 'solo') return json(rowsFor('Docs Writer'));
                if (board && window.__older) return json({ error: 'path not allowed', code: 'path_not_allowed' }, 403); // a computer on v2.0.58 behind a Hub: its versions route takes no query (#14317)
                if (!board && window.__hold) return new Promise(resolve => { window.__release = () => resolve(new Response(JSON.stringify({ error: 'x', code: 'ambiguous_series', boards: ['alpha', 'beta'] }), { status: 409, headers: { 'Content-Type': 'application/json' } })); }); // an older answer, held
                if (!board && window.__ambiguous) return json({ error: 'more than one team holds these bytes in a series: ask for one with ?board=', code: 'ambiguous_series', boards: ['alpha', 'beta'] }, 409);
                if (!board) return json(rowsFor('Docs Writer'));
                return json({ error: 'not found' }, 404); }
            return prev(u, o); };
        return true; })()`;
    const openV = async opts => { await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(H3)}, ${JSON.stringify({ filename: 'release-plan.md', ...opts })}); return true; })()`); await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, 'the document', 8000); await new Promise(r => setTimeout(r, 600)); }; // sleep-ok: the bar's read settles
    const closeV = async () => { await ev(`document.querySelector('#artifact-viewer [data-dialog-close], #artifact-viewer .artifact-viewer-close')?.click(); true`); await new Promise(r => setTimeout(r, 300)); }; // sleep-ok: the viewer closes
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(STUB); await ev(ROUTE); await ev(`window.__ambiguous = true; true`);
            // 1) opened from team alpha: the bar asks ?board=alpha and shows that team's series
            await openV({ board: 'alpha' });
            check(await ev(vis('#artifact-viewer .av-bar')), at + 'opened from team alpha the version bar is shown');
            check(JSON.stringify(await ev(`window.__vreads`)) === JSON.stringify(['alpha']), at + 'the version read named the team (?board=alpha): ' + JSON.stringify(await ev(`window.__vreads`)));
            check(!(await ev(`!!document.querySelector('#artifact-viewer .av-note:not([hidden])')`)), at + 'and there is no ambiguity note');
            await closeV();
            // 2) the same bytes opened from team beta: its own read, its own series
            await ev(`window.__vreads = []; true`);
            await openV({ board: 'beta' });
            check(await ev(vis('#artifact-viewer .av-bar')) && JSON.stringify(await ev(`window.__vreads`)) === JSON.stringify(['beta']), at + 'the same bytes from team beta ask ?board=beta and show its bar: ' + JSON.stringify(await ev(`window.__vreads`)));
            await closeV();
            // 3) a direct link, no team: the route answers 409; no bar, one quiet note, no error toast, and the viewer is usable
            await ev(`window.__vreads = []; true`);
            await openV({});
            check(!(await ev(vis('#artifact-viewer .av-bar'))), at + 'a direct link to bytes two teams hold has no version bar');
            const note = await ev(`(document.querySelector('#artifact-viewer .av-note') || {}).textContent || ''`);
            check(/more than one team/i.test(note) && (await ev(vis('#artifact-viewer .av-note'))), at + 'it says so quietly, once: ' + JSON.stringify(note));
            check(!(await ev(`[...document.querySelectorAll('.toast, [role=alert]')].some(e => e.getClientRects().length && /version|team|ambig|409/i.test(e.textContent))`)), at + 'and shows no error toast');
            check(JSON.stringify(await ev(`window.__vreads`)) === JSON.stringify(['']), at + 'the direct link asked once, with no team: ' + JSON.stringify(await ev(`window.__vreads`)));
            check(await ev(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown') && !document.querySelector('#artifact-viewer').hidden`), at + 'the viewer itself stays usable');
            await closeV();
            // 4) a direct link to bytes only one team holds (the route is not ambiguous): the bar is as it was
            await ev(`window.__ambiguous = false; window.__vreads = []; true`);
            await openV({});
            check(await ev(vis('#artifact-viewer .av-bar')), at + 'a direct link to bytes one team holds still shows its version bar (a route with no ambiguity answers as before)');
            await closeV();
            // 5) a note from one file does not follow the viewer to the next
            await ev(`window.__ambiguous = true; true`); await openV({}); await closeV(); await ev(`window.__ambiguous = false; true`); await openV({ board: 'solo' });
            check(!(await ev(`!!document.querySelector('#artifact-viewer .av-note:not([hidden])')`)) && (await ev(vis('#artifact-viewer .av-bar'))), at + 'opening another file clears the note and shows its bar');
            await closeV();
            // 6) the SAME viewer is reused without closing (held, switched): alpha, then beta, then a link with no team: each asks its own scope and shows its own rows, never the one before's
            const label = () => ev(`(document.querySelector('#artifact-viewer .av-current') || {}).getAttribute?.('aria-label') || ''`);
            await ev(`window.__ambiguous = true; window.__vreads = []; true`);
            await openV({ board: 'alpha' }); check(/v3 of 3/.test(await label()), at + 'alpha: v3 of 3: ' + await label());
            await openV({ board: 'beta' }); check(/v2 of 2/.test(await label()) && (await ev(`window.__vreads`)).slice(-1)[0] === 'beta', at + 'then beta, with no close: its own read and its own rows (v2 of 2), not alpha\'s: ' + await label() + ' ' + JSON.stringify(await ev(`window.__vreads`)));
            await openV({}); check(!(await ev(vis('#artifact-viewer .av-bar'))) && (await ev(vis('#artifact-viewer .av-note'))), at + 'then a link with no team, with no close: its own read (409): no bar, the note, not beta\'s rows');
            await openV({ board: 'alpha' }); check(/v3 of 3/.test(await label()) && !(await ev(vis('#artifact-viewer .av-note'))), at + 'and back to alpha: its rows, the note gone');
            await closeV();
            // 7) a bar that was valid when the polling sees a second team now hold the bytes: it goes, the note says why, and only for that file
            await ev(`window.__ambiguous = false; globalThis.__coralVersionsPollMs = 250; true`);
            await openV({});
            check(await ev(vis('#artifact-viewer .av-bar')), at + 'a direct link to bytes one team holds shows its bar');
            await ev(`window.__ambiguous = true; true`);
            await waitFor(`!${vis('#artifact-viewer .av-bar')} && ${vis('#artifact-viewer .av-note')}`, at + 'a second team now holds the bytes: the poll removes the bar and says why', 8000).catch(() => {});
            check(!(await ev(vis('#artifact-viewer .av-bar'))) && (await ev(vis('#artifact-viewer .av-note'))), at + 'the bar is gone and the note is there after the poll');
            await closeV();
            // 8) an older 409 cannot mutate a newer context: a direct link's answer is held, alpha is opened, then the old answer arrives
            await ev(`window.__hold = true; window.__ambiguous = true; globalThis.__coralVersionsPollMs = 100000; true`);
            await openV({}).catch(() => {}); // its read is held
            await openV({ board: 'alpha' });
            await ev(`window.__release && window.__release(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the old answer has had its turn
            check((await ev(vis('#artifact-viewer .av-bar'))) && !(await ev(vis('#artifact-viewer .av-note'))), at + 'an older 409 does not remove the newer file\'s bar or add a note');
            await ev(`window.__hold = false; window.__release = null; globalThis.__coralVersionsPollMs = 8000; true`);
            await closeV();
            // 9) an older computer refuses ?board= (#14317, Security's INFO 4): no bar, no guess at a series from the plain route, no error toast, one refused read and then none; a direct link with no team is read as before
            await ev(`window.__older = true; window.__ambiguous = false; window.__vreads = []; true`);
            await openV({ board: 'alpha' });
            check(!(await ev(vis('#artifact-viewer .av-bar'))), at + 'an older computer that refuses ?board= gets no version bar (a hidden bar is honest; the plain route would guess a series)');
            check(!(await ev(`[...document.querySelectorAll('.toast, [role=alert]')].some(e => e.getClientRects().length && /version|team|ambig|403|path/i.test(e.textContent))`)), at + 'and shows no error toast');
            check(JSON.stringify(await ev(`window.__vreads`)) === JSON.stringify(['alpha']), at + 'one read, the refused one, no plain second read: ' + JSON.stringify(await ev(`window.__vreads`)));
            await closeV();
            await openV({ board: 'alpha' });
            check(JSON.stringify(await ev(`window.__vreads`)) === JSON.stringify(['alpha']) && !(await ev(vis('#artifact-viewer .av-bar'))), at + 'the next file from that computer sends no read at all: ' + JSON.stringify(await ev(`window.__vreads`)));
            await closeV();
            await openV({});
            check(await ev(vis('#artifact-viewer .av-bar')), at + 'a direct link with no team carries no newer key and still shows its bar');
            await closeV();
            await ev(`window.__older = false; true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the version bar asks for its own team; a direct link to bytes two teams hold gets a quiet note');
})().catch(e => { console.error(e); process.exit(1); });
