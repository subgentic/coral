// #15164 (walk 6 L17): the welcome text is on the page once for a screen reader: a sentence that is in a row's visible text is not in a second element that is read too (an aria-label, a hidden-but-read copy). Real page, welcome items on, 390 px.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const failures = [];
    const guard = await guardSettings();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        try {
            await ev(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inbox_welcome: 'on' }) }).then(r => r.status)`);
            await ev(`sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`new Promise(r => setTimeout(r, 1500))`); // sleep-ok: the Inbox draws after the settings load
            const probe = () => {
                const words = 'This is your Inbox', hits = [];
                const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3 && c.textContent.includes(words)) { const p = c.parentElement; hits.push({ via: 'text', tag: p.tagName, cls: String(p.className).slice(0, 40), hidden: !!p.closest('[aria-hidden="true"]'), vis: !!p.getClientRects().length }); } else if (c.nodeType === 1) walk(c); } };
                walk(document.body);
                for (const e of document.querySelectorAll('[aria-label],[title],[aria-description]')) for (const a of ['aria-label', 'title', 'aria-description']) { if ((e.getAttribute(a) || '').includes(words)) hits.push({ via: a, tag: e.tagName, cls: String(e.className).slice(0, 40), hidden: !!e.closest('[aria-hidden="true"]') }); }
                return { path: location.pathname, hits };
            };
            const r = await ev(`(${probe.toString()})()`);
            console.log(JSON.stringify(r));
            const read = r.hits.filter(h => !h.hidden && h.via !== 'title');
            if (read.length !== 1) failures.push('the welcome sentence is read once, not ' + read.length + ': ' + JSON.stringify(r));
        } finally { await guard.restore().catch(() => {}); }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('welcome_read_once_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
