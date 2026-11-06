// #13144 (UI Accessibility's gap on the icon fix): the kind icon sets no row height on ANY kind of Needs you row, not only the agent's: a file for review (with a question and without) and an operator's question, on a
// computer, at 100% text and at real 200% text (root 32 px). For each row, its height with the icon and with the icon hidden must be the same, and the icon must be inside its row, in front of the words, not over them.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    try {
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 1, y: 1 });
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`fetch('/api/board/qn/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
            const hex = n => n.toString(16).padStart(64, '0');
            const item = (i, name, q) => ({ id: hex(i), name, media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), uploaded_by: 'Writer', review_question: q });
            window.__items = [item(1, 'plan-a.md', 'Which port should the test server use?'), item(2, 'plan-b.md', '')];
            window.__asks = [{ board: 'qn', kind: 'ask', id: 7, asker: 'Writer', text: 'May I rename the folder?', at: new Date(Date.now() - 120000).toISOString() }, { board: 'qn', kind: 'ask', id: 8, asker: 'Writer', text: 'Before I rename the folder and move every file in it to the new place, should the old links keep working through a redirect, and who is told about the change when it lands, and may I also delete the empty directories that are left behind afterwards?', at: new Date(Date.now() - 90000).toISOString() }];
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/operator-asks') return json(window.__asks);
                if (u.pathname !== '/api/board/qn/artifacts') return original(url, opts);
                return json({ project: 'qn', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 4`, 'the review rows and the questions', 20000);
        // #13701: the icon owns a full-height gutter; every preview starts beyond it.
        for (const width of [1280, 390, 320, 1440]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
            await ev(framesJs(8));
            const geometry = await ev(`(() => [...document.querySelectorAll('${T} tbody .dt-row')].map(tr => {
                const icon = tr.querySelector('.inbox-kind-icon'); if (!icon) return null;
                const i = icon.getBoundingClientRect(), r = tr.getBoundingClientRect();
                const texts = [...tr.querySelectorAll('.dt-subtitle, .inbox-review-name, .inbox-review-from, .inbox-proposal-body')].filter(e => e.getClientRects().length);
                return { kind: icon.dataset.kind, center: Math.abs((i.top + i.bottom - r.top - r.bottom) / 2), right: i.right, textLeft: Math.min(...texts.map(e => e.getBoundingClientRect().left)) };
            }).filter(Boolean))()`);
            for (const r of geometry) {
                check(r.center <= 2, width + 'px: icon centered on full row: ' + JSON.stringify(r));
                check(r.textLeft >= r.right + 4, width + 'px: excerpt clears icon column: ' + JSON.stringify(r));
            }
            if ([390, 1280].includes(width) && process.env.CORAL_SCREENSHOT_DIR) {
                const fs = require('node:fs'), dir = process.env.CORAL_SCREENSHOT_DIR; fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(dir + '/needs-kind-column-' + width + '.png', Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            }
        }
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const [zoom, label] of [['100%', '100% text'], ['200%', '200% text']]) {
            await ev(`document.documentElement.style.fontSize = '${zoom}'; true`); await ev(framesJs(6));
            const rows = await ev(`(() => [...document.querySelectorAll('${T} tbody tr')].map(tr => { const i = tr.querySelector('.inbox-kind-icon'); if (!i) return { kind: null, text: tr.textContent.slice(0, 30) };
                const h = () => tr.getBoundingClientRect().height, withIcon = h(); const par = i.parentElement, nxt = i.nextSibling; i.remove(); const without = h(); par.insertBefore(i, nxt);
                const ir = i.getBoundingClientRect(), r = tr.getBoundingClientRect(), words = tr.querySelector('.inbox-review-name, .inbox-review-from, .dt-primary, a, button:not(.dt-mail-lead)'), wr = words ? words.getBoundingClientRect() : null;
                return { kind: i.dataset.kind, text: tr.textContent.replace(/\\s+/g, ' ').slice(0, 40), withIcon, without, inRow: ir.top >= r.top - 1 && ir.bottom <= r.bottom + 1 && ir.left >= r.left - 1, beforeWords: !wr || ir.right <= wr.left + 1 }; }))()`);
            const kinds = new Set(rows.map(r => r.kind).filter(Boolean));
            check(kinds.has('review') && kinds.has('other') || kinds.has('review') && rows.some(r => r.kind && r.kind !== 'review'), label + ': the list has a review row and a question row: ' + JSON.stringify(rows.map(r => [r.kind, r.text])));
            for (const r of rows.filter(x => x.kind)) {
                check(Math.abs(r.withIcon - r.without) < 0.01, `${label}: a ${r.kind} row keeps its height (${r.withIcon} with the icon, ${r.without} without): ${r.text}`);
                check(r.inRow && r.beforeWords, `${label}: a ${r.kind} row's icon is inside the row and in front of its words, not over them: ${JSON.stringify(r)}`);
            }
        }
        // a phone (#13144, the Orchestrator's 12:07): the words of a row never lie over one another, in both themes. Every element that carries its own text is a box; no two boxes of one row intersect.
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await ev(`document.documentElement.style.fontSize = '100%'; true`);
        // the same rows are as tall at 390 with the icon as without it: a review row's file name stays on its first line (#13144, UI Reviewer)
        await ev(framesJs(6));
        const tall = await ev(`(() => [...document.querySelectorAll('${T} tbody tr')].map(tr => { const i = tr.querySelector('.inbox-kind-icon'); if (!i) return null; const h = () => Math.round(tr.getBoundingClientRect().height * 100) / 100, w = h(); const par = i.parentElement, nxt = i.nextSibling; i.remove(); const wo = h(); par.insertBefore(i, nxt); const lt = e => { const rg = document.createRange(); const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let tn = w.nextNode(); while (tn && !tn.textContent.trim()) tn = w.nextNode(); if (!tn) return null; rg.selectNodeContents(tn); /* the first visible text node, not a screen-reader-only span */ const r = [...rg.getClientRects()].find(x => x.width > 0 && x.height > 0); return r ? r.top : null; }; const fromEl = tr.querySelector('.inbox-review-from'), nameEl = tr.querySelector('.inbox-review-name'), sameLine = fromEl && nameEl && i.dataset.kind === 'review' ? lt(fromEl) < lt(nameEl) - 6 : null; /* #13829: on a phone the sender is line one and the file name line two, under it */ const nm = tr.querySelector('.inbox-review-name, .dt-subtitle'); return { kind: i.dataset.kind, sameLine, line: (nm && parseFloat(getComputedStyle(nm).lineHeight)) || 20, text: tr.textContent.replace(/\\s+/g, ' ').slice(0, 30), withIcon: w, without: wo }; }).filter(Boolean))()`);
        // a question's name may take two lines on a phone by design (#11894), so an icon that takes width can push a title near the wrap point onto its second line: a question row may be at most ONE line taller (a runaway change still fails); every other kind keeps its height exactly
        for (const r of tall) {
            if (r.kind === 'review') check(r.sameLine === true, `390 px: in a review row the sender is line one and the file name line two, under it: ${r.text}`);
            const room = r.kind === 'other' || r.kind === 'ask' ? r.line + 1 : 0.5;
            check(r.withIcon >= r.without - 0.5 && r.withIcon - r.without < room, `390 px: a ${r.kind} row keeps its height with the icon${r.kind === 'other' || r.kind === 'ask' ? ' (a question: at most one more line)' : ''} (${r.withIcon} with, ${r.without} without): ${r.text}`);
        }
        const { themeJs } = require('./helpers/theme');
        for (const theme of ['dark', 'light']) {
            await ev(`${themeJs(theme)}; true`); await ev(framesJs(8));
            const clashes = await ev(`(() => { const out = []; for (const tr of document.querySelectorAll('${T} tbody tr')) {
                const boxes = []; const walker = document.createTreeWalker(tr, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (!n.textContent.trim()) continue; const e = n.parentElement; if (!e || !e.getClientRects().length || !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue; const pb = e.getBoundingClientRect(); if (pb.width <= 2 || pb.height <= 2) continue; /* a screen-reader-only word (', unread') is a 1 px box, not text the eye sees */
                    const rg = document.createRange(); rg.selectNodeContents(n); for (const r0 of rg.getClientRects()) { if (!(r0.width > 0 && r0.height > 0)) continue;
                        // only the part the eye sees: cut by every ancestor that clips (an ellipsis, a line clamp), up to the row
                        let l = r0.left, t = r0.top, rt = r0.right, b = r0.bottom; for (let a = e; a && a !== tr.parentElement; a = a.parentElement) { const ov = getComputedStyle(a); if (ov.overflowX !== 'visible' || ov.overflowY !== 'visible') { const c = a.getBoundingClientRect(); if (ov.overflowX !== 'visible') { l = Math.max(l, c.left); rt = Math.min(rt, c.right); } if (ov.overflowY !== 'visible') { t = Math.max(t, c.top); b = Math.min(b, c.bottom); } } }
                        if (rt - l > 1 && b - t > 1) boxes.push({ t: n.textContent.trim().slice(0, 24), r: { left: l, top: t, right: rt, bottom: b } }); } }
                for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { if (boxes[i].t === boxes[j].t) continue; const a = boxes[i].r, b = boxes[j].r, w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (w > 2 && h > 3) out.push(boxes[i].t + ' x ' + boxes[j].t + ' (' + Math.round(w) + 'x' + Math.round(h) + ')'); } }
                return out; })()`);
            // a long question (three lines or more) is clamped to two: the third line must not show in the name's padding (the 44 px target is padding; the clamp clips at the padding edge)
            const leaks = await ev(`(() => [...document.querySelectorAll('${T} .inbox-ask-name')].map(e => { const cs = getComputedStyle(e), r = e.getBoundingClientRect(), contentBottom = r.bottom - parseFloat(cs.paddingBottom); const rg = document.createRange(); rg.selectNodeContents(e);
                const shown = [...rg.getClientRects()].filter(x => x.width > 0 && x.height > 0 && x.top < r.bottom - 1 && x.bottom > contentBottom + 2 && x.top >= contentBottom - 1); return shown.length ? { text: e.textContent.slice(0, 30), lineTop: Math.round(shown[0].top), contentBottom: Math.round(contentBottom), paddingBottom: Math.round(r.bottom) } : null; }).filter(Boolean))()`);
            // and its box is exactly two lines (the Orchestrator's 13:27): not three lines, not one; it has no padding, so no part of a third line has anywhere to show
            const longBox = await ev(`(() => { const e = [...document.querySelectorAll('${T} .inbox-ask-name')].find(x => x.textContent.startsWith('Before I rename')); if (!e) return null; const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return { h: Math.round(r.height * 100) / 100, line: parseFloat(cs.lineHeight) || null, padTop: parseFloat(cs.paddingTop), padBottom: parseFloat(cs.paddingBottom), lines: Math.round((r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / (parseFloat(cs.lineHeight) || 18)) }; })()`);
            check(!!longBox && longBox.lines === 2 && longBox.padTop + longBox.padBottom === 0, `390 px, ${theme}: a four-line question is clamped to exactly two lines, with no padding for a third to show in: ` + JSON.stringify(longBox));
            check(leaks.length === 0, `390 px, ${theme}: a clamped question shows no part of a third line in its padding: ` + JSON.stringify(leaks));
            check(clashes.length === 0, `390 px, ${theme}: no two texts of a Needs you row overlap: ` + JSON.stringify(clashes));
        }
        // The all-agent phone list uses the mail renderer, including answer choices.
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(require('./helpers/inbox_world').INBOX_WORLD);
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Which temperature unit?', ask_id: 'temperature', multi: false, options: ['Celsius', 'Fahrenheit', 'Kelvin'].map((label, i) => ({ n: i + 1, label, action: 'select' })) } }), { headers: { 'content-type': 'application/json' } })) : real(u, o); return true; })()`);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.liveSessions = [{ name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Which temperature unit?', waiting_since: new Date().toISOString(), waiting_choices: ['Celsius', 'Fahrenheit', 'Kelvin'] }]; const m = await import(${S} + 'inbox_tab.js'); m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
        await waitFor(`document.querySelector('${T} .dt-mail-kind') && document.querySelectorAll('${T} .inbox-answer').length === 3`, 'the agent phone mail row', 15000);
        for (const width of [390, 320]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: true }); await ev(framesJs(8));
            const row = await ev(`(() => { const tr = document.querySelector('${T} .dt-mailed'), i = tr.querySelector('.inbox-kind-icon').getBoundingClientRect(), r = tr.querySelector('.dt-mail-open').getBoundingClientRect(), text = tr.querySelector('.dt-mail-text').getBoundingClientRect(); return { center: Math.abs((i.top + i.bottom - r.top - r.bottom) / 2), right: i.right, textLeft: text.left, overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
            check(row.center <= 2 && row.textLeft >= row.right + 4 && !row.overflow, width + 'px: phone gutter spans title/excerpt; choices use the full row: ' + JSON.stringify(row));
        }
        for (const theme of ['dark', 'light']) {
            await ev(`${themeJs(theme)}; true`); await ev(framesJs(4));
            const contrast = await ev(`(async () => { const NF = await import(${S} + 'needs_filters.js'); const channel = x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }; const lum = c => { const rgb = c.match(/[\\d.]+/g).map(Number); return channel(rgb[0]) * .2126 + channel(rgb[1]) * .7152 + channel(rgb[2]) * .0722; }; return NF.KINDS.map(k => { const i = NF.kindIcon({ waiting_kind: k }); document.body.append(i); const cs = getComputedStyle(i), a = lum(cs.color), b = lum(cs.backgroundColor); i.remove(); return { kind: k, ratio: (Math.max(a,b) + .05) / (Math.min(a,b) + .05) }; }); })()`);
            for (const c of contrast) check(c.ratio >= 4.5, theme + ': AA kind tile contrast: ' + JSON.stringify(c));
        }
    } finally { await removeBoards(ev, ['qn']).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_kind_icons_rows_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
