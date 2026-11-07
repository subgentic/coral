// Buttons an agent put on a question, through Coral Hub (#14396, coral-hub batch-125): the Hub serves the claim and settle routes for a computer's live OWNER, so the Needs you of the Hub shows every button of a question that came from
// another computer, and each click sends exactly what the Hub accepts:
//   - claim: POST /api/remote/<computer>/api/board/<team>/asks/<id>/buttons/<id>/claim, an empty body or {}, no query string; settle: .../settle with exactly {outcome: 'done' | 'failed'};
//   - reply: claimed (the computer posts it as the Operator), the dialog closes, nothing settled; open:new-agent opens the New agent dialog ON THE QUESTION'S COMPUTER; open:task and open:artifact open that computer's task and file (not
//     this page's local one); wake reads that computer's team members and wakes the sleeping member through that computer's route, then settles done;
//   - a grantee (the computer answers a claim 403 owner_only): the buttons go away, the text box stays, and the next dialog for that computer offers none.
// The Hub (cloud mode) and two computers are the stubbed Hub world (helpers/hub_world.js); the questions and the claim answers are stubbed in the page on top of it. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld } = require('./helpers/hub_world');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HEX = 'c'.repeat(64);
const BUTTONS = [
    { id: 1, label: 'Ship tonight', action: 'reply', arg: '' },
    { id: 2, label: 'Open a new agent', action: 'open:new-agent', arg: '' },
    { id: 3, label: 'Look at the task', action: 'open:task', arg: '12' },
    { id: 4, label: 'See the file', action: 'open:artifact', arg: HEX },
    { id: 5, label: 'Wake the dev', action: 'wake', arg: 'Backend Dev' },
].map(b => ({ ...b, state: 'pending' }));

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(() => { const original = window.fetch.bind(window), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.__calls = []; window.__launch = []; window.__viewer = [];
                const ask = (id, board) => ({ board, kind: 'ask', id, asker: 'Backend Dev', text: 'Ship tonight or wait?', cut: false, at: new Date().toISOString(), buttons: ${JSON.stringify(BUTTONS)} });
                window.fetch = (url, opts = {}) => {
                    const u = new URL(String(url), location.href), m = (opts.method || 'GET').toUpperCase(), mm = u.pathname.match(/^\\/api\\/remote\\/(m1|m2)(\\/api\\/.*)$/);
                    if (!mm) return original(url, opts);
                    const server = mm[1], path = mm[2];
                    if (path === '/api/operator-asks') return json(server === 'm1' ? [ask(7, 'team-x')] : [ask(8, 'team-y')]);
                    const claim = path.match(/^\\/api\\/board\\/([^/]+)\\/asks\\/(\\d+)\\/buttons\\/(\\d+)\\/(claim|settle)$/);
                    if (claim) {
                        window.__calls.push({ server, path: u.pathname, search: u.search, method: m, body: opts.body === undefined ? '' : String(opts.body), verb: claim[4], button: Number(claim[3]) });
                        if (server === 'm2' && claim[4] === 'claim') return json({ code: 'owner_only', error: 'owner_only', message: 'Only the owner may use these buttons.' }, 403);
                        const b = ${JSON.stringify(BUTTONS)}.find(x => x.id === Number(claim[3]));
                        return json(claim[4] === 'claim' ? { ok: true, action: b.action, arg: b.arg, label: b.label } : { ok: true });
                    }
                    if (path === '/api/board/team-x/subscribers') return json([{ subscriber_id: 'Backend Dev', session_name: 'claude-hub-agent-0' }]);
                    if (/^\\/api\\/sessions\\/live\\/hub-agent-0\\/wake$/.test(path)) { window.__calls.push({ server, path: u.pathname, method: m, verb: 'wake-route' }); return json({ ok: true, sleeping: false }); }
                    if (path.includes(${JSON.stringify(HEX)})) window.__viewer.push(u.pathname);
                    return original(url, opts);
                };
                true; })()`);
            await ev(`import(${S} + 'operator_ask_dialog.js').then(() => { window.showLaunchModal = (...a) => { window.__launch.push(a); return Promise.resolve(); }; return true; })`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            const openAnswer = async who => {
                await waitFor(`[...document.querySelectorAll('button')].some(b => /^Answer the question of Backend Dev/.test(b.getAttribute('aria-label') || '') && b.getClientRects().length)`, `${at}the question's Answer button`, 15000);
                await ev(`(() => { const all = [...document.querySelectorAll('button')].filter(b => /^Answer the question of Backend Dev/.test(b.getAttribute('aria-label') || '') && b.getClientRects().length); all[${who}].click(); return true; })()`);
                await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`, `${at}the dialog opens`, 8000);
            };
            const offers = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); return { buttons: [...d.querySelectorAll('.inbox-ask-offer button')].map(b => b.textContent.trim()), box: !!d.querySelector('.inbox-ask-box'), hint: (d.querySelector('.inbox-ask-offers-hint') || {}).textContent || '', error: d.querySelector('.inbox-ask-error').textContent }; })()`);
            const clickOffer = label => ev(`(() => { const b = [...document.querySelectorAll('dialog.inbox-ask-dialog .inbox-ask-offer button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); b.click(); return true; })()`);
            const calls = () => ev(`window.__calls.map(c => ({ ...c }))`);
            const dialogGone = () => waitFor(`!document.querySelector('dialog.inbox-ask-dialog[open]')`, `${at}the dialog closes`, 8000);

            // the owner's computer (m1): every button is offered
            await openAnswer(0);
            const o = await offers();
            check(JSON.stringify(o.buttons) === JSON.stringify(BUTTONS.map(b => b.label)), `${at}the Hub offers every button the agent declared: ` + JSON.stringify(o.buttons));
            check(o.box, `${at}and the text box stays`);
            check(/run as you/.test(o.hint), `${at}and says the actions run as you: ` + JSON.stringify(o.hint));
            // reply
            await clickOffer('Ship tonight'); await dialogGone();
            let c = await calls();
            check(c.length === 1 && c[0].path === '/api/remote/m1/api/board/team-x/asks/7/buttons/1/claim' && c[0].method === 'POST' && c[0].search === '' && (c[0].body === '' || c[0].body === '{}'), `${at}a reply is claimed with the Hub's exact URL, method and body: ` + JSON.stringify(c));
            // open:new-agent: the dialog starts on the question's computer
            await ev(`window.__calls.length = 0; true`); await openAnswer(0); await clickOffer('Open a new agent'); await dialogGone();
            await waitFor(`window.__launch.length === 1`, `${at}the New agent dialog is asked for`, 5000).catch(() => {});
            check(JSON.stringify(await ev(`window.__launch[0]`)) === JSON.stringify(['m1']), `${at}the New agent dialog starts on the question's computer, m1: ` + JSON.stringify(await ev(`window.__launch`)));
            c = await calls(); check(c.length === 1 && c[0].verb === 'claim' && c[0].button === 2, `${at}opening it claims and does not settle: ` + JSON.stringify(c));
            // open:task: that computer's team, not a local one of the same name
            await ev(`window.__calls.length = 0; true`); await openAnswer(0); await clickOffer('Look at the task'); await dialogGone();
            await waitFor(`/m1/.test(decodeURIComponent(location.pathname + location.search + location.hash))`, `${at}the task opens on the question's computer`, 8000).catch(() => {});
            check(/m1/.test(decodeURIComponent(await ev(`location.pathname + location.search + location.hash`))) && /team-x/.test(decodeURIComponent(await ev(`location.pathname + location.search + location.hash`))), `${at}open:task goes to team-x on m1, not this page's own: ` + await ev(`location.pathname + location.search + location.hash`));
            // back to Needs you for the next ones
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            // open:artifact: the file is read from that computer
            await ev(`window.__calls.length = 0; window.__viewer.length = 0; true`); await openAnswer(0); await clickOffer('See the file'); await dialogGone();
            await waitFor(`window.__viewer.length > 0`, `${at}the file is asked for`, 8000).catch(() => {});
            check((await ev(`window.__viewer`)).every(p => p.startsWith('/api/remote/m1/')) && (await ev(`window.__viewer.length`)) > 0, `${at}open:artifact reads the file through m1: ` + JSON.stringify(await ev(`window.__viewer`)));
            await ev(`document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch {} }); true`);
            // wake: that computer's members, its sleeping member, then settled done
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'state.js').then(({ state }) => { const s = (state.liveSessions || []).find(x => x.session_id === 'hub-agent-0'); if (s) { s.sleeping = true; s.server = 'm1'; } return true; })`);
            await ev(`window.__calls.length = 0; true`); await openAnswer(0); await clickOffer('Wake the dev'); await dialogGone();
            await waitFor(`window.__calls.some(x => x.verb === 'settle')`, `${at}the wake is settled`, 8000).catch(() => {});
            c = await calls();
            check(c.some(x => x.verb === 'wake-route' && x.server === 'm1' && x.path === '/api/remote/m1/api/sessions/live/hub-agent-0/wake'), `${at}wake goes to that computer's route: ` + JSON.stringify(c));
            const settle = c.find(x => x.verb === 'settle');
            check(!!settle && settle.path === '/api/remote/m1/api/board/team-x/asks/7/buttons/5/settle' && settle.search === '' && settle.body === JSON.stringify({ outcome: 'done' }), `${at}and is settled with exactly {outcome: done}: ` + JSON.stringify(settle));

            // a grantee's computer (m2): the claim is refused owner_only; the buttons are taken away and the text box stays
            await ev(`window.__calls.length = 0; true`); await openAnswer(1);
            const g0 = await offers();
            check(g0.buttons.length === 5, `${at}m2's question first offers its buttons (nothing says yet this person is a grantee there): ` + JSON.stringify(g0.buttons));
            await clickOffer('Ship tonight');
            await waitFor(`!document.querySelector('dialog.inbox-ask-dialog .inbox-ask-offer') && /owner/i.test(document.querySelector('dialog.inbox-ask-dialog .inbox-ask-error').textContent)`, `${at}the refused claim takes the buttons away and says why`, 8000).catch(() => {});
            const g1 = await offers();
            check(g1.buttons.length === 0 && g1.box && /owner/i.test(g1.error), `${at}after the refusal: no buttons, the text box stays, the owner is named: ` + JSON.stringify(g1));
            await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); if (d) { d.close(); d.remove(); } return true; })()`);
            await openAnswer(1);
            check((await offers()).buttons.length === 0, `${at}the next dialog for that computer offers none`);
            await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'); if (d) { d.close(); d.remove(); } return true; })()`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS through Coral Hub the owner gets every button with the exact claim and settle calls, a grantee gets none, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
