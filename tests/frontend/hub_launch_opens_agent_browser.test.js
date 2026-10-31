// (#11463 F12, coral-hub's first-time-user walk) A launch from the Coral Hub on a connected computer opened nothing: the person was left on the list with a toast to find the new row. The new agent opens now, on
// the computer it was launched on: _openLaunched selects it with that server (the local launch's call is unchanged), and Launch calls it for every launch that is not "Add agent to a team". The call is read
// from the page's own module and run through its seam. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        const src = fs.readFileSync(path.join(__dirname, '../../coral-go/pkg/frontend/static/launch_dialog.js'), 'utf8');
        assert.match(src, /if \(!added\) \{[^}]*_openLaunched\(result, type, opener, \{ server \}\)/s, 'Launch opens the new agent on the computer it was launched on, local or through the Hub');
        assert.doesNotMatch(src, /normServer\(server\) === LOCAL_SERVER && !added\) \{\s*_openLaunched/, 'it is not only for a local launch');
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        const calls = JSON.parse(await ev(`import(${S} + 'launch_dialog.js').then(async m => {
            const calls = []; const sel = async (...a) => { calls.push(a); };
            const r = { session_name: 'crew-1', session_id: 'abc123' };
            const a = await m._openLaunched(r, 'claude', null, { select: sel, server: 'box-b' });
            const b = await m._openLaunched(r, 'claude', null, { select: sel });
            return JSON.stringify({ calls, a, b });
        })`));
        assert.deepEqual(calls.calls, [['crew-1', 'claude', 'abc123', 'box-b'], ['crew-1', 'claude', 'abc123', 'local']], 'the Hub launch selects the new agent on its computer; a local one is as before');
        assert.equal(calls.a, true); assert.equal(calls.b, true);
        console.log('PASS a launch from the Hub opens the new agent on its computer');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
