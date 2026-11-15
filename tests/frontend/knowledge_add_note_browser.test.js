// #17485 (walk 70, finding 6): the Knowledge tab lets a person add a note by hand, and says what Distill does and costs before it runs. "Add note" sits beside "Distill knowledge" (also on a team with no knowledge yet);
// it opens a form in the right pane (a title and the text; Cancel and Save in the pane's bar; Escape asks once when something was typed); Save writes the note (POST /api/teams/detail/<team>/knowledge) and opens it, and its
// row says "Added by hand"; a title that is taken says so. The form is a lazy module: the page does not load it until the button is pressed. The knowledge routes are stubbed in the page. Isolated dev server; drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-note-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = (bundle) => ev(`(() => { window.__bundle = ${JSON.stringify(bundle)}; window.__posts = []; const R = window.fetch.bind(window);
        const j = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = String((o && o.method) || 'GET').toUpperCase();
            if (/\\/api\\/teams\\/detail\\/[^/]+\\/knowledge$/.test(url.pathname)) {
                if (m === 'GET') return j(window.__bundle);
                if (m === 'POST') { const b = JSON.parse(o.body); window.__posts.push(b); const slug = 'note-' + b.title.toLowerCase().replace(/ /g, '-');
                    if ((window.__bundle.agents || []).some(a => a.name === slug)) return j({ error: 'a note with this title already exists' }, 409);
                    window.__bundle = Object.assign({ exists: true, team_name: '${TEAM}', created_at: '2026-11-15T10:00:00Z', index: 'Notes added by hand.' }, window.__bundle, { exists: true });
                    window.__bundle.agents = (window.__bundle.agents || []).concat([{ name: slug, content: '---\\ntype: note\\ntitle: "' + b.title + '"\\n---\\n\\n' + b.text + '\\n' }]);
                    return j({ ok: true, name: slug, redacted: false }, 201); } }
            return R(u, o); };
        return true; })()`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await settle(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (bundle) => {
        await Emulation.setDeviceMetricsOverride({ width: 1600, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM); await stub(bundle);
        await openTeam(ev, waitFor, TEAM).catch(() => {});
        await goTab(ev, settle, 'Knowledge');
        await waitFor(`!!document.querySelector('.team-knowledge-body .team-distill')`, 'the Knowledge tab', 10000);
    };
    const status = () => ev(`(() => { const s = document.querySelector('#detail-pane .detail-foot .detail-status'); return s ? s.textContent : ''; })()`);
    const footButtons = () => ev(`[...document.querySelectorAll('#detail-pane .detail-foot button')].map(b => b.textContent)`);
    const click = (label) => ev(`(() => { const b = [...document.querySelectorAll('#detail-pane .detail-foot button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    const type = (sel, v) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const esc = () => client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }));
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open({ exists: true, team_name: TEAM, created_at: '2026-11-14T05:00:00Z', index: '# Index\n\nThe team.', agents: [{ name: 'Backend Dev', content: 'Backend knowledge text.' }] });
        await S.run('Add note sits beside Distill knowledge, and a line says what Distill does and costs before it runs', async () => {
            const d = await ev(`(() => { const bar = document.querySelector('.team-knowledge-body .team-toolbar-row'); const b = [...bar.querySelectorAll('button')].map(x => x.textContent); const hint = document.querySelector('.team-distill-hint'); const a = bar.querySelector('.team-add-note').getBoundingClientRect(), t = bar.querySelector('.team-distill').getBoundingClientRect();
                return { b, hint: hint ? hint.textContent : '', gap: Math.round(t.left - a.right), m: [getComputedStyle(bar.querySelector('.team-add-note')).marginLeft, getComputedStyle(bar.querySelector('.team-distill')).marginLeft, bar.querySelector('.team-add-note').nextElementSibling === bar.querySelector('.team-distill'), getComputedStyle(bar).columnGap, bar.className], sameRow: Math.abs(a.top - t.top) < 4, loaded: performance.getEntriesByType('resource').some(r => /team_knowledge_note\\.js/.test(r.name)) }; })()`);
            assert.deepEqual(d.b, ['Add note', 'Distill knowledge']); assert.ok(d.sameRow && d.gap >= 4 && d.gap <= 48, JSON.stringify({ gap: d.gap, sameRow: d.sameRow, m: d.m }));
            assert.ok(/two model calls per agent and one for the team/.test(d.hint) && /rewrites each agent.s notes, edits included/.test(d.hint) && /Notes you add are kept/.test(d.hint) && /Claude plan/.test(d.hint), d.hint);
            assert.equal(d.loaded, false, 'the form is not loaded until the button is pressed');
            await shot('knowledge-add-note-bar');
        });
        await S.run('Add note opens the form in the pane: title and text, Cancel and Save in the bar, the title focused; nothing is sent without a title or text', async () => {
            await ev(`document.querySelector('.team-add-note').click(); true`);
            await waitFor(`!!document.querySelector('#detail-pane .knowledge-note-form')`, 'the form', 8000);
            assert.deepEqual(await footButtons(), ['Cancel', 'Save note']);
            assert.equal(await ev(`document.activeElement && document.activeElement.getAttribute('aria-label')`), 'Note title', 'the focus starts in the title');
            assert.equal(await ev(`window.__tp.pane().querySelector('.detail-title').textContent`), 'New note');
            await click('Save note'); await settle(150);
            assert.equal(await status(), 'Give the note a title.'); assert.equal(await ev(`window.__posts.length`), 0);
            await type('input[aria-label="Note title"]', 'Release rules'); await click('Save note'); await settle(150);
            assert.equal(await status(), 'Write the note’s text.'); assert.equal(await ev(`window.__posts.length`), 0);
            await shot('knowledge-add-note-form');
        });
        await S.run('Escape asks once before throwing typed text away; Keep writing returns to the form', async () => {
            await type('textarea[aria-label="Note text"]', 'Tag on green.'); await esc(); await settle(150);
            assert.deepEqual(await footButtons(), ['Keep writing', 'Discard']);
            await click('Keep writing'); await settle(100);
            assert.deepEqual(await footButtons(), ['Cancel', 'Save note']);
            assert.equal(await ev(`document.querySelector('textarea[aria-label="Note text"]').value`), 'Tag on green.', 'the text is kept');
        });
        await S.run('Save writes the note and opens it; its row says "Added by hand" and the title is its name', async () => {
            await click('Save note');
            await waitFor(`!!document.querySelector('#detail-pane .knowledge-text, #detail-pane .knowledge-md') && /Release rules/.test(window.__tp.pane().querySelector('.detail-title').textContent)`, 'the saved note open', 8000);
            assert.deepEqual(await ev(`window.__posts`), [{ title: 'Release rules', text: 'Tag on green.' }]);
            assert.ok(/Tag on green\./.test(await ev(`window.__tp.pane().innerText`)));
            const rows = await ev(`window.__tp.rows()`);
            assert.ok(rows.some(r => /^Release rules\b.*Added by hand/.test(r)), JSON.stringify(rows));
            assert.ok(rows.some(r => /^Backend Dev\b.*Backend Dev's sessions/.test(r)), 'the agent row is as it was: ' + JSON.stringify(rows));
            await shot('knowledge-add-note-saved');
        });
        await S.run('a title that is taken says so and keeps the text', async () => {
            await ev(`document.querySelector('#detail-pane .detail-close').click(); true`); await settle(200);
            await ev(`document.querySelector('.team-add-note').click(); true`);
            await waitFor(`!!document.querySelector('#detail-pane .knowledge-note-form')`, 'the form', 8000);
            await type('input[aria-label="Note title"]', 'release rules'); await type('textarea[aria-label="Note text"]', 'Second.');
            await click('Save note');
            await waitFor(`/already exists/.test(document.querySelector('#detail-pane .detail-foot .detail-status').textContent)`, 'the refusal', 8000);
            assert.equal(await ev(`document.querySelector('textarea[aria-label="Note text"]').value`), 'Second.');
            assert.deepEqual(await footButtons(), ['Cancel', 'Save note'], 'the buttons are back so it can be changed');
        });
        await S.run('a team with no knowledge yet offers Add note beside Distill knowledge', async () => {
            await open({ exists: false });
            const d = await ev(`({ line: document.querySelector('.team-knowledge-body .empty-state-line').textContent, hint: document.querySelector('.team-knowledge-body .empty-state-hint').textContent, b: [...document.querySelectorAll('.team-knowledge-body .team-toolbar-row button')].map(x => x.textContent) })`);
            assert.equal(d.line, 'No knowledge yet.'); assert.ok(/Add note writes one by hand/.test(d.hint), d.hint); assert.deepEqual(d.b, ['Add note', 'Distill knowledge']);
            await ev(`document.querySelector('.team-add-note').click(); true`);
            await waitFor(`!!document.querySelector('#detail-pane .knowledge-note-form')`, 'the form', 8000);
            await type('input[aria-label="Note title"]', 'First'); await type('textarea[aria-label="Note text"]', 'The first note.'); await click('Save note');
            await waitFor(`/First/.test((window.__tp.pane() || document.body).innerText) && window.__tp.rows() && window.__tp.rows().some(r => /^First\\b.*Added by hand/.test(r))`, 'the first note in the table', 8000);
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
