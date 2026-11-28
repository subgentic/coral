// A phone's Needs you row is as tall as its content (#11858, from the Hub parity comparison #11857): no empty line under the question (the old table's empty cells and 44 px targets used to add about 40 px), on the Needs you
// list (article.nl-row.nl-file, #22094): each row's last line (the file's question under its name in .nl-file-open) ends at the row's padding, the time since (time.nl-when) is at the right of the file name and whole, and rows with
// different names read differently (the name has room, on every row). Five For review files (two read) in their group (opened: a group starts folded unless it holds a question), 390 and 412 px, light and dark. Drives Chrome
// through agent_view_harness.js against the isolated dev server; CORAL_SCREENSHOT_DIR saves the pictures.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], team = 'rowh-' + Date.now().toString(36), T = '#group-table-view .needs-ledger', S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [390, 412]) for (const theme of ['light', 'dark']) {
            const at = `${w} px, ${theme}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0'), ago = m => new Date(Date.now() - m * 60000).toISOString();
                const f = (i, by, name, q, min, read) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: ago(min), source: 'upload', available: true, tags: read ? ['for review', 'read'] : ['for review'], produced_by: by, review_question: q, uri: 'coral://artifacts/' + hex(i) });
                const items = [f(1, 'A very long agent name', 'A very long file name that has to be cut off somewhere', 'Ready to ship?', 5), f(2, 'Designer', 'Phone layout for the Goals list', 'Approve this phone layout for the Goals list?', 42), f(3, 'Writer', 'Billing page copy', 'Is this wording right for the billing page? It has to match the pricing page.', 190), f(4, 'Lead', 'Release notes v2.0.23', 'Anything to add before this goes out?', 1440, true), f(5, 'QA', 'Plan', 'Is the test plan complete?', 2880, true)];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .nl-row').length >= 5`, at + 'five rows', 15000); await ev(`document.querySelectorAll('${T} .nl-group-toggle[aria-expanded=false]').forEach(b => b.click()); true`); await ev(framesJs(6));
            const rows = await ev(`(() => {
                return [...document.querySelectorAll('${T} .nl-row')].map(tr => { const b = tr.getBoundingClientRect(), nm = tr.querySelector('.nl-file-open'), wt = tr.querySelector('.nl-when'), pad = parseFloat(getComputedStyle(tr).paddingBottom) + parseFloat(getComputedStyle(tr).borderBottomWidth);
                    const lowest = Math.max(...[...tr.querySelectorAll('.nl-title, .nl-file-open > *, .nl-side > *, .nl-check-hit, :scope > .nl-icon')].filter(t => t.getClientRects().length && t.getBoundingClientRect().height > 0).map(t => t.getBoundingClientRect().bottom));
                    const nb = nm.getBoundingClientRect(), tn = [...nm.childNodes].find(n => n.nodeType === 3); let seen = ''; if (tn) for (let k = 0; k < tn.length; k++) { const rg = document.createRange(); rg.setStart(tn, k); rg.setEnd(tn, k + 1); const qb = rg.getBoundingClientRect(); if (qb.width && qb.right <= nb.right + 0.5 && qb.bottom <= nb.bottom + 1) seen += tn.data[k]; }
                    const q = nm.querySelector('.nl-meta'), qr = q?.getBoundingClientRect(), wr = wt.getBoundingClientRect(); return { name: tn ? tn.data : '', seen, h: Math.round(b.height), tail: Math.round(b.bottom - lowest - pad), q: q ? q.textContent : null, qBelow: !!qr && qr.top >= nb.top + 1, nameRight: Math.round(nb.right), nameTop: Math.round(nb.top), nameBottom: Math.round(nb.bottom), waitLeft: Math.round(wr.left), waitTop: Math.round(wr.top), waitBottom: Math.round(wr.bottom), rowTop: Math.round(b.top), rowBottom: Math.round(b.bottom), waitText: wt.textContent, waitCut: wt.scrollWidth > wt.clientWidth + 1 }; }); })()`);
            rows.forEach((r, i) => {
                check(r.h >= 44 && r.q && r.qBelow, `${at}row ${i + 1} holds its name and its question under it: ${JSON.stringify(r)}`);
                check(r.tail >= -1 && r.tail <= 2, `${at}row ${i + 1} is as tall as its content: no empty line below its lowest line (only the row's own padding, #11858): ${JSON.stringify(r)}`);
                check(r.waitLeft >= r.nameRight - 1 && r.waitTop >= r.rowTop && r.waitBottom <= r.rowBottom && /ago$/.test(r.waitText), `${at}row ${i + 1}: the time since is at the right of the file name, in the row (#20239, #22094): ${JSON.stringify(r)}`);
                check(!r.waitCut, `${at}row ${i + 1}: the wait text is not cut: ${JSON.stringify(r)}`);
            });
            const seen = rows.map(r => r.seen); check(new Set(rows.map(r => r.name)).size === rows.length ? new Set(seen).size === seen.length && seen.every(t => t.length >= 4) : true, `${at}review rows with different names show different visible text (the file name has room): ${JSON.stringify(rows.map(r => [r.name, r.seen]))}`);
            await shot(`needs-phone-rows-${w}-${theme}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_phone_row_height_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
