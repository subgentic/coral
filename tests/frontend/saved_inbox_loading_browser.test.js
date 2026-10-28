// The Inbox's Saved for later folder while its list loads (#7431, the operator: "loads one screen, then switches to another"; UI/UX's acceptance list and frame sampler; #9929 removed the top bar's bookmark that
// used to open it): opened from the Inbox, the Saved table's chips and the search keep their place while the list loads (one line "Loading saved items", then the rows), the page never scrolls, nothing is wider
// than the screen, and a list that cannot be read says so without a "Loading" line. Over CDP, 30 saved items so a scroll would show, the Saved route held back to see the loading state.
// 1280 and 390 px. Run by run_cdp_suites.mjs (CDP suites are found by name).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { OPEN_INBOX_SAVED } = require('./helpers/open_inbox_saved');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    // Saved's Open and Done are the page toolbar's pills (#8602), in its one header row (#8700; a phone has the choice in the Filters sheet): the row is the strip the sampler follows.
    // The frames from now: the state on every animation frame, kept when it changes (the sampler of UI/UX's note).
    const SAMPLE = `(() => { window.__frames = []; const vis = e => e && !e.hidden && e.getClientRects().length;
        const snap = () => { const nav = document.querySelector('.top-nav-tab.active'); const t = document.getElementById('group-table-view'); const shown = !!vis(t) && /^hub-inbox:/.test(t.dataset.group); const group = shown ? t.dataset.group.split(':')[1] : '';
            const chips = [...t.querySelectorAll('.group-table-chips, .inbox-folder-toolbar .list-bar-search-row')].find(vis); const search = document.getElementById('inbox-search');
            const k = { nav: nav && nav.textContent.trim().replace(/\\s*\\d+$/, ''), inbox: shown || !!vis(document.getElementById('inbox-view')), group, savedPanel: shown && group === 'saved',
                stripTop: chips && vis(chips) ? Math.round(chips.getBoundingClientRect().top) : null, searchTop: search && vis(search) ? Math.round(search.getBoundingClientRect().top) : null, scrollTop: (() => { let n = 0; for (let e = t; e; e = e.parentElement) n += Math.round(e.scrollTop); return n; })(), // the table and every scroller round it
                loading: shown && /Loading saved items/.test(t.textContent) };
            const last = window.__frames[window.__frames.length - 1]; if (!last || JSON.stringify(last.k) !== JSON.stringify(k)) window.__frames.push({ t: Math.round(performance.now() - window.__t0), k }); };
        window.__t0 = performance.now(); window.__sampling = true; const loop = () => { snap(); if (window.__sampling) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return true; })()`; // raf-ok: the sampler is the test: it records every frame of a visible page (a hidden one records none and the Inbox-frames assertion fails loudly)
    const frames = async () => { await ev(`window.__sampling = false; true`); return JSON.parse(await ev(`JSON.stringify(window.__frames)`)); };
    const open = async (w, h, mobile, start) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`localStorage.removeItem('coral.inbox.tab'); true`);
        await ev(`window.__coralReady.startup('liveList', 'inbox')`).catch(() => {}); await sleep(1000); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
        if (start) { await ev(`window.switchNavTab('hub-inbox'); true`); await sleep(500); await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('${start}')).then(() => true)`); await sleep(500); await ev(`window.switchNavTab('agents'); true`); await sleep(300); } // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
        if (start === 'needs' || !start) await ev(`window.switchNavTab('agents'); true`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const it of (await api('GET', '/api/saved')).body.items) await api('DELETE', `/api/saved/${it.id}`);
        for (let i = 1; i <= 30; i++) { const r = await api('POST', '/api/saved', { kind: 'agent', ref: 'sv-a', key: i.toString(16).padStart(20, '0'), agent_type: 'claude', title: 'sv-a', snippet: `A message kept for later, number ${i}`, said_at: '2026-10-17T08:00:00Z' }); assert.equal(r.status, 200, JSON.stringify(r)); }

        for (const [w, h, mobile, tag] of [[1280, 900, false, '1280'], [390, 844, true, '390']]) {
            // a slow list: the chips and the search keep their tops, one line says it is loading, then the list fills in without moving them
            await open(w, h, mobile, '');
            await ev(`(() => { const real = window.fetch; window.fetch = async (u, o) => { if (/^\\/api\\/saved(\\?|$)/.test(String(u)) && (!o || !o.method || o.method === 'GET')) await new Promise(r => setTimeout(r, 800)); return real(u, o); }; return true; })()`); // sleep-ok: the held-back saved list is the point of the case
            await ev(SAMPLE); await ev(OPEN_INBOX_SAVED); await sleep(2500); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
            const slow = await frames(); const shown = slow.filter(f => f.k.inbox && f.k.savedPanel);
            assert.ok(shown.some(f => f.k.loading), `${tag}: while the list loads the Saved tab says "Loading saved items"`);
            assert.equal(new Set(shown.filter(f => f.k.stripTop !== null).map(f => f.k.stripTop)).size, 1, `${tag}: the chips do not move while the list loads`);
            assert.ok(new Set(shown.filter(f => f.k.searchTop !== null).map(f => f.k.searchTop)).size <= 1, `${tag}: the search does not move when the list arrives (${JSON.stringify([...new Set(shown.map(f => f.k.searchTop))])})`);
            assert.ok(slow.every(f => f.k.scrollTop === 0), `${tag}: the page does not scroll while it loads or after`);
            assert.ok(await ev(`document.querySelectorAll('#group-table-view tbody tr').length >= 30`), `${tag}: the list fills in`);
            if (mobile) assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, 'nothing scrolls sideways at 390');
        }
        // a list that cannot be read: the loading line is gone and the error is said (the screen does not say it is loading and that it failed)
        await open(1280, 900, false, '');
        await ev(`(() => { const real = window.fetch; window.__realFetch = real; window.fetch = async (u, o) => { if (/^\\/api\\/saved(\\?|$)/.test(String(u)) && (!o || !o.method || o.method === 'GET')) return new Response('{}', { status: 500 }); return real(u, o); }; return true; })()`);
        await ev(OPEN_INBOX_SAVED); await waitFor(`/Could not read the saved messages/.test(document.getElementById('group-table-view').textContent)`, 'the error line', 8000);
        assert.equal(await ev(`/Loading saved items/.test(document.getElementById('group-table-view').textContent)`), false, 'a rejected list leaves no "Loading saved items" line under the error');
        console.log('PASS the Inbox\'s Saved folder keeps its place while it loads');
    } finally { try { await ev('if (window.__realFetch) window.fetch = window.__realFetch; true'); /* the list read above is rejected on purpose: put the real fetch back so the cleanup can read and delete what the test saved */ for (const it of (await api('GET', '/api/saved')).body.items) await api('DELETE', `/api/saved/${it.id}`); } catch { /* the page is gone */ } await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
