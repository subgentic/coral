// A launch whose name is an archived member's of the team (#19674): the server answers 409 name_archived with the member, its session and a free name; the page asks "An archived agent named X is on this team"
// with Start it (the wake call: its history and tasks come back, the launch answers with that session) or Use another name (the name box gets the suggestion, to edit; nothing is sent). A stub answers the routes.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup');
        await ev(`(() => { const R = window.fetch; window.__sent = [];
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname, method = (o.method || 'GET').toUpperCase();
                const wake = /^\\/api\\/sessions\\/live\\/arch-1\\/wake$/.test(p), launch = p === '/api/sessions/launch' && method === 'POST';
                if (!wake && !launch) return R(u, o);
                window.__sent.push(wake ? 'wake' : 'launch');
                if (launch) return json({ ok: false, code: 'name_archived', member: 'Helper', session_id: 'arch-1', suggested_name: 'Helper 2', error: 'an archived agent named Helper is on this team' }, 409);
                return json({ ok: true, sleeping: false }); };
            const input = document.createElement('input'); input.id = 'qa-name'; document.body.append(input);
            return true; })()`);
        const open = `document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`;
        const launch = () => ev(`window.__sent.length = 0; window.__r = 'pending'; import(${S} + 'launch_core.js').then(m => m._launchOn('local', '/api/sessions/launch', { agent_type: 'claude', working_dir: '/tmp/x', display_name: 'Helper', board_name: 'T' }, 'claude', { nameInput: document.getElementById('qa-name') })).then(v => { window.__r = v; }); true`);

        await launch();
        await waitFor(open, 'the question opens', 8000);
        assert.equal(await ev(`document.getElementById('confirm-modal-title').textContent`), 'An archived agent named Helper is on this team');
        assert.equal(await ev(`document.getElementById('confirm-modal-yes').textContent`), 'Start it');
        assert.equal(await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').textContent`), 'Use another name');
        await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
        await waitFor(`window.__r === null`, 'Use another name launches nothing', 6000);
        assert.deepEqual(await ev('window.__sent'), ['launch'], 'only the first request was sent');
        assert.equal(await ev(`document.getElementById('qa-name').value`), 'Helper 2', 'the name box has the suggestion');

        await launch();
        await waitFor(open, 'the question opens again', 8000);
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__r && window.__r.session_id === 'arch-1'`, 'Start it answers with the started member', 8000);
        assert.deepEqual(await ev('window.__sent'), ['launch', 'wake'], 'Start it is the wake call, not a second launch');
        console.log('PASS a launch named like an archived member asks: Start it wakes that member, Use another name puts the suggestion in the name box');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
