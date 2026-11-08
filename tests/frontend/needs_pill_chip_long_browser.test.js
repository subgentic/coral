// The computer chip with a LONG computer name on a review card with a version pill, and on question and skill cards, at 390 and 320 px and 200% text (UI Reviewer's second MUST on #14683): per card the chip stays inside the card, nothing among the asker, the chip, the time,
// the dots and the pill overlaps, the dots keep their 44 px corner, and nothing is wider than the screen. Two Hub computers with long names; each has a question, a skill and a review file with a version pill (v3). Derived from needs_computer_chip_long_browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld } = require('./helpers/hub_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');


(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, fontPx] of [[390, 844, true, 16], [390, 844, true, 32], [320, 700, true, 16], [320, 700, true, 32]]) {
            const at = `${w} px, text ${fontPx} px: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const LONG = ['Operators-MacBook-Pro-16-inch-Late-2023-Development', 'Reading-List-Build-Server-Number-Two-In-The-Basement']; if (window.__computers) window.__computers.forEach((c, i) => { c.label = LONG[i] || c.label; }); })()` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fontPx}px'; true`);
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                const ask = (id, board, asker, text) => ({ board, kind: 'ask', id, asker, text, cut: false, at: new Date(Date.now() - id * 60000).toISOString() });
                const hex = n => n.toString(16).padStart(64, '0');
                const file = (n, produced) => ({ id: hex(n), name: 'A-very-long-review-file-name-that-has-to-be-cut-somewhere-v' + n + '.md', media_type: 'text/markdown', size: 900, created_at: new Date(Date.now() - 3 * 3600e3).toISOString(), available: true, tags: ['for review'], produced_by: produced, review_question: 'v3: is this one fine?', version: 3, earlier_digests: [hex(n + 100), hex(n + 200)] });
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href), mm = u.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/); if (!mm) return original(url, opts);
                    if (mm[2] === '/api/operator-asks') return json(mm[1] === 'm1' ? [ask(7, 'team-x', 'Backend Dev', 'Ship tonight or wait for the review?')] : [ask(8, 'team-y', 'Designer', 'Which of the two logos do we keep for the launch page?')]);
                    if (mm[2] === '/api/team-artifacts' && (u.searchParams.has('tag') || u.searchParams.has('waiting'))) return json(window.__reviewFixturePage(u.href, location.href, { [mm[1] === 'm1' ? 'team-x' : 'team-y']: { team: 'Release team', artifacts: [file(mm[1] === 'm1' ? 1 : 2, mm[1] === 'm1' ? 'Developer experience' : 'Docs')] } }));
                    return original(url, opts); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 6`, `${at}two questions, two skills and two review files`, 20000);
            await waitFor(`(() => { const t = document.querySelector('#group-table-view tbody'); const k = t.innerText + ':' + Math.round(t.getBoundingClientRect().height); if (window.__npc !== k) { window.__npc = k; window.__npcAt = performance.now(); return false; } return performance.now() - window.__npcAt > 600; })()`, `${at}the rows have settled`, 8000);
            await shot(`needs-pill-chip-long-${w}-${fontPx}`);
            const r = await ev(`(() => { const rc = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; }, hit = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
                const cards = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => { const card = rc(tr), chip = tr.querySelector('.inbox-computer-chip'), from = tr.querySelector('.inbox-review-from'), time = tr.querySelector('.inbox-review-wait'), dots = tr.querySelector('.inbox-row-more-toggle'), pill = tr.querySelector('.inbox-review-version:not([hidden])');
                    const parts = { from, chip, time, dots, pill }, boxes = Object.fromEntries(Object.entries(parts).filter(([, e]) => e && e.getClientRects().length && e.getBoundingClientRect().width > 1).map(([k, e]) => [k, rc(e)]));
                    const names = Object.keys(boxes), clashes = []; for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (hit(boxes[names[i]], boxes[names[j]])) clashes.push(names[i] + '/' + names[j]);
                    return { text: (from ? from.textContent : '').trim().slice(0, 14), chip: boxes.chip ? { r: Math.round(boxes.chip.r), inside: boxes.chip.r <= card.r - 2 } : null, fromW: boxes.from ? Math.round(boxes.from.r - boxes.from.l) : null, pill: !!boxes.pill, pillInside: boxes.pill ? boxes.pill.r <= card.r - 2 : true, clashes, cardR: Math.round(card.r), boxes: Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, [Math.round(b.l), Math.round(b.t), Math.round(b.r), Math.round(b.b)]])) }; });
                return { cards, wide: document.documentElement.scrollWidth - innerWidth }; })()`);
            console.log(at + JSON.stringify(r));
            check(`${at}every card with a chip keeps it inside the card`, r.cards.filter(c => c.chip).length >= 4 && r.cards.filter(c => c.chip).every(c => c.chip.inside), JSON.stringify(r.cards.map(c => c.chip)));
            check(`${at}nothing overlaps among the asker, the chip, the time, the dots and the pill`, r.cards.every(c => c.clashes.length === 0), JSON.stringify(r.cards.map(c => c.clashes)));
            check(`${at}review cards with a version pill are there and the pill is inside the card`, r.cards.filter(c => c.pill).length >= 2 && r.cards.every(c => c.pillInside), JSON.stringify(r.cards.map(c => c.pill)));
            check(`${at}the asker keeps a readable width (at least 56 px)`, r.cards.every(c => c.fromW === null || c.fromW >= 56), JSON.stringify(r.cards.map(c => c.fromW)));
            check(`${at}nothing is wider than the screen`, r.wide <= 0, String(r.wide));
            // a cut chip says its whole name when tapped (the hover title is no help on a phone, #14705) and the card does not open; a chip that fits leaves the tap to the card
            const tap = await ev(`(() => { const chips = [...document.querySelectorAll('#group-table-view tbody tr.dt-row .inbox-computer-chip, #group-table-view tbody tr.dt-row .dt-mail-computer')]; const cut = chips.find(c => c.scrollWidth > c.clientWidth + 1); if (!cut) return { none: true, chips: chips.length }; document.querySelectorAll('.toast').forEach(t => t.remove()); cut.scrollIntoView({ block: 'center', behavior: 'instant' }); const full = cut.textContent.trim(); cut.click(); return { full, chips: chips.length }; })()`);
            if (tap.none) check(`${at}(no chip is cut at this size: nothing to tap)`, true, String(tap.chips));
            else {
                await waitFor(`!![...document.querySelectorAll('.toast')].find(t => t.textContent.includes(${JSON.stringify(tap.full)}))`, `${at}the cut chip's tap says its whole name`, 4000);
                check(`${at}tapping a cut chip says its whole name in a toast and opens no dialog`, await ev(`!document.querySelector('dialog[open]')`), tap.full);
            }
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
