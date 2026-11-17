// The Operator's reminders for one agent, on its page (#19350). The module is mounted on a host; the reminders routes are a thin layer over fetch.
// Checked: only this agent's reminders are listed, each with Cancel; adding a one-time reminder sends {text, board, to, kind:"once", at, timezone}; a repeating one sends kind and every_minutes;
// a server refusal is said and the form keeps its text; cancel removes the row; a name with markup stays text; a refused read (the Hub) draws no section; readable in both themes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const settle = (ms, quietMs = 120) => require('./helpers/wait').settle(ev, ms, quietMs);
    const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
    const layer = () => ev(`(() => { if (!window.__realFetch) window.__realFetch = window.fetch; const R = window.__realFetch;
        window.__rem = { status: 200, addStatus: 201, posts: [], deletes: [], next: 10, rows: [
            { id: 1, name: 'Check CI', schedule_kind: 'interval', every_minutes: 15, target_session: '${SID}', target_board: 'agent-rem', origin: 'operator', paused: false },
            { id: 2, name: '<img src=x onerror=window.__pwn=1>', schedule_kind: 'once', at: '2026-11-18T09:00', timezone: 'UTC', target_session: '${SID}', target_board: 'agent-rem', origin: 'task', paused: true },
            { id: 3, name: 'Someone else', schedule_kind: 'daily', at: '08:00', timezone: 'UTC', target_session: 'bbbbbbbb-1111-4222-8333-444444444444', target_board: 'agent-rem', origin: 'operator', paused: false }] };
        const json = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin); const m = (o.method || 'GET').toUpperCase();
            if (url.pathname === '/api/reminders' && m === 'GET') return window.__rem.status === 200 ? json({ reminders: window.__rem.rows }) : json({ error: 'not_available_through_hub' }, window.__rem.status);
            if (url.pathname === '/api/reminders' && m === 'POST') { const b = JSON.parse(o.body); window.__rem.posts.push(b); if (window.__rem.addStatus !== 201) return json({ error: 'that time has passed' }, window.__rem.addStatus);
                window.__rem.rows.push({ id: window.__rem.next++, name: b.text, schedule_kind: b.kind === 'every' ? 'interval' : b.kind, at: b.at, every_minutes: b.every_minutes, timezone: b.timezone, target_session: '${SID}', target_board: 'agent-rem', origin: 'operator', paused: false }); return json({ ok: true }, 201); }
            const d = url.pathname.match(/^\\/api\\/reminders\\/(\\d+)$/);
            if (d && m === 'DELETE') { window.__rem.deletes.push(d[1]); window.__rem.rows = window.__rem.rows.filter(x => String(x.id) !== d[1]); return json({ ok: true }); }
            return R(u, o); }; return true; })()`);
    const mount = async () => {
        await ev(`document.getElementById('ar-host')?.remove(); (async () => { const m = await import(${S} + 'agent_reminders.js'); const h = Object.assign(document.createElement('main'), { id: 'ar-host' }); h.style.cssText = 'position:fixed;inset:0;z-index:1000;background:var(--bg-primary);padding:16px;overflow:auto'; document.body.append(h);
            window.__sec = await m.mountAgentReminders(h, 'agent-rem', { session_id: '${SID}', subscriber_id: 'Dev', name: 'Dev' }); })(); true`);
        await settle(250);
    };
    const rowTexts = () => ev(`Array.from(document.querySelectorAll('#ar-host .agent-rem-list li')).map(li => li.textContent)`);
    const say = () => ev(`document.querySelector('#ar-host .agent-rem-say')?.textContent || ''`);
    const fill = (text, kind, when, every) => ev(`(() => { const f = document.querySelector('#ar-host form'); const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        set(f.querySelector('input[type=text]'), ${JSON.stringify(text)}); const sel = f.querySelectorAll('select'); set(sel[0], ${JSON.stringify(kind)});
        if (${JSON.stringify(when)}) set(f.querySelector('input[type=datetime-local],input[type=time]'), ${JSON.stringify(when)}); if (${JSON.stringify(every)}) set(sel[1], ${JSON.stringify(every)}); return true; })()`);
    const submit = async () => { await ev(`document.querySelector('#ar-host form button[type=submit]').click(); true`); await settle(300); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const theme of ['dark', 'light']) {
            console.log(theme);
            await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
            await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: theme }] });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await require('./helpers/wait').coralReady(ev); await installAudit(ev); await setTheme(ev, theme);
            await layer(); await mount();
            const rows = await rowTexts();
            check(`${theme}: only this agent's two reminders are listed, with their schedule and "off" for a paused one`, rows.length === 2 && /Check CI \(every 15 min\)/.test(rows[0]) && /once, 2026-11-18 09:00 UTC, off/.test(rows[1]), JSON.stringify(rows));
            check(`${theme}: a name with markup stays text and nothing ran`, !(await ev(`!!document.querySelector('#ar-host img') || !!window.__pwn`)));
            const au = await auditRegion(ev, ['#ar-host'], { focus: ['#ar-host input[type=text]'] });
            check(`${theme}: readable (4.5:1) with a focus ring (${au.checked} checked)`, au.fails.length === 0, JSON.stringify(au.fails.slice(0, 2)));

            await fill('Look at the soak', 'once', '2030-01-02T09:30');
            await submit();
            let p = await ev(`window.__rem.posts`);
            check(`${theme}: a one-time reminder sends text, board, to, kind once, at and the zone`, p.length === 1 && p[0].text === 'Look at the soak' && p[0].board === 'agent-rem' && p[0].to === 'Dev' && p[0].kind === 'once' && p[0].at === '2030-01-02T09:30' && !!p[0].timezone, JSON.stringify(p));
            check(`${theme}: it is listed and the box is empty again`, (await rowTexts()).length === 3 && (await say()) === 'Reminder added.' && (await ev(`document.querySelector('#ar-host input[type=text]').value`)) === '', JSON.stringify([await rowTexts(), await ev(`JSON.stringify(window.__rem.rows.map(x=>x.id))`), await say(), await ev(`document.querySelector('#ar-host input[type=text]').value`)]));

            await fill('Check mail', 'every', '', '30');
            await submit();
            p = await ev(`window.__rem.posts`);
            check(`${theme}: a repeating one sends kind every and every_minutes`, p.length === 2 && p[1].kind === 'every' && p[1].every_minutes === 30 && p[1].at === undefined, JSON.stringify(p[1]));
            await fill('Morning', 'weekdays', '08:15');
            await submit();
            p = await ev(`window.__rem.posts`);
            check(`${theme}: Monday to Friday sends the time only`, p[2].kind === 'weekdays' && p[2].at === '08:15', JSON.stringify(p[2]));

            await ev(`window.__rem.addStatus = 400; true`);
            await fill('Too late', 'daily', '07:00');
            await submit();
            check(`${theme}: a refusal is said and the text stays`, /Could not add it: that time has passed/.test(await say()) && (await ev(`document.querySelector('#ar-host input[type=text]').value`)) === 'Too late');

            await ev(`document.querySelector('#ar-host .agent-rem-list li button').click(); true`); await settle(300);
            check(`${theme}: Cancel removes that reminder only`, (await ev(`window.__rem.deletes`)).join() === '1' && (await say()) === 'Reminder cancelled.' && !(await rowTexts()).some(t => /Check CI/.test(t)));

            await ev(`window.__rem.status = 404; true`);
            await mount();
            check(`${theme}: when the routes are not served there is no section`, (await ev(`window.__sec === null && !document.querySelector('#ar-host section')`)));
            await ev(`document.getElementById('ar-host')?.remove(); true`);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed}/${results.length} checks passed`);
        if (failed) process.exitCode = 1;
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
