// Needs you through Coral Hub, the coral-hub beta (#14419, v2.0.58):
//   - a phone's rows have no Dismiss of their own (the card is one tap), so the question's dialog must have it: through the Hub the owner's dialog shows Dismiss and sends exactly the close route's call
//     (POST /api/remote/<computer>/api/board/<team>/asks/<id>/close, {note}); a grantee's refusal (403 owner_only) takes Dismiss away and says why;
//   - the Yes/No dialog's two buttons say Yes and No in words beside their check and cross (they were icons alone), each still a 44 px target, nothing overflowing;
//   - a file row's name and its question line do not touch on a phone card (at least 4 px apart).
// The Hub (cloud mode) with two computers is the stubbed Hub world (helpers/hub_world.js); the questions, the file and the close answers are stubbed on top. 1280 and 390 px.
const assert = require('node:assert/strict');
const { touchTap } = require('./helpers/touch_tap');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld } = require('./helpers/hub_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
            const at = `${w}: `;
            const snap = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; await ev(`new Promise(r => setTimeout(r, 700))`); /* sleep-ok: a synthesized touch leaves its tap highlight on screen for a moment; the picture waits for it to fade */ fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/hub-dialog-${name}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(() => { const original = window.fetch.bind(window), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.__closes = [];
                const ask = (id, board, text, buttons) => ({ board, kind: 'ask', id, asker: 'Head of Security Review', text, cut: false, at: new Date().toISOString(), buttons });
                const YN = [{ id: 1, label: 'Yes', action: 'reply', arg: '', state: 'pending' }, { id: 2, label: 'No', action: 'reply', arg: '', state: 'pending' }];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href), mm = u.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/); if (!mm) return original(url, opts);
                    const server = mm[1], path = mm[2];
                    if (path === '/api/operator-asks') return json(server === 'm1' ? [ask(7, 'team-x', 'Approve the search index migration tonight?', YN), ask(8, 'team-x', '@Operator Ship batch-120 tonight, or wait for the next window?', [])] : [ask(9, 'team-y', 'Is the sandbox ready for the beta?', [])]);
                    if (path === '/api/team-artifacts' && server === 'm1') return json(window.__reviewFixturePage(u, location.href, { 'team-x': [{ id: 'a'.repeat(64), uri: 'coral://artifacts/' + 'a'.repeat(64), name: 'deploy-with-the-phone-inbox-needs-you-rows-that-wrap-onto-two-lines.md', produced_by: 'Developer', session_id: 's1', available: true, tags: ['for review'], review_question: 'Is this plan ready for the phone inbox?', created_at: new Date().toISOString(), goal_id: 1, goal_title: 'Phone inbox', version: 1, opened_version: 0, new_comments: 0 }] }));
                    const close = path.match(/^\\/api\\/board\\/([^/]+)\\/asks\\/(\\d+)\\/close$/);
                    if (close) { window.__closes.push({ server, path: u.pathname, search: u.search, method: (opts.method || 'GET').toUpperCase(), body: opts.body === undefined ? '' : String(opts.body) });
                        return server === 'm2' ? json({ code: 'owner_only', error: 'owner_only', message: 'Only the owner may do this.' }, 403) : json({ ok: true }); }
                    return original(url, opts); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 4`, `${at}the rows`, 15000);

            // a file row's name and question line (a phone card)
            const gap = await ev(`(() => { const row = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].find(r => r.querySelector('[data-review-artifact]')); if (!row) return null; const nm = row.querySelector('.inbox-review-name'), q = row.querySelector('.inbox-file-question'); if (!nm || !q) return { missing: true }; return { gap: Math.round(q.getBoundingClientRect().top - nm.getBoundingClientRect().bottom), nameTop: Math.round(nm.getBoundingClientRect().top) }; })()`);
            check(gap && !gap.missing && (w > 760 || gap.gap >= 4), `${at}a file row's name and its question line are not touching: ` + JSON.stringify(gap));
            await snap('rows');

            // a person opens the question the way the screen offers it: a touch tap on the visible card at 390, a mouse click on the visible Answer button at 1280 (never a script's click on a button that is off-screen)
            const tapAt = async (x, y) => { if (mobile) await touchTap(client, { x, y }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); } };
            const openRow = async text => {
                const target = await ev(`(() => { const row = [...document.querySelectorAll('#group-table-view tbody tr.dt-row')].find(r => ${JSON.stringify(text)} && r.textContent.includes(${JSON.stringify(text)})); if (!row) return null; row.scrollIntoView({ block: 'center' });
                    const el = ${mobile} ? row.querySelector('.inbox-review-name') || row : [...row.querySelectorAll('button')].find(b => /^Answer the question of/.test(b.getAttribute('aria-label') || '')); if (!el) return null; const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
                    return { x, y, visible: r.width > 0 && r.right <= innerWidth && r.left >= 0 && r.bottom <= innerHeight && r.top >= 0, hit: !!hit && (el === hit || el.contains(hit) || hit.contains(el) || row.contains(hit)) }; })()`);
                check(!!target && target.visible && target.hit, `${at}the card or button a person taps for "${text}" is on screen and the topmost element at its centre: ` + JSON.stringify(target));
                await tapAt(target.x, target.y);
                await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, `${at}the dialog opens from a real ${mobile ? 'tap' : 'click'}`, 8000);
            };
            const foot = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); const vis = e => !!e && !e.hidden && e.getClientRects().length > 0; const dm = [...d.querySelectorAll('.inbox-ask-buttons button')].find(b => b.textContent.trim() === 'Dismiss'); const yn = [...d.querySelectorAll('.inbox-ask-yes-no .inbox-ask-offer button')].map(b => { const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, top = document.elementFromPoint(cx, cy); let inside = true, scrolled = false; for (let a = b.parentElement; a && a !== d.parentElement; a = a.parentElement) { const ar = a.getBoundingClientRect(); if (ar.width > 0 && (r.left < ar.left - 0.5 || r.right > ar.right + 0.5)) inside = false; if (a.scrollWidth - a.clientWidth > 1 && getComputedStyle(a).overflowX !== 'visible') scrolled = true; if (a === d) break; } return { text: b.textContent.replace(/\\s+/g, ' ').trim(), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), inside, scrolled, hit: top === b || b.contains(top) }; });
            return { dismiss: vis(dm), dismissBox: dm ? Math.round(dm.getBoundingClientRect().height) : 0, yn, error: d.querySelector('.inbox-ask-error').textContent, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, dlgRight: Math.round(d.getBoundingClientRect().right), vw: innerWidth }; })()`);

            // the Yes/No question (m1, id 7): words on the buttons, and Dismiss through the Hub
            await openRow('Approve the search index migration');
            const f = await foot();
            check(f.yn.length === 2 && /Yes/.test(f.yn[0].text) && /No/.test(f.yn[1].text), `${at}the Yes/No buttons say Yes and No in words: ` + JSON.stringify(f.yn));
            check(f.yn.every(b => b.h >= 44 && b.w >= 44), `${at}and each is a 44 px target: ` + JSON.stringify(f.yn));
            check(f.overflowX === 0 && f.yn.every(b => b.right <= f.vw), `${at}and nothing is pushed off the screen: ` + JSON.stringify([f.overflowX, f.vw]));
            check(f.yn.length === 2 && f.yn.every(b => b.inside && b.hit), `${at}both Yes and No are fully inside every box that holds them up to the dialog, and hit-testable: ` + JSON.stringify(f.yn));
            check(f.yn.every(b => !b.scrolled), `${at}and none of those boxes scrolls sideways: ` + JSON.stringify(f.yn));
            check(f.dismiss && f.dismissBox >= 36, `${at}through the Hub the owner's dialog has Dismiss: ` + JSON.stringify(f));
            await snap('yes-no');
            await ev(`window.__closes.length = 0; [...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-buttons button')].find(b => b.textContent.trim() === 'Dismiss').click(); true`);
            await waitFor(`window.__closes.length === 1`, `${at}Dismiss sends the close call`, 8000).catch(() => {});
            const c = await ev(`window.__closes`);
            check(c.length === 1 && c[0].path === '/api/remote/m1/api/board/team-x/asks/7/close' && c[0].method === 'POST' && c[0].search === '' && c[0].body === JSON.stringify({ note: 'Dismissed by the operator' }), `${at}the close call is the Hub's: ` + JSON.stringify(c));
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, `${at}the dialog closes after Dismiss`, 8000).catch(() => {});

            // a grantee's computer (m2): Dismiss is refused owner_only; it goes away and says why
            await ev(`window.__closes.length = 0; true`);
            await openRow('Is the sandbox ready');
            check((await foot()).dismiss, `${at}m2's dialog offers Dismiss until it says no`);
            await ev(`[...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-buttons button')].find(b => b.textContent.trim() === 'Dismiss').click(); true`);
            await waitFor(`/owner/i.test(document.querySelector('dialog.inbox-ask-dialog .inbox-ask-error').textContent)`, `${at}the refusal is told`, 8000).catch(() => {});
            const g = await foot();
            check(!g.dismiss && /owner/i.test(g.error), `${at}after the refusal Dismiss is gone and the owner is named: ` + JSON.stringify(g));
            await snap('refused');
            await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); if (d) { d.close(); d.remove(); } return true; })()`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS through Coral Hub: Dismiss in the dialog for the owner, Yes and No in words, a phone card with room between name and question, at 390 and 1280');
})().catch(e => { console.error(e); process.exit(1); });
