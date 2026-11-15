// #18093 (the Operator, v2.0.69 trial): "I can't click on the queue". Every tab of the top bar opens its page when it is CLICKED: the Queue button reached m-switch-nav-tab, whose list of tab names did not name it,
// so the click did nothing (the Queue suites called switchNavTab directly and never clicked). From Analytics, each visible tab is clicked in turn: the tab is the current one (and only that one), its page's address is written.
// 1280 px, light, isolated dev server. Screenshots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const sceneShots = require('./helpers/scene_shots');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = sceneShots(Page, 'top-nav-click');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const tabs = await ev(`[...document.querySelectorAll('.top-nav-tab[data-arg]')].filter(b => b.getBoundingClientRect().width > 0 && !b.hidden).map(b => b.dataset.arg)`);
        if (!tabs.includes('queue') || !tabs.includes('tokens')) problems.push('the top bar has no Queue or Analytics tab: ' + JSON.stringify(tabs));
        const current = () => ev(`({ tab: document.body.getAttribute('data-nav-tab'), marked: [...document.querySelectorAll('.top-nav-tab.active, .top-nav-tab[aria-current="page"]')].map(b => b.dataset.arg), path: location.pathname })`);
        for (const arg of tabs.filter(a => a !== 'tokens')) {
            // always from Analytics, where the Operator was
            await ev(`document.getElementById('nav-tab-tokens').click(); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === 'tokens'`, 'Analytics', 8000);
            await ev(`document.querySelector('.top-nav-tab[data-arg="${arg}"]').click(); true`);
            await waitFor(`document.body.getAttribute('data-nav-tab') === '${arg}'`, 'the ' + arg + ' tab to open when clicked', 6000).catch(() => problems.push(arg + ': the click did nothing, the page is still ' + 'Analytics'));
            // the page is drawn before the next click: a page that loads on first use would otherwise draw over the next tab (a separate matter, not what this suite pins)
            const drawn = { skills: '#skills-view .skills-page', queue: '#queue-tab-body .queue-tab-title', automations: '#scheduler-view *', docs: '#docs-view *' }[arg];
            if (drawn) await waitFor(`!!document.querySelector('${drawn}')`, 'the ' + arg + ' page to be drawn', 10000).catch(e => problems.push(e.message.slice(0, 200)));
            const c = await current();
            if (c.tab === arg && (c.marked.length !== 1 || c.marked[0] !== arg)) problems.push(arg + ': the tabs drawn current are ' + JSON.stringify(c.marked));
            if (arg === 'queue') {
                if (c.path !== '/queue') problems.push('Queue: the address is ' + c.path);
                const g = await ev(`(() => { const shown = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; }, t = document.querySelector('#queue-tab-body .queue-tab-title'); return { queue: shown('queue-view'), skills: shown('skills-view'), left: t ? Math.round(t.getBoundingClientRect().left) : -1, scrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1 }; })()`);
                if (!g.queue) problems.push('Queue: the queue page is not the one shown');
                if (g.skills) problems.push('Queue: the Skills page is still shown');
                if (g.left < 16) problems.push('Queue: the page title is ' + g.left + ' px from the window edge (the page has no padding)');
                if (g.scrollsSideways) problems.push('Queue: the page scrolls sideways');
                await shot('queue-after-click-1280');
            }
        }
        // Queue is not drawn current while another page is
        await ev(`document.getElementById('nav-tab-tokens').click(); true`);
        await waitFor(`document.body.getAttribute('data-nav-tab') === 'tokens'`, 'Analytics again', 8000);
        const q = await ev(`(() => { const b = document.getElementById('nav-tab-queue'); return { active: b.classList.contains('active'), current: b.getAttribute('aria-current') }; })()`);
        if (q.active || q.current) problems.push('Queue is drawn as the current tab on Analytics: ' + JSON.stringify(q));
        await shot('analytics-1280');
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS top bar: each tab opens when clicked from Analytics (' + tabs.join(', ') + '), only the current one is marked');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
