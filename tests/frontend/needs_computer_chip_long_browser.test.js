// #22094 replaces ellipsized computer chips with wrapping source-qualified metadata.
// Full source names, asker visibility, separate times, ancestor containment and 320/390px at 100/200% remain asserted.
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
            await waitFor(`document.querySelectorAll('#group-table-view .nl-row').length === 4`, `${at}two questions and two skills, one of each from each computer`, 15000);
            await waitFor(`(() => { const t = document.querySelector('#group-table-view .nl-lists'); const k = t.innerText + ':' + Math.round(t.getBoundingClientRect().height); if (window.__ncc !== k) { window.__ncc = k; window.__nccAt = performance.now(); return false; } return performance.now() - window.__nccAt > 500; })()`, `${at}the rows have settled`, 8000);
            await shot(`needs-computer-chip-${w}`);
            const g = await ev(`(() => { const inside = (a,b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; return { cards: [...document.querySelectorAll('#group-table-view .nl-row')].map(row => { const meta = row.querySelector('.nl-meta'), from = meta.firstElementChild, time = row.querySelector('.nl-when'), body = row.querySelector('.nl-body'), card = row.getBoundingClientRect(), m = meta.getBoundingClientRect(), f = from.getBoundingClientRect(), t = time.getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(meta); return { text: meta.textContent, contained: [...r.getClientRects()].every(rect => inside(rect,card)), bodyWidth: body.getBoundingClientRect().width, timeSeparate: m.right <= t.left + 1 || m.bottom <= t.top + 1 || t.bottom <= m.top + 1, fromVisible: f.width > 0 && inside(f,card) }; }), wide: document.documentElement.scrollWidth - innerWidth }; })()`);
            check(at + 'four rows retain each full computer name as readable metadata', g.cards.length === 4 && g.cards.every(c => /Operators-MacBook-Pro-16-inch-Late-2023-Development|Reading-List-Build-Server-Number-Two-In-The-Basement/.test(c.text)), JSON.stringify(g));
            check(at + 'wrapped source labels and asker text stay within each row', g.cards.every(c => c.contained && c.fromVisible && c.bodyWidth >= 80), JSON.stringify(g));
            check(at + 'source metadata never overlaps the time', g.cards.every(c => c.timeSeparate), JSON.stringify(g));
            check(at + 'nothing is wider than the screen at either text size', g.wide <= 0, JSON.stringify(g));
            await shot(`needs-computer-chip-long-${w}-${fontPx}`);

        }
        console.log('needs_computer_chip_long: done');
    } finally { await client.close(); }
    if (process.exitCode) process.exit(process.exitCode);
})().catch(e => { console.error(e); process.exit(1); });
