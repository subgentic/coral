// The computer chip with a LONG computer name on a review card with a version pill, and on question and skill cards, at 390 and 320 px and 200% text (UI Reviewer's second MUST on #14683): per card the chip stays inside the card, nothing among the asker, the chip, the time,
// the dots and the pill overlaps, the dots keep their 44 px corner, and nothing is wider than the screen. Two Hub computers with long names; each has a question, a skill and a review file with a version pill (v3). Derived from needs_computer_chip_long_browser.
// On the ledger (#22094): the chip became the row's wrapping source line (.nl-meta, the full computer name, as needs_computer_chip_long checks), the version pill became "version 3" beside the file's name (.nl-version), a file's sender is the agent avatar at the side, and the dots are the phone's ⋯ (.nl-more-toggle). Per row: the full computer name is readable inside the row on every question and skill, the parts (title, source line, version, avatar, New, time, ⋯) never overlap, the version words are inside the row, the ⋯ keeps a 44 px target, and nothing is wider than the screen.
// Retired on the ledger (#22094): "board and clock stay within the sender header height" (.inbox-header-meta): the ledger has no sender header; the time sits at the side apart from the source line, checked here as "never overlaps" and in needs_computer_chip_long ("source metadata never overlaps the time"). "The asker keeps a readable width": a file names its agent by the avatar (its label is the whole name, checked in needs_phone_walk), and a question's asker is the first part of the wrapping source line, checked whole in needs_computer_chip_long.
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
            await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.setItem('coral-inbox-group-review-goal', 'false');` }); // Group by None: one flat list, no folded goal group
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
            await waitFor(`document.querySelectorAll('#group-table-view .nl-row').length >= 6`, `${at}two questions, two skills and two review files`, 20000);
            await waitFor(`(() => { const t = document.querySelector('#group-table-view .nl-lists'); const k = t.innerText + ':' + Math.round(t.getBoundingClientRect().height); if (window.__npc !== k) { window.__npc = k; window.__npcAt = performance.now(); return false; } return performance.now() - window.__npcAt > 600; })()`, `${at}the rows have settled`, 8000);
            await ev(`document.querySelector('#group-table-view .nl-row').scrollIntoView({block:'start'});true`);
            await shot(`needs-pill-chip-long-${w}-${fontPx}`);
            const r = await ev(`(() => { const rc = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; }, hit = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1, inside = (a, c) => a.l >= c.l - 1 && a.r <= c.r + 1 && a.t >= c.t - 1 && a.b <= c.b + 1;
                const LONG = /Operators-MacBook-Pro-16-inch-Late-2023-Development|Reading-List-Build-Server-Number-Two-In-The-Basement/;
                const cards = [...document.querySelectorAll('#group-table-view .nl-row')].map(row => { const card = rc(row), meta = row.querySelector(':scope > .nl-body > .nl-meta'), title = row.querySelector('.nl-title'), file = !!row.querySelector('.nl-file-open'), name = file ? row.querySelector('.nl-file-open').firstChild : null;
                    const parts = { title: file ? null : title, meta, version: row.querySelector('.nl-version'), agent: row.querySelector('.nl-side .goal-decision-agent-icon'), isNew: row.querySelector('.nl-side .nl-new'), time: row.querySelector('.nl-side .nl-when'), dots: row.querySelector('.nl-side .nl-more-toggle') };
                    const boxes = Object.fromEntries(Object.entries(parts).filter(([, e]) => e && e.getClientRects().length && e.getBoundingClientRect().width > 1).map(([k, e]) => [k, rc(e)]));
                    if (name && name.nodeType === 3) { const rg = document.createRange(); rg.selectNodeContents(name); const nb = rg.getBoundingClientRect(); boxes.name = { l: nb.left, t: nb.top, r: nb.right, b: nb.bottom }; }
                    const names = Object.keys(boxes), clashes = []; for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (!((names[i] === 'name' && names[j] === 'version') || (names[i] === 'version' && names[j] === 'name')) && hit(boxes[names[i]], boxes[names[j]])) clashes.push(names[i] + '/' + names[j]);
                    let metaInside = true; if (meta) { const rg = document.createRange(); rg.selectNodeContents(meta); metaInside = [...rg.getClientRects()].every(x => inside({ l: x.left, t: x.top, r: x.right, b: x.bottom }, card)); }
                    const dots = boxes.dots ? parts.dots.getBoundingClientRect() : null;
                    return { file, source: meta && LONG.test(meta.textContent), metaInside, pill: !!boxes.version, pillInside: boxes.version ? inside(boxes.version, card) : true, dots: dots ? [Math.round(dots.width), Math.round(dots.height)] : null, clashes, cardR: Math.round(card.r), boxes: Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, [Math.round(b.l), Math.round(b.t), Math.round(b.r), Math.round(b.b)]])) }; });
                return { cards, wide: document.documentElement.scrollWidth - innerWidth }; })()`);
            console.log(at + JSON.stringify(r));
            check(`${at}every question and skill shows its full computer name, inside the row`, r.cards.filter(c => !c.file).length >= 4 && r.cards.filter(c => !c.file).every(c => c.source && c.metaInside), JSON.stringify(r.cards.map(c => [c.source, c.metaInside])));
            check(`${at}nothing overlaps among the title, the source line, the version, the avatar, New, the time and the ⋯`, r.cards.every(c => c.clashes.length === 0), JSON.stringify(r.cards.map(c => c.clashes)));
            check(`${at}review rows with a version are there and the version is inside the row`, r.cards.filter(c => c.pill).length >= 2 && r.cards.every(c => c.pillInside), JSON.stringify(r.cards.map(c => c.pill)));
            check(`${at}the ⋯ keeps a 44 px target on every row`, r.cards.every(c => c.dots && c.dots[0] >= 44 && c.dots[1] >= 44), JSON.stringify(r.cards.map(c => c.dots)));
            check(`${at}nothing is wider than the screen`, r.wide <= 0, String(r.wide));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
