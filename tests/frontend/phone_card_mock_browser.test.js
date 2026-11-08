// The rest of the approved phone mock on a Needs you card (#14683, ccdb36ff): the three dots sit at the card's top right, on the sender's line with the time, not in the button row; the version is a small pill beside the title, not text in
// the time line. At 390 and 320 px (and 430, 360); the fixture is inbox_phone_cards_browser's (two review files, one at v3 with earlier versions). The star stays: a 44 px button at the end of the button row, at the card's bottom right.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client; const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, theme, font, mobile = true] of [[390, 'dark', 16], [430, 'dark', 16], [390, 'light', 16], [390, 'dark', 32], [320, 'dark', 16], [360, 'dark', 16], [390, 'dark', 16, false], [320, 'dark', 32]]) {
            const at = `${w} ${theme} ${font}px${mobile ? '' : ' (no touch emulation)'}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '${font}px'; true`);
            await ev(`(() => { const real = window.fetch, now = Date.now(), hex = n => n.toString(16).padStart(64, '0');
                const rows = [{ id: hex(1), name: 'Desktop film with local voice over (Samantha, v3).mp4', media_type: 'text/html', size: 900, created_at: new Date(now - 10 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Developer experience', review_question: 'v3: fuller captions over the whole film, same words spoken. Good? A longer second sentence that must not make the card taller.', version: 3, earlier_digests: [hex(8), hex(9)] },
                    { id: hex(2), name: 'release-plan.md', media_type: 'text/markdown', size: 1200, created_at: new Date(now - 20 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'On v2.0.57, do the main pages look consistent on a phone?' },
                    { id: hex(3), name: 'A very long unversioned title that has to run all the way to the right edge of the card and be cut there.md', media_type: 'text/markdown', size: 800, created_at: new Date(now - 30 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: 'Docs', review_question: 'Is this short summary fine?' }];
                window.fetch = (u, o = {}) => { if (/\\/api\\/board\\/team-a\\/artifacts\\/[0-9a-f]{64}\\/tags/.test(String(u)) && (o.method || 'GET').toUpperCase() === 'PUT') return Promise.resolve(new Response(JSON.stringify({ tags: ['for review', 'read'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); const page = window.__reviewFixturePage(u, location.origin, { 'team-a': rows }); if (page) return Promise.resolve(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } })); return real(u, o); }; return true; })()`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 3`, `${at}three cards`, 15000);
            await waitFor(`!!document.querySelector('#group-table-view .dt-box.dt-folded')`, `${at}folded to phone rows`, 5000);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the fold settles after the first paint
            const g = await ev(`(() => { const tr = document.querySelector('#group-table-view tbody tr.dt-row'), rc = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
                const from = tr.querySelector('.inbox-review-from'), time = tr.querySelector('.inbox-review-wait'), dots = tr.querySelector('.inbox-row-more-toggle'), actions = tr.querySelector('.inbox-review-actions'), name = tr.querySelector('.inbox-review-name'), pill = tr.querySelector('.inbox-review-version'), tags = pill,  star = tr.querySelector('.inbox-review-star');
                const approve = [...tr.querySelectorAll('.inbox-review-actions .btn')].find(b => /^Approve/.test(b.textContent));
                return { card: rc(tr), from: from && rc(from), time: time && rc(time), dots: dots && rc(dots), approve: approve && rc(approve), name: name && rc(name), pill: pill ? { ...rc(pill), text: pill.textContent.trim() } : null, tags: tags && rc(tags), star: star && { ...rc(star), events: getComputedStyle(star).pointerEvents }, tagsText: tags ? tags.textContent.trim() : null, timeText: time ? time.textContent.trim() : null }; })()`);
            check(!!g.dots && g.dots.t < g.name.t && g.dots.r >= g.card.r - 12 && g.dots.t < g.approve.t - 30, `${at}the three dots are at the card's top right, not in the button row: ` + JSON.stringify([g.dots, g.card, g.approve && g.approve.t]));
            check(!!g.tags && g.tagsText === 'v3' && g.tags.t >= g.name.t - 4 && g.tags.b <= g.name.b + 6 && g.tags.l >= g.name.l, `${at}the version is a pill on the title's line, not in the time line: ` + JSON.stringify([g.tags, g.name, g.tagsText]));
            check(await ev(`(() => { const t = document.querySelector('#group-table-view tbody tr.dt-row .inbox-review-tags .inbox-review-version'); if (!t) return false; const cs = getComputedStyle(t); return parseFloat(cs.borderTopLeftRadius) >= 8 && cs.borderTopWidth === '1px'; })()`), `${at}the version has a pill's border and radius`);
            check(!g.star || (g.star.b - g.star.t >= 43.5 && g.star.r - g.star.l >= 43.5 && g.star.events !== 'none' && g.star.t >= g.approve.t - 4 && g.star.r <= g.card.r - 8), `${at}a starred card's star is a 44 px button at the end of the button row (the dots are at the top right): ` + JSON.stringify(g.star));
            const clear = await ev(`(() => [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].filter(tr => !tr.querySelector('.inbox-review-tags .inbox-review-version')).map(tr => { tr.scrollIntoView({ block: 'center', behavior: 'instant' }); /* a card under the fixed bottom bar cannot be hit-tested */ const name = tr.querySelector('.inbox-review-name'), dots = tr.querySelector('.inbox-row-more-toggle'), n = name.getBoundingClientRect(), d = dots.getBoundingClientRect(); const hit = document.elementFromPoint((d.left + d.right) / 2, (d.top + d.bottom) / 2); return { title: name.textContent.slice(0, 24), margin: getComputedStyle(name).marginInlineEnd, nameRight: Math.round(n.right), dotsLeft: Math.round(d.left), dotsHit: !!hit && (hit === dots || dots.contains(hit)), hitClass: hit ? String(hit.className).slice(0, 40) : '' }; }))()`);
            check(clear.length >= 2 && clear.every(x => x.nameRight <= x.dotsLeft + 1 && x.dotsHit && x.margin === '52px'), `${at}an unversioned card's title (a long one too) stops short of the dots' 44 px target and nothing covers the dots: ` + JSON.stringify(clear));
            const t = await ev(`(() => { const sort = document.querySelector('.list-bar-sort-chip'), filter = document.querySelector('.list-bar-toggle-chip'), vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1, rc = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
                const from = document.querySelector('#group-table-view tbody tr.dt-row .inbox-review-from'), title = document.querySelector('#group-table-view tbody tr.dt-row .inbox-review-name'), time = document.querySelector('#group-table-view tbody tr.dt-row .inbox-review-wait'), fs = from && getComputedStyle(from), ts = title && getComputedStyle(title);
                return { sort: vis(sort) ? { ...rc(sort), text: sort.options[sort.selectedIndex].text } : null, filter: vis(filter) ? { ...rc(filter), text: filter.textContent.trim() } : null, from: fs && { tt: fs.textTransform, fs: parseFloat(fs.fontSize), color: fs.color }, title: ts && { fs: parseFloat(ts.fontSize), color: ts.color }, timeClipped: time ? time.scrollWidth > time.clientWidth + 1 : null, vw: innerWidth }; })()`);
            check(!!t.sort && !!t.filter && t.sort.b - t.sort.t >= 43.5 && t.filter.b - t.filter.t >= 43.5 && t.sort.l >= 0 && t.sort.r <= t.vw && t.filter.l >= 0 && t.filter.r <= t.vw && /\S/.test(t.sort.text) && /Filter/.test(t.filter.text), `${at}the sort chip (the current order, in words) and a labelled Filter chip are visible, 44 px, on the screen (#14706): ` + JSON.stringify([t.sort, t.filter]));
            check(!!t.from && t.from.tt === 'uppercase' && t.from.fs < t.title.fs && t.from.color !== t.title.color, `${at}the sender is small, secondary and uppercase (the mock's .who, #14706): ` + JSON.stringify([t.from, t.title]));
            check(g.time && t.timeClipped === false && g.time.r <= g.card.r - 2 && g.from && g.from.r - g.from.l >= 40, `${at}a useful sender and the whole time, none clipped (#14706): ` + JSON.stringify([g.from, g.time, t.timeClipped]));
            check(g.timeText && !/v3/.test(g.timeText), `${at}the time line says the time only: ` + g.timeText);
            await shot('phone-card-mock-' + w + '-' + theme + '-' + font + (mobile ? '' : '-notouch'));

        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('phone_card_mock_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
