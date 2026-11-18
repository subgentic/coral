// When Start it fails in the archived-name question (#19693, Security's SHOULD on #19674): the launch answers nothing and the person is told why in a toast, with the server's reason when it gave one. (#19674: A launch whose name is an archived member's of the team): the server answers 409 name_archived with the member, its session and a free name; the page asks "An archived agent named X is on this team"
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
                return window.__wakeFail === 'throw' ? Promise.reject(new TypeError('offline')) : window.__wakeFail === 'refuse' ? json({ ok: false, error: 'no free slot to start it' }, 409) : json({ ok: true, sleeping: false }); };
            const input = document.createElement('input'); input.id = 'qa-name'; document.body.append(input);
            return true; })()`);
        const open = `document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`;
        const launch = () => ev(`window.__sent.length = 0; window.__r = 'pending'; import(${S} + 'launch_core.js').then(m => m._launchOn('local', '/api/sessions/launch', { agent_type: 'claude', working_dir: '/tmp/x', display_name: 'Helper', board_name: 'T' }, 'claude', { nameInput: document.getElementById('qa-name') })).then(v => { window.__r = v; }); true`);

        const toasts = `[...document.querySelectorAll('.toast .toast-message')].map(t => t.textContent).join(' | ')`;
        for (const [mode, want] of [['refuse', 'no free slot to start it'], ['throw', 'Failed to']]) {
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); window.__wakeFail = ${JSON.stringify(mode)}; true`);
            await launch();
            await waitFor(open, 'the question opens', 8000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__r === null`, 'a failed Start launches nothing', 6000);
            await waitFor(`(${toasts}).includes(${JSON.stringify(want)})`, `${mode}: the toast says why`, 4000);
        }
        console.log('PASS a failed Start it in the archived-name question says why in a toast and launches nothing');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
