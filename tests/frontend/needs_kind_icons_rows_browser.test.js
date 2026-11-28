// #13144 (UI Accessibility's gap on the icon fix): the kind icon sets no row height on ANY kind of Needs you row, not only the agent's: a file for review (with a question and without) and an operator's question, on a
// computer, at 100% text and at real 200% text (root 32 px). For each row of the approved list (#22094: article.nl-row, its icon span.material-icons.nl-icon in the leading column), its height with the icon and with the icon
// removed must be the same (a question or a file may take one more line), and the icon must be inside its row, in front of the words, not over them. On a phone no two texts of a row overlap, a long question is whole in its
// question box, an agent's question with choices keeps the icon's column, and every kind icon is AA against its background.
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
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'qn': window.__items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                if (u.pathname === '/api/operator-asks') return json(window.__asks);
                if (u.pathname !== '/api/board/qn/artifacts') return original(url, opts);
                return json({ project: 'qn', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false }); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        try { await waitFor(`[...document.querySelectorAll('${T} .nl-row')].filter(n => n.getClientRects().length).length >= 4`, 'the review rows and the questions', 20000); } catch (e) { throw new Error(e.message + ' ' + await ev(`JSON.stringify([...document.querySelectorAll('${T} .nl-row, ${T} .nl-group-toggle')].map(r => [r.className, r.getClientRects().length, r.textContent.slice(0, 60)]))`)); }
        const ICON = `:scope > .nl-icon, :scope > .inbox-kind-icon`, KIND = `(tr => tr.matches('.nl-file') ? 'review' : tr.matches('.nl-question') ? 'ask' : tr.matches('.nl-permission') ? 'permission' : 'other')`;
        // #13701: the icon owns a full-height gutter; every preview starts beyond it.
        for (const width of [1280, 390, 320, 1440]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
            await ev(framesJs(8));
            const geometry = await ev(`(() => [...document.querySelectorAll('${T} .nl-row')].map(tr => {
                const icon = tr.querySelector('${ICON}'); if (!icon) return null;
                const i = icon.getBoundingClientRect(), r = tr.getBoundingClientRect();
                const texts = [...tr.querySelectorAll('.nl-title, .nl-body > .nl-meta, .nl-question-box, .nl-other-text')].filter(e => e.getClientRects().length && e.getBoundingClientRect().top < i.bottom);
                return { kind: ${KIND}(tr), center: Math.abs((i.top + i.bottom - r.top - r.bottom) / 2), right: i.right, textLeft: Math.min(...texts.map(e => e.getBoundingClientRect().left)) };
            }).filter(Boolean))()`);
            check(geometry.length >= 4, width + 'px: every row has its icon: ' + JSON.stringify(geometry));
            for (const r of geometry) {
                check(r.center >= 0, width + 'px: the icon is in one spot, top left of the card, not centred (#13911, and a computer\'s rows are cards too, #15162): ' + JSON.stringify(r));
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
            const rows = await ev(`(() => [...document.querySelectorAll('${T} .nl-row')].map(tr => { const i = tr.querySelector('${ICON}'); if (!i) return { kind: null, text: tr.textContent.slice(0, 30) };
                const h = () => tr.getBoundingClientRect().height, wordsH = () => [...tr.querySelectorAll('.nl-title, .nl-body > .nl-meta, .nl-question-box, .nl-other-text')].reduce((n, e) => n + e.getBoundingClientRect().height, 0), withIcon = h(), wordsWith = wordsH(); i.style.height = '0px'; i.style.overflow = 'hidden'; const spacer = h(); i.style.height = ''; i.style.overflow = ''; const par = i.parentElement, nxt = i.nextSibling; i.remove(); const without = h(), rewrap = wordsWith - wordsH(); par.insertBefore(i, nxt);
                const ir = i.getBoundingClientRect(), r = tr.getBoundingClientRect(), words = tr.querySelector('.nl-title'), wr = words ? words.getBoundingClientRect() : null;
                return { kind: ${KIND}(tr), text: tr.textContent.replace(/\\s+/g, ' ').slice(0, 40), withIcon, spacer, without, rewrap, lineHeight: parseFloat(getComputedStyle(tr.querySelector('.nl-title') || tr).lineHeight) || 20, inRow: ir.top >= r.top - 1 && ir.bottom <= r.bottom + 1 && ir.left >= r.left - 1, beforeWords: !wr || ir.right <= wr.left + 1 }; }))()`);
            const kinds = new Set(rows.map(r => r.kind).filter(Boolean));
            check(rows.every(r => r.kind) && kinds.has('review') && kinds.has('ask'), label + ': the list has a review row and a question row: ' + JSON.stringify(rows.map(r => [r.kind, r.text])));
            for (const r of rows.filter(x => x.kind)) {
                check(Math.abs(r.withIcon - r.spacer) < 0.5, `${label}: a ${r.kind} row is as tall with its icon as with a spacer of the icon's width and no height (the icon's own height sets nothing) (${r.withIcon} with the icon, ${r.spacer} with the spacer): ${r.text}`);
                check(r.withIcon - r.without >= -0.01 && r.withIcon - r.without < (/200%/.test(label) && (r.kind === 'ask' || r.kind === 'review') ? Math.max(90, r.rewrap + 1) : (r.kind === 'ask' || r.kind === 'review') ? r.lineHeight + 1 : 0.01), /* #20203: a question's or a file's words may wrap one extra line when the icon's column is present; at 200% text (a body of about 300 px) a long question may wrap more: then all the extra height must be its words' re-wrap. Exact height for other kinds. */ `${label}: a ${r.kind} row keeps its height (${r.withIcon} with the icon, ${r.without} without, ${r.rewrap} of it the words re-wrapping): ${r.text}`);
                check(r.inRow && r.beforeWords, `${label}: a ${r.kind} row's icon is inside the row and in front of its words, not over them: ${JSON.stringify(r)}`);
            }
        }
        // a phone (#13144, the Orchestrator's 12:07): the words of a row never lie over one another, in both themes. Every element that carries its own text is a box; no two boxes of one row intersect.
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await waitFor(`[...document.querySelectorAll('${T} .nl-row')].filter(n => n.getClientRects().length).length >= 4 && document.documentElement.clientWidth <= 400`, 'Needs you draws the phone\'s rows once the window is a phone', 8000);
        await ev(`document.documentElement.style.fontSize = '100%'; true`);
        // the same rows are as tall at 390 with the icon as without it: a review row's file name stays on its first line (#13144, UI Reviewer)
        await ev(framesJs(6));
        const tall = await ev(`(() => [...document.querySelectorAll('${T} .nl-row')].map(tr => { const i = tr.querySelector('${ICON}'); if (!i) return null; const h = () => Math.round(tr.getBoundingClientRect().height * 100) / 100, w = h(); const par = i.parentElement, nxt = i.nextSibling; i.remove(); const wo = h(); par.insertBefore(i, nxt); const nm = tr.querySelector('.nl-title'); return { kind: ${KIND}(tr), line: (nm && parseFloat(getComputedStyle(nm).lineHeight)) || 20, text: tr.textContent.replace(/\\s+/g, ' ').slice(0, 30), withIcon: w, without: wo }; }).filter(Boolean))()`);
        // a question's title may take two lines on a phone by design (#11894), so an icon that takes width can push a title near the wrap point onto its second line: a question or a file row may be at most ONE line taller (a runaway change still fails); every other kind keeps its height exactly
        // (retired: #13829's "the sender is line one and the file name line two" on a phone: removed by design, the approved list of #22094 shows a file's sender as the agent's picture at the row's side)
        check(tall.length >= 4, '390 px: every row has its icon: ' + JSON.stringify(tall));
        for (const r of tall) {
            const room = r.kind === 'other' || r.kind === 'ask' || r.kind === 'review' ? r.line + 1 : 0.5;
            check(r.withIcon >= r.without - 0.5 && r.withIcon - r.without < room, `390 px: a ${r.kind} row keeps its height with the icon${room > 1 ? ' (at most one more line)' : ''} (${r.withIcon} with, ${r.without} without): ${r.text}`);
        }
        const { themeJs } = require('./helpers/theme');
        for (const theme of ['dark', 'light']) {
            await ev(`${themeJs(theme)}; true`); await ev(framesJs(8));
            const clashes = await ev(`(() => { const out = []; for (const tr of document.querySelectorAll('${T} .nl-row')) {
                const boxes = []; const walker = document.createTreeWalker(tr, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) { if (!n.textContent.trim()) continue; const e = n.parentElement; if (!e || !e.getClientRects().length || !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue; const pb = e.getBoundingClientRect(); if (pb.width <= 2 || pb.height <= 2) continue; /* a screen-reader-only word (', unread') is a 1 px box, not text the eye sees */
                    const rg = document.createRange(); rg.selectNodeContents(n); for (const r0 of rg.getClientRects()) { if (!(r0.width > 0 && r0.height > 0)) continue;
                        // only the part the eye sees: cut by every ancestor that clips (an ellipsis, a line clamp), up to the row
                        let l = r0.left, t = r0.top, rt = r0.right, b = r0.bottom; for (let a = e; a && a !== tr.parentElement; a = a.parentElement) { const ov = getComputedStyle(a); if (ov.overflowX !== 'visible' || ov.overflowY !== 'visible') { const c = a.getBoundingClientRect(); if (ov.overflowX !== 'visible') { l = Math.max(l, c.left); rt = Math.min(rt, c.right); } if (ov.overflowY !== 'visible') { t = Math.max(t, c.top); b = Math.min(b, c.bottom); } } }
                        if (rt - l > 1 && b - t > 1) boxes.push({ t: n.textContent.trim().slice(0, 24), r: { left: l, top: t, right: rt, bottom: b } }); } }
                for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { if (boxes[i].t === boxes[j].t) continue; const a = boxes[i].r, b = boxes[j].r, w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (w > 2 && h > 3) out.push(boxes[i].t + ' x ' + boxes[j].t + ' (' + Math.round(w) + 'x' + Math.round(h) + ')'); } }
                return out; })()`);
            // #20239's four-line preview with a More button is retired by design: the approved list (#22094) shows a long question whole in its question box under a one-line title (needs_long_question_browser checks the words are whole).
            const preview = await ev(`(() => { const row = [...document.querySelectorAll('${T} .nl-row.nl-question')].find(e => e.textContent.includes('Before I rename')), box = row?.querySelector('.nl-question-box') || row?.querySelector('.nl-title'); if (!box) return null; return { whole: box.textContent.includes('Before I rename the folder') && box.textContent.trim().endsWith('left behind afterwards?'), cut: box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1, inRow: box.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1 }; })()`);
            check(!!preview && preview.whole && !preview.cut && preview.inRow, `390 px, ${theme}: the long question is whole in its title or box, nothing cut, inside its row: ` + JSON.stringify(preview));
            check(clashes.length === 0, `390 px, ${theme}: no two texts of a Needs you row overlap: ` + JSON.stringify(clashes));
        }
        // An agent's question with choices on a phone: the icon keeps its column beside the title and the choices sit under the words (the approved list draws them in the row's body, not the full row as the old mail row did).
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(require('./helpers/inbox_world').INBOX_WORLD);
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: { question: 'Which temperature unit?', ask_id: 'temperature', multi: false, options: ['Celsius', 'Fahrenheit', 'Kelvin'].map((label, i) => ({ n: i + 1, label, action: 'select' })) } }), { headers: { 'content-type': 'application/json' } })) : real(u, o); return true; })()`);
        await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.liveSessions = [{ name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', waiting_for_input: true, waiting_kind: 'question', waiting_summary: 'Which temperature unit?', waiting_since: new Date().toISOString(), waiting_choices: ['Celsius', 'Fahrenheit', 'Kelvin'] }]; const m = await import(${S} + 'inbox_tab.js'); m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
        await waitFor(`document.querySelector('${T} .nl-row.nl-question') && document.querySelectorAll('${T} .nl-row .inbox-answer').length === 3`, 'the agent question row with its three choices', 15000);
        for (const width of [390, 320]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: true }); await ev(framesJs(8));
            const row = await ev(`(() => { const tr = document.querySelector('${T} .nl-row.nl-question'), i = tr.querySelector('${ICON}').getBoundingClientRect(), r = tr.querySelector('.nl-title').getBoundingClientRect(), own = tr.getBoundingClientRect(), answers = [...tr.querySelectorAll('.inbox-answer')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility === 'visible').map(b => b.getBoundingClientRect()); return { top: Math.abs(i.top - r.top), right: i.right, textLeft: r.left, answers: answers.length, answersIn: answers.every(b => b.left >= i.right + 4 && b.right <= own.right + 1 && b.bottom <= own.bottom + 1), overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
            check(row.top <= 4 && row.textLeft >= row.right + 4 && row.answers === 3 && row.answersIn && !row.overflow, width + 'px: #20203 top-aligned icon keeps its column; the three choices are shown inside the row: ' + JSON.stringify(row));
        }
        for (const theme of ['dark', 'light']) {
            await ev(`${themeJs(theme)}; true`); await ev(framesJs(4));
            const contrast = await ev(`(async () => { const NF = await import(${S} + 'needs_filters.js'); const channel = x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }; const lum = c => { const rgb = c.match(/[\\d.]+/g).map(Number); return channel(rgb[0]) * .2126 + channel(rgb[1]) * .7152 + channel(rgb[2]) * .0722; }; return NF.KINDS.map(k => { const i = NF.kindIcon({ waiting_kind: k }); document.body.append(i); const cs = getComputedStyle(i); let bg = i; while (bg.parentElement && getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement; const a = lum(cs.color), b = lum(getComputedStyle(bg).backgroundColor); i.remove(); return { kind: k, ratio: (Math.max(a,b) + .05) / (Math.min(a,b) + .05) }; }); })()`);
            for (const c of contrast) check(c.ratio >= 4.5, theme + ': AA grey kind icon against its visible background: ' + JSON.stringify(c));
            const own = await ev(`(() => { const channel = x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }; const lum = c => { const rgb = c.match(/[\\d.]+/g).map(Number); return channel(rgb[0]) * .2126 + channel(rgb[1]) * .7152 + channel(rgb[2]) * .0722; }; return [...document.querySelectorAll('${T} .nl-row > .nl-icon')].map(i => { let bg = i; while (bg.parentElement && getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement; const a = lum(getComputedStyle(i).color), b = lum(getComputedStyle(bg).backgroundColor); return { glyph: i.textContent, ratio: (Math.max(a,b) + .05) / (Math.min(a,b) + .05) }; }); })()`);
            check(own.length >= 1, theme + ': the question row has the list\'s own icon');
            for (const c of own) check(c.ratio >= 4.5, theme + ': AA grey icon of the list\'s own row against its visible background: ' + JSON.stringify(c));
        }
    } finally { await removeBoards(ev, ['qn']).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_kind_icons_rows_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
