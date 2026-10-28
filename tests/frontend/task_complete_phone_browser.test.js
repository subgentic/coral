// The Complete-task form on a phone (#10064, Mobile tester #10053): opened from an Operator task in the Inbox (/inbox/tasks/<team>/<id>), its labels sit ABOVE full-width fields (the message was a label with a small textarea
// squeezed beside it), the textarea is a real one (at least 100 px high, 16 px text so a phone does not zoom in), the Outcome select is full width, and Complete in the bar finishes it in one tap, with nothing typed.
// 390 px and 1280 px, against a real board on the isolated dev server (the board is removed again). Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const B = 'tcp-' + Date.now().toString(36);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const S = `(window.__coralStatic || '/static/')`;
    const mk = async title => { const r = await api('POST', `/api/board/${B}/tasks`, { title, body: 'Details', created_by: 'orch', assigned_to: 'Operator', priority: 'medium' }); return r.body.id || r.body.task_id || (r.body.task && r.body.task.id); };
    const bar = text => ev(`[...document.querySelectorAll('#inbox-page button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && b.getBoundingClientRect().height > 0)`.replace(/^/, '(() => { const b = ') + `; return b ? { h: Math.round(b.getBoundingClientRect().height), top: Math.round(b.getBoundingClientRect().top), bottom: Math.round(b.getBoundingClientRect().bottom) } : null; })()`);
    const tap = text => ev(`(() => { const b = [...document.querySelectorAll('#inbox-page button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && b.getBoundingClientRect().height > 0); if (b) b.click(); return !!b; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            if (w === 390) { await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'orch-s' }); }
            const id = await mk(`Write the hello note ${w}`);
            await ev(`Promise.all([import(${S} + 'nav.js')]).then(([n]) => n.go({ view: 'inbox-tasks', sub: 'tasks', id: ${JSON.stringify(B)}, item: ${id} })).then(() => true)`);
            await waitFor(`!!document.querySelector('#inbox-page .inbox-item-body') && [...document.querySelectorAll('#inbox-page button')].some(b => b.textContent.trim() === 'Complete' && b.getBoundingClientRect().height > 0)`, 'the task page with Complete', 15000);
            await tap('Complete');
            await waitFor(`!!document.getElementById('task-complete-message')`, 'the form', 8000);
            await sleep(300); // sleep-ok: the form settles after it is drawn
            const g = await ev(`(() => { const r = id => document.getElementById(id).getBoundingClientRect(), l = id => document.getElementById(id).closest('label'), form = document.querySelector('.task-completion-form').getBoundingClientRect(), ta = document.getElementById('task-complete-message'), sel = document.getElementById('task-complete-outcome');
                const textTop = id => { const lab = l(id), rg = document.createRange(); const tn = [...lab.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()); rg.selectNodeContents(tn); return Math.round(rg.getBoundingClientRect().bottom); };
                return { formW: Math.round(form.width), taW: Math.round(r('task-complete-message').width), taH: Math.round(r('task-complete-message').height), taFont: parseFloat(getComputedStyle(ta).fontSize), selW: Math.round(sel.getBoundingClientRect().width), selFont: parseFloat(getComputedStyle(sel).fontSize),
                    msgAbove: textTop('task-complete-message') <= Math.round(r('task-complete-message').top) + 1, outAbove: textTop('task-complete-outcome') <= Math.round(sel.getBoundingClientRect().top) + 1, vw: innerWidth, noHScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }; })()`);
            check(`${tag}: the labels sit above the fields, which are the form's full width`, g.msgAbove && g.outAbove && g.taW >= g.formW - 2 && g.selW >= g.formW - 2 && g.noHScroll, JSON.stringify(g));
            check(`${tag}: the message is a real textarea (at least 100 px high${mobile ? ', 16 px text' : ''})`, g.taH >= 100 && (!mobile || (g.taFont >= 16 && g.selFont >= 16)), JSON.stringify(g));
            const seen = await ev(`(() => { const r = document.getElementById('task-complete-message').getBoundingClientRect(); const b = [...document.querySelectorAll('#inbox-page button')].find(x => x.textContent.trim() === 'Complete' && x.getBoundingClientRect().height > 0).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), barTop: Math.round(b.top), focus: document.activeElement && document.activeElement.id }; })()`);
            check(`${tag}: opening the form brings the message box into view, above the bar, with the focus in it`, seen.top >= 0 && seen.bottom <= seen.barTop + 1 && seen.focus === 'task-complete-message', JSON.stringify(seen));
            await shot(`task-complete-form-${w}`);
            const done = await bar('Complete');
            check(`${tag}: Complete is in view without scrolling${mobile ? ' and 44 px high' : ''}`, done && done.bottom <= h && (!mobile || done.h >= 43.5), JSON.stringify(done));
            await tap('Complete'); // one tap, nothing typed
            await waitFor(`!document.getElementById('task-complete-message')`, 'the form closes', 8000);
            const t = (await api('GET', `/api/board/${B}/tasks/${id}`)).body;
            check(`${tag}: one tap on Complete finishes the task (success, nothing typed)`, t && /complete/i.test(t.status || '') , JSON.stringify([t && t.status]));
        }
    } finally { await api('DELETE', `/api/board/${B}`).catch(() => {}); await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} complete-form checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
