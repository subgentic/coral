// The permission mode as a list of explained rows, one component in New agent, New team and Settings > Defaults (#15886, LA2; spec 695ed583).
// Today: six equal buttons on two rows, and only the chosen mode is explained. Done when all six explanations are readable without choosing, the arrow keys move the choice, and the same component is in the three places.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const places = {
            'New agent': { open: `(async () => { await window.showLaunchModal(); await window._selectLaunchType('agent'); return true; })()`, stage: `document.getElementById('launch-dir').value = '/tmp'; window._launchStage('agent'); true`, pane: `(() => { const m = document.getElementById('launch-step-agent'); const t = [...m.querySelectorAll('[role=tab]')].find(x => x.dataset.section === 'permissions'); if (t && t.getClientRects().length) t.click(); else { const s = m.querySelector('.settings-group-pick select'); if (s && s.value !== 'permissions') { s.value = 'permissions'; s.dispatchEvent(new Event('change', { bubbles: true })); } } return !!document.querySelector('#launch-step-agent .acf-permission-mode + .seg-list .seg-desc')?.getClientRects().length; })()`, root: '#launch-step-agent', sel: '.acf-permission-mode', modes: 6 },
            'New team (member)': { open: `(async () => { await window.showLaunchModal(); await window._selectLaunchType('team'); return true; })()`, ready: `typeof window.showTeamAgentModal === 'function'`, then: `(async () => { await window.showTeamAgentModal(); return true; })()`, stage: `window._launchStage('agent'); true`, pane: null, root: '#launch-step-agent', sel: '.acf-permission-mode', modes: 6 },
            'Settings > Defaults': { open: `(async () => { await window.showSettingsModal('agents'); return true; })()`, root: '#settings-modal', sel: '#settings-permission-mode', modes: 6 },
        };
        const inspect = (p) => ev(`(() => { const sel = document.querySelector(${JSON.stringify(p.root + ' ' + p.sel)}); const g = sel && sel.nextElementSibling; if (!g || !g.classList.contains('seg-list')) return { list: false };
            const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
            const rows = [...g.querySelectorAll('.seg-btn')].map(b => ({ v: b.dataset.value, role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'), mark: !!b.querySelector('.seg-mark'), name: b.querySelector('.seg-name')?.textContent || '', desc: (b.querySelector('.seg-desc')?.textContent || '').trim(), warn: (b.querySelector('.seg-warn')?.textContent || '').trim(), top: Math.round(b.getBoundingClientRect().top), left: Math.round(b.getBoundingClientRect().left), w: Math.round(b.getBoundingClientRect().width), descVisible: !!b.querySelector('.seg-desc') && vis(b.querySelector('.seg-desc')), warnColor: b.querySelector('.seg-warn') ? getComputedStyle(b.querySelector('.seg-warn')).color : '' }));
            const hint = [...document.querySelectorAll(${JSON.stringify(p.root)} + ' .perm-mode-desc')].some(vis);
            return { list: true, rows, hintVisible: hint, scrollX: document.documentElement.scrollWidth > innerWidth }; })()`);
        const run = async (w, h, label) => {
            for (const [place, p] of Object.entries(places)) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'settings');
                // Cold lazy adapters return promises. Finish opening before selecting/staging,
                // and use the wizard transition so modal and step state agree (#16405).
                await ev(p.open);
                if (place === 'Settings > Defaults') await ev(`document.querySelector('#settings-permission-mode').scrollIntoView({block:'center'});true`);
                if (p.ready) { await waitFor(p.ready, 'member dialog module', 8000); await ev(p.then); }
                if (p.stage) { p.pane = p.pane || places['New agent'].pane; await waitFor(`!!document.querySelector('#launch-step-agent .acf-permission-mode + .seg-list .seg-btn')`, 'permission rows rendered', 10000); await ev(p.stage); await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'agent' && document.getElementById('launch-modal').dataset.agentStage === 'agent'`, 'agent wizard stage synchronized', 8000); await waitFor(p.pane, 'visible Permissions pane', 8000).catch(async e => { throw new Error('the Permissions pane did not show: ' + await ev(`JSON.stringify({ tabs: [...document.querySelectorAll('#launch-step-agent [role=tab]')].map(t => t.dataset.section + ':' + t.getClientRects().length), pick: !!document.querySelector('#launch-step-agent .settings-group-pick select'), stage: document.getElementById('launch-step-agent').dataset.stage })`)); }); }
                await waitFor(`!!document.querySelector(${JSON.stringify(p.root + ' ' + p.sel)}) && !!document.querySelector(${JSON.stringify(p.root + ' ' + p.sel)}).nextElementSibling?.classList.contains('seg-list') && [...document.querySelectorAll(${JSON.stringify(p.root + ' .seg-list .seg-desc')})].some(e => e.getBoundingClientRect().height > 0) && getComputedStyle(document.querySelector(${JSON.stringify(p.root + ' .seg-list .seg-btn')})).display === 'grid'`, place + ' visible permission list', 8000).catch(async e => { throw new Error(place + ' ' + label + ': no list: ' + JSON.stringify(await ev(`(() => { const s = document.querySelector(${JSON.stringify(p.root + ' ' + p.sel)}); return s ? { next: s.nextElementSibling && s.nextElementSibling.className, html: s.nextElementSibling && s.nextElementSibling.innerHTML.slice(0, 500), disp: s.nextElementSibling && getComputedStyle(s.nextElementSibling.querySelector(".seg-desc") || s).display, sheet: !!document.querySelector("link[href*=permission_mode_list]") } : null; })()`))); });
                const r = await inspect(p);
                const tag = `${label} ${place}`;
                assert.equal(r.list, true, tag + ': the mode is a list');
                assert.deepEqual(r.rows.map(x => x.v).sort(), ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'], tag + ': the six modes, in rows, and no Not set row');
                assert.ok(r.rows.every(x => x.role === 'radio' && x.mark && x.name && x.desc && x.descVisible), `${tag}: every row is a radio with its name and a visible line on what it allows: ${JSON.stringify(r.rows.filter(x => !(x.desc && x.descVisible)))}`);
                assert.equal(new Set(r.rows.map(x => x.left)).size, 1, tag + ': one column');
                assert.ok(r.rows.every((x, i) => i === 0 || x.top > r.rows[i - 1].top), tag + ': each row under the one before');
                assert.equal(r.rows.filter(x => x.checked === 'true').length, 1, tag + ': one is chosen');
                for (const v of ['bypassPermissions', 'dontAsk']) assert.ok(r.rows.find(x => x.v === v).warn, `${tag}: ${v} carries the warning line`);
                assert.ok(r.rows.filter(x => x.warn).length === 2, tag + ': and only those two');
                assert.equal(r.hintVisible, false, tag + ': the one-line hint is not drawn a second time');
                assert.equal(r.scrollX, false, tag + ': no sideways scroll');
                // arrow keys move the choice
                const before = r.rows.find(x => x.checked === 'true').v;
                await ev(`document.querySelector(${JSON.stringify(p.root + ' .seg-list [aria-checked="true"]')}).focus(); true`);
                await ev(`document.querySelector(${JSON.stringify(p.root + ' .seg-list [aria-checked="true"]')}).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); true`);
                // Settings confirms moving into a risky mode before committing the selection (ST3).
                if (place === 'Settings > Defaults' && await ev(`document.getElementById('confirm-modal')?.style.display === 'flex'`)) await ev(`document.getElementById('confirm-modal-yes').click();true`);
                const after = (await inspect(p)).rows.find(x => x.checked === 'true').v;
                assert.notEqual(after, before, `${tag}: ArrowDown moves the choice (${before} -> ${after})`);
                assert.equal(await ev(`document.querySelector(${JSON.stringify(p.root + ' ' + p.sel)}).value`), after, tag + ': and the select follows it');
                console.log('ok', tag, 'rows ' + r.rows.length);
            }
        };
        await run(1440, 900, 'desktop');
        await run(390, 800, 'phone');
        console.log('PASS permission mode list');
    } finally {
        await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
        await client.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
