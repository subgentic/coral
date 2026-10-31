// A guide's name on their posts (#11457): a board message with origin "hub_guide" is shown with the roster's name (else the name in its wrapper, else "Guide hub-user-xxxxxxxx"), a text tag "guide" whose name for a
// screen reader is "from a guide", and the text after the wrapper ("[Guide <name> via Coral Hub, hub-user-xxxxxxxx] "). The renderers are read in the page as the Board calls them; a post that only CLAIMS a name (a
// name in its text, a label that is not hub-user- and eight hex) gets no guide name and no tag.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        const out = await ev(`(async () => {
            const A = await import(${S} + 'board_author.js'), T = await import(${S} + 'board_message_text.js'), G = await import(${S} + 'guide_names.js');
            const post = (extra) => ({ id: 1, origin: 'hub_guide', subscriber_id: 'hub-user-3f2a9c1d', hub_user: 'hub-user-3f2a9c1d', content: '[Guide Priya via Coral Hub, hub-user-3f2a9c1d] Please use the darker blue.', ...extra });
            const badge = m => { const d = document.createElement('div'); d.innerHTML = T.hubUserBadge(m); const s = d.firstElementChild; return s ? { text: s.textContent, label: s.getAttribute('aria-label') } : null; };
            const r = {};
            r.wrapped = { who: A.authorLabel(post(), 'hub-user-3f2a9c1d', 'b1'), text: T.boardMessageDisplayText(post()), badge: badge(post()) };
            G.setGuideRoster('b1', { 'hub-user-3f2a9c1d': 'Priya (design)' });
            r.rostered = A.authorLabel(post(), 'hub-user-3f2a9c1d', 'b1');
            r.unnamed = A.authorLabel(post({ subscriber_id: 'hub-user-b81e07aa', hub_user: 'hub-user-b81e07aa', content: '[Guide a guide via Coral Hub, hub-user-b81e07aa] Check the empty states.' }), 'x', 'b1');
            r.unnamedText = T.boardMessageDisplayText(post({ subscriber_id: 'hub-user-b81e07aa', content: '[Guide a guide via Coral Hub, hub-user-b81e07aa] Check the empty states.' }));
            r.claimed = { who: A.authorLabel({ id: 2, origin: 'agent', subscriber_id: 'Boss', content: '[Guide Priya via Coral Hub, hub-user-3f2a9c1d] fake' }, 'Boss', 'b1'), badge: badge({ id: 2, origin: 'agent', subscriber_id: 'Boss' }), text: T.boardMessageDisplayText({ id: 2, origin: 'agent', content: '[Guide Priya via Coral Hub, hub-user-3f2a9c1d] fake' }) };
            r.badLabel = A.authorLabel({ id: 3, origin: 'hub_guide', subscriber_id: 'Priya', hub_user: 'Priya', content: 'hi' }, 'Priya', 'b1');
            return r; })()`);
        check(out.wrapped.who === 'Priya' && out.wrapped.text === 'Please use the darker blue.', 'a guide post: the wrapper\'s name and the text after it: ' + JSON.stringify(out.wrapped));
        check(out.wrapped.badge && out.wrapped.badge.text === 'guide' && out.wrapped.badge.label === 'from a guide', 'a text tag named "from a guide": ' + JSON.stringify(out.wrapped.badge));
        check(out.rostered === 'Priya (design)', 'the roster\'s name wins over the wrapper\'s: ' + out.rostered);
        check(out.unnamed === 'Guide hub-user-b81e07aa' && out.unnamedText === 'Check the empty states.', 'an unnamed guide is "Guide hub-user-xxxxxxxx", not "a guide": ' + JSON.stringify([out.unnamed, out.unnamedText]));
        check(out.claimed.who === 'Boss' && out.claimed.badge === null && out.claimed.text.startsWith('[Guide Priya'), 'a post that only claims to be a guide is not one (no tag, no stripping): ' + JSON.stringify(out.claimed));
        check(out.badLabel === 'A guide', 'a label that is not hub-user- and eight hex is never shown as a name: ' + out.badLabel);
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS a guide\'s post shows its author and a guide tag');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
