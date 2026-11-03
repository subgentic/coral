// The set-up-over-SSH dialog of the Servers tab (#11370) in a real page at 1280 and 390 px: the flow from the button through the plan, the host fingerprints and the Set up press to the finished
// steps, and a registered ssh server's Uninstall. The page's own modules run; only the hub's /api/servers routes are answered by a script in the page (a fake hub, as the other Servers suites do).
// Checks: nothing wider than the page, the fingerprint is text and no terms or acceptance are asked for, Set up is disabled until the key box is ticked, Remove until the name is typed, what is sent holds no key, the steps and the
// failure are in a live region or an alert. Screenshots with CORAL_SCREENSHOT_DIR. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setTheme } = require('./helpers/contrast');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const HUB = `(() => {
  const steps = (s = {}) => ['connect', 'detect', 'install', 'start', 'register'].map(n => ({ name: n, title: 'Step ' + n + ' of the setup', state: s[n] || 'pending', detail: s[n] === 'ok' ? 'Done well.' : '' }));
  const row = { id: 'ssh-box', label: 'Build box', url: 'ssh://user@box.example.com:22', status: 'online', transport: 'ssh', ssh_target: 'user@box.example.com:22', allow_private: false, created_at: '2026-10-30T10:00:00Z', last_seen: null, last_error: null };
  const world = { servers: [row], runBody: null, runs: 0, plans: [], polls: 0 };
  window.__hub = world;
  const real = window.fetch.bind(window);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, init = {}) => {
    const u = String(url), method = (init && init.method) || 'GET', body = init && init.body ? JSON.parse(init.body) : null;
    if (u === '/api/servers' && method === 'GET') return json(world.servers);
    if (!u.startsWith('/api/servers/provision')) return real(url, init);
    if (u.endsWith('/options')) return json({ hosts: ['build-box', 'second'], acceptance_label: 'hub-owner@my-mac', records_acceptance: true });
    if (u.endsWith('/plan')) { world.plans.push(body); const kind = body.action || 'setup';
      return json({ plan: 'p1', target: body.target || 'user@box.example.com:22', server_id: body.server_id || 'ssh-box-example-com', label: body.label || 'ssh-box-example-com', kind, phase: 'planned', steps: kind === 'setup' ? steps() : steps().slice(0, 3), delete_data: !!body.delete_data }, 201); }
    if (u.endsWith('/connect')) return json({ plan: 'p1', target: 'user@box.example.com:22', server_id: world.plans.at(-1).server_id || 'ssh-box-example-com', label: 'x', kind: world.plans.at(-1).action || 'setup', phase: world.plans.at(-1).action ? 'connected' : 'needs_keys', system: 'Linux x86_64',
      host_keys: world.plans.at(-1).action ? [] : [{ host: 'box.example.com', type: 'ssh-ed25519', fingerprint: 'SHA256:' + 'Zq9'.repeat(14) + '<img src=x onerror=window.__pwned=1>' }], steps: steps() });
    if (u.endsWith('/run')) { world.runBody = body; world.runs++; world.polls = 0; return json({ plan: 'p1', kind: world.plans.at(-1).action || 'setup', phase: 'running', steps: steps({ connect: 'ok' }) }, 202); }
    if (method === 'DELETE') return json({ status: 'cancelled' });
    if (method === 'GET' && world.failUpgrade && (world.plans.at(-1).action || 'setup') === 'upgrade') { const help = ['# To see why, and to start it yourself, sign in to that computer and run these lines. The kill line may say there is nothing to stop: that is fine.', 'tail -n 40 ~/.coral-server/coral.log', 'kill "$(cat ~/.coral-server/coral.pid)"', 'nohup ~/.coral-server/2.0.10/root/coral --host 127.0.0.1 --port 8420 --no-browser --cloud-url off --backend "$(cat ~/.coral-server/backend 2>/dev/null || echo pty)" --home ~/.coral-server/data </dev/null >> ~/.coral-server/coral.log 2>&1 & echo $! > ~/.coral-server/coral.pid <img src=x onerror=window.__pwned=1>', '# Then choose Upgrade here again: this hub finds the release already running and only checks it.'];
      return json({ plan: 'p1', kind: 'upgrade', phase: 'failed', error: 'The new release could not be started on that computer: its start command ended with code 9. The old release was stopped and the new one is installed.', steps: [{ name: 'install', title: 'Install the new release', state: 'ok', detail: 'Installed.' }, { name: 'restart', title: 'Restart Coral', state: 'failed', detail: 'The new release could not be started on that computer: its start command ended with code 9. The old release was stopped and the new one is installed.', help }, { name: 'verify', title: 'Check the new release', state: 'pending' }] }); }
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
            await ev(`(() => { const i = document.getElementById('ssh-host'); i.value = 'user@box.example.com'; i.dispatchEvent(new Event('input')); document.querySelector('.ssh-form').requestSubmit(); return true; })()`);
            await waitFor(`!!${btn('Connect')}`, 'the plan', 8000);
            check(`${label}: the plan lists the five steps and says nothing has connected`, await ev(`document.querySelectorAll('.ssh-step').length === 5 && document.querySelector('.ssh-setup').textContent.includes('Nothing has connected yet')`));
            check(`${label}: the plan fits the page`, await ev(noOverflow));
            await shot(`ssh-plan-${label}`);

            // connect: fingerprints
            await ev(`${btn('Connect')}.click(); true`);
            await waitFor(`!!document.getElementById('ssh-keys-ok')`, 'the fingerprints', 8000); await settle(200);
            check(`${label}: a fingerprint is text, not an element`, await ev(`document.querySelector('.ssh-key-fp').textContent.includes('<img src=x onerror=') && !document.querySelector('#servers-tab-body img') && !window.__pwned`));
            check(`${label}: the dialog shows no terms and asks for no acceptance`, await ev(`!document.querySelector('.ssh-terms') && !/By pressing|you accept/.test(document.querySelector('.ssh-setup').textContent)`));
            check(`${label}: Set up is disabled until the fingerprints are confirmed`, await ev(`${btn('Set up')}.disabled === true`));
            check(`${label}: the page does not widen`, await ev(`${noOverflow}`));
            check(`${label}: the one line says what the computer records, as information`, await ev(`document.querySelector('.ssh-consent').textContent === 'That computer records who accepted (hub-owner@my-mac), when, and which version.'`));
            await shot(`ssh-keys-terms-${label}`);
            // the data folder field (#12958, #12971): an invalid folder shows in the shared error colour on the words and the field, and says why Set up is closed; a valid one does not
            const typeDir = v => ev(`(() => { const i = document.getElementById('ssh-datadir-input'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); return true; })()`);
            const dirStyle = () => ev(`(() => { const i = document.getElementById('ssh-datadir-input'), n = document.getElementById('ssh-datadir-note'), p = document.createElement('span'); document.body.append(p);
                p.style.color = 'var(--error-text, var(--error))'; const word = getComputedStyle(p).color; p.style.color = 'var(--error)'; const edge = getComputedStyle(p).color; p.remove();
                return { wordOk: getComputedStyle(n).color === word, edgeOk: getComputedStyle(i).borderTopColor === edge, invalid: i.getAttribute('aria-invalid'), text: n.textContent }; })()`);
            await typeDir('../x'); const bad = await dirStyle();
            check(`${label}: an invalid data folder's note is in the error colour`, bad.wordOk && bad.invalid === 'true', JSON.stringify(bad));
            check(`${label}: and its field has the error border`, bad.edgeOk, JSON.stringify(bad));
            check(`${label}: and it says why Set up is closed`, /Set up waits until this is fixed/.test(bad.text) && await ev(`${btn('Set up')}.disabled === true`));
            await ev(`document.getElementById('ssh-datadir-input').scrollIntoView({ block: 'center' }); true`); await settle(200);
            await shot(`ssh-datadir-invalid-${label}`);
            await typeDir(''); const ok = await dirStyle();
            check(`${label}: a valid data folder is not in the error colour`, !ok.wordOk && !ok.edgeOk && ok.invalid === 'false', JSON.stringify(ok));
            if (label === '390') { // the phone: the folder field and the footer scrolled into view, in the light theme, and at 200% text
                const scrolls = async tag => {
                    await ev(`document.getElementById('ssh-datadir-input').scrollIntoView({ block: 'center' }); true`); await settle(200); await shot(`ssh-datadir-field-${tag}`);
                    await ev(`${btn('Cancel')}.scrollIntoView({ block: 'end' }); true`); await settle(200); await shot(`ssh-footer-${tag}`);
                    check(`${label} ${tag}: the page does not widen`, await ev(`${noOverflow}`));
                };
                await scrolls('dark');
                await setTheme(ev, 'light'); await scrolls('light');
                await ev(`document.documentElement.style.fontSize = '200%'; true`); await settle(300); await scrolls('light-200');
                await ev(`document.documentElement.style.fontSize = ''; true`);
                await setTheme(ev, 'dark'); await ev(`window.scrollTo(0, 0); true`); await settle(200);
            }
            await ev(`(() => { const c = document.getElementById('ssh-keys-ok'); c.click(); return true; })()`); await settle(100);
            check(`${label}: ticking the box enables Set up`, await ev(`${btn('Set up')}.disabled === false`));
            const nameOf = await ev(`${btn('Set up')}.getAttribute('aria-label') || ${btn('Set up')}.textContent.trim()`);
            check(`${label}: the button's name says what it does`, nameOf === 'Set up', nameOf);

            // run: the body, the steps, done
            await ev(`${btn('Set up')}.click(); true`);
            await waitFor(`!!document.querySelector('.ssh-progress[role="status"]')`, 'the progress', 8000);
            await waitFor(`document.querySelector('.ssh-setup').textContent.includes('Done. The computer is in your list.')`, 'done', 12000); await settle(200);
            const sent = await ev(`JSON.stringify(window.__hub.runBody)`);
            check(`${label}: Set up sent only the key box and the backend choice (pty by default): no key, no terms`, sent === JSON.stringify({ accept_keys: true, backend: "pty" }), sent);
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

            // a failed restart of an upgrade shows the commands to run by hand under the step (#12947): wrapped, as text, in a page that does not widen
            await ev(`window.__hub.failUpgrade = true; document.querySelector('[data-action="ssh-upgrade"]').click(); true`);
            await waitFor(`!!${btn('Connect')}`, 'the upgrade plan', 8000);
            await ev(`${btn('Connect')}.click(); true`);
            const upBtn = `[...document.querySelectorAll('.ssh-setup button')].find(b => /^Upgrade/.test(b.textContent.trim()))`;
            await waitFor(`!!${upBtn}`, 'the upgrade button', 8000);
            await ev(`${upBtn}.click(); true`);
            await waitFor(`!!document.querySelector('.ssh-step-help')`, 'the commands under the failed step', 12000); await settle(200);
            check(`${label}: the commands are under the failed step and hold the log, the stop and the start`, await ev(`(() => { const p = document.querySelector('.ssh-step-help'); return p.closest('.ssh-step').classList.contains('ssh-step-failed') && p.textContent.includes('tail -n 40 ~/.coral-server/coral.log') && p.textContent.includes('kill "$(cat ~/.coral-server/coral.pid)"') && p.textContent.includes('nohup ~/.coral-server/2.0.10/root/coral'); })()`));
            check(`${label}: they wrap: nothing is wider than the page and the block has no sideways scroll`, await ev(`${noOverflow} && (() => { const p = document.querySelector('.ssh-step-help'); return p.scrollWidth <= p.clientWidth + 1; })()`));
            check(`${label}: they are text, not markup`, await ev(`!document.querySelector('.ssh-step-help img') && window.__pwned !== 1`));
            check(`${label}: a keyboard can reach the block and it is named`, await ev(`(() => { const p = document.querySelector('.ssh-step-help'); return p.tabIndex === 0 && !!p.getAttribute('aria-label'); })()`));
            await shot(`ssh-restart-failed-${label}`);
            await ev(`window.__hub.failUpgrade = false; ${btn('Close')}.click(); true`);
            await waitFor(`!!document.querySelector('[data-action="ssh-remove"]')`, 'back to the server page', 8000);
            await ev(`document.querySelector('[data-action="ssh-remove"]').click(); true`);
            await waitFor(`!!${btn('Connect')}`, 'the remove plan', 8000);
            // what happens to the data is a choice on the plan (#12263): kept by default, and deleted only when ticked
            check(`${label}: Remove offers "also delete its data", unticked, and the plan keeps it`, await ev(`(() => { const c = document.getElementById('ssh-delete-data'); return !!c && c.checked === false && !document.querySelector('.ssh-delete-warning') && /Kept/.test(document.querySelector('.servers-facts').textContent) && !window.__hub.plans.at(-1).delete_data; })()`));
            const plansBefore = await ev(`window.__hub.plans.length`);
            await ev(`document.getElementById('ssh-delete-data').click(); true`);
            await waitFor(`window.__hub.plans.length === ${plansBefore} + 1 && !!document.querySelector('.ssh-delete-warning')`, 'the plan with the data deleted', 8000);
            check(`${label}: ticking it makes a new plan that says the data goes, and the page says what is deleted`, await ev(`window.__hub.plans.at(-1).delete_data === true && /Deleted too/.test(document.querySelector('.servers-facts').textContent) && document.getElementById('ssh-delete-data').checked === true && /cannot be undone/.test(document.querySelector('.ssh-delete-warning').textContent)`));
            await ev(`document.getElementById('ssh-delete-data').click(); true`);
            await waitFor(`window.__hub.plans.length === ${plansBefore} + 2 && !document.querySelector('.ssh-delete-warning')`, 'the plan with the data kept again', 8000);
            check(`${label}: unticking it keeps the data again`, await ev(`!window.__hub.plans.at(-1).delete_data && /Kept/.test(document.querySelector('.servers-facts').textContent)`));
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
