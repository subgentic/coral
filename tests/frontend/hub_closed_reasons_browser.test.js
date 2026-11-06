// What the Hub closes for everyone says so (#13871; the census of #13860 found these three vanish or hang without a word): the skills picker of another computer's launch, the Queue folder when its read is refused,
// and a control marked data-hub-closed, which is dimmed with its own reason whatever the access tier. The reads are stubbed. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        // the skills picker: another computer's launch has a row with the reason; a refused read on this computer says so too; none of it can be ticked
        const picker = await ev(`(async () => { const m = await import(${S} + 'launch_skills.js'), original = window.fetch; if (!document.getElementById('launch-skills-row')) { const r = document.createElement('div'); r.id = 'launch-skills-row'; r.hidden = true; const h = document.createElement('div'); h.id = 'launch-skills-host'; r.append(h); document.body.append(r); } // the dialog's own row, drawn when it opens
            const row = () => document.getElementById('launch-skills-row'), host = () => document.getElementById('launch-skills-host'), out = {};
            await m.mountLaunchSkills('launch-skills', false); out.remote = { hidden: row().hidden, text: host().textContent, boxes: host().querySelectorAll('input[type=checkbox]').length, ids: m.launchSkillIds('launch-skills') };
            window.fetch = (u, o) => (String(u).includes('/api/skills') ? Promise.resolve(new Response('{}', { status: 403 })) : original(u, o));
            await m.mountLaunchSkills('launch-skills', true); out.refused = { hidden: row().hidden, text: host().textContent, ids: m.launchSkillIds('launch-skills') };
            window.fetch = original; return out; })()`);
        check(picker.remote.hidden === false && /Skills stay on the computer/.test(picker.remote.text) && picker.remote.boxes === 0 && picker.remote.ids.length === 0, "another computer's launch: the row says where the skills are, nothing to tick: " + JSON.stringify(picker.remote));
        check(picker.refused.hidden === false && /could not be read from this computer/.test(picker.refused.text) && picker.refused.ids.length === 0, 'a refused read says so, not a missing row: ' + JSON.stringify(picker.refused));
        // the Queue folder: a refused read is said, not left on "Reading the queue."
        const queue = await ev(`(async () => { const q = await import(${S} + 'automations_queue.js'), original = window.fetch;
            window.fetch = (u, o) => (new URL(String(u), location.origin).pathname === '/api/resources' ? Promise.resolve(new Response('{}', { status: 404 })) : original(u, o));
            await q.refreshQueue(); const line = q.queueTable([], false).empty.line; window.fetch = original; return line; })()`);
        check(/could not be read from this computer \(HTTP 404\)/.test(queue), 'a refused Queue read says so, not "Reading the queue.": ' + JSON.stringify(queue));
        // a control the Hub closes for everyone is dimmed with its own reason, and cleared when the mark goes
        const closed = await ev(`(async () => { const m = await import(${S} + 'hub_blocked_controls.js'); const b = document.createElement('button'); b.textContent = 'Open in editor'; b.title = 'Open it'; b.dataset.hubClosed = 'Opening an editor happens on the computer itself.'; document.body.append(b);
            m.markBlockedControls(); const on = { cls: b.classList.contains('hub-blocked'), aria: b.getAttribute('aria-disabled'), title: b.title };
            delete b.dataset.hubClosed; m.markBlockedControls(); const off = { cls: b.classList.contains('hub-blocked'), title: b.title }; b.remove(); return { on, off }; })()`);
        check(closed.on.cls && closed.on.aria === 'true' && /happens on the computer itself/.test(closed.on.title), 'a closed control is dimmed with its reason: ' + JSON.stringify(closed.on));
        check(!closed.off.cls && closed.off.title === 'Open it', 'and it is put back when it is no longer closed: ' + JSON.stringify(closed.off));
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS what the Hub closes for everyone says so: the skills picker, the Queue folder, a dimmed control');
})().catch(e => { console.error(e); process.exit(1); });
