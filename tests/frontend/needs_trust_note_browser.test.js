// The folder-trust row's note is read in full and its buttons stay in the row (#14661, Beta run 5): a waiting agent whose folder-trust prompt cannot offer Yes (a shared or shallow folder) says "No Yes here: Coral does not trust a shared or
// shallow folder, or one that other people on this computer can write into, from here. Open the agent to answer." - the whole sentence wraps inside its row, "No, exit" and Dismiss stay inside the row, and no row runs over the next.
// Three agents waiting at once, in the Inbox's Needs you at 1280 and 390 px and in a team's Needs you tab at 1280 (the Beta's screenshot; a real board is made and removed again). Derived from inbox_trust_row_browser (the agent, its chat reply and the answer route are stubbed).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const WHY = 'Coral does not trust a shared or shallow folder, or one that other people on this computer can write into, from here.';
const MENU = { question: 'Quick safety check: Is this a project you created or one you trust?', ask_id: 'trust-ask', unnumbered: true, options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, I trust this folder', action: 'select' }], trust_folder: '/tmp/exp-proj-6', trust_offer: false, trust_why: WHY };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const B = 'trust-' + Date.now().toString(36);
        const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, where] of [[1280, 900, false, 'inbox'], [390, 844, true, 'inbox'], [1280, 900, false, 'team']]) {
            const at = `${w} px ${where}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.__po = ${JSON.stringify(MENU)};
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: window.__po }), { headers: { 'content-type': 'application/json' } }));
                    return real(u, o); };
                const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to know: Quick safety check: Is this a project you created or one you trust?', waiting_since: 'w1' });
                for (const [name, job] of [['orch', 'Orchestrator'], ['lead', 'Lead Developer'], ['qa', 'QA Engineer']]) window.__m.add(name, 'A', 4, { sleeping: false, board_project: ${JSON.stringify(B)}, session_id: name + '-id', board_job_title: job }); true`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 3`, `${at}the three agents`, 8000);
            await ev(`window.__qaState.liveSessions = window.__qaState.liveSessions.map(s => ({ ...s, ...window.__m.entry(window.__m.agents[s.session_id]) })); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.updateInboxTab()); true`);
            await waitFor(`document.getElementById('nav-tab-hub-inbox-badge').textContent === '3'`, `${at}three waiting`, 8000);
            let T = '#group-table-view';
            if (where === 'team') { T = '#team-panel-needs'; for (const id of ['orch', 'lead', 'qa']) await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: id, session_name: id + '-s' }); await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'needs' }); true`); }
            else if (mobile) {
                await ev(`document.getElementById('nav-select').click(); true`);
                await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, `${at}Inbox in the view menu`, 5000);
                await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`);
                await waitFor(`!!document.querySelector('#mobile-inbox-list .sidebar-pane')`, `${at}the phone list`, 8000);
            } else await ev(`document.getElementById('nav-tab-hub-inbox').click(); true`);
            if (where !== 'team') await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} .inbox-only-reject').length === 3`, `${at}three trust notes`, 15000);
            await waitFor(`(() => { const t = document.querySelector('${T} tbody'); const k = t.innerText + ':' + Math.round(t.getBoundingClientRect().height); if (window.__ntn !== k) { window.__ntn = k; window.__ntnAt = performance.now(); return false; } return performance.now() - window.__ntnAt > 600; })()`, `${at}the rows have settled`, 8000);
            await shot(`needs-trust-note-${where}-${w}`);
            const r = await ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].filter(tr => tr.querySelector('.inbox-only-reject')); const box = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
                const scroller = document.querySelector('${T}'); const clip = (e) => { let p = e.parentElement; let right = innerWidth; while (p && p !== document.body) { const cs = getComputedStyle(p); if (cs.overflowX !== 'visible') right = Math.min(right, p.getBoundingClientRect().right); p = p.parentElement; } return right; };
                return rows.map((tr, i) => { const note = tr.querySelector('.inbox-only-reject'), nb = box(note), rb = box(tr), next = rows[i + 1] && box(rows[i + 1]); const btns = [...tr.querySelectorAll('.inbox-answers .btn, .inbox-answer, .inbox-dismiss, .inbox-review-actions .btn')].filter(b => b.getClientRects().length).map(box);
                    const range = document.createRange(); range.selectNodeContents(note); const text = [...range.getClientRects()].reduce((m, q) => Math.max(m, q.right), 0), textL = [...range.getClientRects()].reduce((m, q) => Math.min(m, q.left), 1e9);
                    return { noteLeft: Math.round(textL), btnLeft: btns.length ? Math.round(Math.min(...btns.map(b => b.l))) : null, text: note.textContent, textRight: Math.round(text), noteRight: Math.round(nb.r), clipRight: Math.round(clip(note)), noteOverflow: note.scrollWidth > note.clientWidth + 1, outside: btns.filter(b => b.b > rb.b + 1 || b.t < rb.t - 1 || b.r > innerWidth + 1).length, over: !!next && rb.b > next.t + 1, btnCount: btns.length }; }); })()`);
            console.log(`${at}` + JSON.stringify(r.map(x => ({ tr: x.textRight, nr: x.noteRight, cr: x.clipRight, ov: x.noteOverflow, out: x.outside, over: x.over, b: x.btnCount }))));
            check(`${at}three rows with the note`, r.length === 3 && r.every(x => /^No Yes here: Coral does not trust a shared or shallow folder, or one that other people on this computer can write into, from here\. Open the agent to answer\.$/.test(x.text)), JSON.stringify(r.map(x => x.text.slice(0, 30))));
            check(`${at}the whole sentence is inside its row: nothing cut at the right edge`, r.every(x => !x.noteOverflow && x.textRight <= x.clipRight + 1), JSON.stringify(r.map(x => [x.textRight, x.clipRight, x.noteOverflow])));
            check(`${at}No, exit (and Dismiss on a wide row; on a phone it is in the three dots) stay inside their row`, r.every(x => x.outside === 0 && x.btnCount >= (mobile ? 1 : 2)), JSON.stringify(r.map(x => [x.outside, x.btnCount])));
            if (mobile) check(`${at}the note is inset like the button above it: not flush with the screen's left edge, 12 px clear on the right`, r.every(x => x.btnLeft !== null && x.noteLeft >= x.btnLeft - 1 && x.textRight <= w - 12), JSON.stringify(r.map(x => [x.noteLeft, x.btnLeft, x.textRight])));
            check(`${at}no row runs over the next`, r.every(x => !x.over), JSON.stringify(r.map(x => x.over)));
        }
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
