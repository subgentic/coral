// The phone agent page's top bar (#21257, the Operator's shot): one name row (back, dot, name, team · computer, ⋯) and, with the ⋯ open, one row of equal action buttons (Find, Copy, Sidebar, Terminal), each one
// control with its word inside a 44 px target. Nothing overlaps the name block at 360, 390 and 430 px, in both themes, with a short and a long name and team. Chrome over CDP, isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const LONG = { name: 'senior-frontend-developer-two-with-a-very-long-name', team: 'a-very-long-team-name-for-testing' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], report = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [360, 390, 430]) for (const theme of ['dark', 'light']) for (const [name, team] of [['Orchestrator', 'coral-go-team'], [LONG.name, LONG.team]]) {
            const at = `${w} ${theme} ${name.length > 20 ? 'long' : 'short'}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.setItem('coral-theme', '${theme}'); document.documentElement.setAttribute('data-theme', '${theme}'); window.__m.add(${JSON.stringify(name)}, 'A', 3, { sleeping: false, session_id: 'tb-id', board_project: ${JSON.stringify(team)} }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === ${JSON.stringify(name)})`, `${at}the agent`, 10000);
            await ev(`window.selectLiveSession(${JSON.stringify(name)}, 'claude', 'tb-id', 'local'); true`);
            await waitFor(`document.getElementById('terminal-header-label')?.textContent === ${JSON.stringify(name)} && document.querySelector('.terminal-header').getClientRects().length > 0`, `${at}the header`, 10000);
            await waitFor(`!!document.getElementById('agent-bar-more') && document.getElementById('agent-bar-more').getClientRects().length > 0`, `${at}the ⋯`, 8000);
            await waitFor(`document.querySelector('.terminal-header').hasAttribute('data-more') && document.querySelector('#popout-panel-toggle-btn').getClientRects().length > 0`, `${at}the row of buttons, without pressing the ⋯ (the approved mock shows it always)`, 6000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: layout settles after the row opens
            const m = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
                const vis = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
                const id = document.getElementById('terminal-header-identity'), back = document.querySelector('.terminal-back-btn'), more = document.getElementById('agent-bar-more');
                const ids = ['chat-find-btn', 'terminal-copy-screen-btn', 'terminal-open-window-link', 'popout-panel-toggle-btn', 'live-view-switch-menu'];
                const btns = ids.map(i => document.getElementById(i)).filter(vis).map(e => ({ id: e.id, text: e.textContent.trim() + '|' + (getComputedStyle(e, '::before').content || ''), ...r(e), bg: getComputedStyle(e).backgroundColor, shadow: getComputedStyle(e).boxShadow !== 'none', border: getComputedStyle(e).borderTopWidth }));
                return { id: r(id), back: r(back), more: r(more), btns, docW: document.documentElement.scrollWidth, label: r(document.getElementById('terminal-header-label')), ctx: r(document.getElementById('terminal-header-context')), ctxShown: vis(document.getElementById('terminal-header-context')) }; })()`);
            report.push(at + JSON.stringify({ btns: m.btns.map(b => [b.id, Math.round(b.t), Math.round(b.h), Math.round(b.w)]), id: [Math.round(m.id.t), Math.round(m.id.b)], back: Math.round(m.back.t) }));
            check(m.btns.length >= 4 && m.btns.some(b => b.id === 'popout-panel-toggle-btn') && m.btns.some(b => b.id === 'live-view-switch-menu'), `${at}the action buttons are shown (${m.btns.map(b => b.id)})`);
            const nameBottom = Math.max(m.id.b, m.back.b, m.more.b);
            for (const b of m.btns) {
                check(b.t >= nameBottom - 0.5, `${at}${b.id} is on its own row under the name row (top ${Math.round(b.t)}, name row ends ${Math.round(nameBottom)})`);
                check(b.h >= 43.5 && b.w >= 43.5, `${at}${b.id} is at least 44 x 44 (${Math.round(b.w)} x ${Math.round(b.h)})`);
                check(b.l >= -0.5 && b.r <= w + 0.5, `${at}${b.id} is inside the screen`);
            }
            const tops = m.btns.map(b => Math.round(b.t)); check(new Set(tops).size === 1, `${at}the buttons share one row (tops ${tops})`);
            const hs = m.btns.map(b => Math.round(b.h)), ws = m.btns.map(b => Math.round(b.w)); check(new Set(hs).size === 1 && Math.max(...ws) - Math.min(...ws) <= 1, `${at}the buttons are the same size (${ws} x ${hs})`);
            check(new Set(m.btns.map(b => b.bg + b.shadow + b.border)).size === 1, `${at}the buttons share one style (${m.btns.map(b => b.bg + '/' + b.shadow + '/' + b.border).join(' ')})`);
            for (const b of m.btns) check(/Find|Copy|Window|Sidebar|erminal|hat/.test(b.text), `${at}${b.id} says its word (${b.text})`);
            check(m.label.r <= m.more.l + 0.5 && m.label.l >= m.back.r - 0.5, `${at}the name sits between the back arrow and the ⋯ (${Math.round(m.label.l)}-${Math.round(m.label.r)})`);
            if (m.ctxShown) check(m.ctx.t >= m.label.b - 1 && m.ctx.r <= m.more.l + 0.5, `${at}the team line is under the name and clear of the ⋯`);
            check(m.docW <= w, `${at}no sideways scroll (${m.docW})`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ') + '\n--\n' + report.slice(0, 4).join('\n')); process.exitCode = 1; return; }
    console.log('PASS the phone agent top bar: name row and equal 44 px buttons, no overlap at 360, 390 and 430 px, both themes');
})().catch(e => { console.error(e); process.exitCode = 1; });
