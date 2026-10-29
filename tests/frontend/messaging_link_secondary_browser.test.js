// Messaging settings (task 7884, UI/UX's follow-up to #7837): "Link a team on another Coral" is a normal secondary button (the one primary is Save settings), and "How this works" has the disclosure's arrow
// (a right arrow closed, a down arrow open) so it reads as a control. The group is drawn straight into a host with mountMessaging and a ready state. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const r = await ev(`(async () => {
            const host = document.createElement('div'); host.id = 'qa-host'; document.body.append(host);
            const m = await import(${S} + 'team_cross_team_fields.js'); m._setHubForTests(null);
            await m.mountMessaging(host, 'qa-team', { state: { status: { state: 'ready', text: 'Cross-team messaging is on for this team.' } }, settings: { cross_team_messaging: true, cross_team_artifacts: false } });
            const link = host.querySelector('.xt-primary'), sum = host.querySelector('.xt-how > summary'), how = host.querySelector('.xt-how');
            const arrow = () => getComputedStyle(sum, '::before').content;
            const closed = arrow(); how.open = true; const open = arrow();
            return { linkTag: link.tagName, linkClass: link.className, primaries: [...host.querySelectorAll('.btn-primary')].map(b => b.textContent.trim()), closed, open, listStyle: getComputedStyle(sum).listStyleType, weight: getComputedStyle(sum).fontWeight };
        })()`);
        assert.equal(r.linkTag, 'A'); assert.ok(!/btn-primary/.test(r.linkClass), 'the Link button is a secondary button: ' + r.linkClass);
        assert.deepEqual(r.primaries, ['Save settings'], 'the one primary of the group is its Save: ' + JSON.stringify(r.primaries));
        assert.ok(/▸/.test(r.closed) && /▾/.test(r.open), 'How this works has the disclosure arrow, right closed and down open: ' + JSON.stringify([r.closed, r.open]));
        assert.equal(r.listStyle, 'none', 'and the browser\'s own marker is not drawn twice');
        console.log('PASS messaging link secondary');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
