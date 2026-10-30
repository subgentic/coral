// settings_view (#7744, step 0): the one component that draws a settings surface from a schema. A scratch host in the app's own page, a spec with every field type, then: the nav (a list, a select on
// a phone, a deep link), the rows in both modes (settings: label and help at the left, control at the right; form: label above), the tokens the rows read, dirty / save / cancel (only the changed fields
// are saved), errors per field (under the control, naming it, first invalid focused), apply 'now', read-only, a danger action with its confirmation, visible-when, a custom field, long help.
// 1280 px and 390 px with touch; isolated dev server. Every scenario is reported, not the first failure.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const SV = `import((window.__coralStatic || '/static/') + 'settings_view.js')`;
    const fresh = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
    };
    // The spec every scenario mounts: three groups, every type, load and save recorded in the page.
    const mount = (extra = '', opts = '') => ev(`(async () => {
        const { mountSettingsView } = await ${SV};
        document.getElementById('sv-host')?.remove();
        const host = document.createElement('div'); host.id = 'sv-host'; host.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:flex;background:var(--bg-primary);z-index:99999'; document.body.append(host);
        window.__saves = []; window.__applies = []; window.__ran = 0; window.__sig = { values: { name: 'alpha', days: 7, mode: 'auto', on: true, live: false, key: '', picks: ['a'], size: 'm', notes: 'n', path: '/tmp', extra: 'x' } };
        const spec = { label: 'Test settings', remember: ${opts.includes('remember') ? "'svtest'" : 'null'}, load: async () => ({ ...window.__sig.values }),
            save: async (changes) => { window.__saves.push(changes); if (window.__failNext) { const e = new Error('server said no'); if (window.__failNext === 'field') e.fields = { name: 'is taken' }; window.__failNext = null; throw e; } return {}; },
            onApply: (k, v) => window.__applies.push([k, v]), ${extra}
            groups: [
              { id: 'general', label: 'General', icon: 'tune', hint: 'The basics.', fields: [
                { key: 'name', type: 'text', label: 'Name', help: 'What it is called.', required: true, validate: v => /^[a-z]+$/.test(v) ? '' : 'use letters only.', id: 'sv-name' },
                { key: 'days', type: 'number', label: 'Keep for', unit: 'days', min: 0, help: { text: 'How long.', more: 'First paragraph.\\n\\nSecond paragraph.' } },
                { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'auto', label: 'Auto' }, { value: 'ask', label: 'Ask' }] },
                { key: 'on', type: 'toggle', label: 'Switched on', help: 'Waits for Save.' },
                { key: 'live', type: 'toggle', label: 'Live', apply: 'now' },
                { key: 'key', type: 'secret', label: 'API key' } ] },
              { id: 'agents', label: 'Agents', icon: 'smart_toy', fields: [
                { key: 'picks', type: 'multiselect', label: 'Pick some', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] },
                { key: 'size', type: 'radio', label: 'Size', options: [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }] },
                { key: 'notes', type: 'textarea', label: 'Notes', wide: true, rows: 3 },
                { key: 'path', type: 'path', label: 'Folder' },
                { key: 'extra', type: 'text', label: 'Extra', visibleWhen: v => v.on } ] },
              { id: 'more', label: 'More', icon: 'inventory_2', fields: [
                { key: 'danger', type: 'custom', label: 'Custom thing', render: (slot) => { const i = document.createElement('input'); i.id = 'sv-custom-in'; slot.append(i); return { get: () => i.value, set: v => { i.value = v ?? ''; } }; } },
                { key: 'prune', type: 'custom', label: 'Old files', help: 'Prune them.', action: { label: 'Prune', danger: true, confirm: 'Delete the old files?', run: async () => { window.__ran++; } }, render: (slot) => ({ get: () => '', set: () => {} }) } ] } ] };
        window.__v = mountSettingsView(host, spec); await window.__v.ready; return true; })()`);
    const q = js => ev(`(() => { const r = document.getElementById('sv-host'); ${js} })()`);
    const status = () => q(`return (r.querySelector('.sv-status') || {}).textContent`);
    const btn = cls => q(`const b = r.querySelector('.${cls}'); return b ? { disabled: b.disabled } : null`);
    const type = (sel, v) => ev(`(() => { const e = document.querySelector(${JSON.stringify('#sv-host ' + sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await fresh(1280, 800, false);
        await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },");

        await S.run('the nav: a list of the groups with their names; the first is open; the others are hidden panes', async () => {
            const tabs = await q(`return [...r.querySelectorAll('.settings-tabs [role=tab]')].map(t => [t.querySelector('.settings-tab-name').textContent.trim(), t.getAttribute('aria-selected')])`);
            assert.deepEqual(tabs.map(t => t[0]), ['General', 'Agents', 'More'], 'the three groups ' + JSON.stringify(tabs));
            assert.equal(tabs[0][1], 'true', 'the first is open');
            assert.deepEqual(await q(`return [...r.querySelectorAll('.settings-pane')].map(p => !p.hidden)`), [true, false, false]);
        });
        await S.run('a click and the arrow keys move between the groups; the group event fires', async () => {
            await ev(`window.__groups = []; document.getElementById('sv-host').addEventListener('sv-group', e => window.__groups.push(e.detail.id)); document.querySelectorAll('#sv-host .settings-tabs [role=tab]')[1].click(); true`); await settle(200);
            assert.equal(await q(`return r.querySelector('.settings-pane:not([hidden])').dataset.section`), 'agents', 'a click opens Agents');
            await ev(`document.querySelectorAll('#sv-host .settings-tabs [role=tab]')[1].focus(); document.querySelector('#sv-host .settings-tabs').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); true`); await settle(200);
            assert.equal(await q(`return r.querySelector('.settings-pane:not([hidden])').dataset.section`), 'more', 'ArrowDown opens More');
            assert.deepEqual(await ev(`window.__groups`), ['agents', 'more'], 'the group event named each');
            await ev(`window.__v.showGroup('general'); true`);
        });
        await S.run('a deep link: spec.group opens that group at once, and showGroup moves there', async () => {
            await mount("group: 'agents', saveBar: { save: 'Save settings', cancel: 'Cancel' },");
            assert.equal(await q(`return r.querySelector('.settings-pane:not([hidden])').dataset.section`), 'agents');
            await ev(`window.__v.showGroup('more'); true`); assert.equal(await q(`return r.querySelector('.settings-pane:not([hidden])').dataset.section`), 'more');
            await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },");
        });
        await S.run('settings mode: label and help at the left, the control at the right; help is under its label', async () => {
            const g = await q(`const row = r.querySelector('[data-key=days]'); const l = row.querySelector('.sv-label').getBoundingClientRect(), c = row.querySelector('.sv-control').getBoundingClientRect(), h = row.querySelector('.sv-help').getBoundingClientRect(); return { lr: l.right, cl: c.left, hb: h.top, lb: l.bottom, cw: Math.round(c.width) };`);
            assert.ok(g.lr <= g.cl + 1, `the label ends before the control starts ${JSON.stringify(g)}`); assert.ok(g.hb >= g.lb - 1, 'the help is under the label ' + JSON.stringify(g));
        });
        await S.run('every field type is drawn: text, number with its unit, select with its options, switch (appearance none), secret, path, textarea, radio, multiselect, custom', async () => {
            const k = await q(`const t = (key, sel) => !!r.querySelector('[data-key=' + key + '] ' + sel); const sw = r.querySelector('[data-key=on] input'); return { text: t('name', 'input[type=text]'), num: t('days', 'input[type=number]'), unit: (r.querySelector('[data-key=days] .sv-unit') || {}).textContent, opts: [...r.querySelectorAll('[data-key=mode] option')].map(o => o.textContent), sw: !!sw && getComputedStyle(sw).appearance, secret: t('key', 'input[type=password]'), path: t('path', 'input[type=text]'), ta: t('notes', 'textarea'), radios: r.querySelectorAll('[data-key=size] input[type=radio]').length, checks: r.querySelectorAll('[data-key=picks] input[type=checkbox]').length, custom: t('danger', '#sv-custom-in') };`);
            assert.deepEqual([k.text, k.num, k.unit, k.opts, k.sw, k.secret, k.path, k.ta, k.radios, k.checks, k.custom], [true, true, 'days', ['Auto', 'Ask'], 'none', true, true, true, 2, 3, true], JSON.stringify(k));
        });
        await S.run('load fills every control; the DOM id a field asks for is kept (#sv-name)', async () => {
            const v = await q(`return { name: r.querySelector('#sv-name').value, days: r.querySelector('[data-key=days] input').value, mode: r.querySelector('[data-key=mode] select').value, on: r.querySelector('[data-key=on] input').checked, size: [...r.querySelectorAll('[data-key=size] input')].find(i => i.checked).value, picks: [...r.querySelectorAll('[data-key=picks] input')].filter(i => i.checked).map(i => i.value) };`);
            assert.deepEqual(v, { name: 'alpha', days: '7', mode: 'auto', on: true, size: 'm', picks: ['a'] }, JSON.stringify(v));
        });
        await S.run('the tokens: the label is 13/500 and primary, the help 12/400 and tertiary, a control is 32 px high on a desktop', async () => {
            const t = await q(`const row = r.querySelector('[data-key=name]'); const l = getComputedStyle(row.querySelector('.sv-label')), h = getComputedStyle(row.querySelector('.sv-help')), root = getComputedStyle(document.documentElement); return { label: l.fontSize + ' ' + l.fontWeight, help: h.fontSize + ' ' + h.fontWeight, helpColor: h.color, muted: (() => { const p = document.createElement('i'); p.style.color = 'var(--text-muted)'; r.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(), labelColor: l.color, primary: (() => { const p = document.createElement('i'); p.style.color = 'var(--text-primary)'; r.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(), control: Math.round(row.querySelector('.sv-input').getBoundingClientRect().height) };`);
            assert.deepEqual([t.label, t.help, t.helpColor === t.muted, t.labelColor === t.primary, t.control], ['13px 500', '12px 400', true, true, 32], JSON.stringify(t));
        });
        await S.run('dirty, cancel: the bar says "No changes to save." and Save is off; an edit says "You have unsaved changes." and turns Save and Cancel on; Cancel puts the value back', async () => {
            assert.equal(await status(), 'No changes to save.'); assert.equal((await btn('sv-save')).disabled, true, 'Save is off'); assert.equal((await btn('sv-cancel')).disabled, true, 'Cancel is off');
            await ev(`window.__dirty = []; document.getElementById('sv-host').addEventListener('sv-dirty', e => window.__dirty.push(e.detail.dirty)); true`);
            await type('[data-key=name] input', 'beta');
            assert.equal(await status(), 'You have unsaved changes.'); assert.equal((await btn('sv-save')).disabled, false, 'Save is on'); assert.equal((await btn('sv-cancel')).disabled, false, 'Cancel is on');
            assert.deepEqual(await ev(`window.__v.dirty().size ? [...window.__v.dirty()] : []`), ['name']); assert.deepEqual(await ev(`window.__dirty`), [true], 'the event said dirty');
            await ev(`document.querySelector('#sv-host .sv-cancel').click(); true`);
            assert.equal(await q(`return r.querySelector('#sv-name').value`), 'alpha', 'Cancel put the value back'); assert.equal(await status(), 'No changes to save.'); assert.deepEqual(await ev(`window.__dirty`), [true, false]);
            await type('[data-key=name] input', 'beta'); await type('[data-key=name] input', 'alpha');
            assert.equal((await btn('sv-save')).disabled, true, 'an edit put back is not a change');
        });
        await S.run('save sends ONLY the changed fields, says "Saved.", and the saved values are the new baseline', async () => {
            await type('[data-key=name] input', 'gamma'); await ev(`document.querySelector('#sv-host [data-key=days] input').value = '9'; document.querySelector('#sv-host [data-key=days] input').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#sv-host [data-key=on] input').click(); true`);
            await ev(`document.querySelector('#sv-host .sv-save').click(); true`); await waitFor(`window.__saves.length === 1`, 'the save');
            assert.deepEqual(await ev(`window.__saves[0]`), { name: 'gamma', days: 9, on: false }, 'only the three changed fields, typed (a number is a number, a switch a boolean)');
            await waitFor(`document.querySelector('#sv-host .sv-status').textContent === 'Saved.'`, 'Saved.'); assert.equal((await btn('sv-save')).disabled, true, 'nothing is left to save');
            await type('[data-key=name] input', 'delta'); await ev(`document.querySelector('#sv-host .sv-cancel').click(); true`);
            assert.equal(await q(`return r.querySelector('#sv-name').value`), 'gamma', 'Cancel goes back to what was saved');
        });
        await S.run('errors: required and validate stop the save, show under the control naming the field, set aria-invalid and aria-describedby, focus the first invalid field and say how many; fixing clears it', async () => {
            await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },");
            await type('#sv-name', '1bad'); await ev(`document.querySelector('#sv-host .sv-save').click(); true`); await settle(250);
            assert.equal(await ev(`window.__saves.length`), 0, 'nothing was saved');
            const e = await q(`const row = r.querySelector('[data-key=name]'), er = row.querySelector('.sv-error'), c = row.querySelector('.sv-control').getBoundingClientRect(), eb = er.getBoundingClientRect(), i = row.querySelector('input'); return { text: er.textContent, hidden: er.hidden, under: eb.top >= c.bottom - 1, invalid: i.getAttribute('aria-invalid'), described: (i.getAttribute('aria-describedby') || '').split(' ').includes(er.id), focused: document.activeElement === i, status: r.querySelector('.sv-status').textContent, color: getComputedStyle(er).color };`);
            assert.ok(e.text.includes('Name') && /letters only/.test(e.text) && !e.hidden && e.under && e.invalid === 'true' && e.described && e.focused, JSON.stringify(e)); assert.equal(e.status, '1 field needs attention.');
            // one announcement (#8431): the focused field carries its error as its description and the bar's status line says it; a field's own error is not an alert on top
            assert.deepEqual(await q(`return { alerts: r.querySelectorAll('.sv-error[role=alert]').length, bar: document.querySelector('#sv-host .sv-status').getAttribute('role') + '/' + document.querySelector('#sv-host .sv-status').getAttribute('aria-live'), describes: r.querySelector('[data-key=name] input').getAttribute('aria-describedby').split(' ').includes(r.querySelector('[data-key=name] .sv-error').id) }`), { alerts: 0, bar: 'status/polite', describes: true }, 'field errors are described, the one status line announces');
            await type('#sv-name', 'good'); assert.equal(await q(`return r.querySelector('[data-key=name] .sv-error').hidden`), true, 'fixing the value clears the error'); assert.equal(await q(`return r.querySelector('#sv-name').hasAttribute('aria-invalid')`), false);
            await type('#sv-name', ''); await ev(`document.querySelector('#sv-host .sv-save').click(); true`); await settle(200);
            assert.ok(/Name.*required/i.test(await q(`return r.querySelector('[data-key=name] .sv-error').textContent`)), 'required says so');
            await ev(`window.__v.cancel(); true`);
        });
        await S.run('a save that throws shows "Could not save: <reason>" and keeps the changes; one that names a field puts the message under it and focuses it', async () => {
            await type('#sv-name', 'omega'); await ev(`window.__failNext = true; document.querySelector('#sv-host .sv-save').click(); true`); await waitFor(`/Could not save/.test(document.querySelector('#sv-host .sv-status').textContent)`, 'the failure');
            assert.equal(await status(), 'Could not save: server said no'); assert.equal((await btn('sv-save')).disabled, false, 'Save is on again');
            await ev(`window.__failNext = 'field'; document.querySelector('#sv-host .sv-save').click(); true`); await waitFor(`!document.querySelector('#sv-host [data-key=name] .sv-error').hidden`, 'the field error');
            assert.ok(/Name.*is taken/.test(await q(`return r.querySelector('[data-key=name] .sv-error').textContent`)), 'the message names the field'); assert.equal(await q(`return document.activeElement === r.querySelector('#sv-name')`), true, 'its field has the focus');
        });
        await S.run('apply now: the help says "Applies immediately.", the switch is never dirty, and onApply is called with the new value', async () => {
            await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },");
            assert.ok(/Applies immediately\./.test(await q(`return r.querySelector('[data-key=live] .sv-help').textContent`)), 'the help says it');
            await ev(`document.querySelector('#sv-host [data-key=live] input').click(); true`); assert.deepEqual(await ev(`window.__applies`), [['live', true]]); assert.equal(await status(), 'No changes to save.', 'not a change to save');
        });
        await S.run('read-only: a reason line, every control off, Save off; a per-field read-only leaves the others on', async () => {
            await mount("readOnly: 'Only the Operator on this computer can change these.', saveBar: { save: 'Save settings', cancel: 'Cancel' },");
            const a = await q(`return { lead: (r.querySelector('.sv-lead') || {}).textContent, enabled: [...r.querySelectorAll('.sv-row input, .sv-row select, .sv-row textarea')].filter(e => !e.disabled).length, save: r.querySelector('.sv-save').disabled };`);
            assert.deepEqual(a, { lead: 'Only the Operator on this computer can change these.', enabled: 0, save: true }, JSON.stringify(a));
            await mount("readOnly: k => k === 'days' ? 'Set by the team.' : false, saveBar: { save: 'Save settings', cancel: 'Cancel' },");
            const b = await q(`return { days: r.querySelector('[data-key=days] input').disabled, name: r.querySelector('#sv-name').disabled, help: r.querySelector('[data-key=days] .sv-help').textContent };`);
            assert.ok(b.days && !b.name && /Set by the team\./.test(b.help), JSON.stringify(b));
        });
        await S.run('a danger action asks in the row: Prune shows its question with Cancel; Cancel runs nothing; confirming runs it once', async () => {
            await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },"); await ev(`window.__v.showGroup('more'); true`); await settle(150);
            await ev(`document.querySelector('#sv-host [data-key=prune] .sv-action').click(); true`);
            const c = await q(`const b = r.querySelector('[data-key=prune] .sv-confirm'); return b ? { text: b.querySelector('.sv-confirm-text').textContent, role: b.getAttribute('role'), danger: !!r.querySelector('[data-key=prune] .sv-danger') } : null;`);
            assert.deepEqual(c, { text: 'Delete the old files?', role: 'group', danger: true }, JSON.stringify(c));
            await ev(`document.querySelector('#sv-host [data-key=prune] .sv-confirm-no').click(); true`); assert.equal(await ev(`window.__ran`), 0, 'Cancel ran nothing'); assert.equal(await q(`return !r.querySelector('[data-key=prune] .sv-confirm')`), true);
            await ev(`document.querySelector('#sv-host [data-key=prune] .sv-action').click(); document.querySelector('#sv-host [data-key=prune] .sv-confirm-yes').click(); true`); await waitFor(`window.__ran === 1`, 'the action ran');
        });
        await S.run('visible-when: a row shows and hides with another field; a hidden field is not in the changes', async () => {
            await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },"); await ev(`window.__v.showGroup('agents'); true`);
            assert.equal(await q(`return r.querySelector('[data-key=extra]').hidden`), false, 'shown while Switched on');
            await ev(`window.__v.showGroup('general'); document.querySelector('#sv-host [data-key=on] input').click(); true`); await ev(`window.__v.showGroup('agents'); true`);
            assert.equal(await q(`return r.querySelector('[data-key=extra]').hidden`), true, 'hidden when it is off');
            assert.deepEqual(await ev(`Object.keys(window.__v.changes())`), ['on'], 'only the switch, not the hidden field');
        });
        await S.run('a custom field takes part: its value is dirty and saved with the rest', async () => {
            await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },"); await ev(`window.__v.showGroup('more'); true`);
            await type('#sv-custom-in', 'hello'); await ev(`document.querySelector('#sv-host .sv-save').click(); true`); await waitFor(`window.__saves.length === 1`, 'the save');
            assert.deepEqual(await ev(`window.__saves[0]`), { danger: 'hello' });
        });
        await S.run('long help: Learn more opens the rest under the help (aria-expanded true, "Show less"), two paragraphs', async () => {
            await ev(`window.__v.showGroup('general'); true`);
            await ev(`document.querySelector('#sv-host [data-key=days] .sv-learn').click(); true`);
            const m = await q(`const b = r.querySelector('[data-key=days] .sv-learn'), more = r.querySelector('[data-key=days] .sv-more'); return { exp: b.getAttribute('aria-expanded'), label: b.textContent, shown: !more.hidden, paras: more.querySelectorAll('p').length, ctl: b.getAttribute('aria-controls') === more.id };`);
            assert.deepEqual(m, { exp: 'true', label: 'Show less', shown: true, paras: 2, ctl: true }, JSON.stringify(m));
        });
        await S.run('form mode: no nav and no bar; the label is above the control, "Required" is next to the label, validate({ focus }) focuses the first invalid field', async () => {
            await ev(`(async () => { const { mountSettingsView } = await ${SV}; document.getElementById('sv-host')?.remove(); const host = document.createElement('div'); host.id = 'sv-host'; host.style.cssText = 'position:fixed;left:0;top:0;width:520px;bottom:0;display:flex;background:var(--bg-primary);z-index:99999'; document.body.append(host);
                window.__v = mountSettingsView(host, { mode: 'form', load: async () => ({ title: '', prio: 'medium' }), groups: [{ id: 'f', label: '', fields: [{ key: 'title', type: 'text', label: 'Title', required: true, help: 'Short.' }, { key: 'prio', type: 'select', label: 'Priority', options: [{ value: 'medium', label: 'Medium' }] }] }] }); await window.__v.ready; return true; })()`);
            const f = await q(`const row = r.querySelector('[data-key=title]'), l = row.querySelector('.sv-label').getBoundingClientRect(), c = row.querySelector('.sv-input').getBoundingClientRect(), p = row.getBoundingClientRect(); return { nav: !!r.querySelector('.settings-nav'), bar: !!r.querySelector('.sv-bar'), above: l.bottom <= c.top + 1, full: Math.round(c.width) >= Math.round(p.width) - 2, req: (row.querySelector('.sv-required') || {}).textContent };`);
            assert.deepEqual(f, { nav: false, bar: false, above: true, full: true, req: 'Required' }, JSON.stringify(f));
            const v = await ev(`(() => { const r = window.__v.validate({ focus: true }); return { ok: r.ok, first: r.first, focused: document.activeElement && document.activeElement.name }; })()`);
            assert.deepEqual(v, { ok: false, first: 'title', focused: 'title' }, JSON.stringify(v));
        });

        // a phone: the nav is a select, the rows stack, the controls are 44 px
        await fresh(390, 844, true);
        await mount("saveBar: { save: 'Save settings', cancel: 'Cancel' },");
        await S.run('390 px with touch: the list is a select at the top, the rows stack, a control is a 44 px target, Save stays reachable', async () => {
            const p = await q(`const pick = r.querySelector('.settings-group-pick'), tabs = r.querySelector('.settings-tabs'), row = r.querySelector('[data-key=days]'), l = row.querySelector('.sv-label').getBoundingClientRect(), c = row.querySelector('.sv-input').getBoundingClientRect(), sw = r.querySelector('[data-key=on] .sv-switch-hit').getBoundingClientRect(); return { select: getComputedStyle(pick).display !== 'none', tabs: getComputedStyle(tabs).display, stacked: l.bottom <= c.top + 1 || row.querySelector('.sv-text').getBoundingClientRect().bottom <= c.top + 1, ctl: Math.round(c.height), sw: Math.round(sw.height), save: Math.round(r.querySelector('.sv-save').getBoundingClientRect().height), over: document.documentElement.scrollWidth - document.documentElement.clientWidth };`);
            assert.ok(p.select && p.tabs === 'none' && p.stacked && p.ctl >= 44 && p.sw >= 44 && p.save >= 44 && p.over <= 0, JSON.stringify(p));
            await ev(`const s = document.querySelector('#sv-host .settings-group-pick select'); s.value = 'agents'; s.dispatchEvent(new Event('change', { bubbles: true })); true`); await settle(200);
            assert.equal(await q(`return r.querySelector('.settings-pane:not([hidden])').dataset.section`), 'agents', 'the select opens a group');
        });
        await ev(`document.getElementById('sv-host')?.remove(); true`);
        S.finish();
    } finally { await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exitCode = 1; });
