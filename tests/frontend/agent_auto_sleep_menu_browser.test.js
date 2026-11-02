// #12111: the Operator's per-agent switch for auto-sleep is in an awake agent's menu: "Don't auto-sleep" while it is on, "Allow auto-sleep" once it is off (the live list's auto_sleep_off); choosing it
// posts {session_id, agent_type, off} to the agent's auto-sleep route and says so. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            const items = await ev(`(async () => {
                const rows = await import(${S} + 'session_rows.js');
                const mk = off => ({ name: 'dev', agent_type: 'claude', session_id: '11111111-2222-4333-8444-555555555555', display_name: 'Dev', sleeping: false, working_directory: '/tmp', ...(off ? { auto_sleep_off: true } : {}) });
                const labels = [];
                for (const off of [false, true]) {
                    const host = document.createElement('div'); host.innerHTML = rows._renderSessionItem(mk(off), '', false, false, '');
                    document.body.append(host);
                    const btn = host.querySelector('.sidebar-kebab, [aria-haspopup="menu"], .kebab-btn') || host.querySelector('button[data-on-click*="kebab"], .session-kebab');
                    const menu = host.querySelector('.sidebar-kebab-menu');
                    rows.openRowMenu(host.querySelector('.session-group-item') ? host.querySelector('.session-group-item').querySelector('button') : btn, menu);
                    labels.push([...host.querySelectorAll('[data-on-click="agent-auto-sleep"]')].map(b => [b.textContent.trim(), b.dataset.mode]));
                    host.remove();
                }
                return labels;
            })()`);
            assert.deepEqual(items, [[["Don't auto-sleep", 'off']], [['Allow auto-sleep', 'on']]], at + 'the menu item and its wording: ' + JSON.stringify(items));
            // choosing it posts the switch
            const posted = await ev(`(async () => {
                const calls = []; const R = window.fetch;
                window.fetch = async (u, o = {}) => { if (String(u).includes('/auto-sleep')) { calls.push({ url: String(u), body: JSON.parse(o.body) }); return new Response(JSON.stringify({ ok: true, auto_sleep_off: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } return R(u, o); };
                const a = await import(${S} + 'agent_actions.js');
                const ok = await a.setAgentAutoSleep('dev', 'claude', '11111111-2222-4333-8444-555555555555', 'off');
                window.fetch = R; return { ok, calls };
            })()`);
            assert.equal(posted.ok, true, at + 'the switch was taken');
            assert.equal(posted.calls.length, 1);
            assert.match(posted.calls[0].url, /\/api\/sessions\/live\/dev\/auto-sleep$/);
            assert.deepEqual(posted.calls[0].body, { session_id: '11111111-2222-4333-8444-555555555555', agent_type: 'claude', off: true });
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS the per-agent auto-sleep switch is in the awake agent\'s menu and posts to its route');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
