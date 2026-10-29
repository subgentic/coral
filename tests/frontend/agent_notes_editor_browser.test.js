// The Notes tab's edit box (task 7760, the operator: "the edit note box is too small"): the box is as tall as its text (about eight lines at least, most of the list at most, then it scrolls), it sits inside its
// card under the card's header and does not cover it, it is in the note's own reading font and size, and Save and Cancel are under it, on the screen. Save keeps the text, Cancel throws it away, Tab from the box
// reaches them without closing it. The same for a new note. At 1280 px and at 390 px. Real isolated server; the notes are posted the way an agent does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { scenarios } = require('./helpers/team_page');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = scenarios(); const MOD = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const LONG = Array.from({ length: 26 }, (_, i) => `Line ${i + 1} of a long note, long enough to be a real sentence about the work.`).join('\n\n');
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280 px', 1280, 900, false], ['390 px', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            const bot = 'note-bot-' + (mobile ? 'm' : 'd');
            await ev(`window.__m.add(${JSON.stringify(bot)}, 'A', 3, { sleeping: false }); true`);
            await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === ${JSON.stringify(bot)})`, 'the agent', 10000);
            await ev(`window.selectLiveSession(${JSON.stringify(bot)}, 'claude', ${JSON.stringify(bot + '-id')}, 'local'); true`);
            await waitFor(`!!document.getElementById('note-md-rendered')`, 'the notes panel', 8000);
            if (mobile) await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) { const b = document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'); if (b) b.click(); } return true; })()`);
            await ev(`window.switchAgenticTab('notes', 'top'); true`);
            const posted = await ev(`(async () => { const out = []; for (const c of ['A short note.', ${JSON.stringify(LONG)}]) { const r = await fetch('/api/sessions/live/${bot}/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: c, session_id: '${bot}-id' }) }); out.push(r.status); } return out; })()`);
            assert.deepEqual(posted, [200, 200], 'two notes posted');
            const load = () => ev(`(async () => { const m = await import(${MOD} + 'agent_notes.js'); await m.loadAgentNotes(${JSON.stringify(bot)}, ${JSON.stringify(bot + '-id')}); return true; })()`);
            await load(); await waitFor(`document.querySelectorAll('#note-md-rendered .note-card').length === 2`, 'two cards', 6000);
            const edit = async which => { await ev(`document.querySelectorAll('#note-md-rendered .note-card-body')[${which}].click(); true`); await waitFor(`document.activeElement === document.getElementById('note-md-editor')`, 'the editor', 4000); await waitFor(`document.getElementById('note-md-editor').getBoundingClientRect().height > 0`, 'the editor drawn', 3000); };
            const geo = () => ev(`(() => { const e = document.getElementById('note-md-editor'), card = e.closest('.note-card'), head = card.querySelector('.note-card-time'), bar = card.querySelector('.note-edit-actions'), list = document.getElementById('note-md-rendered');
                const r = x => x.getBoundingClientRect(), eb = r(e), hb = r(head), bb = bar && r(bar), cb = r(card), lb = r(list), line = parseFloat(getComputedStyle(e).lineHeight);
                const ec = getComputedStyle(e); return { h: Math.round(eb.height), lines: Math.round(eb.height / line), noInnerScroll: e.scrollHeight <= e.clientHeight + 1, cap: Math.round(lb.height * 0.8), headBottom: Math.round(hb.bottom), top: Math.round(eb.top), inCard: eb.left >= cb.left - 1 && eb.right <= cb.right + 1, bar: bb && { top: Math.round(bb.top), bottom: Math.round(bb.bottom), underBox: bb.top >= eb.bottom - 1, inView: bb.bottom <= innerHeight && bb.top >= 0, inCard: bb.bottom <= cb.bottom + 1 }, font: [ec.fontFamily, ec.fontSize].join(' / ') }; })()`);
            const readerFont = () => ev(`(() => { const b = document.querySelector('#note-md-rendered .note-card-body'); if (!b) return null; const p = b.querySelector('p') || b; const c = getComputedStyle(p); return [c.fontFamily, c.fontSize].join(' / '); })()`);
            await S.run(`${label}: a short note's box is about eight lines, under the header, with Save and Cancel under it`, async () => {
                const reading = await readerFont(); await edit(1); const g = await geo(); await shot(`notes-edit-short-${mobile ? 390 : 1280}`);
                assert.ok(g.lines >= 8 && g.lines <= 12, 'about eight lines: ' + JSON.stringify(g)); assert.ok(g.top >= g.headBottom - 1, 'under the header, not over it: ' + JSON.stringify(g));
                assert.deepEqual([g.bar.underBox, g.bar.inView, g.bar.inCard, g.inCard], [true, true, true, true], 'Save and Cancel under it, inside the card, on the screen: ' + JSON.stringify(g));
                assert.equal(g.font, reading, "the note's reading font and size: " + g.font + ' against ' + reading);
                await ev(`document.getElementById('note-md-editor').blur(); true`); await waitFor(`!document.querySelector('.note-card-editing')`, 'the editor to close', 4000);
            });
            await S.run(`${label}: a long note's box follows its text, up to the cap, and nothing covers the header`, async () => {
                await edit(0); // the newest note is the long one
                const g = await geo(); await shot(`notes-edit-long-${mobile ? 390 : 1280}`);
                assert.ok(g.top >= g.headBottom - 1, 'under the header: ' + JSON.stringify(g)); assert.ok(g.h >= Math.min(g.cap - 4, 300), 'tall, not three lines: ' + JSON.stringify(g));
                assert.ok(g.h <= g.cap + 2, 'no taller than most of the list: ' + JSON.stringify(g)); assert.ok(g.noInnerScroll || g.h >= g.cap - 2, 'no inner scrollbar until the cap: ' + JSON.stringify(g));
                await ev(`(() => { const e = document.getElementById('note-md-editor'); e.value = e.value + '\\n\\nmore text '.repeat(40); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                const g2 = await geo(); assert.ok(g2.h <= g2.cap + 2, 'typing more does not outgrow the cap: ' + JSON.stringify(g2));
                await ev(`document.getElementById('note-md-editor').blur(); true`); await waitFor(`!document.querySelector('.note-card-editing')`, 'the editor to close', 4000); await load();
            });
            await S.run(`${label}: Tab reaches Save and Cancel with the box open; Cancel throws the text away, Save keeps it`, async () => {
                await waitFor(`document.querySelectorAll('#note-md-rendered .note-card').length === 2`, 'the cards', 5000); await edit(1);
                await ev(`(() => { const e = document.getElementById('note-md-editor'); e.value = 'cancelled words'; e.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.note-edit-actions .btn:not(.btn-primary)').focus(); return true; })()`);
                assert.equal(await ev(`!!document.querySelector('.note-card-editing') && document.activeElement.textContent.trim()`), 'Cancel', 'focus on Cancel, the box still open');
                await ev(`document.querySelector('.note-edit-actions .btn:not(.btn-primary)').click(); true`); await waitFor(`!document.querySelector('.note-card-editing')`, 'the editor to close', 4000);
                await load(); assert.ok(!(await ev(`document.getElementById('note-md-rendered').textContent`)).includes('cancelled words'), 'Cancel kept nothing');
                await edit(1); await ev(`(() => { const e = document.getElementById('note-md-editor'); e.value = 'saved words'; e.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.note-edit-actions .btn-primary').click(); return true; })()`);
                await waitFor(`document.getElementById('note-md-rendered').textContent.includes('saved words')`, 'the saved note', 5000); await load();
                assert.ok((await ev(`document.getElementById('note-md-rendered').textContent`)).includes('saved words'), 'Save kept it, on the server too');
            });
            await S.run(`${label}: a new note is a card with a header, a box of the same size and Save and Cancel`, async () => {
                await ev(`document.querySelector('#note-md-rendered .note-add-small, #note-md-rendered .note-add').click(); true`);
                await waitFor(`document.activeElement === document.getElementById('note-md-editor') && document.getElementById('note-md-editor').closest('.note-card-editing')`, 'the new note editor', 4000);
                const g = await geo(); assert.ok(g.lines >= 8 && g.top >= g.headBottom - 1 && g.bar.underBox && g.bar.inView, JSON.stringify(g));
                await ev(`document.querySelector('.note-edit-actions .btn:not(.btn-primary)').click(); true`); await waitFor(`!document.querySelector('.note-card-editing')`, 'the new note to close', 4000);
            });
        }
    } finally { await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
