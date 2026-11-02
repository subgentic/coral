// Hermes is a provider in New agent and in the member / restart picker (#12038, goal #192 slice B): a card with the badge H and a radio when the CLI is found (picking it sets the form's agent to hermes, what Launch sends); under
// "Not installed" with an Install link and no radio when it is not found; and on a Windows server (the CLI check answers `supported: false` with a line) no card, no radio, no option in the form's select, and the line says why.
// New agent's cards (launch_provider_cards.js) and the older radio group (launch_agent_pick.js) are both driven. Isolated dev server; every answer is stubbed. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, openNewAgent, stubModels, stubCliChecks, stepLine } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const WHY = "Hermes isn't offered on Windows yet: it has not been tried with Coral there.";
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const toAgentStep = async () => {
        for (let i = 0; i < 4 && !/Step 3 of 3/.test(await stepLine(ev)); i++) {
            await ev(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /^Next$/.test(x.textContent.trim()) && x.getClientRects().length); const f = document.getElementById('launch-dir'); if (f && !f.value) { f.value = '/tmp'; f.dispatchEvent(new Event('input', { bubbles: true })); } if (b) b.click(); return true; })()`);
            await waitFor(`/Step ${i + 2} of 3|Step 3 of 3/.test(document.querySelector('[role=dialog]')?.textContent || '')`, 'the next step', 4000).catch(() => {});
        }
        await waitFor(`document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards heard from the CLI checks', 8000);
    };
    const cardsOf = () => ev(`(() => { const g = document.getElementById('launch-agent-pick'), c = [...g.querySelectorAll('.provider-card')].find(x => x.dataset.type === 'hermes'); return {
        radios: [...g.querySelectorAll('input[type=radio]')].map(r => r.value), card: c ? { missing: c.classList.contains('is-missing'), mark: c.querySelector('.provider-mark')?.textContent, name: c.querySelector('.provider-name')?.textContent, link: c.querySelector('a.provider-install')?.getAttribute('href') || null } : null,
        option: !!document.querySelector('#launch-agent-acf .acf-agent-type option[value="hermes"]'), line: g.querySelector('.provider-unsupported')?.textContent || null, sideways: document.scrollingElement.scrollWidth > innerWidth + 1 }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            for (const mode of ['installed', 'missing', 'windows']) {
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev);
                await stubCliChecks(ev, mode === 'missing' ? ['hermes'] : [], mode === 'windows' ? ['hermes'] : []);
                await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/tmp'])); true`);
                await openNewAgent(ev, waitFor); await toAgentStep();
                const c = await cardsOf(); const tag = `${at}${mode}: `;
                assert.equal(c.sideways, false, tag + 'no sideways scroll');
                if (mode === 'installed') {
                    assert.deepEqual(c.radios, ['claude', 'codex', 'agy', 'pi', 'opencode', 'hermes'], tag + 'six radios, Hermes last: ' + JSON.stringify(c));
                    assert.ok(c.card && !c.card.missing && c.card.mark === 'H' && c.card.name === 'Hermes', tag + 'a Hermes card with the badge H: ' + JSON.stringify(c.card));
                    assert.equal(c.option, true, tag + 'the form\'s select has it'); assert.equal(c.line, null, tag + 'no unsupported line');
                    await ev(`document.querySelector('#launch-agent-pick input[value="hermes"]').click(); true`);
                    await waitFor(`document.querySelector('#launch-agent-acf .acf-agent-type').value === 'hermes'`, tag + 'picking Hermes sets the form\'s agent', 4000);
                    assert.equal(await ev(`import(${S} + 'agent_config_form.js').then(m => m.getAgentConfig('launch-agent-acf').agentType)`), 'hermes', tag + 'what Launch sends');
                } else if (mode === 'missing') {
                    assert.ok(c.card && c.card.missing && c.card.link === 'https://example.invalid/install/hermes', tag + 'under Not installed with the server\'s install link: ' + JSON.stringify(c.card));
                    assert.ok(!c.radios.includes('hermes'), tag + 'no radio'); assert.equal(c.line, null, tag + 'not the unsupported line');
                } else {
                    assert.equal(c.card, null, tag + 'no card at all: ' + JSON.stringify(c)); assert.ok(!c.radios.includes('hermes'), tag + 'no radio');
                    assert.equal(c.option, false, tag + 'no option in the form\'s select'); assert.equal(c.line, WHY, tag + 'one line says why');
                    assert.deepEqual(c.radios, ['claude', 'codex', 'agy', 'pi', 'opencode'], tag + 'the other five are untouched');
                }
            }
            // the older radio group (member and restart dialogs): the same three answers
            for (const mode of ['installed', 'missing', 'windows']) {
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await stubCliChecks(ev, mode === 'missing' ? ['hermes'] : [], mode === 'windows' ? ['hermes'] : []);
                const g = await ev(`(async () => { const m = await import(${S} + 'launch_agent_pick.js');
                    const form = document.createElement('div'); form.innerHTML = '<select class="acf-agent-type"><option value="claude">Claude</option><option value="hermes">Hermes</option></select>'; const group = document.createElement('div'); group.id = 'pick-' + Date.now(); document.body.append(form, group);
                    await m.buildAgentPick({ group, form, server: 'local' });
                    return { radios: [...group.querySelectorAll('input')].map(i => i.value), missing: [...group.querySelectorAll('.has-mark input')].map(i => i.value), option: !!form.querySelector('option[value="hermes"]'), line: group.querySelector('.launch-agent-unsupported')?.textContent || null }; })()`);
                const tag = `${at}old picker ${mode}: `;
                if (mode === 'installed') { assert.ok(g.radios.includes('hermes') && g.missing.length === 0 && g.option && g.line === null, tag + JSON.stringify(g));
                    // the chips carry their letter (#12169, QA Reviewer 2): the picker's radios (member and restart dialogs) and the provider segments (team and member forms) say H and O, as C, X, A and P are said
                    const marks = await ev(`(async () => { const m = await import(${S} + 'launch_agent_pick.js'), seg = await import(${S} + 'segmented.js');
                        const form = document.createElement('div'); form.innerHTML = '<select class="acf-agent-type"><option value="claude">Claude</option><option value="opencode">OpenCode</option><option value="hermes">Hermes</option></select>'; const group = document.createElement('div'); group.id = 'launch-agent-pick'; document.body.append(form, group);
                        await m.buildAgentPick({ group, form, server: 'local' });
                        const wrap = document.createElement('label'); wrap.className = 'acf-provider-label'; const sel = form.querySelector('.acf-agent-type'); wrap.append(sel); document.body.append(wrap); seg.segmentSelect(sel, { label: 'Provider' });
                        const c = e => e ? getComputedStyle(e, '::before').content : null, radio = t => group.querySelector('.launch-agent-opt:has(input[value="' + t + '"])'), segb = t => wrap.parentElement.querySelector('.seg-btn[data-value="' + t + '"]');
                        return { radioH: c(radio('hermes')), radioO: c(radio('opencode')), radioC: c(radio('claude')), segH: c(segb('hermes')), segO: c(segb('opencode')), segC: c(segb('claude')) }; })()`);
                    assert.deepEqual([marks.radioH, marks.radioO, marks.radioC], ['"H"', '"O"', '"C"'], tag + 'the picker radios carry their letters: ' + JSON.stringify(marks));
                    assert.deepEqual([marks.segH, marks.segO, marks.segC], ['"H"', '"O"', '"C"'], tag + 'the provider segments carry their letters: ' + JSON.stringify(marks));
                }
                else if (mode === 'missing') { assert.ok(g.radios.includes('hermes') && g.missing.includes('hermes'), tag + 'marked not installed: ' + JSON.stringify(g)); }
                else { assert.ok(!g.radios.includes('hermes') && !g.option && g.line === WHY, tag + JSON.stringify(g)); }
            }
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS Hermes is a provider in New agent and the member picker; not installed and Windows are said');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
