// The provider is chosen in New Agent's third step (#6199, Codex Test's first-run walk; #11235, Option B): a card for each provider this computer has, the installed ones first, the others under "Not installed" with an Install link and
// no radio; the cards follow the form's own agent select (both ways); with no saved default and Claude missing, an installed provider starts selected. At 1280 and 390 px.
// The CLI check is stood in per agent. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const stub = (installed, delay = 0) => ev(`(() => { if (!window.__realFetch) window.__realFetch = window.fetch; const real = window.__realFetch; window.fetch = async (u, o = {}) => { const p = String(u), m = /\\/api\\/system\\/cli-check\\?(?:.*&)?type=([a-z]+)/.exec(p);
        if (m) { if (${delay}) await new Promise(r => setTimeout(r, ${delay})); const found = ${JSON.stringify(installed)}.includes(m[1]); return new Response(JSON.stringify({ found, agent_type: m[1], status: found ? 'available' : 'missing' }), { headers: { 'Content-Type': 'application/json' } }); } return real(u, o); }; return true; })()`);
    const open = async (probed = true) => {
        await ev(`(async () => { await window.showLaunchModal(); document.querySelector('#launch-step-chooser [data-arg="agent"]').click(); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('launch-step-agent')).display !== 'none' && !!document.getElementById('launch-agent-next')`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) i.value = '/tmp'; document.getElementById('launch-agent-next').click(); document.getElementById('launch-agent-next').click(); return true; })()`); // the agent is chosen in the third step: Next twice (#7391)
        await waitFor(`!document.getElementById('launch-agent-pick').hidden && getComputedStyle(document.getElementById('launch-agent-pick')).display !== 'none'`, 'the agent choice', 8000);
        if (probed) await waitFor(`document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the CLI checks answered', 8000);
    };
    const state = () => ev(`(() => { const g = document.getElementById('launch-agent-pick'); const sel = document.querySelector('#launch-agent-acf .acf-agent-type'); return { cards: [...g.querySelectorAll('.provider-card:not(.is-missing) .provider-name')].map(l => l.textContent.trim()), missing: [...g.querySelectorAll('.provider-missing .provider-name')].map(l => l.textContent.trim()), links: [...g.querySelectorAll('.provider-missing a')].map(a => [a.textContent.trim(), a.getAttribute('href'), a.target]), radios: g.querySelectorAll('.provider-missing input').length, checked: (g.querySelector('input:checked') || {}).value || null, select: sel.value, inMore: !!g.closest('#launch-agent-more'), shown: g.getClientRects().length > 0, role: g.getAttribute('role'), name: (document.getElementById(g.getAttribute('aria-labelledby')) || {}).textContent }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`(async () => { const m = await import(${S} + 'launch_models.js'); return true; })()`);
            // Claude and Antigravity missing, Codex and Pi installed, nothing ever chosen: Codex and Pi are the cards, Codex selected; the other two are under Not installed with a link and no radio
            await stub(['codex', 'pi']);
            await open();
            let s = await state();
            check(`${tag}: the provider choice is in the third step, not behind a disclosure, a named radio group`, s.shown && !s.inMore && s.role === 'radiogroup' && s.name === 'Provider', JSON.stringify([s.shown, s.inMore, s.role, s.name]));
            check(`${tag}: the installed providers are the cards, first; the others are under Not installed`, JSON.stringify(s.cards) === JSON.stringify(['Codex', 'Pi']) && JSON.stringify(s.missing) === JSON.stringify(['Claude', 'Antigravity', 'OpenCode']), JSON.stringify([s.cards, s.missing]));
            check(`${tag}: a provider that is not installed has an Install link (a new tab) and no radio`, s.radios === 0 && s.links.length === 3 && s.links.every(l => /^Install /.test(l[0]) && /^https?:/.test(l[1]) && l[2] === '_blank'), JSON.stringify([s.radios, s.links]));
            check(`${tag}: with no default chosen and Claude missing, the first installed provider is selected (the form's select agrees)`, s.checked === 'codex' && s.select === 'codex', JSON.stringify([s.checked, s.select]));
            // choosing in the third step drives the form
            await ev(`document.querySelector('#launch-agent-pick input[value="pi"]').click(); true`);
            s = await state();
            const cfg = await ev(`import(${S} + 'agent_config_form.js').then(m => m.getAgentConfig('launch-agent-acf').agentType)`);
            check(`${tag}: picking Pi sets the form's agent (what Launch sends)`, s.select === 'pi' && cfg === 'pi', JSON.stringify([s.select, cfg]));
            // and the form drives the choice
            await ev(`(() => { const sel = document.querySelector('#launch-agent-acf .acf-agent-type'); sel.value = 'codex'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            s = await state();
            check(`${tag}: changing the form's agent select moves the choice here`, s.checked === 'codex', JSON.stringify([s.checked, s.select]));
            // each card is a real target
            const sizes = await ev(`[...document.querySelectorAll('#launch-agent-pick .provider-card-head, #launch-agent-pick .provider-install')].map(l => { const b = l.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; })`);
            check(`${tag}: ${mobile ? 'each card and link is 44 px high' : 'each card and link is a clear target'}`, sizes.length === 5 && sizes.every(z => z[1] >= (mobile ? 44 : 28)), JSON.stringify(sizes));
            const fits = await ev(`(() => { const r = document.getElementById('launch-agent-pick').getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= 0; })()`);
            check(`${tag}: it fits the screen`, fits);
            // everything installed: the default order, Claude selected, no Not installed section
            await ev(`window.hideLaunchModal(); true`);
            await stub(['claude', 'codex', 'agy', 'pi', 'opencode']);
            await open();
            s = await state();
            check(`${tag}: everything installed: the usual order, Claude selected, no Not installed section`, JSON.stringify(s.cards) === JSON.stringify(['Claude', 'Codex', 'Antigravity', 'Pi', 'OpenCode']) && s.missing.length === 0 && s.checked === 'claude', JSON.stringify([s.cards, s.missing, s.checked]));
            await ev(`window.hideLaunchModal(); true`);
            // a CLI check that fails: all four are cards, none is said to be missing, the default stays
            await ev(`(() => { const real = window.__realFetch; window.fetch = async (u, o = {}) => { if (/cli-check/.test(String(u))) return new Response('x', { status: 500 }); return real(u, o); }; return true; })()`);
            await open();
            s = await state();
            check(`${tag}: when the check cannot answer, nothing is called missing and Claude stays the default`, s.missing.length === 0 && s.cards.length === 5 && s.checked === 'claude', JSON.stringify([s.cards, s.missing, s.checked]));
            await ev(`window.hideLaunchModal(); true`);
            // the probes are slow (1 s): the four cards are there at once and usable; a late answer moves the missing ones and does not undo a choice (#8024)
            await stub(['codex', 'pi'], 1000);
            const t0 = Date.now(); await open(false);
            s = await state();
            check(`${tag}: slow CLI checks: the group is shown at once, five cards in the usual order, none under Not installed yet`, Date.now() - t0 < 900 && JSON.stringify(s.cards) === JSON.stringify(['Claude', 'Codex', 'Antigravity', 'Pi', 'OpenCode']) && s.missing.length === 0 && s.checked === 'claude', JSON.stringify([Date.now() - t0, s.cards, s.missing, s.checked]));
            const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            await shot(`agent-pick-at-once-${w}`);
            await ev(`(() => { const sel = document.querySelector('#launch-agent-acf .acf-agent-type'); sel.value = 'agy'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); // a person chooses Antigravity, which the late answer says is missing
            await waitFor(`document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the late answers', 8000);
            await shot(`agent-pick-after-probes-${w}`);
            await waitFor(`!!document.querySelector('#launch-cli-slot .acf-cli-warning p, .launch-cli-slot .acf-cli-warning p')`, 'the install help (its link and command are drawn after the check answers)', 8000);
            const col = await ev(`(() => { const w = document.querySelector('.launch-cli-slot .acf-cli-warning'); const kids = [...w.children].filter(c => c.getClientRects().length); const label = kids.find(c => c.tagName === 'SPAN'), btn = kids.find(c => c.tagName === 'BUTTON' || c.classList.contains('cli-actions')) /* Check again, or with Set path the group of the two (#10013) */, help = kids.filter(c => c.tagName === 'P'); const mid = e => (e.getBoundingClientRect().top + e.getBoundingClientRect().bottom) / 2, wr = w.getBoundingClientRect();
                return { labelLeft: Math.round(label.getBoundingClientRect().left), btnRight: Math.round(wr.right - btn.getBoundingClientRect().right), sameLine: Math.abs(mid(label) - mid(btn)) < 12, helpBelow: help.every(h => h.getBoundingClientRect().top >= label.getBoundingClientRect().bottom - 1), helps: help.length }; })()`);
            check(`${tag}: the install help is a row (Restart's): the status at the left edge, the button at the right end, the link and the command under them`, (col.sameLine || tag === '390px') && col.btnRight <= 6 && col.helps >= 1 && col.helpBelow, JSON.stringify(col));
            s = await state();
            check(`${tag}: the late answers move the missing ones under Not installed and leave the choice a person made (the form's select stays on Antigravity)`, s.select === 'agy' && JSON.stringify(s.missing) === JSON.stringify(['Claude', 'Antigravity', 'OpenCode']) && s.checked === null, JSON.stringify([s.checked, s.select, s.missing]));
            await ev(`window.hideLaunchModal(); true`);
            // nobody chose: the late answers put the installed first and select the first installed one (Claude is missing)
            await stub(['codex', 'pi'], 600);
            await open(false);
            await waitFor(`document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the late answers', 8000);
            s = await state();
            check(`${tag}: nobody chose: the late answers order the installed first and start on Codex`, JSON.stringify(s.cards) === JSON.stringify(['Codex', 'Pi']) && JSON.stringify(s.missing) === JSON.stringify(['Claude', 'Antigravity', 'OpenCode']) && s.checked === 'codex', JSON.stringify([s.cards, s.missing, s.checked]));
            await ev(`window.hideLaunchModal(); true`);
        }
    } finally { /* the harness closes the page */ }
    const failed = results.filter(r => !r).length;
    console.log(`launch_agent_pick: ${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
