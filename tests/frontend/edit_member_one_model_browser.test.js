// #11826 (follow-up of #11821): Add/Edit member's form has ONE Model input and ONE Model row however many times a member is opened. A reopen used to draw a second Model row while the cards kept the previous open's
// (two .sv-row[data-key=model], two .acf-model in the launch form); the form read the first and it worked, but a late default or a fix elsewhere could hit the other. Three opens of a worker: the counts stay one, and the
// model chosen each time is on the member's row after Save member. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNT, M, N, T, openNewTeam, scenarios, stubModels } = require('./helpers/new_team');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios(); const t = T(ev, waitFor); const mem = M(ev, waitFor);
    const roles = () => ev(`window.__nt.roles(window.__nt.dlg(${N.team}))`);
    const rowText = role => ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team})).find(x => window.__na.name(x) === ${JSON.stringify('Edit ' + role)}); return b ? window.__na.text(b.closest('.team-agent-row')) : null; })()`);
    const nextOff = () => ev(`(() => { const b = window.__nt.find(window.__nt.dlg(${N.team}), 'button', ${N.next}); return !!b && (b.disabled || b.getAttribute('aria-disabled') === 'true'); })()`);
    const pressNext = async () => { await t.click('button', N.next); await settle(150); return ev(`(() => { const r = document.getElementById('team-recap'); const a = document.activeElement; return { said: r.textContent.trim(), red: r.classList.contains('launch-recap-error'), focus: a && a.id, step: /Step 2 of 3/.test(window.__na.text(window.__nt.dlg(${N.team}))) }; })()`); };
    const why = () => ev(`(() => { const d = window.__nt.dlg(${N.team}); const b = window.__nt.find(d, 'button', ${N.next}); const dd = (b.getAttribute('aria-describedby') || '').split(/\\s+/).map(i => (document.getElementById(i) || {}).textContent || '').join(' ').trim(); const live = [...d.querySelectorAll('[aria-live=polite],[role=status]')].map(e => window.__na.text(e)).join(' | '); return dd + ' || ' + live; })()`);
    const openRow = async role => { await ev(`(() => { const b = window.__nt.rows(window.__nt.dlg(${N.team})).find(x => window.__na.name(x) === 'Edit ' + ${JSON.stringify(role)}); b.click(); return true; })()`); await waitFor(`!!window.__nt.dlg(${N.member})`, `the Edit member dialog for ${role}`, 5000); };
    const mtab = name => (name === 'Persona' ? mem.toPersona() : mem.section(name)); // Persona is the page before the settings (#7861)
    const setRole = v => mem.setRole(v);
    const setProvider = async name => { // a select or a radiogroup, as the build draws it
        const ok = await ev(`(() => { const d = window.__nt.dlg(${N.member}); const s = window.__nt.find(d, 'select', /^Provider$/i); if (s) { const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(name)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; } const g = [...d.querySelectorAll('[role=radiogroup]')].find(e => /^Provider$/i.test(window.__na.name(e))); if (!g) return false; const r = window.__na.radios(g).find(x => window.__na.radioName(x) === ${JSON.stringify(name)}); if (!r) return false; r.click(); return true; })()`);
        assert.ok(ok, `a Provider control with ${name} in Edit member`); await settle(500);
    };
    const setThinking = async name => { assert.ok(await ev(`(() => { const d = window.__nt.dlg(${N.member}); const g = [...d.querySelectorAll('[role=radiogroup]')].find(e => /^Thinking/i.test(window.__na.name(e))); if (g) { const r = window.__na.radios(g).find(x => window.__na.radioName(x) === ${JSON.stringify(name)}); if (!r) return false; r.click(); return true; } const s = window.__nt.find(d, 'select', /^Thinking/i); if (!s) return false; const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(name)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), `a Thinking control with ${name}`); await settle(200); };
    const setModel = async rx => { assert.ok(await ev(`(() => { const s = window.__nt.find(window.__nt.dlg(${N.member}), 'select', /^Model$/i); if (!s) return false; const o = [...s.options].find(o => ${rx}.test(o.value + ' ' + o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), `a Model option ${rx}`); await settle(200); };
    const save = async () => { await mem.save(); await settle(200); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev); await stubModels(ev);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor);
        await t.to(2, { template: /Coding|\(\d+ members\)/ });
        const counts = () => ev(`(() => { const f = document.getElementById('launch-agent-acf'); return f ? { model: f.querySelectorAll('.acf-model').length, rows: f.querySelectorAll('.sv-row[data-key="model"]').length, select: f.querySelectorAll('.acf-model-select').length, thinking: f.querySelectorAll('.sv-row[data-key="thinking"]').length } : null; })()`);
        const r0 = await roles(); assert.ok(r0.length >= 3, 'a template with workers: ' + JSON.stringify(r0));
        const seen = [];
        for (let i = 0; i < 3; i++) {
            await openRow(r0[1 + (i % 2)]); await mtab('Agent');
            seen.push(await counts());
            await setModel(/claude-small/); await setThinking('High'); await save();
            assert.match(await rowText(r0[1 + (i % 2)]), /small/i, `open ${i + 1}: the member's row shows the model chosen`);
        }
        for (const [i, c] of seen.entries()) assert.deepEqual([c.model, c.rows, c.select, c.thinking], [1, 1, 1, 1], `open ${i + 1}: one Model input, row and select and one Thinking row in the member's form: ` + JSON.stringify(seen));
        console.log('\nPASS Edit member keeps one Model row across opens');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
