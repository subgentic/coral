// The Agent reminders group of Team settings (#19288): each agent's count of reminders still to come, the next time on hover, and a switch per agent that turns its reminders off and back on without deleting them.
// The board is real; the reminders routes are a thin layer over fetch (GET /api/reminders/agents, POST .../switch). Checked: a row per agent with its count and "Next:" hover; an agent with none has a disabled switch;
// the switch sends {board, on} to that agent's own session and the row then says "off"; a refused switch puts it back and says so; a name with markup stays text; a refused read (the Hub) removes the group; readable in both themes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const TEAM = 'rem-team-' + Date.now().toString(36);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' \u2014 ' + detail : ''}`); };
    const settle = (ms, quietMs = 120) => require('./helpers/wait').settle(ev, ms, quietMs);
    const layer = () => ev(`(() => { if (!window.__realFetch) window.__realFetch = window.fetch; const R = window.__realFetch;
        window.__rem = { status: 200, switchStatus: 200, posts: [], agents: [
            { session_id: 'aaaaaaaa-1111-4222-8333-444444444444', name: 'Dev', count: 3, active: 3, next_at: '2026-11-18T09:00:00Z' },
            { session_id: 'bbbbbbbb-1111-4222-8333-444444444444', name: '<img src=x onerror=window.__pwn=1>', count: 2, active: 1, next_at: '' },
            { session_id: 'cccccccc-1111-4222-8333-444444444444', name: 'Helper', count: 0, active: 0, next_at: '' }] };
        const json = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin); const m = (o.method || 'GET').toUpperCase();
            if (url.pathname === '/api/reminders/agents' && m === 'GET') return window.__rem.status === 200 ? json({ agents: window.__rem.agents }) : json({ error: 'not_available_through_hub' }, window.__rem.status);
            const sw = url.pathname.match(/^\\/api\\/reminders\\/agents\\/([^\\/]+)\\/switch$/);
            if (sw && m === 'POST') { const b = JSON.parse(o.body); window.__rem.posts.push({ session: sw[1], ...b }); if (window.__rem.switchStatus !== 200) return json({ error: 'no' }, window.__rem.switchStatus);
                const a = window.__rem.agents.find(x => x.session_id === sw[1]); a.active = b.on ? a.count : 0; return json({ ok: true, on: b.on }); }
            return R(u, o); }; return true; })()`);
    const open = async () => {
        await ev(`document.getElementById('team-settings-workspace')?.remove(); import(${S} + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .settings-tab[data-section=reminders]')`, 'the settings page', 15000);
        await settle(200);
    };
    const tab = () => ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=reminders]') ? true : false`);
    const P = '#team-settings-reminders';
    const rows = () => ev(`Array.from(document.querySelectorAll('${P} .rem-agents li')).map(li => ({ name: li.querySelector('label').textContent, words: li.querySelector('.rem-count').textContent, title: li.querySelector('.rem-count').title, on: li.querySelector('input').checked, disabled: li.querySelector('input').disabled }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const theme of ['dark', 'light']) {
            console.log(theme);
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await require('./helpers/wait').coralReady(ev); await installAudit(ev); await setTheme(ev, theme);
            const sub = await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Dev', job_title: 'Developer', session_name: 'claude-aaaaaaaa-1111-4222-8333-444444444444' }) }).then(r => r.status)`);
            assert.ok(sub < 300, 'subscribe ' + sub);
            await layer();
            await open();
            check(`${theme}: the group is there`, await tab());
            await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=reminders]').click(); true`); await settle(150);
            const r = await rows();
            check(`${theme}: a row per agent with its count (Dev 3 reminders, 1 of 2 on, none)`, r.length === 3 && r[0].words === '3 reminders' && r[1].words === '1 of 2 on' && r[2].words === 'No reminders', JSON.stringify(r.map(x => x.words)));
            check(`${theme}: the hover says when the next one is, and "Nothing is due" when none`, /^Next: /.test(r[0].title) && r[1].title === 'Nothing is due', JSON.stringify(r.map(x => x.title)));
            check(`${theme}: an agent with none has its switch disabled; the others are on (1 of 2 counts as on)`, r[2].disabled && !r[0].disabled && r[0].on && r[1].on, JSON.stringify(r.map(x => [x.disabled, x.on])));
            check(`${theme}: a name with markup stays text and nothing ran`, r[1].name.startsWith('<img') && !(await ev(`!!document.querySelector('${P} img') || !!window.__pwn`)));
            const au = await auditRegion(ev, [P], { focus: [`${P} .rem-agents input`] });
            check(`${theme}: readable (4.5:1) with a focus ring (${au.checked} checked)`, au.fails.length === 0, JSON.stringify(au.fails.slice(0, 2)));

            // off: one POST to that agent's own session, then the row says off and keeps its count
            await ev(`document.querySelector('${P} .rem-agents li input').click(); true`); await settle(300);
            const posts = await ev(`window.__rem.posts`);
            check(`${theme}: the switch sends {board, on:false} for that agent's session only`, posts.length === 1 && posts[0].session === 'aaaaaaaa-1111-4222-8333-444444444444' && posts[0].on === false && posts[0].board === TEAM && Object.keys(posts[0]).sort().join() === 'board,on,session', JSON.stringify(posts));
            const off = await rows();
            check(`${theme}: the row says "3 reminders, off" and the switch is off; nothing is deleted`, off[0].words === '3 reminders, off' && !off[0].on && off[1].words === '1 of 2 on', JSON.stringify(off[0]));
            check(`${theme}: it says so in words`, /Dev's reminders are off/.test(await ev(`document.querySelector('${P} .rem-say').textContent`)));
            await ev(`document.querySelector('${P} .rem-agents li input').click(); true`); await settle(300);
            check(`${theme}: back on, the row is "3 reminders" again`, (await rows())[0].words === '3 reminders');

            // refused: the switch goes back and the page says it could not
            await ev(`window.__rem.switchStatus = 403; true`);
            await ev(`document.querySelector('${P} .rem-agents li input').click(); true`); await settle(300);
            check(`${theme}: a refused switch goes back and says it could not`, (await rows())[0].on === true && /Could not turn Dev's reminders off/.test(await ev(`document.querySelector('${P} .rem-say').textContent`)));

            // through the Hub: not served, no group
            await ev(`window.__rem.status = 404; true`);
            await open();
            check(`${theme}: when the routes are not served the group is not drawn`, !(await tab()));
            await ev(`document.getElementById('qa-ts-host')?.remove(); true`);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed}/${results.length} checks passed`);
        if (failed) process.exitCode = 1;
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
