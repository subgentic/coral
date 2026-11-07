// "Use Full access for this agent" in the launch and restart form (#14085, part d): the checkbox is there only where the page can act on it (the launch dialog and the restart form opt in; the team member's form
// does not), only for the three CLIs that have it, the narrowing note points to it, and what the form reads (getAgentConfig) carries the choice for the launch and restart bodies. Drives Chrome over CDP
// through agent_view_harness.js against the isolated dev server; the form is rendered in a scratch container of the real page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            const m = await import(st + 'agent_config_form.js'); window.__acf = m; // the chip's click action lives in modals.js (lazy): the form's own toggle is called directly
            for (const [id, offer] of [['ufa-offer', true], ['ufa-team', false]]) {
                const d = document.createElement('div'); d.id = id; document.body.appendChild(d);
                m.renderAgentConfigForm(id, { showPreset: false, showName: false, offerUseFullAccess: offer, value: { agentType: 'claude' } });
            }
            return true; })()`);
        const type = (id, t) => ev(`{ const s = document.querySelector('#${id} .acf-agent-type'); s.value = ${JSON.stringify(t)}; s.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        const row = id => ev(`(() => { const r = document.querySelector('#${id} .acf-use-full-access'); return r ? { hidden: r.hidden } : null; })()`);

        console.log('Only a form that opts in has the checkbox; the team member form has none');
        assert.equal(await row('ufa-team'), null, 'the team member form has no such field');
        assert.notEqual(await row('ufa-offer'), null);

        console.log('Only for Claude, Codex and agy');
        for (const [t, shown] of [['claude', true], ['codex', true], ['agy', true], ['terminal', false]]) {
            await type('ufa-offer', t);
            await waitFor(`document.querySelector('#ufa-offer .acf-agent-type').value === ${JSON.stringify(t)}`, t);
            assert.equal((await row('ufa-offer')).hidden, !shown, `${t}: the checkbox is ${shown ? 'there' : 'hidden'}`);
        }

        console.log('What the form reads: the choice is sent only when the box is shown and ticked');
        await type('ufa-offer', 'agy');
        const read = () => ev(`window.getAgentConfig('ufa-offer').useFullAccess`);
        assert.equal(await read(), false, 'not ticked: not sent');
        await ev(`document.querySelector('#ufa-offer .acf-use-full-access-input').click(); true`);
        assert.equal(await read(), true, 'ticked');
        await type('ufa-offer', 'terminal');
        assert.equal(await read(), false, 'a hidden box that was ticked is not sent');
        await type('ufa-offer', 'agy');
        assert.equal(await read(), true, 'and is still ticked when it comes back');
        await ev(`document.querySelector('#ufa-offer .acf-use-full-access-input').click(); true`);

        console.log('The narrowing note points to it (agy, Bypass, the Technical Writer list)');
        await ev(`{ const m = document.querySelector('#ufa-offer .acf-permission-mode'); m.value = 'bypassPermissions'; m.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        // exactly these two Allow chips on, whatever the form started with. The form may still be applying the type's defaults after the switch, so the wanted state is set again on every look until the note shows
        const WANT = `(() => { for (const chip of document.querySelectorAll('#ufa-offer .perm-chip[data-type="allow"]')) { const want = ['file_read', 'file_write'].includes(chip.dataset.cap); if (chip.classList.contains('active') !== want) window.__acf._togglePermChip(chip); } return !document.querySelector('#ufa-offer .acf-mode-override').hidden; })()`;
        await waitFor(WANT, 'the note').catch(async e => {
            console.log('state when the note did not come: ' + JSON.stringify(await ev(`(() => { const c = document.getElementById('ufa-offer'); const ov = c.querySelector('.acf-mode-override'); return { type: c.querySelector('.acf-agent-type').value, mode: c.querySelector('.acf-permission-mode')?.value, caps: window.getAgentConfig('ufa-offer').capabilities, override: ov ? { hidden: ov.hidden, text: ov.textContent } : null, chips: [...c.querySelectorAll('.perm-chip[data-type="allow"]')].map(x => x.dataset.cap + ':' + x.classList.contains('active') + (x.disabled ? ':disabled' : '')) }; })()`)));
            throw e;
        });
        assert.equal(await ev(`document.querySelector('#ufa-offer .acf-mode-override').textContent`), 'The capabilities narrow this Mode: Accepts edits. Tick Use Full access for this agent, below, to override that.');

        console.log('The note follows the box: ticked, it says Full access and stops saying it will run narrowed; unticked, it points to the box again');
        const note = () => ev(`document.querySelector('#ufa-offer .acf-mode-override').textContent`);
        await ev(`document.querySelector('#ufa-offer .acf-use-full-access-input').click(); true`);
        await waitFor(`/Use Full access is ticked/.test(document.querySelector('#ufa-offer .acf-mode-override').textContent)`, 'the ticked note');
        assert.equal(await note(), 'Use Full access is ticked: this agent runs with Full access whatever its capabilities say.');
        await ev(`document.querySelector('#ufa-offer .acf-use-full-access-input').click(); true`);
        await waitFor(`/Tick Use Full access/.test(document.querySelector('#ufa-offer .acf-mode-override').textContent)`, 'the pointer again');

        console.log('A form that does not offer the box never points to it (the team member form), and a hidden box does not count as ticked');
        await type('ufa-team', 'agy');
        await ev(`{ const m = document.querySelector('#ufa-team .acf-permission-mode'); m.value = 'bypassPermissions'; m.dispatchEvent(new Event('change', { bubbles: true })); } true`);
        await waitFor(`(() => { for (const chip of document.querySelectorAll('#ufa-team .perm-chip[data-type="allow"]')) { const want = ['file_read', 'file_write'].includes(chip.dataset.cap); if (chip.classList.contains('active') !== want) window.__acf._togglePermChip(chip); } return !document.querySelector('#ufa-team .acf-mode-override').hidden; })()`, 'the team form note');
        assert.equal(await ev(`document.querySelector('#ufa-team .acf-mode-override').textContent`), 'The capabilities narrow this Mode: Accepts edits.', 'no pointer to a box that is not there');
        console.log('PASS use full access form');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
