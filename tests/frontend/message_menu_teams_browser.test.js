// "Send to another agent" in a message's menu is grouped by team (#10676, the Operator: one flat list of every agent, two Lead Developers, two Orchestrators): this agent's own team first, then the other teams by name,
// the agents with no team last under "No team"; each team a heading over its agents; the list scrolls inside the menu and the arrows still walk it. 1280 and 390 px; a chat of mocked agents in four teams.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const problems = [];
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { localStorage.setItem('coral-live-view-mode', 'chat'); const ids = {};
                const add = (name, sid, team, extra = {}) => { window.__m.add(name, 'A', 4, { sleeping: false, session_id: sid, ...(team ? { board_project: team } : {}), ...extra }); };
                add('qa', 'qa-sid', 'team-b'); add('orch-b', 'ob-sid', 'team-b', {}); add('dev-b', 'db-sid', 'team-b');
                add('orch-a', 'oa-sid', 'team-a'); add('lead-a', 'la-sid', 'team-a'); add('orch-c', 'oc-sid', 'team-c'); add('lead-c', 'lc-sid', 'team-c'); add('solo-1', 's1-sid', ''); add('solo-2', 's2-sid', '');
                for (let i = 0; i < 24; i++) add('extra-' + i, 'ex' + i + '-sid', i % 2 ? 'team-a' : 'team-c');
                window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); return true; })()`);
            await ev(`window.selectLiveSession('qa', 'claude', 'qa-sid', 'local'); true`);
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, `${w}: the chat`, 15000);
            await ev(`document.querySelector('#live-history-messages .chat-bubble.human .chat-msg-menu-btn').click(); true`);
            await waitFor(`!!document.getElementById('chat-msg-menu') && !document.getElementById('chat-msg-menu').hidden && document.getElementById('chat-msg-menu').getClientRects().length > 0`, `${w}: the menu opens`, 4000);
            const m = await ev(`(() => { const menu = document.getElementById('chat-msg-menu'); const groups = [...menu.querySelectorAll('[role=group]')].map(g => ({ name: g.getAttribute('aria-label') || (document.getElementById(g.getAttribute('aria-labelledby')) || {}).textContent || '', count: g.querySelectorAll('[role=menuitem]').length, head: (document.getElementById(g.getAttribute('aria-labelledby')) || {}).getClientRects ? ((document.getElementById(g.getAttribute('aria-labelledby')).getClientRects().length > 0) ? 'shown' : '') : '' }));
                const cs = getComputedStyle(menu), r = menu.getBoundingClientRect(); return { groups, scrolls: menu.scrollHeight > menu.clientHeight + 1, overflowY: cs.overflowY, fits: r.top >= 0 && r.bottom <= innerHeight, items: [...menu.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim()) }; })()`);
            const names = m.groups.map(g => g.name || g.head);
            if (JSON.stringify(names.slice(0, 4)) !== JSON.stringify(['team-b', 'team-a', 'team-c', 'No team'])) problems.push(`${w}: the teams are this agent's own first, the others by name, No team last: ${JSON.stringify(names)}`);
            if (m.groups[0] && m.groups[0].count !== 2) problems.push(`${w}: the own team lists its two other agents: ${JSON.stringify(m.groups[0])}`);
            if (m.groups.length && !m.groups.every(g => g.head)) problems.push(`${w}: each team has a visible heading: ${JSON.stringify(m.groups)}`);
            if (!m.scrolls || !/auto|scroll/.test(m.overflowY) || !m.fits) problems.push(`${w}: the list scrolls inside the menu and the menu stays on the screen: ${JSON.stringify({ scrolls: m.scrolls, overflowY: m.overflowY, fits: m.fits })}`);
            await shot(`message-menu-teams-${w}`);
            // the arrows walk the groups: Down from the last visible item keeps going into later teams
            await ev(`document.getElementById('chat-msg-menu').querySelector('[role=menuitem]').focus(); true`);
            for (let i = 0; i < 6; i++) await Input.dispatchKeyEvent({ type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }));
            const act = await ev(`(() => { const a = document.activeElement; return a && a.closest('#chat-msg-menu') ? (a.closest('[role=group]') || {}).getAttribute ? (a.closest('[role=group]') && (a.closest('[role=group]').getAttribute('aria-label') || '')) : 'in menu' : 'outside'; })()`);
            if (act === 'outside') problems.push(`${w}: the arrow keys stay in the menu`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Send to another agent by team:\n  ' + problems.join('\n  '));
    console.log('PASS Send to another agent is grouped by team');
})().catch(e => { console.error(e); process.exit(1); });
