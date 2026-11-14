// Needs you on a Hub with two computers (#14623, coral-hub's phone comparison): on a phone the computer's name is a small chip on each card's meta line, with the asker and the time, and there is no separate Computer line under the
// text; on a wide screen the Computer column stays. Two computers (Laptop, Desktop): (A) each with a question and a skill; (B) only two waiting agents of the SAME name, one on each computer (the one-line mail rows, no item rows), through the stubbed Hub world (helpers/hub_world.js). 1280, 390 and 320 px.
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
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true], [320, 700, true]]) {
            const at = `${w} px: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
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
                check(`${at}each card has the computer's name as a chip (two questions and two skills, one of each from Laptop and Desktop)`, JSON.stringify(r.rows.map(x => x.chip).sort()) === JSON.stringify(['Desktop', 'Desktop', 'Laptop', 'Laptop']), JSON.stringify(r.rows.map(x => x.chip)));
                check(`${at}the chip is on the meta line, the asker's line (not under the text)`, r.rows.every(x => x.chipTop !== null && x.fromTop !== null && Math.abs(x.chipTop - x.fromTop) <= 12), JSON.stringify(r.rows.map(x => [x.chipTop, x.fromTop])));
                check(`${at}no separate Computer line under the card's text`, r.rows.every(x => x.serverCellText === ''), JSON.stringify(r.rows.map(x => x.serverCellText)));
                check(`${at}nothing is wider than the screen`, r.wide <= 0 && r.rows.every(x => x.right <= w + 1), String(r.wide));
            } else {
                check(`${at}a computer's wide card names its computer in its words, no chip (#15162: no table header any more)`, r.rows.every(x => x.chip === null && /Laptop|Desktop/.test(x.serverCellText)), JSON.stringify(r.rows.map(x => x.serverCellText)));
            }

            // B: only waiting agents (no question, no skill, no file): the one-line mail rows of a phone
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(() => { const original = window.fetch.bind(window), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                const agent = (server, i) => ({ session_id: 'same-' + i, name: 'same-' + i, display_name: 'Backend Dev', agent_type: 'claude', working_directory: '/repo/' + server, server, sleeping: false, archived: false, status: 'idle', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: new Date(Date.now() - 120000).toISOString() });
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href), mm = u.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/);
                    if (u.pathname === '/api/sessions/live') return json({ sessions: [agent('m1', 1), agent('m2', 2)] });
                    if (mm && mm[2] === '/api/operator-asks') return json([]);
                    if (mm && mm[2] === '/api/needs-you' && /kind=skill/.test(u.search)) return json({ count: 0, counts: { skill: 0 }, items: [] });
                    return original(url, opts); }; return true; })()`);
            await ev(`(async () => { const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); const m = await import((window.__coralStatic || '/static/') + 'inbox_tab.js'); const agent = (server, i) => ({ session_id: 'same-' + i, name: 'same-' + i, display_name: 'Backend Dev', agent_type: 'claude', working_directory: '/repo/' + server, server, sleeping: false, archived: false, status: 'idle', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: go test ./...', waiting_since: new Date(Date.now() - 120000).toISOString() }); state.liveSessions = [agent('m1', 1), agent('m2', 2)]; m.updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            try { await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 2`, `${at}two waiting agents (B)`, 15000); } catch (e) { throw new Error(e.message + ' ' + await ev(`JSON.stringify([...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].map(r => r.innerText.slice(0, 60)))`)); }
            await waitFor(`(() => { const t = document.querySelector('#group-table-view tbody'); const k = t.innerText + ':' + Math.round(t.getBoundingClientRect().height); if (window.__nccb !== k) { window.__nccb = k; window.__nccbAt = performance.now(); return false; } return performance.now() - window.__nccbAt > 500; })()`, `${at}the agent rows have settled`, 8000);
            await shot(`needs-computer-chip-agents-${w}`);
            const b = await ev(`(() => { const vis = e => e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1; return { rows: [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => { const chip = tr.querySelector('.inbox-computer-chip, .dt-mail-computer'); const title = tr.querySelector('.dt-mail-title, .inbox-review-from'); return { name: title ? title.textContent.trim() : '', chip: chip ? chip.textContent.trim() : null, sameLine: !!chip && !!title && Math.abs(chip.getBoundingClientRect().top - title.getBoundingClientRect().top) <= 12 }; }), headers: [...document.querySelectorAll('#group-table-view thead th')].filter(vis).map(t => t.textContent.trim()), wide: document.documentElement.scrollWidth - innerWidth }; })()`);
            console.log(`${at}B ` + JSON.stringify(b));
            if (mobile) {
                check(`${at}(B) two agents of one name: each row's chip says which computer`, JSON.stringify(b.rows.map(x => x.chip).sort()) === JSON.stringify(['Desktop', 'Laptop']) && b.rows.every(x => x.name === 'Backend Dev'), JSON.stringify(b.rows));
                check(`${at}(B) the chip is on the name's line, nothing wider than the screen`, b.rows.every(x => x.sameLine) && b.wide <= 0, JSON.stringify([b.rows.map(x => x.sameLine), b.wide]));
            } else check(`${at}(B) each wide card says which computer (no chip, no table header, #15162)`, JSON.stringify(await ev(`[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].map(tr => (tr.innerText.match(/Laptop|Desktop/) || [''])[0]).sort()`)) === JSON.stringify(['Desktop', 'Laptop']) && b.rows.every(x => x.chip === null), JSON.stringify(b.rows));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
