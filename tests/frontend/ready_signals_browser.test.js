// window.__coralReady as a supported surface (#12124, coral-hub's ask 2): the names of its parts, its optional parts and the ordering guarantee are pinned, so a Hub that waits on them is not broken by a refactor.
//  1. the five required parts and the two optional ones (inboxListDrawn, hubFrameLoaded) are in `parts`, and startup() with no names waits for the five required ones only;
//  2. the page's delegated handlers (data-on-click) are bound before 'liveListLoaded' is marked: a control clicked in the same turn the part resolves works (actions.js before app.js's list loads);
//  3. the main promise resolves once, after all five required parts, with no part ever going back to false;
//  4. 'inboxListDrawn' is marked when the Inbox's first folder list is drawn; an unknown part name is refused.
// Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable();
        // before any page script: record each change of `parts` and the moment liveListLoaded resolves, in the page's own turn
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { window.__trace = { sawRegress: false, last: null, handlerAtLoaded: null, readyCount: 0 };
            const iv = setInterval(() => { const r = window.__coralReady; if (!r) return; clearInterval(iv);
                const snap = () => JSON.stringify(r.parts); let prev = r.parts;
                const watch = setInterval(() => { const now = r.parts; for (const k of Object.keys(prev)) if (prev[k] && !now[k]) window.__trace.sawRegress = true; prev = now; }, 5);
                r.startup('liveListLoaded').then(async () => { const m = await import((window.__coralStatic || '/static/') + 'actions.js'); let hit = false; m.registerActions({ __readyProbe: () => { hit = true; } });
                    const b = document.createElement('button'); b.dataset.onClick = '__readyProbe'; b.hidden = true; document.body.append(b); b.click(); b.remove(); window.__trace.handlerAtLoaded = hit; });
                r.then(() => { window.__trace.readyCount++; window.__trace.partsAtReady = r.parts; });
            }, 1); })();` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: lets the trace's own timers observe the settled page
        const t = await ev(`({ ...window.__trace, parts: window.__coralReady.parts })`);
        for (const p of ['liveList', 'liveListLoaded', 'feed', 'history', 'settings']) check(p in t.parts, `the required part "${p}" is in parts: ${JSON.stringify(t.parts)}`);
        for (const p of ['inboxListDrawn', 'hubFrameLoaded']) check(p in t.parts, `the optional part "${p}" is in parts: ${JSON.stringify(t.parts)}`);
        check(['liveList', 'liveListLoaded', 'feed', 'history', 'settings'].every(p => t.parts[p] === true), 'every required part is done once the page is ready');
        check(t.readyCount === 1, `the main promise resolved once: ${t.readyCount}`);
        check(t.partsAtReady && ['liveList', 'liveListLoaded', 'feed', 'history', 'settings'].every(p => t.partsAtReady[p] === true), `at the moment it resolved all five required parts were done: ${JSON.stringify(t.partsAtReady)}`);
        check(t.handlerAtLoaded === true, 'a delegated data-on-click handler works in the turn liveListLoaded resolves (the handlers are bound first)');
        check(t.sawRegress === false, 'no part went back to false');
        const optional = await ev(`(async () => { const r = window.__coralReady; const a = await Promise.race([r.startup(), new Promise(x => setTimeout(() => x('timeout'), 50))]); let unknown = ''; try { await r.startup('nonsense'); } catch (e) { unknown = e.message; } return { required: a !== 'timeout', unknown }; })()`);
        check(optional.required, 'startup() with no names resolves without the optional parts');
        check(/unknown startup part: nonsense/.test(optional.unknown), 'an unknown part name is refused: ' + optional.unknown);
        // the Inbox: its first folder list drawn marks inboxListDrawn
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        const drawn = await ev(`Promise.race([window.__coralReady.startup('inboxListDrawn').then(() => true), new Promise(x => setTimeout(() => x(false), 8000))])`);
        check(drawn === true, 'inboxListDrawn is marked when the Inbox folder list is drawn');
        check((await ev('window.__coralReady.parts.inboxListDrawn')) === true, 'and parts says so');
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('ready_signals_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
