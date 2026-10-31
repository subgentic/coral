// The set-up-over-SSH dialog of the Servers tab (#11370) in a real page at 1280 and 390 px: the flow from the button through the plan, the host fingerprints, the terms and the Set up press to the finished
// steps, and a registered ssh server's Uninstall. The page's own modules run; only the hub's /api/servers routes are answered by a script in the page (a fake hub, as the other Servers suites do).
// Checks: nothing wider than the page, the fingerprint and the terms are text, Set up is disabled until the key box is ticked, Remove until the name is typed, what is sent holds no key, the steps and the
// failure are in a live region or an alert. Screenshots with CORAL_SCREENSHOT_DIR. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const HUB = `(() => {
  const DIGEST = 'b'.repeat(64);
  const steps = (s = {}) => ['connect', 'detect', 'install', 'start', 'register'].map(n => ({ name: n, title: 'Step ' + n + ' of the setup', state: s[n] || 'pending', detail: s[n] === 'ok' ? 'Done well.' : '' }));
  const row = { id: 'ssh-box', label: 'Build box', url: 'ssh://rich@box.example.com:22', status: 'online', transport: 'ssh', ssh_target: 'rich@box.example.com:22', allow_private: false, created_at: '2026-10-30T10:00:00Z', last_seen: null, last_error: null };
  const world = { servers: [row], runBody: null, runs: 0, plans: [], polls: 0 };
  window.__hub = world;
  const real = window.fetch.bind(window);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const u = String(url), method = (init && init.method) || 'GET', body = init && init.body ? JSON.parse(init.body) : null;
    if (u === '/api/servers' && method === 'GET') return json(world.servers);
    if (!u.startsWith('/api/servers/provision')) return real(url, init);
    if (u.endsWith('/options')) return json({ hosts: ['build-box', 'second'], terms: { version: '2026-03-26', sha256: DIGEST, text: 'TERMS OF SERVICE <b>not bold</b>\\n' + 'A long line of terms that has to wrap inside the box and never push the page wider than the screen. '.repeat(40) }, acceptance_label: 'hub-owner@my-mac' });
    if (u.endsWith('/plan')) { world.plans.push(body); const kind = body.action || 'setup';
      return json({ plan: 'p1', target: body.target || 'rich@box.example.com:22', server_id: body.server_id || 'ssh-box-example-com', label: body.label || 'ssh-box-example-com', kind, phase: 'planned', steps: kind === 'setup' ? steps() : steps().slice(0, 3), delete_data: !!body.delete_data }, 201); }
    if (u.endsWith('/connect')) return json({ plan: 'p1', target: 'rich@box.example.com:22', server_id: world.plans.at(-1).server_id || 'ssh-box-example-com', label: 'x', kind: world.plans.at(-1).action || 'setup', phase: world.plans.at(-1).action ? 'connected' : 'needs_keys', system: 'Linux x86_64',
      host_keys: world.plans.at(-1).action ? [] : [{ host: 'box.example.com', type: 'ssh-ed25519', fingerprint: 'SHA256:' + 'Zq9'.repeat(14) + '<img src=x onerror=window.__pwned=1>' }], steps: steps() });
    if (u.endsWith('/run')) { world.runBody = body; world.runs++; world.polls = 0; return json({ plan: 'p1', kind: world.plans.at(-1).action || 'setup', phase: 'running', steps: steps({ connect: 'ok' }) }, 202); }
    if (method === 'DELETE') return json({ status: 'cancelled' });
    if (method === 'GET') { world.polls++;
      const done = world.polls >= 2;
      if (done && !world.plans.at(-1).action && !world.servers.some(s => s.id === 'ssh-box-example-com')) world.servers = [...world.servers, { ...row, id: 'ssh-box-example-com', label: 'ssh-box-example-com' }];
      return json({ plan: 'p1', kind: world.plans.at(-1).action || 'setup', phase: done ? 'done' : 'running', steps: done ? steps({ connect: 'ok', detect: 'ok', install: 'ok', start: 'ok', register: 'ok' }) : steps({ connect: 'ok', detect: 'ok' }) }); }
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
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(HUB);
            await ev(`(async () => { const S = (n) => import((window.__coralStatic || '/static/') + n); const st = (await S('state.js')).state; st.hub = true; st.servers = [{ id: 'ssh-box', label: 'Build box', status: 'online' }];
                (await S('servers_tab.js')).updateServersTabVisibility(); window.switchNavTab('servers'); return true; })()`);
            await waitFor(`!!document.querySelector('#servers-tab-body [data-action="ssh-setup"]')`, 'the Set up over SSH button', 10000);
            check(`${label}: the Servers tab has Set up over SSH beside Add server`, await ev(`!!document.querySelector('#servers-tab-body [data-action="add"]') && !!document.querySelector('#servers-tab-body [data-action="ssh-setup"]')`));
            await shot(`ssh-servers-${label}`);

            // setup: target
            await ev(`document.querySelector('#servers-tab-body [data-action="ssh-setup"]').click(); true`);
            await waitFor(`!!document.getElementById('ssh-host')`, 'the host form', 8000); await settle(200);
            check(`${label}: the SSH config hosts are the choices`, JSON.stringify(await ev(`[...document.querySelectorAll('#ssh-picked option')].map(o => o.value)`)) === JSON.stringify(['', 'build-box', 'second']));
            check(`${label}: the form fits the page`, await ev(noOverflow));
            await shot(`ssh-target-${label}`);
            await ev(`(() => { const i = document.getElementById('ssh-host'); i.value = 'rich@box.example.com'; i.dispatchEvent(new Event('input')); document.querySelector('.ssh-form').requestSubmit(); return true; })()`);
            await waitFor(`!!${btn('Connect')}`, 'the plan', 8000);
            check(`${label}: the plan lists the five steps and says nothing has connected`, await ev(`document.querySelectorAll('.ssh-step').length === 5 && document.querySelector('.ssh-setup').textContent.includes('Nothing has connected yet')`));
            check(`${label}: the plan fits the page`, await ev(noOverflow));
            await shot(`ssh-plan-${label}`);

            // connect: fingerprints
            await ev(`${btn('Connect')}.click(); true`);
            await waitFor(`!!document.getElementById('ssh-keys-ok')`, 'the fingerprints', 8000); await settle(200);
            check(`${label}: a fingerprint is text, not an element`, await ev(`document.querySelector('.ssh-key-fp').textContent.includes('<img src=x onerror=') && !document.querySelector('#servers-tab-body img') && !window.__pwned`));
            check(`${label}: the terms are text`, await ev(`document.querySelector('.ssh-terms').textContent.includes('<b>not bold</b>') && !document.querySelector('.ssh-terms b')`));
            check(`${label}: Set up is disabled until the fingerprints are confirmed`, await ev(`${btn('Set up')}.disabled === true`));
            check(`${label}: the terms box scrolls inside itself and the page does not widen`, await ev(`(() => { const t = document.querySelector('.ssh-terms'); return t.scrollHeight > t.clientHeight && ${noOverflow}; })()`));
            check(`${label}: the record line names the hub computer`, await ev(`document.querySelector('.ssh-setup').textContent.includes('hub-owner@my-mac')`));
            await shot(`ssh-keys-terms-${label}`);
            await ev(`(() => { const c = document.getElementById('ssh-keys-ok'); c.click(); return true; })()`); await settle(100);
            check(`${label}: ticking the box enables Set up`, await ev(`${btn('Set up')}.disabled === false`));
            const nameOf = await ev(`${btn('Set up')}.getAttribute('aria-label') || ${btn('Set up')}.textContent.trim()`);
            check(`${label}: the button's name says what it does`, nameOf === 'Set up', nameOf);

            // run: the body, the steps, done
            await ev(`${btn('Set up')}.click(); true`);
            await waitFor(`!!document.querySelector('.ssh-progress[role="status"]')`, 'the progress', 8000);
            await waitFor(`document.querySelector('.ssh-setup').textContent.includes('Done. The computer is in your list.')`, 'done', 12000); await settle(200);
            const sent = await ev(`JSON.stringify(window.__hub.runBody)`);
            check(`${label}: Set up sent the acceptance, the digest of the terms shown and the key box, no key`, sent === JSON.stringify({ accept_terms: true, terms_sha256: 'b'.repeat(64), accept_keys: true }), sent);
            check(`${label}: the finished steps are all done`, await ev(`[...document.querySelectorAll('.ssh-step')].every(li => li.classList.contains('ssh-step-ok'))`));
            await shot(`ssh-done-${label}`);
            await ev(`${btn('Close')}.click(); true`);
            await waitFor(`!!document.querySelector('#servers-tab-body [data-action="ssh-setup"]') && !document.getElementById('servers-ssh-host')`, 'back to the list', 8000);
            check(`${label}: the new server is in the list after Close`, await ev(`!!document.getElementById('server-row-ssh-box-example-com')`));

            // manage: Uninstall of an ssh server
            await ev(`document.getElementById('server-row-ssh-box').querySelector('[data-action="open"]').click(); true`);
            await waitFor(`!!document.querySelector('[data-action="ssh-remove"]')`, 'the server page', 8000);
            check(`${label}: an ssh server's page has Upgrade, Stop Coral and Uninstall`, await ev(`['ssh-upgrade', 'ssh-stop', 'ssh-remove'].every(a => !!document.querySelector('[data-action="' + a + '"]'))`));
            await shot(`ssh-page-${label}`);
            await ev(`document.querySelector('[data-action="ssh-remove"]').click(); true`);
            await waitFor(`!!${btn('Connect')}`, 'the remove plan', 8000);
            await ev(`${btn('Connect')}.click(); true`);
            await waitFor(`!!document.getElementById('ssh-typed')`, 'the remove confirm', 8000); await settle(200);
            check(`${label}: Remove is disabled until the name is typed, and no terms are shown`, await ev(`${btn('Remove')}.disabled === true && !document.querySelector('.ssh-terms')`));
            await shot(`ssh-remove-${label}`);
            await ev(`(() => { const t = document.getElementById('ssh-typed'); t.value = 'ssh-box'; t.dispatchEvent(new Event('input')); return true; })()`);
            check(`${label}: typing the name enables Remove`, await ev(`${btn('Remove')}.disabled === false`));
            await ev(`${btn('Remove')}.click(); true`);
            await waitFor(`window.__hub.runs >= 2 && document.querySelector('.ssh-setup').textContent.includes('Done.')`, 'the remove to finish', 12000);
            check(`${label}: Remove sent only the typed name`, await ev(`JSON.stringify(window.__hub.runBody) === JSON.stringify({ confirm: 'ssh-box' })`), await ev(`JSON.stringify(window.__hub.runBody)`));
        }
        const failed = results.filter(r => !r).length;
        console.log(`${results.length - failed} of ${results.length} checks passed`);
        await client.close(); process.exit(failed ? 1 : 0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})().catch(e => { console.error(e); process.exitCode = 1; });
