// The top bar's Saved for later button and the Inbox tab are one screen (#7431, the operator: "jumps to a different screen than if you click on Inbox directly" and "loads one screen, then switches to another";
// UI/UX's acceptance list and frame sampler), on the sidebar Inbox (#7472). The bookmark only selects the Saved group of the same Inbox and remembers it as the last group; the Inbox tab then opens on that group. No frame
// shows another group first, the page never scrolls, the focus ring shows only after a key, and the Saved table's chips and the search keep their place while the list loads (one line "Loading saved items", then the rows).
// Real mouse and key events over CDP, 30 saved items so a scroll would show, the Saved route held back to see the loading state. 1280 and 390 px. Run by run_cdp_suites.mjs (CDP suites are found by name).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const { Input } = client;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const click = async sel => { // a real mouse click on the element's centre
        const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await Input.dispatchMouseEvent({ type, x: r.x, y: r.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    };
    // Under 640 px the top row is one hamburger (#9021) and the bookmark is its "Saved for later" entry: the same intent, the same real mouse click and key.
    const SAVED_ENTRY = '#nav-more-menu:not([hidden]) [data-on-click="m-show-saved"]';
    const bookmark = async mobile => { if (!mobile) return click('#saved-btn'); await click('#top-menu-btn'); await waitFor(`!!document.querySelector('${SAVED_ENTRY}')`, 'the menu\'s Saved for later entry', 6000); await click(SAVED_ENTRY); };
    const KEYS = { Enter: [13, '\r'], Escape: [27] };
    const key = async k => { const [vk, text] = KEYS[k]; for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && text ? { text } : {}) }); };
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
    const ringOnFocus = () => ev(`(() => { const a = document.activeElement; return { id: a && (a.id || a.className || a.tagName), visible: !!a && a !== document.body && a.matches(':focus-visible') }; })()`);
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
            // 1 and 2: from Agents and from the Inbox's Needs you and Tasks groups, the bookmark (a real click) lands on Saved: no other group first, no scroll, one chips position
            for (const [name, start] of [['from Agents', ''], ['from the Inbox on Needs you', 'needs'], ['from the Inbox on Tasks', 'tasks']]) {
                await open(w, h, mobile, start);
                await ev(SAMPLE); await bookmark(mobile); await sleep(2000); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
                const fr = await frames(); const inbox = fr.filter(f => f.k.inbox);
                assert.ok(inbox.length > 0, `${tag} ${name}: the Inbox is shown`);
                assert.ok(inbox.every(f => f.k.group === '' || f.k.group === 'saved'), `${tag} ${name}: no frame shows another group before Saved (${JSON.stringify(inbox.map(f => f.k.group))})`);
                assert.ok(inbox.some(f => f.k.group === 'saved'), `${tag} ${name}: and Saved is shown`);
                assert.ok(fr.every(f => f.k.scrollTop === 0), `${tag} ${name}: the page does not scroll (${JSON.stringify([...new Set(fr.map(f => f.k.scrollTop))])})`);
                assert.equal(new Set(inbox.filter(f => f.k.stripTop !== null).map(f => f.k.stripTop)).size, 1, `${tag} ${name}: the chips are in one place`);
                // 3: no ring after a mouse click
                const ring = await ringOnFocus(); assert.equal(ring.visible, false, `${tag} ${name}: no focus ring after a mouse click (${JSON.stringify(ring)})`);
            }
            // The Inbox tab afterwards opens on the same group (the bookmark's choice is the last group) at the same place
            await open(w, h, mobile, 'needs');
            await bookmark(mobile); await sleep(1500); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
            const viaBookmark = await ev(`({ group: document.getElementById('group-table-view').getClientRects().length ? (document.getElementById('group-table-view').dataset.group || '').split(':')[1] : '', scroll: (() => { let n = 0; for (let e = document.getElementById('group-table-view'); e; e = e.parentElement) n += Math.round(e.scrollTop); return n; })(), top: document.getElementById('group-table-view').getClientRects().length ? Math.round(document.querySelector('#group-table-view .group-table-chips, #group-table-view .inbox-folder-toolbar .team-tb-pills, #group-table-view .inbox-folder-toolbar .list-bar-search-row').getBoundingClientRect().top) : null })`);
            await ev(`window.switchNavTab('agents'); true`); await sleep(400); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
            if (mobile) await ev(`window.switchNavTab('hub-inbox'); true`); else await click('#nav-tab-hub-inbox'); // a phone's navigation is not the top row: the switch is the same call
            await sleep(1500); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
            const viaTab = await ev(`({ group: document.getElementById('group-table-view').getClientRects().length ? (document.getElementById('group-table-view').dataset.group || '').split(':')[1] : '', scroll: (() => { let n = 0; for (let e = document.getElementById('group-table-view'); e; e = e.parentElement) n += Math.round(e.scrollTop); return n; })(), top: document.getElementById('group-table-view').getClientRects().length ? Math.round(document.querySelector('#group-table-view .group-table-chips, #group-table-view .inbox-folder-toolbar .team-tb-pills, #group-table-view .inbox-folder-toolbar .list-bar-search-row').getBoundingClientRect().top) : null })`);
            if (mobile) { // a phone's Inbox is a folder's table with the folders' select on top (#7785): the bookmark opens the Saved table, and the tab returns to the folder last on screen, which is Saved; neither scrolls
                assert.deepEqual([viaBookmark.group, viaTab.group, viaBookmark.scroll, viaTab.scroll], ['saved', 'saved', 0, 0], `${tag}: the bookmark opens the Saved table, the Inbox tab the folder last on screen`);
            } else assert.deepEqual(viaBookmark, viaTab, `${tag}: the bookmark and the Inbox tab land on the same screen`);
            assert.equal(viaBookmark.group, 'saved', `${tag}: and it is Saved`);

            // 3: after a key, the ring shows
            await open(w, h, mobile, '');
            if (mobile) { await ev(`document.getElementById('top-menu-btn').focus(); true`); await key('Enter'); await waitFor(`!!document.querySelector('${SAVED_ENTRY}')`, 'the menu', 6000); await ev(`document.querySelector('${SAVED_ENTRY}').focus(); true`); } else await ev(`document.getElementById('saved-btn').focus(); true`);
            const ringBefore = mobile ? await ringOnFocus() : null; // the menu closes on Enter and takes its focus with it: on a phone the ring is read on the entry, reached by the keyboard, before it is pressed
            await key('Enter'); await sleep(1500); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
            const kring = ringBefore || await ringOnFocus(); assert.equal(kring.visible, true, `${tag}: after Enter on the bookmark the focus ring shows (${JSON.stringify(kring)})`);

            // 4: a slow list: the chips and the search keep their tops, one line says it is loading, then the list fills in without moving them
            await open(w, h, mobile, '');
            await ev(`(() => { const real = window.fetch; window.fetch = async (u, o) => { if (/^\\/api\\/saved(\\?|$)/.test(String(u)) && (!o || !o.method || o.method === 'GET')) await new Promise(r => setTimeout(r, 800)); return real(u, o); }; return true; })()`); // sleep-ok: the held-back saved list is the point of the case
            await ev(SAMPLE); await bookmark(mobile); await sleep(2500); // sleep-ok: the frame sampler records for a fixed window and the page settles after a navigation: no event to wait for
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
        await click('#saved-btn'); await waitFor(`/Could not read the saved messages/.test(document.getElementById('group-table-view').textContent)`, 'the error line', 8000);
        assert.equal(await ev(`/Loading saved items/.test(document.getElementById('group-table-view').textContent)`), false, 'a rejected list leaves no "Loading saved items" line under the error');
        console.log('PASS the bookmark and the Inbox tab are one screen');
    } finally { try { await ev('if (window.__realFetch) window.fetch = window.__realFetch; true'); /* the list read above is rejected on purpose: put the real fetch back so the cleanup can read and delete what the test saved */ for (const it of (await api('GET', '/api/saved')).body.items) await api('DELETE', `/api/saved/${it.id}`); } catch { /* the page is gone */ } await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
