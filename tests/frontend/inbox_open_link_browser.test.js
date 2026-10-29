// "Open the task" in the shared Inbox component (#7572, UI/UX's #7472 item 3): on a task's page of its own (mountInbox's `only` option) it is a plain link under the title line, no box; in a list, and in every mount that does not
// ask for the page (Coral Hub mounts inbox_panel.js at a pinned version), it keeps the small bordered button it had. Both the link variant (the adapter gives taskHref) and the button variant (it only opens). 24 px for a mouse,
// 44 px on a phone; both themes. The tasks are given by a stub adapter. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['desktop', 1280, 800, false], ['phone', 390, 844, true]]) for (const theme of ['dark', 'light']) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await setTheme(ev, theme);
            const at = `${label}, ${theme}`;
            // a stub adapter: one task; `link` gives the task an address (an <a>), without it the control is a button that opens the task through the adapter
            await ev(`(async () => { const m = await import(${S} + 'inbox_panel.js'); const c = await import(${S} + 'inbox_coral.js');
                const task = { id: 7, project: 'team-a', board: 'team-a', title: 'Review the plan', priority: 'low', status: 'pending', created_by: 'Orchestrator', updated_at: '2026-10-25T10:00:00Z', revision: 1 };
                const base = { ...c.coralInboxAdapter, listTasks: async () => [task], getTask: async () => ({ body: 'Please check the plan.', created_by: 'Orchestrator', status: 'pending' }), openTask: () => {}, taskHref: undefined }; // no address: the control opens the task through the adapter, as a button
                const mk = (id, adapter, options) => { const host = document.createElement('div'); host.id = id; document.body.append(host); return m.mountInbox(host, adapter, options); };
                window.__mount = { listLink: () => mk('h-list-link', { ...base, taskHref: () => '/board/team-a' }), listButton: () => mk('h-list-btn', base),
                    oneLink: () => mk('h-one-link', { ...base, taskHref: () => '/board/team-a' }, { region: false, only: { project: 'team-a', id: 7 } }), oneButton: () => mk('h-one-btn', base, { region: false, only: { project: 'team-a', id: 7 } }) };
                for (const k of Object.keys(window.__mount)) window.__mount[k](); return true; })()`);
            await waitFor(`!!document.querySelector('#h-one-link .ibx-open') && !!document.querySelector('#h-one-btn .ibx-open')`, `${at}: the one-task mounts`, 6000);
            await ev(`for (const id of ['h-list-link', 'h-list-btn']) { const head = document.querySelector('#' + id + ' .ibx-task-head'); if (head) head.click(); } true`);
            await waitFor(`!!document.querySelector('#h-list-link .ibx-open') && !!document.querySelector('#h-list-btn .ibx-open')`, `${at}: the list mounts, opened`, 6000);
            const look = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const cs = getComputedStyle(e); const b = e.getBoundingClientRect(); return { tag: e.tagName, btn: e.classList.contains('btn'), border: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderLeftWidth), bg: cs.backgroundColor, under: cs.textDecorationLine, h: Math.round(b.height), underTitle: !e.closest('.ibx-task-body') ? null : true }; })()`);
            for (const [name, sel, plain] of [['one task, link', '#h-one-link .ibx-open', true], ['one task, button', '#h-one-btn .ibx-open', true], ['a list, link', '#h-list-link .ibx-open', false], ['a list, button', '#h-list-btn .ibx-open', false]]) {
                const l = await look(sel);
                check(`${at}: ${name}: is ${/button/.test(name) ? 'a button (the adapter only opens)' : 'an <a> (the adapter gives an address)'}`, l.tag === (/button/.test(name) ? 'BUTTON' : 'A'), l.tag);
                if (plain) { check(`${at}: ${name}: "Open the task" is a plain link (no box, no fill, underlined)`, !l.btn && l.border === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(l.bg) && /underline/.test(l.under), JSON.stringify(l)); check(`${at}: ${name}: it is ${mobile ? 44 : 24} px or more high to hit`, l.h >= (mobile ? 44 : 24), String(l.h)); }
                else check(`${at}: ${name}: unchanged, the small bordered button`, l.btn && l.border > 0, JSON.stringify(l));
            }
            const order = await ev(`(() => { const body = document.querySelector('#h-one-link .ibx-task-body'); const kids = [...body.children].map(c => c.className.split(' ')[0]); return kids; })()`);
            check(`${at}: on the task's page the link comes first in the body, before the text and the reply`, order[0] === 'ibx-task-metarow', JSON.stringify(order));
        }
        assert.ok(results.every(Boolean), `${results.filter(r => !r).length} check(s) failed`);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
