// A phone's Needs you row is as tall as its content (#11858, from the Hub parity comparison #11857): no empty 44 px line under the question (the empty Waiting-for and Goal cells and the name's 44 px target used to add
// about 40 px, rows were 111 to 129 px, now 70 to 90), and (the Operator's decision, #13144) the wait text sits UNDER the file name so the name has the first line beside the sender and rows with different names read differently, on every row. Five For review files (two read), 390 and 412 px, light and
// dark. Drives Chrome through agent_view_harness.js against the isolated dev server; CORAL_SCREENSHOT_DIR saves the pictures.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], team = 'rowh-' + Date.now().toString(36), T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
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
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 5`, at + 'five rows', 15000); await ev(framesJs(6));
            const rows = await ev(`(() => { const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;font:600 100px ' + getComputedStyle(document.body).fontFamily; probe.innerHTML = 'Hxg<i style="display:inline-block;width:0;height:0"></i>'; document.body.append(probe);
                const pr = document.createRange(); pr.selectNodeContents(probe.firstChild); const pt = pr.getBoundingClientRect(), k = (probe.querySelector('i').getBoundingClientRect().bottom - pt.top) / pt.height; probe.remove(); // where the baseline sits in a text's own box (this font)
                const base = e => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.textContent.trim() ? 1 : 3) }), n = w.nextNode(), r = document.createRange(); r.selectNodeContents(n); const t = r.getBoundingClientRect(); return t.top + k * t.height; };
                return [...document.querySelectorAll('${T} tbody tr')].map(tr => { const b = tr.getBoundingClientRect(), nm = tr.querySelector('.inbox-review-name'), wt = tr.querySelector('td[data-key="waiting"]'), q = tr.querySelector('.dt-subtitle'), vis = [...tr.querySelectorAll('td')].filter(t => t.getClientRects().length && t.getBoundingClientRect().width > 0);
                    const wtext = wt.querySelector('*') && [...wt.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim()) || wt, lowest = Math.max(...vis.filter(t => !t.matches('[data-key="review"]')).map(t => t.getBoundingClientRect().bottom));
                    const nb = nm.getBoundingClientRect(), tn = [...nm.childNodes].find(n => n.nodeType === 3); let seen = ''; if (tn) for (let k = 0; k < tn.length; k++) { const rg = document.createRange(); rg.setStart(tn, k); rg.setEnd(tn, k + 1); const qb = rg.getBoundingClientRect(); if (qb.width && qb.right <= nb.right + 0.5 && qb.bottom <= nb.bottom + 1) seen += tn.data[k]; }
                    return { name: nm.textContent, seen, nameBottom: Math.round(nb.bottom), waitTop: Math.round(wtext.getBoundingClientRect().top), h: Math.round(b.height), nameBase: Math.round(base(nm) * 10) / 10, waitBase: Math.round(base(wtext) * 10) / 10, nameRight: Math.round(nm.getBoundingClientRect().right), waitLeft: Math.round(wtext.getBoundingClientRect().left), waitCut: wtext.scrollWidth > wtext.clientWidth + 1, gap: Math.round(b.bottom - lowest), q: !!q }; }); })()`);
            rows.forEach((r, i) => {
                check(r.h >= 60 && r.h <= 135, `${at}row ${i + 1} is as tall as its content (one line taller than before is the Operator's choice), 60 to 135 px: ${r.h}`);
                check(r.gap <= 12, `${at}row ${i + 1} has no empty line under its text (${r.gap} px below the last cell, 8 px padding): ${JSON.stringify(r)}`);
                check(r.waitTop >= r.nameBottom - 1, `${at}row ${i + 1}: "waiting N min" is under the file name, not beside it (name ends ${r.nameBottom}, wait starts ${r.waitTop})`);
                check(!r.waitCut, `${at}row ${i + 1}: the wait text is not cut: ${JSON.stringify(r)}`);
            });
            const seen = rows.map(r => r.seen); check(new Set(rows.map(r => r.name)).size === rows.length ? new Set(seen).size === seen.length && seen.every(t => t.length >= 4) : true, `${at}review rows with different names show different visible text (the file name has room): ${JSON.stringify(rows.map(r => [r.name, r.seen]))}`);
            await shot(`needs-phone-rows-${w}-${theme}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_phone_row_height_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
