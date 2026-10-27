// The New workflow form (#6540 mock, #6578; a settings_view in form mode since #8450): Name (Required, the allowed characters under its label), then Steps with one empty step already showing, numbered from 1;
// Description, Repository path and Time limit behind "More options"; the limit is a number with a unit. Every control of a step has its own name; Create is always on, pressing it focuses the first invalid
// field and says what is missing, on the field and in the line beside the buttons. 1280 and 390 px, both themes for contrast.
// The save is stood in at the page's fetch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setTheme, installAudit, auditRegion } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

const STUB = `(() => {
    const real = window.fetch; window.__saved = [];
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/workflows' && m === 'POST') { window.__saved.push(JSON.parse(o.body)); return json({ id: 5, name: 'x' }); }
        return real(u, o); };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const type = async (sel, text) => { await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select && e.select(); return true; })()`); await Input.insertText({ text }); };
    const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility(); })()`;
    const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.fetch = (u, o) => { const url = String(u && u.url || u); if (new URL(url, location.origin).pathname === '/api/workflows' && (!o || !o.method || o.method === 'GET')) return Promise.resolve(new Response(JSON.stringify({ workflows: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return R(u, o); }; })();` }); // no workflow: the page is its one empty line (a shared server may hold workflows other suites made)
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`); await ev(STUB);
            await ev(`window.openAutomationsFolder('workflows'); window.showWorkflowCreateModal(); true`);
            await waitFor(`document.getElementById('wf-create-modal').style.display === 'flex'`, 'the dialog', 8000).catch(async e => { throw new Error(e.message + ' ' + await ev(`String(typeof window.showWorkflowCreateModal)`)); });
            await installAudit(ev);

            // 1. first screen: Name, Steps with one step showing; the rest behind More options
            assert.equal(await ev(vis('#wf-input-name')), true, at + 'Name');
            const pat = await ev(`(() => { const m = document.querySelector('#wf-create-modal .modal-content').getBoundingClientRect(), x = document.querySelector('#wf-create-modal .modal-close-btn').getBoundingClientRect(), f = document.getElementById('wf-modal-save').getBoundingClientRect(); return { xRight: Math.round(m.right - x.right), xTop: Math.round(x.top - m.top), btnRight: Math.round(m.right - f.right) }; })()`);
            assert.ok(pat.xRight >= 0 && pat.xRight <= 40 && pat.xTop <= 40, at + 'the X is at the top right: ' + JSON.stringify(pat));
            assert.ok(pat.btnRight <= 40, at + 'the buttons are at the bottom right, as in New job: ' + JSON.stringify(pat));
            assert.equal(await ev(`document.querySelectorAll('#wf-steps-editor .wf-step-editor-item').length`), 1, at + 'one step is already there');
            assert.deepEqual(await ev(`[document.querySelector('.wf-step-type-select').value, document.querySelector('.wf-step-name-input').value, document.querySelector('.wf-step-content').value]`), ['shell', 'Run tests', ''], at + 'it is a named step to fill in, with no command saved by accident (#9297)');
            assert.equal(await ev(`document.querySelector('.wf-step-content').placeholder`), 'e.g. npm test', at + 'the example is the placeholder');
            assert.equal(await ev(vis('#wf-build-hint')), true, at + 'a hint offers Build with Agent');
            assert.match(await ev(`document.getElementById('wf-build-hint').textContent.replace(/\\s+/g, ' ').trim()`), /^Not sure what the steps are\? An agent can write them with you\. Build with Agent$/, at);
            for (const id of ['#wf-input-desc', '#wf-input-repo', '#wf-input-max-dur']) assert.equal(await ev(vis(id)), false, at + id + ' is behind More options');
            assert.equal(await ev(`document.getElementById('wf-more').open`), false);
            assert.deepEqual(await ev(`(() => { const r = document.getElementById('wf-input-name').closest('.sv-row'); return [r.querySelector('.sv-label').textContent.replace('Required', '').trim(), !!r.querySelector('.sv-required'), document.getElementById('wf-input-name').getAttribute('aria-required')]; })()`), ['Name', true, 'true'], at + 'Name says Required');
            assert.match(await ev(`(() => { const d = document.getElementById('wf-input-name').getAttribute('aria-describedby') || ''; return d.split(' ').map(id => (document.getElementById(id) || {}).textContent || '').join(' '); })()`), /Letters, numbers, hyphens and underscores/, at + 'the allowed characters describe the field');
            assert.equal(await ev(`document.getElementById('wf-modal-save').disabled`), false, at + 'Create is on with nothing filled in');
            assert.equal(await ev(`document.querySelector('.wf-step-num').textContent`), 'Step 1', at + 'steps are numbered from 1');
            const names = await ev(`[...document.querySelectorAll('#wf-steps-editor .wf-step-editor-item [aria-label]')].map(e => e.getAttribute('aria-label'))`);
            assert.deepEqual(names, ['Step 1 type', 'Step 1 name', 'Remove step 1', 'Step 1 command'], at + 'each control of a step has its own name: ' + JSON.stringify(names));
            // the Name label sits right above its field, and Steps starts within the first screen
            const gap = await ev(`(() => { const r = document.getElementById('wf-input-name').closest('.sv-row'), l = r.querySelector('.sv-label').getBoundingClientRect(), i = document.getElementById('wf-input-name').getBoundingClientRect(); return Math.round(i.top - l.bottom); })()`);
            assert.ok(gap <= 40, at + 'the field sits under its label (the allowed characters between): ' + gap);
            const stepsTop = await ev(`Math.round(document.getElementById('wf-steps-editor').getBoundingClientRect().top)`);
            assert.ok(stepsTop < h - 200, at + 'the steps start on the first screen: ' + stepsTop);
            await setTheme(ev, mobile ? 'dark' : 'light'); // the shots: 1280 light, 390 dark
            await shot(`wf-form-${w}`);
            await setTheme(ev, 'dark');

            // 2. contrast, both themes
            for (const theme of ['dark', 'light']) {
                await setTheme(ev, theme);
                const c = await auditRegion(ev, ['#wf-create-modal .modal-content']);
                assert.ok(c.checked && !c.fails.length, at + theme + ' contrast: ' + JSON.stringify(c.fails));
            }
            await setTheme(ev, 'dark');
            assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth`), true, at + 'no sideways scroll');
            if (mobile) {
                const edge = await ev(`Math.round(document.getElementById('wf-input-name').getBoundingClientRect().left)`);
                assert.ok(edge <= 28, at + 'the fields start close to the edge: ' + edge);
                const nameRow = await ev(`(() => { const n = document.querySelector('.wf-step-name-input').getBoundingClientRect(), s = document.querySelector('.wf-step-type-select').getBoundingClientRect(); return { sameRow: Math.abs(n.top - s.top) < 4, h: Math.round(n.height) }; })()`);
                assert.equal(nameRow.sameRow, false, at + "a step's name takes its own row on a phone");
                assert.ok(nameRow.h >= 44, at + "the step's name is a 44 px target: " + nameRow.h);
            }

            // 3. steps: add one, numbered; Create with a gap focuses the first invalid field, says it on the field and beside the buttons
            await ev(`(() => { for (const sel of ['.wf-step-name-input', '.wf-step-content']) { const e = document.querySelector(sel); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`); // the example step cleared: the gaps below are the ones a blank step has
            await click('.wf-add-step-btn');
            assert.deepEqual(await ev(`[...document.querySelectorAll('.wf-step-num')].map(e => e.textContent)`), ['Step 1', 'Step 2']);
            const said = () => ev(`(() => { const e = document.querySelector('#wf-form .sv-error:not([hidden])'); return { field: e ? e.textContent : '', role: e && e.getAttribute('role'), line: document.querySelector('#wf-footer .sv-status').textContent }; })()`);
            await click('#wf-modal-save');
            let say = await said();
            assert.equal(await ev(`document.activeElement.id`), 'wf-input-name', at + 'the first gap is the Name, and focus is on it');
            await setTheme(ev, mobile ? 'dark' : 'light'); await shot(`wf-form-error-${w}`); await setTheme(ev, 'dark');
            assert.equal(say.field, 'Give the workflow a name.'); assert.equal(say.role, null, at + 'the field error is described, not an alert (#8431)'); assert.equal(say.line, 'Give the workflow a name.', at + 'the line beside the buttons (role=status) says it once');
            assert.equal(await ev(`document.getElementById('wf-input-name').getAttribute('aria-invalid')`), 'true', at + 'and the field is marked');
            await type('#wf-input-name', 'nightly-build');
            await click('#wf-modal-save');
            assert.equal(await ev(`document.activeElement.classList.contains('wf-step-name-input')`), true, at + 'focus is on the step that needs a name');
            say = await said();
            assert.match(say.field, /^Steps: Step 1 needs a name\.$/, at + 'the first gap, in words (the view names the field before it)'); assert.equal(say.line, say.field);
            assert.equal(await ev(`document.activeElement.getAttribute('aria-invalid')`), 'true', at + 'the step name is marked');
            await type('.wf-step-editor-item:nth-child(1) .wf-step-name-input', 'Install');
            assert.equal(await ev(`document.querySelector('.wf-step-editor-item:nth-child(1) .wf-step-name-input').hasAttribute('aria-invalid')`), false, at + 'typing in a marked field clears its mark');
            await click('#wf-modal-save');
            assert.match((await said()).field, /^Steps: Step 1 \(Install\) needs a command\.$/, at);
            await type('.wf-step-editor-item:nth-child(1) .wf-step-content', 'npm ci');
            await type('.wf-step-editor-item:nth-child(2) .wf-step-name-input', 'Test');
            await type('.wf-step-editor-item:nth-child(2) .wf-step-content', 'npm test');

            // 4. More options: the time limit in words
            await click('#wf-more > summary');
            assert.equal(await ev(vis('#wf-input-max-dur')), true);
            assert.equal(await ev(`document.getElementById('wf-input-max-dur').value + ' ' + document.getElementById('wf-input-max-dur-unit').selectedOptions[0].textContent`), '1 hours');
            await type('#wf-input-max-dur', '25');
            const limitSays = () => ev(`(() => { const e = document.getElementById('wf-input-max-dur').closest('.sv-row').querySelector('.sv-error'); return { text: e.textContent, hidden: e.hidden }; })()`);
            assert.match((await limitSays()).text, /at most 24 hours/, at + 'over the ceiling, in words');
            await shot(`wf-form-options-${w}`);
            await type('#wf-input-max-dur', '0');
            assert.match((await limitSays()).text, /whole number of one or more/);
            await type('#wf-input-max-dur', '90');
            await ev(`(() => { const u = document.getElementById('wf-input-max-dur-unit'); u.value = '60'; u.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            assert.equal((await limitSays()).hidden, true, at + 'a good limit clears the sentence');
            await type('#wf-input-desc', 'Build and test');

            // 5. Save sends steps and the limit in seconds
            await click('#wf-modal-save');
            await waitFor(`window.__saved.length === 1`, 'the save', 8000);
            const body = await ev(`window.__saved[0]`);
            assert.equal(body.name, 'nightly-build'); assert.equal(body.max_duration_s, 5400, at + '90 minutes is 5400 seconds'); assert.equal(body.description, 'Build and test');
            assert.deepEqual(body.steps.map(s => [s.name, s.type, s.command]), [['Install', 'shell', 'npm ci'], ['Test', 'shell', 'npm test']]);

            // 6. a fresh form shows no mark from the last, More options closed again, one step
            await ev(`window.showWorkflowCreateModal(); true`);
            assert.equal(await ev(`document.getElementById('wf-more').open`), false, at + 'More options starts closed again');
            assert.equal(await ev(`document.querySelectorAll('#wf-steps-editor .wf-step-editor-item').length`), 1);
            assert.equal(await ev(`document.querySelectorAll('#wf-create-modal [aria-invalid]').length`), 0, at + 'no mark is left over');
        }
        // the Workflows page behind the dialog: with no workflow, one empty line and no count pill (the page has no header of its own, #7471)
        await ev(`document.querySelector('#wf-create-modal .modal-close-btn').click(); window.openAutomationsFolder('workflows'); true`);
        await waitFor(`!!document.querySelector('#group-table-view .empty-state-line') && document.querySelector('#group-table-view .empty-state-line').checkVisibility()`, 'the Workflows page', 8000);
        assert.equal(await ev(`document.getElementById('wf-count-badge')`), null, 'the page draws no count badge');
        console.log('PASS workflow form: Name, Steps first, the rest behind More options; errors in words');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
