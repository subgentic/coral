// A new goal's pictures against the REAL isolated server (#11650 + #11653): the New goal form's picker and Create meeting the real goal-images route, the goal store and the goal page. A team with an agent session
// is made through the board API; a picture goes through the form's real file input and is stored on the team; Create names it in `images`; the goal reads back with it through the API, the page draws it under the
// Description from the artifact URL, and it is still there after a reload. The route's refusals (the bytes decide the type, text as a picture, a team with no agent, a picture another team's goal did not get) are
// checked directly. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { sqliteText } = require('./helpers/sqlite.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA = process.env.CORAL_TEST_DATA_DIR || '';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'gir-' + Date.now().toString(36);
    const EMPTY = 'gie-' + Date.now().toString(36);
    const SID = 'a1b2c3d4-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const rawUpload = (team, b64, type) => ev(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0)); const r = await fetch('/api/board/${team}/goal-images', { method: 'POST', headers: { 'Content-Type': ${JSON.stringify(type)} }, body: bytes }); return { status: r.status, body: await r.json().catch(() => ({})) }; })()`);
    try {
        assert.ok(DATA, 'run under run_cdp_suites.mjs (CORAL_TEST_DATA_DIR names the isolated server\'s folder)');
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
        await load('/');
        // a team with an agent (a session of its own) and one with none
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'claude-' + SID })).status < 300);
        assert.ok((await api('POST', `/api/board/${EMPTY}/subscribe`, { subscriber_id: 'lead', job_title: 'Orchestrator' })).status < 300);

        await load(`/team/${B}/goals`);
        await waitFor(`!!document.querySelector('#team-panel-goals .goals-new')`, 'the New goal button', 15000);
        await ev(`document.querySelector('#team-panel-goals .goals-new').click(); true`);
        await waitFor(`!!document.querySelector('.goals-dialog #goal-new-title') && !!document.querySelector('.goals-dialog .ac-picker input')`, 'the form with its picture button', 8000);
        await ev(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'sketch.png', { type: 'image/png' })); const i = document.querySelector('.goals-dialog .ac-picker input'); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`);
        await waitFor(`document.querySelectorAll('.goals-dialog .ac-thumb-img').length === 1 && document.querySelectorAll('.goals-dialog .ac-thumb-uploading').length === 0`, 'the stored thumbnail', 8000);
        check('the real goal-images route took the picture: no failed thumbnail', (await ev(`document.querySelectorAll('.goals-dialog .ac-thumb-failed').length`)) === 0);
        await ev(`(() => { const t = document.querySelector('.goals-dialog #goal-new-title'); t.value = 'Draw the phone list'; t.dispatchEvent(new Event('input')); const d = document.querySelector('.goals-dialog #goal-new-description'); d.value = 'Two columns on wide screens.\\nOne on a phone.'; d.dispatchEvent(new Event('input')); document.querySelector('.goals-dialog form').requestSubmit(); return true; })()`);
        let g;
        // the goal and its pictures are two writes: a read between them sees the goal first, so wait for the pictures
        for (let i = 0; i < 40 && !g; i++) { const r = await api('GET', `/api/board/${B}/goals`); const found = (r.body.goals || []).find(x => x.title === 'Draw the phone list'); if (found && found.images) g = found; else await new Promise(r2 => setTimeout(r2, 150)); } // sleep-ok: the create answers after the form posts
        check('the goal was created with its Description and one picture', g && g.outcome === 'Two columns on wide screens.\nOne on a phone.' && g.images && g.images.length === 1 && g.images[0].content_type === 'image/png', JSON.stringify(g && g.images));
        assert.ok(g, 'the goal with its picture'); const pic = g.images[0].hex;
        const one = await api('GET', `/api/board/${B}/goals/${g.id}`);
        check('the goal reads back with its picture', one.status === 200 && one.body.images && one.body.images[0].hex === pic);
        check('the picture is kept with the team\'s agent session as a goal picture', fs.existsSync(path.join(DATA, 'artifacts', 'uploads', SID, pic + '.json')) && JSON.parse(fs.readFileSync(path.join(DATA, 'artifacts', 'uploads', SID, pic + '.json'), 'utf8')).source === 'goal-image');
        check('the database holds it', /1/.test(sqliteText(path.join(DATA, 'messageboard.db'), `select count(*) from board_goal_images where board_id = '${B}' and hex = '${pic}'`)));
        const raw = await ev(`fetch('/api/artifacts/${pic}?v=2').then(async r => ({ status: r.status, type: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength }))`);
        check('it is served from its artifact URL as a PNG', raw.status === 200 && /image\/png/.test(raw.type) && raw.n > 0, JSON.stringify(raw));

        // the goal's page draws it, and after a reload too
        for (const again of [false, true]) {
            await load(`/team/${B}/goals/${g.id}`);
            await waitFor(`document.querySelectorAll('#team-panel-goals .goal-pic-img').length === 1`, 'the goal\'s picture' + (again ? ' after a reload' : ''), 10000);
            await waitFor(`[...document.querySelectorAll('#team-panel-goals .goal-pic-img')].every(i => i.complete && i.naturalWidth > 0)`, 'the picture drawn' + (again ? ' after a reload' : ''), 8000);
            check('the goal page draws the picture under the Description' + (again ? ' (after a reload)' : ''), true);
        }

        // the route's refusals
        const mism = await rawUpload(B, PNG, 'image/jpeg');
        check('a PNG sent as a JPEG is refused: image_type_mismatch', mism.status === 415 && mism.body.code === 'image_type_mismatch', JSON.stringify(mism));
        const text = await rawUpload(B, Buffer.from('not a picture').toString('base64'), 'image/png');
        check('text sent as a PNG is refused: image_type', text.status === 415 && text.body.code === 'image_type', JSON.stringify(text));
        const none = await rawUpload(EMPTY, PNG, 'image/png');
        check('a team with no agent session has nowhere to keep it: no_team', none.status === 409 && none.body.code === 'no_team', JSON.stringify(none));
        const gone = await rawUpload('no-such-team-' + Date.now().toString(36), PNG, 'image/png');
        check('a team that does not exist is a 404', gone.status === 404, JSON.stringify(gone));
        const stolen = await api('POST', `/api/board/${EMPTY}/goals`, { subscriber_id: 'Operator', title: 'Borrowed', images: [pic] });
        check('a picture uploaded for another team\'s goal cannot be named: 400', stolen.status === 400, JSON.stringify(stolen));
        console.log(results.every(Boolean) ? 'PASS goal pictures against the real route' : 'FAIL goal pictures against the real route');
        if (!results.every(Boolean)) process.exitCode = 1;
    } finally { await removeBoards(ev, [B, EMPTY]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
