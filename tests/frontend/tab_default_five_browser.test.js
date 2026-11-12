// #15731: the agent side panel shows Files, Browse, Artifacts, Activity and Tasks by default, in that order; Board, Notes, Agent UI, Saved, Info and Branches stay in Customize tabs, unchecked, for anyone to turn on;
// Reset to default gives that set. A layout somebody saved (a v2.0.65 one) is not touched, and something that opens a hidden tab (a link to Info or Branches, the Saved badge, a board mention) still shows it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle, coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ defaultTabs: true });
    const KEY = 'coral-agentic-tab-prefs';
    const shown = () => ev(`[...document.querySelectorAll('#agentic-block-top .agentic-tab[data-tab]')].filter(b => getComputedStyle(b).display !== 'none' && b.getClientRects().length).map(b => b.dataset.tab)`);
    const load = async () => {
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`window.__m.add('five-bot', 'A', 3, { sleeping: false }); true`);
        await settle(ev, 600); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('five-bot', 'claude', 'five-bot-id', 'local'); true`);
        await ev(`(() => { const p = document.getElementById('agentic-state'); if (p.classList.contains('collapsed') || document.getElementById('agentic-tab-files').getBoundingClientRect().width === 0) window.toggleAgenticPanel(true); return true; })()`);
        await waitFor(`document.getElementById('agentic-tab-customize').getBoundingClientRect().width > 0`, 'side panel open', 8000);
    };
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const MAIN = ['files', 'browse', 'artifacts', 'activity', 'tasks'];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load();
        await ev(`localStorage.removeItem('${KEY}'); true`);
        await load();
        let s = await shown();
        await shot('default-row-1280');
        check(JSON.stringify(s.filter(t => t !== 'saved')) === JSON.stringify(MAIN), `the default row is Files, Browse, Artifacts, Activity, Tasks: ${JSON.stringify(s)}`);
        check(!s.some(t => ['board', 'notes', 'agent-ui', 'saved', 'info', 'branches'].includes(t)), `no other tab is in the default row: ${JSON.stringify(s)}`);
        await ev(`document.getElementById('agentic-tab-customize').click(); true`); await waitFor(`!!document.getElementById('tab-customize')`, 'popover opens');
        const rows = await ev(`[...document.querySelectorAll('#tab-customize .tc-row')].map(r => [r.dataset.tab, r.querySelector('.tc-check').checked])`);
        const on = rows.filter(r => r[1]).map(r => r[0]), off = rows.filter(r => !r[1]).map(r => r[0]).sort();
        check(JSON.stringify(on) === JSON.stringify(MAIN), `Customize tabs ticks those five, in order: ${JSON.stringify(rows)}`);
        check(['info', 'notes', 'agent-ui', 'branches'].every(t => off.includes(t)), `the others are listed, unticked: ${JSON.stringify(rows)}`);
        // turning one on keeps it across a reload and Reset gives the default back
        await ev(`document.querySelector('#tab-customize .tc-check[data-tab="info"]').click(); true`);
        await waitFor(`!!document.querySelector('#agentic-tab-info') && getComputedStyle(document.getElementById('agentic-tab-info')).display !== 'none'`, 'Info turns on', 4000);
        await ev(`document.getElementById('tab-customize').remove(); true`); await load();
        check((await shown()).includes('info'), 'Info stays on after a reload');
        await ev(`document.getElementById('agentic-tab-customize').click(); true`); await waitFor(`!!document.getElementById('tab-customize')`, 'popover opens');
        await ev(`document.querySelector('#tab-customize .tc-reset').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('agentic-tab-info')).display === 'none'`, 'Reset hides Info again', 4000);
        s = await shown();
        check(JSON.stringify(s.filter(t => t !== 'saved')) === JSON.stringify(MAIN) && (await ev(`localStorage.getItem('${KEY}')`)) === null, `Reset to default: the five, and nothing stored: ${JSON.stringify(s)}`);
        // a hidden tab that something opens is shown
        for (const t of ['info', 'branches', 'notes']) {
            await ev(`window.switchAgenticTab('${t}', 'top'); true`);
            await waitFor(`document.getElementById('agentic-panel-${t}').classList.contains('active') && getComputedStyle(document.getElementById('agentic-tab-${t}')).display !== 'none'`, `${t} opens and shows`, 4000);
        }
        check((await ev(`localStorage.getItem('${KEY}')`)) === null, 'opening a hidden tab does not save a layout');
        // a layout saved before (v2.0.65: nothing hidden, an order) is read as it was: every tab shows, and a tab the person hid stays hidden when something opens it
        await ev(`localStorage.setItem('${KEY}', JSON.stringify({ agent: { order: ['tasks', 'files'], hidden: [] } })); true`);
        await load();
        s = await shown();
        check(s[0] === 'tasks' && s[1] === 'files' && ['info', 'notes', 'branches', 'browse', 'activity'].every(t => s.includes(t)), `a saved layout is read as saved, nothing hidden by the new default: ${JSON.stringify(s)}`);
        await ev(`localStorage.setItem('${KEY}', JSON.stringify({ agent: { order: [], hidden: ['info'] } })); true`);
        await load();
        await ev(`window.switchAgenticTab('info', 'top'); true`);
        s = await shown();
        check(!s.includes('info') && s.includes('notes'), `a tab the person hid stays hidden when something opens it: ${JSON.stringify(s)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the default side panel tabs:\n  ' + problems.join('\n  '));
    console.log('PASS five tabs by default, a saved layout untouched, a hidden tab opens when asked');
})().catch(e => { console.error(e); process.exit(1); });
