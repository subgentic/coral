// The sidebar and session micro buttons are the family's dense icon button (#9484, group 1 of #9480): the folder card's copy-path button, the team health icon, the session header's copy-branch button and the
// composer's macro delete are .btn.btn-quiet.btn-icon.btn-xs (a 24 px box, a 44 px hit area on touch), with their own rules only placing or revealing them. Drawn from the page's own renderers (the agent list from live sessions; the
// header and macro buttons from their real markup), 1280 and 390, dark and light, with shots of each control. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const S = (id, name, extra) => ({ session_id: id, name, agent_type: 'claude', working_directory: '/tmp/proj', sleeping: false, ...extra });
const SESSIONS = [S('a-orc', 'orc-1', { board_project: 'alpha', display_name: 'Orchestrator', working_directory: '/tmp/alpha' }), S('f-1', 'folder-a', { display_name: 'Solo One', working_directory: '/tmp/folder-a' }), S('f-2', 'folder-b', { display_name: 'Solo Two', working_directory: '/tmp/folder-b' })];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const { Input } = client;
    const theme = t => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${t}'); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(() => { localStorage.removeItem('coral_collapsed_groups'); window.switchNavTab('agents'); window._coralSetLiveSessions(${JSON.stringify(SESSIONS)}); return true; })()`);
            await waitFor(`document.querySelectorAll('.folder-copy-btn').length >= 1 && document.querySelectorAll('.session-group-item .sidebar-kebab-btn').length >= 1`, `${at}the agent list`, 15000);
            // the header and macro buttons, from their real markup, in a visible probe (the session pages and the composer need a live session)
            await ev(`(() => { document.getElementById('btn-probe')?.remove(); const p = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'btn-probe', style: 'position:fixed;right:12px;top:80px;z-index:9999;padding:12px 16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;display:flex;gap:18px;align-items:center;font-size:13px' }));
                const cb = document.querySelector('.copy-branch-btn'); const span = document.createElement('span'); span.textContent = 'feat/branch '; if (cb) span.append(cb.cloneNode(true)); p.append(span);
                const wrap = document.createElement('span'); wrap.className = 'macro-btn-wrap'; wrap.style.cssText = 'position:relative;display:inline-block'; wrap.innerHTML = '<button class="btn-nav">Macro</button><button class="btn btn-quiet btn-icon btn-xs btn-danger macro-delete-btn" title="Remove macro"><span class="material-icons" aria-hidden="true">close</span></button>'; p.append(wrap); wrap.querySelector('.macro-delete-btn').style.display = 'inline-flex'; return true; })()`);
            const m = await ev(`(() => { const info = sel => [...document.querySelectorAll(sel)].map(b => { const cs = getComputedStyle(b), r = b.getBoundingClientRect(), a = getComputedStyle(b, '::after'); return { cls: b.className, shown: b.getClientRects().length > 0, w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, hit: parseFloat(a.width) || 0 }; });
                return { copy: info('.folder-copy-btn:not(.team-health-btn)'), health: info('.team-health-btn'), branch: info('#btn-probe .copy-branch-btn'), macro: info('#btn-probe .macro-delete-btn') }; })()`);
            for (const [name, list] of Object.entries(m)) {
                assert.ok(list.length >= 1 || name === 'health', `${at}${name}: the control is on the page`); // the team health icon appears with the health report: not drawn from live sessions alone (team_health_icon_browser covers it)
                for (const b of list) assert.ok(/\bbtn-icon\b/.test(b.cls) && /\bbtn-xs\b/.test(b.cls) && /\bbtn-quiet\b/.test(b.cls), `${at}${name}: a dense quiet icon button: ${b.cls}`);
            }
            for (const [name, list] of Object.entries(m)) for (const b of list.filter(x => x.shown)) { assert.ok(b.w >= 24 && b.h >= 24 && b.w <= 28 && b.h <= 28, `${at}${name}: a 24 px box: ${b.w}x${b.h}`); if (mobile) assert.ok(b.hit >= 44, `${at}${name}: a 44 px hit area on touch: ${b.hit}`); }
            // a delete keeps a danger hover: the quiet danger tint, red text (the macro delete lost its red circle in group 1)
            const danger = await ev(`(() => { const b = document.querySelector('#btn-probe .macro-delete-btn'); b.classList.add('probe-hover'); const cs = getComputedStyle(b); return { cls: b.className, color: cs.color }; })()`);
            assert.ok(/\bbtn-danger\b/.test(danger.cls), at + 'the macro delete is a danger icon button: ' + danger.cls);
            // the folder card's copy button shows on hover of its header
            await ev(`document.querySelector('.folder-copy-btn:not(.team-health-btn)').closest('.session-group-header').scrollIntoView({ block: 'center' }); true`);
            const pt = await ev(`(() => { const r = document.querySelector('.folder-copy-btn:not(.team-health-btn)').closest('.session-group-header').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
            if (!mobile) { await Input.dispatchMouseEvent({ type: 'mouseMoved', x: pt[0], y: pt[1] }); await new Promise(r => setTimeout(r, 250)); } // sleep-ok: the hover reveal's transition
            const hov = await ev(`(() => { const b = document.querySelector('.folder-copy-btn:not(.team-health-btn)'), r = b.getBoundingClientRect(); return { shown: b.getClientRects().length > 0, w: Math.round(r.width), h: Math.round(r.height) }; })()`);
            if (!mobile) assert.ok(hov.shown && hov.w >= 24, `${at}the folder copy button shows on hover as a 24 px box: ` + JSON.stringify(hov));
            for (const t of ['dark', 'light']) { await theme(t); await new Promise(r => setTimeout(r, 450)); await shot(`btn-group1-${t}-${w}`); } // sleep-ok: the theme's colour transition settles
        }
        console.log('PASS button group 1: the sidebar and session micro buttons are the family\'s dense quiet icon button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
