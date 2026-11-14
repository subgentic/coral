// Edit member: a Model picked from the list stays picked when the form syncs again (a CLI re-check, a newer default fetch), and Save member keeps it (#16648, walk 28: the select stayed on "Default (recommended)", so a member could not be set to Haiku).
// The real model list of the isolated server (no stub): the pick used to be put back to Default by the next sync because only a TYPED id counted as the person's own. Isolated dev server.
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
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installNT(ev);
        await ev(`for (const k of Object.keys(localStorage)) if (k.startsWith('coral-models:v1:')) localStorage.removeItem(k); true`);
        await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
        await openNewTeam(ev, waitFor);
        await t.to(2, { template: /Coding|\(\d+ members\)/ });
        const r0 = await roles();
        await openRow(r0[1]); await mtab('Agent');
        await settle(1500);
        const dump = () => ev(`(() => { const d = window.__nt.dlg(${N.member}); const s = window.__nt.find(d, 'select', /^Model$/i); const i = d.querySelector('.acf-model'); return s ? { opts: [...s.options].map(o => o.value + '|' + o.textContent), val: s.value, input: i && i.value, inputHidden: i && i.hidden } : null; })()`);
        await ev(`(() => { const s = window.__nt.find(window.__nt.dlg(${N.member}), 'select', /^Model$/i); const o = [...s.options].find(o => /haiku/i.test(o.value + ' ' + o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        await settle(1500);
        await ev(`(() => { const t = window.__nt.dlg(${N.member}).querySelector('.acf-agent-type'); t.dispatchEvent(new Event('change', { bubbles: true })); return !!t; })()`);
        await settle(1500);
        const d = await dump();
        assert.equal(d.val, 'claude-haiku-5-5', 'the pick survives a re-sync of the form: ' + JSON.stringify(d));
        assert.equal(d.input, 'claude-haiku-5-5');
        await save();
        assert.match(await rowText(r0[1]), /haiku/i, "the member's row shows Haiku after Save member");
        console.log('\nPASS Edit member: a picked model stays picked through a re-sync and is saved');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
