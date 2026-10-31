// The Orchestrator access group of Team settings (#11432), against the real server for the board and its members, with a thin layer over fetch for the grant, its log and its refusals (a fresh server has no live
// session to seat). Checked: the group is there and its seat list is the board's own agents (a terminal and the Operator are not offered); turning it on with no seat is refused in the form and sends nothing;
// Save sends the whole grant and only the fields the server reads (no actor, no claim); the log is text (markup stays text); a refusal of the read removes the group; readable (4.5:1) in both themes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

const SEAT = '0b7c2e4a-5d1f-4c8e-9a36-2f4d8e1b7c90';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const TEAM = 'og-team-' + Date.now().toString(36);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const settle = (ms, quietMs = 120) => require('./helpers/wait').settle(ev, ms, quietMs);
    const board = (p, method, body) => ev(`fetch('/api/board/${TEAM}${p}', { method: '${method}', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => ({ status: r.status }))`);
    // The layer: grant (the answer to GET orchestrator-grant, or a refusal), log, puts (every PUT body) and the answer to the next PUT.
    const layer = () => ev(`(() => { if (!window.__realFetch) window.__realFetch = window.fetch; const R = window.__realFetch; window.__og = { grant: { status: 200, body: { project: '${TEAM}', enabled: false, max_per_hour: 10, max_live: 8, idle_minutes: 5 } }, log: [], puts: [], putAnswer: null };
        const json = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin).pathname; const m = (o.method || 'GET').toUpperCase();
            if (p === '/api/board/${TEAM}/orchestrator-grant' && m === 'GET') return json(window.__og.grant.body, window.__og.grant.status);
            if (p === '/api/board/${TEAM}/orchestrator-grant' && m === 'PUT') { const b = JSON.parse(o.body); window.__og.puts.push(b); if (window.__og.putAnswer) return json(window.__og.putAnswer.body, window.__og.putAnswer.status); window.__og.grant.body = { ...window.__og.grant.body, enabled: b.enabled, seat_session: b.seat_session, max_per_hour: b.max_per_hour, max_live: b.max_live, idle_minutes: b.idle_minutes }; return json(window.__og.grant.body); }
            if (p === '/api/board/${TEAM}/lifecycle-log' && m === 'GET') return json(window.__og.log);
            return R(u, o); }; return true; })()`);
    const open = async () => {
        await ev(`document.getElementById('team-settings-workspace')?.remove(); import(${S} + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .settings-tab[data-section=messaging]')`, 'the settings page', 15000);
        await settle(200);
    };
    const tab = () => ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=orchestrator]') ? true : false`);
    const show = async () => { await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=orchestrator]').click(); true`); await settle(150); };
    const P = '#team-settings-orchestrator';
    const q = (sel) => `document.querySelector('${P} ${sel}')`;
    const setNum = async (name, v) => { await ev(`(() => { const i = ${q(`input[name=${name}]`)}; i.value = '${v}'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const theme of ['dark', 'light']) {
            console.log(theme);
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await require('./helpers/wait').coralReady(ev); await installAudit(ev); await setTheme(ev, theme);
            for (const [id, title, session] of [['Boss', 'Orchestrator', `claude-${SEAT}`], ['Dev', 'Developer', 'claude-11111111-2222-4333-8444-555555555555'], ['Shell', 'Terminal', 'terminal-22222222-2222-4333-8444-555555555555']]) {
                const sub = await board('/subscribe', 'POST', { subscriber_id: id, job_title: title, session_name: session });
                assert.ok(sub.status < 300, JSON.stringify(sub));
            }
            await layer();
            await ev(`window.__og.log = [{ id: 1, kind: 'wake', actor: 'Boss', target: 'Dev', status: 'ok', at: '2026-10-31T06:00:00Z' }, { id: 2, kind: 'launch', actor: 'Boss', target: '<img src=x onerror=window.__pwn=1>', status: 'ok', at: '2026-10-31T06:01:00Z' }]; true`);
            await open();
            check(`${theme}: the group is there`, await tab());
            await show();
            const opts = await ev(`Array.from(${q('select[name=og_seat]')}.options).map(o => o.textContent)`);
            check(`${theme}: the seat list is the board's own agents (none, Boss, Dev), not the terminal or the Operator`, JSON.stringify(opts) === JSON.stringify(['No one', 'Boss (Orchestrator)', 'Dev (Developer)']), JSON.stringify(opts));
            check(`${theme}: caps and idle are off until the switch is on`, await ev(`${q('input[name=og_max_per_hour]')}.disabled && ${q('select[name=og_seat]')}.disabled`));
            const logText = await ev(`Array.from(document.querySelectorAll('${P} .sv-row[data-key=og_log] li')).map(li => li.textContent)`);
            check(`${theme}: the log reads as sentences, markup stays text and nothing ran`, logText.length === 2 && /Boss woke Dev/.test(logText[0]) && logText[1].includes('<img src=x') && !(await ev(`!!document.querySelector('${P} img') || window.__pwn === 1`)), JSON.stringify(logText));
            const au = await auditRegion(ev, [P], { focus: [`${P} input[name=og_enabled]`] });
            check(`${theme}: readable (4.5:1) with a focus ring (${au.checked} checked)`, au.fails.length === 0, JSON.stringify(au.fails.slice(0, 2)));

            // on, no seat: refused in the form, nothing sent
            await ev(`${q('input[name=og_enabled]')}.click(); true`); await settle(100);
            await ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`); await settle(250);
            check(`${theme}: on with no seat is refused in the form and sends nothing`, (await ev(`window.__og.puts.length`)) === 0 && /Pick the agent/.test(await ev(`document.querySelector('${P}').textContent`)));

            // seat and a cap: Save sends the whole grant, only what the server reads
            await ev(`(() => { const s = ${q('select[name=og_seat]')}; s.value = '${SEAT}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await setNum('og_max_live', 12);
            await ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`); await settle(400);
            const puts = await ev(`window.__og.puts`);
            check(`${theme}: Save sends the whole grant and nothing else (no actor, no claim)`, puts.length === 1 && JSON.stringify(puts[0]) === JSON.stringify({ enabled: true, seat_session: SEAT, max_per_hour: 10, max_live: 12, idle_minutes: 5 }), JSON.stringify(puts));
            check(`${theme}: the form shows what the server kept and is clean`, (await ev(`${q('input[name=og_max_live]')}.value`)) === '12' && (await ev(`document.querySelector('#team-settings-workspace .sv-save').disabled`)));

            // the server's refusal is said, the page stays dirty
            await ev(`window.__og.putAnswer = { status: 400, body: { error: 'seat_session must be a live agent seated on this board' } }; true`);
            await setNum('og_idle_minutes', 9);
            await ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`); await settle(400);
            check(`${theme}: a refusal is said in the server's words`, /seated on this board/.test(await ev(`document.querySelector('#team-settings-workspace').textContent`)));

            // a refused read (through the Hub, not the owner): no group
            await ev(`window.__og.putAnswer = null; window.__og.grant = { status: 403, body: { error: 'owner_only', code: 'owner_only' } }; true`);
            await open();
            check(`${theme}: when the grant cannot be read the group is not drawn`, !(await tab()));
            await ev(`document.getElementById('qa-ts-host')?.remove(); true`);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed}/${results.length} checks passed`);
        if (failed) process.exitCode = 1;
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
