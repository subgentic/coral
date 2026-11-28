// The phone's Agents tab is the sidebar's row at a thumb's size (#10691, the operator picked Option A): the title is "Agents" (not "Live Sessions"); a team or folder header is chevron, name, count, menu with no card around it; an
// agent is a row of at least 48 px (#22105, the approved sidebar mock v2: the mark says the state, no status line; the row's accessible name keeps it), the state pill gone; no ALL-CAPS and no italics anywhere in the list; the per-row
// menu stays a touch target. 390 px, dark and light; the agents are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { const entry = window.__m.entry.bind(window.__m); window.__m.entry = a => ({ ...entry(a), ...(a.name === 'Orchestrator' ? { waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run npm test', status: 'Waiting for input' } : a.name === 'Lead Developer' ? { working: true, status: 'Working', summary: 'Refactoring the sidebar rows' } : {}) });
            window.__m.add('Orchestrator', 'O', 4, { sleeping: false, board_project: 'team-a' }); window.__m.add('Lead Developer', 'L', 4, { sleeping: false, board_project: 'team-a' }); window.__m.add('QA Engineer', 'Q', 4, { sleeping: true, board_project: 'team-a' }); window.__m.add('solo', 'S', 4, { sleeping: false }); return true; })()`);
        await sleep(1200); // sleep-ok: the list draws over frames
        await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'render.js'), import((window.__coralStatic || '/static/') + 'state.js')]).then(([r, st]) => { r.renderLiveSessions(st.state.liveSessions); return true; })`);
        await ev(`window.switchMobileTab && window.switchMobileTab('agents'); true`);
        await waitFor(`document.querySelectorAll('#mobile-session-list .session-group-item[data-session-id]').length >= 3`, 'the phone list', 8000);
        for (const theme of ['dark', 'light']) {
            await setTheme(ev, theme); await sleep(400); // sleep-ok: the theme settles over frames
            const g = await ev(`(() => { const list = document.getElementById('mobile-session-list'), rows = [...list.querySelectorAll('.session-group-item[data-session-id]')], cs = (e, p) => getComputedStyle(e, p);
                const hdr = list.querySelector('.session-group-header'), all = [...list.querySelectorAll('*')];
                return { title: document.querySelector('.mobile-list-title').textContent.trim(), rowH: rows.map(r => Math.round(r.getBoundingClientRect().height)), status: rows.map(r => { const l = r.querySelector('.session-info > .session-status-line'); return l ? l.textContent.trim() : null; }), statusShown: rows.map(r => { const l = r.querySelector('.session-status-line'); return !!l && cs(l).display !== 'none' && l.getClientRects().length > 0; }), statusBefore: rows.map(r => cs(r.querySelector('.session-info'), '::after').content), named: rows.map(r => { const l = r.querySelector('.session-status-line'); return !!l && (r.getAttribute('aria-label') || '').includes(l.textContent.trim()); }), found: ['Needs input', 'Working'].map(t => { getSelection().removeAllRanges(); return window.find(t, false, false, true); }),
                    marks: rows.map(r => (r.querySelector('.session-dot') || {}).className || ''), pill: rows.some(r => { const p = r.querySelector('.chip.session-state-pill'); return !!p && cs(p).display !== 'none'; }),
                    upper: all.filter(e => e.getClientRects().length && e.textContent.trim() && cs(e).textTransform === 'uppercase').map(e => e.className).slice(0, 5), italic: all.filter(e => e.getClientRects().length && e.textContent.trim() && cs(e).fontStyle === 'italic').map(e => e.className).slice(0, 5),
                    header: { bg: cs(hdr).backgroundColor, radius: cs(hdr).borderTopLeftRadius }, kebab: rows.map(r => { const k = r.querySelector('.sidebar-kebab-btn'); const b = k && k.getBoundingClientRect(); return b ? [Math.round(b.width), Math.round(b.height)] : null; }) }; })()`);
            assert.equal(g.title, 'Agents', `${theme}: the title is Agents`);
            assert.ok(g.rowH.every(h => h >= 48), `${theme}: every agent row is at least 48 px (the approved sidebar mock v2, #22105): ${JSON.stringify(g.rowH)}`);
            // the state is the mark (amber needs you, filled green working) and the row's accessible name; no status line is drawn (mock v2: the name, then the task line)
            assert.ok(g.marks.some(c => /mk-need/.test(c)) && g.marks.some(c => /mk-work/.test(c)), `${theme}: the marks say needs you and working: ${JSON.stringify(g.marks)}`);
            assert.ok(g.statusShown.every(v => !v), `${theme}: no status line under the name: ${JSON.stringify(g.statusShown)}`);
            assert.ok(g.named.every(Boolean), `${theme}: each row's accessible name has its status: ${JSON.stringify(g.named)}`);
            assert.equal(g.pill, false, `${theme}: no state pill on a row`);
            assert.deepEqual([g.upper, g.italic], [[], []], `${theme}: no ALL-CAPS and no italics in the list`);
            assert.ok(g.header.bg === 'rgba(0, 0, 0, 0)' && g.header.radius === '0px', `${theme}: the header has no card: ${JSON.stringify(g.header)}`);
            assert.ok(g.kebab.every(k => k && k[0] >= 24 && k[1] >= 24), `${theme}: each row keeps its menu: ${JSON.stringify(g.kebab)}`);
            await shot(`phone-agents-${theme}`);
        }
        console.log('PASS Phone Agents (Option A): Agents, 48 px rows, the mark and the accessible name say the state, no pill, no caps, no italics, no card, a menu per row, dark and light');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
