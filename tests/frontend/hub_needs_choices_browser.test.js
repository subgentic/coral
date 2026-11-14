// #15010 (2), from #14780: through the Hub a Needs you question shows its choices as buttons with names (not unlabeled icons): a Yes/No question reads Yes and No, a question with its own choices reads
// them, and one press answers through the computer's route (/api/remote/<computer>/api/sessions/live/<id>/answer-prompt). The Hub's feed carries the waiting agent of a computer; the card is read through it.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');
const CASES = [
    ['Yes/No', 'Run the migration?', [{ n: 1, label: 'Yes', action: 'select' }, { n: 2, label: 'No', action: 'select' }], ['Yes', 'No']],
    ['custom choices', 'Pick a color:', [{ n: 1, label: 'Red', action: 'select' }, { n: 2, label: 'Blue', action: 'select' }, { n: 3, label: 'Always pick Red from now on', action: 'select' }], ['Red', 'Blue']],
];
(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            for (const [name, question, options, shown] of CASES) {
                const at = `${w} ${name}: `;
                await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, hubFeed: true, inbox: 'native', needs: 'native' });
                await Page.addScriptToEvaluateOnNewDocument({ source: `(() => {
                    window.__answers = []; window.__hubSessionPatch = s => s.session_id === 'hub-agent-2' ? { ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to know: ${question.replace(/'/g, '')}', waiting_since: new Date(Date.now() - 60000).toISOString() } : s;
                    const real = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
                    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), p = url.pathname, m = (o.method || 'GET').toUpperCase();
                        if (m !== 'GET') (window.__posts = window.__posts || []).push(m + ' ' + p + ' ' + String(o.body || '').slice(0, 120));
                        if (m === 'POST' && /\\/api\\/sessions\\/live\\/[^/]+\\/answer-prompt$/.test(p)) { window.__answers.push({ path: p, body: JSON.parse(o.body) }); return json({ ok: true }); }
                        if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat$/.test(p)) return json({ messages: [], total: 0, prompt_options: { question: ${JSON.stringify(question)}, ask_id: 'ask-1', multi: false, options: ${JSON.stringify(options)} } });
                        return real(u, o); };
                })()` });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'settings');
                if (mobile) { await ev(`document.getElementById('nav-select').click(); true`); await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, at + 'Inbox in the view dropdown', 8000); await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`); }
                else await ev(`window.switchNavTab('hub-inbox'); true`);
                await ev(`import(${S}+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
                try { await waitFor(`document.querySelectorAll('#group-table-view .inbox-answer').length === ${shown.length}`, at + 'the choices are buttons on the row', 15000); }
                catch (e) { throw new Error(e.message + ' :: ' + await ev(`JSON.stringify({ group: (document.getElementById('group-table-view') || {}).dataset, rows: [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].map(r => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)), buttons: [...document.querySelectorAll('#group-table-view tbody button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 60)), chatReads: (window.__chatReads || 0), iframe: !!document.querySelector('#group-table-view iframe'), live: (window.__qaState || {}).liveSessions ? 1 : 0 })`)); }
                const names = await ev(`[...document.querySelectorAll('#group-table-view .inbox-answer')].map(b => ({ text: b.textContent.trim(), name: (b.getAttribute('aria-label') || b.textContent).trim() }))`);
                assert.deepEqual(names.map(b => b.text), shown, at + 'each button carries its own words, not an icon');
                for (const b of names) assert.ok(b.name.length > 0 && !/^[\W_]*$/.test(b.name), at + 'a name a person and a screen reader can read: ' + JSON.stringify(b));
                await ev(`new Promise(r => setTimeout(r, 900))`); // sleep-ok: a permission's Yes ignores a press for its first 400 ms (the arm hold, #14302)
                await ev(`document.querySelector('#group-table-view .inbox-answer').click(); true`);
                try { await waitFor(`window.__answers.length === 1`, at + 'one press answers', 10000); }
                catch (e) { throw new Error(e.message + ' :: posts ' + await ev(`JSON.stringify(window.__posts || [])`) + ' :: row ' + await ev(`(document.querySelector('#group-table-view tbody tr:not(.dt-group)') || {}).textContent`)); }
                const sent = await ev(`window.__answers[0]`);
                assert.match(sent.path, /^\/api\/remote\/m2\/api\/sessions\/live\/hub-agent-2\/answer-prompt$/, at + 'through the computer, not the Hub itself: ' + sent.path);
                assert.equal(sent.body.label, shown[0], at + 'the label sent is the button\'s');
                console.log(`   ✓ ${at}${shown.join(' / ')}`);
            }
        }
        // a view-only computer (Laptop, m1): no buttons, and the row says why
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} view-only: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, hubFeed: true, inbox: 'native', needs: 'native' });
            await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { window.__hubSessionPatch = s => s.session_id === 'hub-agent-0' ? { ...s, waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to know: Run the migration', waiting_since: new Date(Date.now() - 60000).toISOString() } : s; })()` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await coralReady(ev, 'startup', 'liveList', 'settings');
            if (mobile) { await ev(`document.getElementById('nav-select').click(); true`); await waitFor(`!!document.querySelector('#nav-more-menu [data-arg="hub-inbox"]')`, at + 'Inbox in the view dropdown', 8000); await ev(`document.querySelector('#nav-more-menu [data-arg="hub-inbox"]').click(); true`); }
            else await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S}+'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .inbox-answer-why')`, at + 'the row says why it has no buttons', 15000);
            assert.equal(await ev(`document.querySelectorAll('#group-table-view .inbox-answer').length`), 0, at + 'no answer buttons');
            assert.equal(await ev(`document.querySelector('#group-table-view .inbox-answer-why').textContent`), 'View only through Coral Hub', at + 'the words');
            assert.match(await ev(`document.querySelector('#group-table-view .inbox-answer-why').title`), /Blocked|View|Interact/, at + 'the full reason is its title');
            console.log(`   ✓ ${at}no buttons, and the row says why`);
        }
        console.log('PASS a Hub-mode Needs you question shows named choices and answers through the computer');
    } finally { try { client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exitCode = 1; });
