// A stop that was left while it ran is found again (#12372, the Operator testing v2.0.35: "I clicked away and could not get back to the screen about stopping Coral"). The hub keeps the plan: the Computers
// page reads the hub's list of running and just-finished setups, so the computer's row says "Stopping Coral" after the progress screen is left, its page offers Show progress (the same plan, watched again) and, once
// the plan ended, Show result and Dismiss. A fake hub answers the /api/servers routes (as server_ssh_setup_browser does). Drives Chrome over CDP against the isolated dev server, at 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const HUB = `(() => {
  const steps = (s = {}) => ['connect', 'stop', 'verify'].map(n => ({ name: n, title: 'Step ' + n, state: s[n] || 'pending', detail: '' }));
  const row = { id: 'ssh-box', label: 'Build box', url: 'ssh://user@box.example.com:22', status: 'online', transport: 'ssh', ssh_target: 'user@box.example.com:22', allow_private: false, created_at: '2026-10-30T10:00:00Z', last_seen: '2026-10-30T10:00:00Z' };
  const world = { servers: [row], plan: null, polls: 0, deletes: 0, finish: false };
  window.__hub = world;
  const real = window.fetch.bind(window);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  const view = () => ({ plan: 'p1', target: 'user@box.example.com:22', server_id: 'ssh-box', label: 'Build box', kind: 'stop', phase: world.plan, steps: world.plan === 'done' ? steps({ connect: 'ok', stop: 'ok', verify: 'ok' }) : steps({ connect: 'ok' }) });
  window.fetch = async (url, init = {}) => {
    const u = String(url), method = (init && init.method) || 'GET';
    if (u === '/api/servers' && method === 'GET') return json(world.servers);
    if (!u.startsWith('/api/servers/provision')) return real(url, init);
    if (u.endsWith('/options')) return json({ hosts: [], acceptance_label: 'x', records_acceptance: true });
    if (u === '/api/servers/provision' && method === 'GET') return json({ plans: world.plan && world.plan !== 'planned' ? [{ plan: 'p1', server_id: 'ssh-box', kind: 'stop', phase: world.plan }] : [] });
    if (u.endsWith('/plan')) { world.plan = 'planned'; return json({ ...view(), phase: 'planned' }); }
    if (u.endsWith('/connect')) { world.plan = 'connected'; return json({ ...view(), phase: 'connected' }); }
    if (u.endsWith('/run')) { world.plan = 'running'; return json({ ...view(), phase: 'running' }, 202); }
    if (method === 'DELETE') { world.deletes++; world.plan = null; return json({ status: 'cancelled' }); }
    if (method === 'GET') { world.polls++; if (world.finish) world.plan = 'done'; return world.plan ? json(view()) : json({ error: 'no such setup' }, 404); }
    return json({}, 404);
  };
  return true;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const btn = label => `[...document.querySelectorAll('#servers-tab-body button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    const noOverflow = `document.documentElement.scrollWidth <= window.innerWidth + 1`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(HUB);
            await ev(`(async () => { const S = (n) => import((window.__coralStatic || '/static/') + n); const st = (await S('state.js')).state; st.hub = true; st.servers = [{ id: 'ssh-box', label: 'Build box', status: 'online' }];
                (await S('servers_tab.js')).updateServersTabVisibility(); window.switchNavTab('servers'); return true; })()`);
            await waitFor(`!!document.getElementById('server-row-ssh-box')`, 'the server row', 10000);
            await ev(`document.getElementById('server-row-ssh-box').querySelector('[data-action="open"]').click(); true`);
            await waitFor(`!!document.querySelector('[data-action="ssh-stop"]')`, 'the server page', 8000);
            check(`${label}: with nothing running there is no setup line`, await ev(`!document.querySelector('.servers-setup-state')`));
            await ev(`document.querySelector('[data-action="ssh-stop"]').click(); true`);
            await waitFor(`!!${btn('Connect')}`, 'the stop plan', 8000);
            await ev(`${btn('Connect')}.click(); true`);
            await waitFor(`!!${btn('Stop Coral')}`, 'the ready step', 8000);
            await ev(`${btn('Stop Coral')}.click(); true`);
            await waitFor(`!!document.querySelector('.ssh-progress[role="status"]')`, 'the progress', 8000);

            // click away while it runs
            await ev(`document.querySelector('[data-action="ssh-back"]').click(); true`);
            await waitFor(`!document.getElementById('servers-ssh-host')`, 'back on the computers page', 8000);
            await waitFor(`/Stopping Coral/.test(document.getElementById('server-row-ssh-box').textContent)`, 'the row says the stop is running', 8000);
            check(`${label}: the row says Stopping Coral after the progress screen was left`, true);
            await ev(`(() => { const o = document.getElementById('server-row-ssh-box').querySelector('[data-action="open"]'); if (o) o.click(); return true; })()`); // the table's row opens the page; the page the Operator left from is already open
            await waitFor(`!!document.querySelector('.servers-setup-state')`, 'the setup line on the page', 8000);
            check(`${label}: the page has Show progress, and no Upgrade, Stop Coral or Uninstall while it runs`, await ev(`!!${btn('Show progress')} && !document.querySelector('[data-action="ssh-stop"],[data-action="ssh-upgrade"],[data-action="ssh-remove"]')`));
            check(`${label}: the page fits`, await ev(noOverflow));

            // back to it, and it finishes while shown
            await ev(`window.__hub.finish = true; ${btn('Show progress')}.click(); true`);
            await waitFor(`!!document.querySelector('.ssh-steps')`, 'the steps again', 8000);
            await waitFor(`!!${btn('Close')} && document.querySelector('.ssh-setup').textContent.includes('Done')`, 'the stop to finish while shown', 12000);
            check(`${label}: it is the same plan (watched, not started again): all steps ok`, await ev(`[...document.querySelectorAll('.ssh-step')].every(li => li.classList.contains('ssh-step-ok'))`));
            await ev(`${btn('Close')}.click(); true`);
            await waitFor(`!document.getElementById('servers-ssh-host')`, 'closed', 8000);

            // the result stays until dismissed
            await waitFor(`/Stop finished/.test(document.body.textContent)`, 'the result on the page', 8000);
            check(`${label}: the result stays (Stop finished) with Show result and Dismiss`, await ev(`!!${btn('Show result')} && !!${btn('Dismiss')}`));
            await ev(`${btn('Dismiss')}.click(); true`);
            await waitFor(`!document.querySelector('.servers-setup-state') && window.__hub.deletes === 1`, 'dismissed', 8000);
            check(`${label}: Dismiss asks the hub to drop the plan and the line goes`, true);
            await settle(100);
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})().catch(e => { console.error(e); process.exitCode = 1; });
