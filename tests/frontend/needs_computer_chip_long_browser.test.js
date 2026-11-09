// #14637 (2): the computer chip on a phone card with a LONG computer name, a LONG asker name and 200% text, at 390 and 320 px (the follow-up of #14623, UI Reviewer: 'long labels and 200% remain a follow-up'). Per card: the chip stays inside the card, is cut with an ellipsis rather than pushing the line, never overlaps the asker or the time, the asker keeps a readable width, the full computer name is the chip's title, and nothing is wider than the screen. Two computers with long names, a question and a skill from each.
// (derived from needs_computer_chip_browser)
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
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href), mm = u.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/); if (!mm) return original(url, opts);
                    if (mm[2] === '/api/operator-asks') return json(mm[1] === 'm1' ? [ask(7, 'team-x', 'Backend Dev', 'Ship tonight or wait for the review?')] : [ask(8, 'team-y', 'Designer', 'Which of the two logos do we keep for the launch page?')]);
                    return original(url, opts); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 4`, `${at}two questions and two skills, one of each from each computer`, 15000);
            await waitFor(`(() => { const t = document.querySelector('#group-table-view tbody'); const k = t.innerText + ':' + Math.round(t.getBoundingClientRect().height); if (window.__ncc !== k) { window.__ncc = k; window.__nccAt = performance.now(); return false; } return performance.now() - window.__nccAt > 500; })()`, `${at}the rows have settled`, 8000);
            await shot(`needs-computer-chip-${w}`);
            const r = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => { const td = tr.querySelector('td.dt-grow') || tr.querySelector('td'); const chip = tr.querySelector('.inbox-computer-chip'); const from = tr.querySelector('.inbox-review-from');
                    const vis = e => e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1; const cell = [...tr.querySelectorAll('td')].find(c => c.dataset.key === 'server' || /Computer/.test(c.getAttribute('data-label') || ''));
                    const serverCellText = cell && vis(cell) ? cell.textContent.trim() : '';
                    return { chip: chip ? chip.textContent.trim() : null, chipTop: chip && vis(chip) ? Math.round(chip.getBoundingClientRect().top) : null, fromTop: from ? Math.round(from.getBoundingClientRect().top) : null, serverCellText, h: Math.round(tr.getBoundingClientRect().height), right: Math.round(tr.getBoundingClientRect().right), headers: [...document.querySelectorAll('#group-table-view thead th')].filter(vis).map(t => t.textContent.trim()) }; });
                return { rows, wide: document.documentElement.scrollWidth - innerWidth }; })()`);
            console.log(`${at}` + JSON.stringify(r));
            if (mobile) {
                check(`${at}the chip is on the meta line, the asker's line (not under the text)`, r.rows.every(x => x.chipTop !== null && x.fromTop !== null && Math.abs(x.chipTop - x.fromTop) <= 12), JSON.stringify(r.rows.map(x => [x.chipTop, x.fromTop])));
                check(`${at}no separate Computer line under the card's text`, r.rows.every(x => x.serverCellText === ''), JSON.stringify(r.rows.map(x => x.serverCellText)));
                check(`${at}nothing is wider than the screen`, r.wide <= 0 && r.rows.every(x => x.right <= w + 1), String(r.wide));
            } else {
                check(`${at}the wide table keeps its Computer column, and no chip`, r.rows.every(x => x.chip === null) && r.rows[0].headers.some(t => /^Computer/.test(t)), JSON.stringify(r.rows[0].headers));
            }


            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the cards settle at the new text size
            await shot(`needs-computer-chip-long-${w}-${fontPx}`);
            const g = await ev(`(() => { const box = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) }; }; const vis = e => e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1;
                const cards = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => { const chip = tr.querySelector('.inbox-computer-chip'), from = tr.querySelector('.inbox-review-from'), time = tr.querySelector('.inbox-review-wait'), card = tr.getBoundingClientRect();
                    return { chip: chip && vis(chip) ? { text: chip.textContent, title: chip.title, box: box(chip), cut: chip.scrollWidth > chip.clientWidth } : null, from: from && vis(from) ? { text: from.textContent.slice(0, 40), box: box(from) } : null, time: time && vis(time) ? box(time) : null, card: { l: Math.round(card.left), r: Math.round(card.right) } }; });
                return { cards, wide: document.documentElement.scrollWidth - innerWidth, vw: innerWidth }; })()`);
            console.log(`${at}` + JSON.stringify(g).slice(0, 900));
            const overlap = (a, b) => !!a && !!b && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
            check(`${at}four cards, each with a computer chip`, g.cards.length === 4 && g.cards.every(c => c.chip), JSON.stringify(g.cards.map(c => c.chip && c.chip.text)));
            check(`${at}each chip's title is the whole computer name`, g.cards.every(c => c.chip && /^On (Operators-MacBook-Pro-16-inch-Late-2023-Development|Reading-List-Build-Server-Number-Two-In-The-Basement)$/.test(c.chip.title)), JSON.stringify(g.cards.map(c => c.chip && c.chip.title)));
            check(`${at}a chip stays inside its card`, g.cards.every(c => c.chip && c.chip.box.l >= c.card.l - 1 && c.chip.box.r <= c.card.r + 1), JSON.stringify(g.cards.map(c => [c.card, c.chip && c.chip.box])));
            check(`${at}a chip never overlaps the asker or the time`, g.cards.every(c => !overlap(c.chip && c.chip.box, c.from && c.from.box) && !overlap(c.chip && c.chip.box, c.time)), JSON.stringify(g.cards.map(c => [c.chip && c.chip.box, c.from && c.from.box, c.time])));
            check(`${at}the asker keeps a readable width (at least 80 px)`, g.cards.every(c => c.from && c.from.box.w >= 80), JSON.stringify(g.cards.map(c => c.from && c.from.box)));
            check(`${at}nothing is wider than the screen`, g.wide <= 0 && g.cards.every(c => c.card.r <= g.vw + 1), String(g.wide));
        }
        console.log('needs_computer_chip_long: done');
    } finally { await client.close(); }
    if (process.exitCode) process.exit(process.exitCode);
})().catch(e => { console.error(e); process.exit(1); });
