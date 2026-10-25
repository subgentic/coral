// Focus goes back to a dialog's opener when it closes; when a redraw replaced the opener while the dialog was open, dialog_focus.js now looks for the element with the same id (eb1df5128, the Goals heading). This
// is page-wide, so QA's adversarial cases (#rc2 review): the successor gets focus only when it is the same kind of element and shown; an id that now belongs to a different element, a hidden one, one in a
// closed dialog, or no id at all must not get focus (the old behaviour: focus is not taken). A test dialog is built in the page and wired with attachDialogFocus like the real ones. Expects CORAL_TEST_URL +
// CDP_PORT from the runner. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const results = [];
    const scenario = async (name, fn) => { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); console.log('   FAIL ' + name + ': ' + String((e && e.message) || e).split('\n')[0].slice(0, 300)); } };
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady();
        // run(setup): builds an opener (#qa-opener, with `openerHtml`), opens a test dialog from it, runs `during` (the redraw), closes the dialog, and says what has focus.
        const run = (openerHtml, during) => ev(`(async () => {
            document.getElementById('qa-stage')?.remove();
            const stage = document.createElement('div'); stage.id = 'qa-stage'; stage.innerHTML = ${JSON.stringify(openerHtml)} + '<button id="qa-other">other</button><div id="qa-closed" class="modal" role="dialog" aria-label="closed" style="display:none"><button id="qa-in-closed">in closed</button></div><div id="qa-dlg" class="modal" role="dialog" aria-label="qa" style="display:none"><button id="qa-dlg-btn">inside</button></div>'; document.body.appendChild(stage);
            const m = await import((window.__coralStatic || '/static/') + 'dialog_focus.js');
            const opener = document.getElementById('qa-opener'); if (opener) opener.focus();
            const dlg = document.getElementById('qa-dlg'); m.attachDialogFocus(dlg);
            dlg.style.display = 'flex'; await new Promise(r => setTimeout(r, 150)); // sleep-ok: the dialog's own open focus runs in a frame and a mutation observer
            ${during}
            dlg.style.display = 'none'; await new Promise(r => setTimeout(r, 150)); // sleep-ok: the close handler runs in a mutation observer
            const a = document.activeElement; return { id: a && a.id, tag: a && a.tagName, body: a === document.body };
        })()`);
        await scenario('the replaced opener\'s successor (same id, same kind, shown) gets the focus', async () => {
            const r = await run('<button id="qa-opener">open</button>', `document.getElementById('qa-opener').replaceWith(Object.assign(document.createElement('button'), { id: 'qa-opener', textContent: 'open (redrawn)' }));`);
            assert.equal(r.id, 'qa-opener');
        });
        await scenario('an opener removed with nothing of that id back: focus is not taken (the old behaviour)', async () => {
            const r = await run('<button id="qa-opener">open</button>', `document.getElementById('qa-opener').remove();`);
            assert.ok(r.body || r.id === 'qa-dlg-btn' || r.id === '', `focus went to ${r.id}`);
            assert.notEqual(r.id, 'qa-other');
        });
        await scenario('the id now belongs to a hidden element: no focus', async () => {
            const r = await run('<button id="qa-opener">open</button>', `const o = document.getElementById('qa-opener'); const h = document.createElement('button'); h.id = 'qa-opener'; h.style.display = 'none'; o.replaceWith(h);`);
            assert.notEqual(r.id, 'qa-opener', 'a hidden element was given the focus');
        });
        await scenario('the id now belongs to an element inside a closed dialog: no focus', async () => {
            const r = await run('<button id="qa-opener">open</button>', `document.getElementById('qa-opener').remove(); document.getElementById('qa-in-closed').id = 'qa-opener';`);
            assert.notEqual(r.id, 'qa-opener', 'an element in a closed dialog was given the focus');
        });
        await scenario('an opener without an id that is removed: no focus to anywhere else', async () => {
            const r = await run('<button id="qa-opener">open</button>', `const o = document.getElementById('qa-opener'); o.removeAttribute('id'); o.remove();`);
            assert.ok(r.body || r.id === 'qa-dlg-btn' || r.id === '', `focus went to ${r.id}`);
        });
        await scenario('the id now belongs to a DIFFERENT kind of element (a text input, a link, another control): it must not get the focus', async () => {
            const r = await run('<button id="qa-opener">open</button>', `document.getElementById('qa-opener').remove(); const i = document.createElement('input'); i.id = 'qa-opener'; document.getElementById('qa-stage').appendChild(i);`);
            assert.notEqual(r.id, 'qa-opener', `an unrelated <input> that only shares the id took the focus (${r.tag})`);
        });
        await scenario('LIMIT (informational, never fails): a same-kind button that took a recycled id next to the opener is indistinguishable from the redrawn opener', async () => {
            const r = await run('<button id="qa-opener">open</button>', `document.getElementById('qa-opener').remove(); const b = document.createElement('button'); b.id = 'qa-opener'; b.textContent = 'Delete this agent'; document.getElementById('qa-other').after(b);`);
            console.log('        (observed: focus goes to ' + r.id + '; an id that is recycled for another button of the same kind cannot be told apart by the id alone)');
        });
        await scenario('a visibility:hidden successor: nothing breaks and focus does not go anywhere surprising', async () => {
            const r = await run('<button id="qa-opener">open</button>', `const o = document.getElementById('qa-opener'); const h = document.createElement('button'); h.id = 'qa-opener'; h.style.visibility = 'hidden'; o.replaceWith(h);`);
            assert.ok(r.body || r.id === 'qa-dlg-btn' || r.id === '', `focus is on ${r.id}`);
        });
        await scenario('an opener that is still in the page is unchanged: it gets the focus', async () => {
            const r = await run('<button id="qa-opener">open</button>', ``);
            assert.equal(r.id, 'qa-opener');
        });
        const bad = results.filter(r => r[1]);
        console.log(`${results.length - bad.length}/${results.length} scenarios pass`);
        if (bad.length) { console.error('FAIL: ' + bad.map(r => r[0]).join('; ')); process.exit(1); }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
