// Automations, the Queue folder (#13651, goal #225): this computer's resource queue as one table, a group per resource ("mac-heavy: 1 of 1 in use, 3 waiting, on Mac"), the holder first (agent, state "Holding", the lease
// left), then the waiting line in order ("Waiting, place 1", how long it has waited), the note shown as the pattern text it is; a resource with nobody on it says all its slots are free. The Operator's Move first / up / down
// (off at the ends) and Kick (asks once more) call the routes and the table follows; the table reads again every few seconds; a 403 takes the buttons away. A phone has the same actions behind each row's ⋯.
// Drives Chrome over CDP through agent_view_harness.js with a stubbed /api/resources.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const now = Date.now();
const iso = ms => new Date(now + ms).toISOString();
const QUEUE = [
    { name: 'mac-heavy', slots: 1, machine: 'Mac', max_lease_seconds: 3600, holders: [{ id: 11, agent: 'Data Science & Dashboarding', task: 13596, priority: 3, note: 'cdp-suite inbox_*', enqueued_at: iso(-1800000), granted_at: iso(-1500000), lease_until: iso(25 * 60000) }],
        queue: [{ id: 12, agent: 'Frontend Dev', task: 13600, priority: 2, note: 'go-test routes', enqueued_at: iso(-600000), place: 1 }, { id: 13, agent: 'QA Engineer', task: 13601, priority: 2, note: 'cdp-suite saved_*', enqueued_at: iso(-300000), place: 2 },
            { id: 14, agent: 'Backend Dev', priority: 1, note: 'go-test board', enqueued_at: iso(-60000), place: 3 }] },
    { name: 'mini', slots: 2, machine: 'Mini', max_lease_seconds: 3600, holders: [{ id: 21, agent: 'UI Reviewer', note: 'cdp-suite inbox_artifact_count', enqueued_at: iso(-900000), granted_at: iso(-800000), lease_until: iso(40 * 60000) }], queue: [] },
    { name: 'spare', slots: 3, holders: [], queue: [] },
];
const STUB = `(() => { const real = window.fetch; window.__calls = []; window.__queue = ${JSON.stringify(QUEUE)}; window.__deny = false;
    const J = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
    const renumber = r => { r.queue.forEach((e, i) => { e.place = i + 1; }); };
    window.fetch = (u, o) => { const s = String(u), method = (o && o.method) || 'GET';
        if (method === 'GET' && /\\/api\\/resources$/.test(s)) return J({ resources: window.__queue });
        const mv = /\\/api\\/resources\\/entries\\/(\\d+)\\/move$/.exec(s), del = /\\/api\\/resources\\/entries\\/(\\d+)$/.exec(s);
        if (method === 'POST' && mv) { window.__calls.push(['move', Number(mv[1]), JSON.parse(o.body).how]); if (window.__deny) return J({ error: 'not_allowed' }, 403);
            for (const r of window.__queue) { const i = r.queue.findIndex(e => e.id === Number(mv[1])); if (i < 0) continue; const how = JSON.parse(o.body).how, [e] = r.queue.splice(i, 1); r.queue.splice(how === 'first' ? 0 : how === 'up' ? Math.max(0, i - 1) : Math.min(r.queue.length, i + 1), 0, e); renumber(r); }
            return J({ ok: true }); }
        if (method === 'DELETE' && del) { window.__calls.push(['kick', Number(del[1])]); if (window.__deny) return J({ error: 'not_allowed' }, 403);
            for (const r of window.__queue) { r.holders = r.holders.filter(e => e.id !== Number(del[1])); r.queue = r.queue.filter(e => e.id !== Number(del[1])); renumber(r); }
            return J({ ok: true }); }
        return real(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const themed = async (name, w) => { for (const t of ['dark', 'light']) { await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}); true`); await shot(`${name}-${t}-${w}`); } await ev(`document.documentElement.setAttribute('data-theme', 'dark'); true`); };
    const groups = () => ev(`[...document.querySelectorAll('#group-table-view tr.dt-group th')].map(th => th.textContent.trim())`);
    const rows = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
    const calls = () => ev(`window.__calls`);
    const agents = () => ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .queue-agent, #group-table-view tbody tr[data-key] .dt-mail-title')].map(e => e.textContent.trim())`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`localStorage.clear(); window.openAutomationsFolder('queue'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr[data-key]').length === 6`, at + 'the six rows of the queue (4 entries, 1 holder of the mini, the idle resource)', 10000);
            assert.equal(await ev(`location.pathname`), '/automations/queue', at + "the address is the folder's");
            const list = mobile ? `[...document.querySelectorAll('#group-table-view .view-list-select option')].map(o => o.textContent.trim())` : `[...document.querySelectorAll('.view-list-item')].map(b => b.textContent.trim())`;
            assert.ok((await ev(list)).some(t => /^Queue\s*\(?5\)?$/.test(t)), at + 'the folder list has Queue with its five entries: ' + JSON.stringify(await ev(list)));
            assert.deepEqual(await groups(), ['mac-heavy: 1 of 1 in use, 3 waiting, on Mac', 'mini: 1 of 2 in use, on Mini', 'spare: 0 of 3 in use'], at + 'a group per resource with its slots, line and machine');
            assert.deepEqual(await agents(), ['Data Science & Dashboarding', 'Frontend Dev', 'QA Engineer', 'Backend Dev', 'UI Reviewer', ...(mobile ? ['spare: all slots free'] : [])], at + 'the holder first, then the line in order');
            const text = (await rows()).join(' | ');
            assert.match(text, /Data Science & Dashboarding.*Holding/, at + 'the holder says Holding');
            assert.match(text, /Frontend Dev.*Waiting, place 1/, at + 'the first in line is place 1');
            assert.match(text, /QA Engineer.*Waiting, place 2/, at + 'the next is place 2');
            assert.match(text, /Backend Dev.*Waiting, place 3/, at + 'then place 3');
            assert.match(text, /2[0-9] min left|25 min left|24 min left/, at + "the holder's lease left is said");
            assert.match(text, /Waiting \d+ min|Waiting \d+ s/, at + 'a waiting entry says how long it has waited');
            assert.match(text, /cdp-suite inbox_\*/, at + 'the note is the pattern as text');
            assert.equal(await ev(`/rm -rf|\\$\\(/.test(document.getElementById('group-table-view').textContent)`), false, at + 'no command is shown');
            assert.equal(await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true, at + 'no sideways scroll');
            await themed('automations-queue', w);

            // the actions: desktop buttons, a phone's ⋯ menu
            const press = async (agent, label) => {
                if (!mobile) { await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].find(r => r.textContent.includes(${JSON.stringify(agent)})).querySelector('button[aria-label^=${JSON.stringify(label + ':')}]').click(); true`); return; }
                await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].find(r => r.textContent.includes(${JSON.stringify(agent)})).querySelector('.dt-mail-more-toggle').click(); true`);
                await waitFor(`!!document.querySelector('.dt-mail-menu:not([hidden])')`, at + 'the row menu', 4000);
                await ev(`[...document.querySelectorAll('.dt-mail-menu:not([hidden]) .menu-item')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
            };
            if (!mobile) {
                const state = agent => ev(`(() => { const r = [...document.querySelectorAll('#group-table-view tbody tr[data-key]')].find(r => r.textContent.includes(${JSON.stringify(agent)})); return [...r.querySelectorAll('.queue-act')].map(b => b.textContent.trim() + (b.disabled ? ' (off)' : '')); })()`);
                assert.deepEqual(await state('Frontend Dev'), ['Move first (off)', 'Move up (off)', 'Move down', 'Kick'], at + 'the first in line cannot move up');
                assert.deepEqual(await state('Backend Dev'), ['Move first', 'Move up', 'Move down (off)', 'Kick'], at + 'the last cannot move down');
                assert.deepEqual(await state('Data Science'), ['Kick'], at + 'a holder can only be kicked');
                assert.equal(await ev(`[...document.querySelectorAll('#group-table-view tbody tr[data-key]')].find(r => r.textContent.includes('All slots free')).querySelectorAll('.queue-act').length`), 0, at + 'a free resource has no buttons');
            }
            await press('QA Engineer', 'Move up');
            await waitFor(`window.__calls.length === 1`, at + 'the move call', 5000);
            assert.deepEqual(await calls(), [['move', 13, 'up']], at + 'Move up posts how: up for that entry');
            await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr[data-key] .queue-agent, #group-table-view tbody tr[data-key] .dt-mail-title')].map(e => e.textContent.trim()).slice(0, 3).join() === 'Data Science & Dashboarding,QA Engineer,Frontend Dev'`, at + 'the table follows: QA Engineer is now first in line', 8000);
            await press('Backend Dev', 'Move first');
            await waitFor(`window.__calls.length === 2`, at + 'the second call', 5000);
            assert.deepEqual((await calls())[1], ['move', 14, 'first'], at + 'Move first');
            if (!mobile) {
                await press('Frontend Dev', 'Kick');
                assert.equal((await calls()).length, 2, at + 'Kick asks once more: nothing is sent by the first press');
                assert.equal(await ev(`[...document.querySelectorAll('.queue-sure')].map(b => b.textContent).join()`), 'Confirm kick', at + 'the button says Confirm kick');
                await press('Frontend Dev', 'Kick');
            } else await press('Frontend Dev', 'Kick');
            await waitFor(`window.__calls.length === 3`, at + 'the kick call', 5000);
            assert.deepEqual((await calls())[2], ['kick', 12], at + 'Kick deletes that entry');
            await waitFor(`!document.getElementById('group-table-view').textContent.includes('Frontend Dev')`, at + 'the kicked agent leaves the table', 8000);
            await shot(`automations-queue-after-${w}`);

            // live: another agent joins the line; the table shows it within a few polls
            await ev(`window.__queue[0].queue.push({ id: 15, agent: 'Hermes Agent Investigation', note: 'go-test tunnel', enqueued_at: new Date().toISOString(), place: window.__queue[0].queue.length + 1 }); true`);
            await waitFor(`document.getElementById('group-table-view').textContent.includes('Hermes Agent Investigation')`, at + 'a new entry shows by itself (live refresh)', 12000);

            // the server refuses: the buttons go for good
            await ev(`window.__deny = true; true`);
            await press('QA Engineer', 'Kick').catch(() => {});
            if (!mobile) { await press('QA Engineer', 'Kick'); }
            await waitFor(`${mobile ? "![...document.querySelectorAll('#group-table-view .dt-mail-more-toggle')].length" : "document.querySelectorAll('#group-table-view .queue-act').length === 0"}`, at + 'a 403 takes the buttons away', 8000);
        }
    } finally { await client.close(); }
    console.log('PASS the Queue folder: groups, order, leases, actions, live refresh, 403');
})().catch(e => { console.error(e); process.exit(1); });
