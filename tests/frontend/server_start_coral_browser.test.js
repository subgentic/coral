// Start Coral (#15998) on the page of a computer set up over SSH whose Coral does not answer, in a real page at 1280 and 390 px, light and dark. The page's own modules run; only the hub's /api/servers routes are
// answered by a script in the page (a fake hub, as server_ssh_setup_browser does). Checks: the button is there for an unreachable or offline computer and for no other status, it is the primary one; it opens a plan
// named "start" for that server alone (no target, no package, no terms asked); the plan says what it will do and starts nothing until the press; what the run sends holds no terms and no keys; the steps and the end
// ("Coral is running.") are in a live region; nothing is wider than the page. Screenshots with CORAL_SCREENSHOT_DIR (the page before, the plan, the end). Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setTheme } = require('./helpers/contrast');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const HUB = `(() => {
  const steps = (s = {}) => ['connect', 'identity', 'start', 'verify'].map(n => ({ name: n, title: { connect: 'Connect over SSH and check the host key', identity: 'Check it is the computer that was set up', start: 'Start Coral', verify: 'Check that it answers' }[n], state: s[n] || 'pending', detail: s[n] === 'ok' && n === 'start' ? 'Started Coral 2.0.65.' : s[n] === 'ok' && n === 'verify' ? 'Coral is running.' : '' }));
  const row = { id: 'ssh-box', label: 'Build box', url: 'ssh://user@box.example.com:22', status: 'unreachable', transport: 'ssh', ssh_target: 'user@box.example.com:22', allow_private: false, created_at: '2026-10-30T10:00:00Z', last_seen: '2026-11-12T20:00:00Z', last_error: null };
  const world = { servers: [row], runBody: null, runs: 0, plans: [], polls: 0 };
  window.__hub = world;
  const real = window.fetch.bind(window);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const u = String(url), method = (init && init.method) || 'GET', body = init && init.body ? JSON.parse(init.body) : null;
    if (u === '/api/servers' && method === 'GET') return json(world.servers);
    if (!u.startsWith('/api/servers/provision')) return real(url, init);
    if (u.endsWith('/options')) return json({ hosts: [], acceptance_label: 'hub-owner@my-mac', records_acceptance: true });
    if (u.endsWith('/plan')) { world.plans.push(body); return json({ plan: 'p1', target: 'user@box.example.com:22', server_id: body.server_id, label: 'Build box', kind: body.action, phase: 'planned', steps: steps() }, 201); }
    if (u.endsWith('/connect')) return json({ plan: 'p1', target: 'user@box.example.com:22', server_id: 'ssh-box', label: 'Build box', kind: 'start', phase: 'connected', system: 'Linux x86_64', host_keys: [], steps: steps() });
    if (u.endsWith('/run')) { world.runBody = body; world.runs++; world.polls = 0; return json({ plan: 'p1', kind: 'start', phase: 'running', steps: steps({ connect: 'ok', identity: 'ok' }) }, 202); }
    if (method === 'DELETE') return json({ status: 'cancelled' });
    if (method === 'GET') { world.polls++; const done = world.polls >= 2;
      if (done) world.servers = [{ ...row, status: 'online', last_seen: null }];
      return json({ plan: 'p1', kind: 'start', phase: done ? 'done' : 'running', steps: done ? steps({ connect: 'ok', identity: 'ok', start: 'ok', verify: 'ok' }) : steps({ connect: 'ok', identity: 'ok' }) }); }
    return json({}, 404);
  };
  return true;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const btn = label => `[...document.querySelectorAll('#servers-tab-body button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    const noOverflow = `document.documentElement.scrollWidth <= window.innerWidth + 1 && document.getElementById('servers-tab-body').scrollWidth <= document.getElementById('servers-tab-body').clientWidth + 1`;
    const showServers = status => ev(`(async () => { const S = (n) => import((window.__coralStatic || '/static/') + n); const st = (await S('state.js')).state; st.hub = true; st.servers = [{ id: 'ssh-box', label: 'Build box', status: ${JSON.stringify(status)} }];
        (await S('servers_tab.js')).updateServersTabVisibility(); window.switchNavTab('servers'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(HUB);
            const openPage = async status => {
                await showServers(status);
                await waitFor(`!!document.getElementById('server-row-ssh-box')`, 'the computer row', 10000);
                await ev(`document.getElementById('server-row-ssh-box').querySelector('[data-action="open"]').click(); true`);
                await waitFor(`!!document.querySelector('[data-action="ssh-stop"]')`, 'the computer page', 8000);
            };
            const startBtn = `document.querySelector('[data-action="ssh-start"]')`;
            // no Start Coral for a Coral that answers or whose key cannot be read; one for a computer that does not answer
            for (const status of ['online', 'key_unreadable', 'unauthorized']) {
                await openPage(status);
                check(`${label}: no Start Coral for a computer that is ${status}`, await ev(`!${startBtn}`));
                await ev(`document.querySelector('#servers-back') && document.querySelector('#servers-back').click(); true`);
            }
            for (const theme of ['light', 'dark']) {
                await setTheme(ev, theme);
                await openPage('unreachable');
                check(`${label}/${theme}: Start Coral is on the page of an unreachable computer, the primary button, before Upgrade`, await ev(`(() => { const b = ${startBtn}; return !!b && b.classList.contains('btn-primary') && b.textContent.trim() === 'Start Coral' && b.compareDocumentPosition(document.querySelector('[data-action="ssh-upgrade"]')) & Node.DOCUMENT_POSITION_FOLLOWING; })()`));
                check(`${label}/${theme}: the page fits`, await ev(noOverflow));
                await shot(`start-coral-before-${label}-${theme}`);
                await ev(`${startBtn}.click(); true`);
                await waitFor(`!!${btn('Connect')}`, 'the plan', 8000); await settle(200);
                check(`${label}/${theme}: the plan is for that server alone, action start`, await ev(`JSON.stringify(window.__hub.plans.at(-1)) === JSON.stringify({ server_id: 'ssh-box', action: 'start' })`), await ev(`JSON.stringify(window.__hub.plans.at(-1))`));
                check(`${label}/${theme}: it says what it will do, and asks for no terms and no package`, await ev(`(() => { const t = document.querySelector('.ssh-setup').textContent; return /Start Coral on that computer/.test(t) && /Nothing is downloaded or installed/.test(t) && !document.querySelector('.ssh-terms') && !document.querySelector('.ssh-source'); })()`));
                check(`${label}/${theme}: the plan fits`, await ev(noOverflow));
                await ev(`${btn('Connect')}.click(); true`);
                const go = `[...document.querySelectorAll('.ssh-setup button')].find(b => b.textContent.trim() === 'Start Coral')`;
                await waitFor(`!!${go}`, 'the Start Coral press', 8000);
                check(`${label}/${theme}: nothing has run before the press`, await ev(`window.__hub.runs === ${theme === 'light' ? 0 : 1}`));
                await shot(`start-coral-plan-${label}-${theme}`);
                await ev(`${go}.click(); true`);
                await waitFor(`!!document.querySelector('.ssh-progress[role="status"]')`, 'the progress', 8000);
                await waitFor(`document.querySelector('.ssh-setup').textContent.includes('Coral is running.')`, 'the end', 12000); await settle(200);
                const sent = await ev(`JSON.stringify(window.__hub.runBody)`);
                check(`${label}/${theme}: the run sent no terms, no keys and no package source`, !/accept_terms|terms_sha256|accept_keys|key_fingerprints|package_source|data_dir|backend|port/.test(sent), sent);
                check(`${label}/${theme}: the steps are all done`, await ev(`[...document.querySelectorAll('.ssh-step')].every(li => li.classList.contains('ssh-step-ok'))`));
                check(`${label}/${theme}: the end fits the page`, await ev(noOverflow));
                await shot(`start-coral-after-${label}-${theme}`);
                await ev(`${btn('Close')}.click(); true`);
                await waitFor(`!document.getElementById('servers-ssh-host') || !document.querySelector('.ssh-setup')`, 'back', 8000);
                await ev(`window.__hub.servers = [{ id: 'ssh-box', label: 'Build box', url: 'ssh://user@box.example.com:22', status: 'unreachable', transport: 'ssh', ssh_target: 'user@box.example.com:22', allow_private: false, created_at: '2026-10-30T10:00:00Z', last_seen: '2026-11-12T20:00:00Z', last_error: null }]; true`);
            }
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})().catch(e => { console.error(e); process.exitCode = 1; });
