// The Notes tab lists every note an agent has (#7653, UI Accessibility's report item 11): newest first, each with its time, the badge counts them,
// a note opens for editing in its own card and saves on blur, an emptied note is removed, and "Add a note" writes another. Real isolated server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const cards = () => ev(`[...document.querySelectorAll('#note-md-rendered .note-card:not(.note-card-editing)')].map(c => ({ time: c.querySelector('.note-card-time').textContent, title: c.querySelector('.note-card-time').title, text: c.querySelector('.note-card-body').textContent.trim() }))`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const count = () => ev(`document.getElementById('note-bar-count').textContent`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__m.add('note-bot', 'A', 3, { sleeping: false }); true`);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
        await ev(`window.selectLiveSession('note-bot', 'claude', 'note-bot-id', 'local'); true`);
        await waitFor(`!!document.getElementById('note-md-rendered')`, 'the notes panel', 8000);
        await ev(`window.switchAgenticTab('notes', 'top'); true`);
        // three notes, posted the way an agent does
        const posted = await ev(`(async () => { const out = []; for (const t of ['first note', 'second note', 'third **note**']) { const r = await fetch('/api/sessions/live/note-bot/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: t, session_id: 'note-bot-id' }) }); out.push(r.status); await new Promise(x => setTimeout(x, 1100)); /* sleep-ok: notes are ordered by their one-second timestamps, so each post is a second apart */ } return out; })()`);
        assert.deepEqual(posted, [200, 200, 200], 'three notes posted');
        const load = () => ev(`(async () => { const m = await import(${S} + 'agent_notes.js'); await m.loadAgentNotes('note-bot', 'note-bot-id'); return true; })()`);
        await load();
        await waitFor(`document.querySelectorAll('#note-md-rendered .note-card:not(.note-card-editing)').length === 3`, 'three cards', 5000);
        let c = await cards();
        assert.deepEqual(c.map(x => x.text), ['third note', 'second note', 'first note'], 'every note, newest first');
        assert.ok(c.every(x => /^(just now|\d+ min ago|today |yesterday )/.test(x.time) && /\d/.test(x.title)), 'each shows when in the page\'s words, the exact time as its title: ' + JSON.stringify(c));
        assert.equal(await ev(`document.querySelector('#note-md-rendered .note-add-small').classList.contains('btn-small')`), true, 'with notes, Add a note is the normal small button');
        assert.equal(await count(), '3', 'the badge counts them');
        console.log('   ✓ three notes listed newest first with their times, badge 3');
        await shot('notes-list');

        // edit the middle one in its own card; Escape saves (it leaves the editor)
        await ev(`document.querySelectorAll('#note-md-rendered .note-card-body')[1].click(); true`);
        await waitFor(`document.activeElement === document.getElementById('note-md-editor') && document.getElementById('note-md-editor').closest('.note-card')`, 'the editor in the card', 4000);
        assert.equal(await ev(`document.getElementById('note-md-editor').value`), 'second note');
        await ev(`(() => { const e = document.getElementById('note-md-editor'); e.value = 'second note, changed'; e.blur(); return true; })()`);
        await waitFor(`document.querySelectorAll('#note-md-rendered .note-card-body')[1].textContent.includes('changed')`, 'the card after saving', 5000);
        await load();
        assert.deepEqual((await cards()).map(x => x.text), ['third note', 'second note, changed', 'first note'], 'the change is saved, in place');
        console.log('   ✓ a note edits in its own card and saves');

        // add another
        await ev(`document.querySelector('#note-md-rendered .note-add-small').click(); true`);
        await waitFor(`document.activeElement === document.getElementById('note-md-editor')`, 'the editor for a new note', 4000);
        await ev(`(() => { const e = document.getElementById('note-md-editor'); e.value = 'fourth note'; e.blur(); return true; })()`);
        await waitFor(`document.querySelectorAll('#note-md-rendered .note-card:not(.note-card-editing)').length === 4`, 'four cards', 5000);
        assert.equal((await cards())[0].text, 'fourth note', 'the new note is first');
        assert.equal(await count(), '4');
        console.log('   ✓ Add a note puts the new one first and the badge says 4');

        // empty one: removed
        await ev(`document.querySelectorAll('#note-md-rendered .note-card-body')[3].click(); true`);
        await waitFor(`document.activeElement === document.getElementById('note-md-editor')`, 'the editor', 4000);
        await ev(`(() => { const e = document.getElementById('note-md-editor'); e.value = ''; e.blur(); return true; })()`);
        await waitFor(`document.querySelectorAll('#note-md-rendered .note-card:not(.note-card-editing)').length === 3`, 'three cards again', 5000);
        await load();
        assert.deepEqual((await cards()).map(x => x.text), ['fourth note', 'third note', 'second note, changed'], 'the emptied note is gone');
        assert.equal(await count(), '3');
        console.log('   ✓ an emptied note is removed');
        console.log('PASS agent notes list');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
