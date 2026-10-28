// The Link team dialog (#9888, slice 1, to the pictures the operator approved): "Link team..." in a team's menu after Team settings, only when the Hub's account field team_link_dialog is true; the dialog
// for links to teams on other computers (the Hub's relay routes, stubbed here: the page calls only those, checked at run time); Both ways is the default and is sent explicitly; each direction is its own row
// with its own Revoke (Not delivered and Old-style included); the Not delivered sentence is coral-hub Security's exact one; no View-only or offline computer and no named (non-generated) team is offered;
// a refusal and a rate limit are said in our words. 1280 and 390 px; CORAL_SCREENSHOT_DIR saves the pictures. Isolated dev server; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SENTENCE = "That team isn't on that computer (it may have been deleted). Revoke this link, and link the team again if it was re-created.";
const OWN = '@s-own/b-aaaaaaaaaa';
const SERVERS = [{ id: 's-own', label: 'This Mac', online: true, effective_mode: 'launch' }, { id: 's-two', label: 'Studio Mac', online: true, effective_mode: 'interact' }, { id: 's-view', label: 'Viewer', online: true, effective_mode: 'view' }, { id: 's-off', label: 'Sleeping', online: false, effective_mode: 'launch' }, { id: 's-old', label: 'Old Mac', online: true, effective_mode: 'interact' }, { id: 's-low', label: 'Low Mac', online: true, effective_mode: 'interact' }];
const LINKS = [
    { id: 11, src_server_id: 's-two', src_team: 'b-bbbbbbbbbb', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'nightly', notice: { source: 'delivered', target: 'delivered' } },
    { id: 12, src_server_id: 's-own', src_team: 'b-aaaaaaaaaa', dst_server_id: 's-two', dst_team: 'b-bbbbbbbbbb', dst_team_label: 'nightly', notice: { source: 'unavailable', target: 'delivered' } },
    { id: 13, src_server_id: 's-two', src_team: 'b-cccccccccc', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'build-bots', notice: { source: 'delivered', target: 'not_delivered' } },
    { id: 14, src_server_id: 's-two', src_team: 'b-eeeeeeeeee', dst_server_id: 's-own', dst_team: 'b-aaaaaaaaaa', src_team_label: 'old-team', notice: { source: 'delivered', target: 'delivered' }, legacy: true },
    { id: 15, src_server_id: 's-x', src_team: 'b-xxxxxxxxxx', dst_server_id: 's-y', dst_team: 'b-yyyyyyyyyy', notice: { source: 'delivered', target: 'delivered' } },
];
const LIVE = { servers: [{ id: 's-own', label: 'This Mac', version: '2.0.3', coral_version: '2.0.3' }, { id: 's-two', label: 'Studio Mac', version: '2.0.3', coral_version: '2.0.3' }, { id: 's-view', label: 'Viewer', version: '2.0.3' }, { id: 's-off', label: 'Sleeping', version: '2.0.3' }, { id: 's-old', label: 'Old Mac', version: '2.0.2', coral_version: '2.0.2' }, { id: 's-low', label: 'Low Mac', version: '2.0.9', coral_version: '2.0.9', below_minimum: true, min_coral: '2.0.5' }], sessions: [{ session_id: 'h1', name: 'HOSTILE-SESSION-<b>x</b>', display_name: 'HOSTILE-SESSION' }] };
const PROJECTS = [{ project: 'b-dddddddddd', board_label: 'research-crew' }, { project: 'legacy_board', board_label: 'legacy' }];
const ALLOWED = [/^GET \/api\/sessions\/live$/, /^GET \/api\/relay\/links$/, /^POST \/api\/relay\/links$/, /^DELETE \/api\/relay\/links\/\d+$/, /^GET \/api\/servers$/, /^GET \/api\/remote\/[\w-]+\/api\/board\/projects$/, /^GET \/api\/account$/];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const dlg = (js) => ev(`(() => { const d = document.getElementById('team-link-dialog'); return ${js}; })()`);
    const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => {
                window.__calls = []; window.__post = { status: 200 }; window.__links = ${JSON.stringify(LINKS)};
                const real = window.fetch.bind(window);
                const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
                window.fetch = async (url, opt = {}) => {
                    const u = String(url), m = (opt.method || 'GET').toUpperCase(), path = u.split('?')[0];
                    const hubby = /^\\/api\\/(relay\\/|servers$|sessions\\/live$|remote\\/|account$)/.test(path);
                    window.__paths = window.__paths || []; window.__paths.push(m + ' ' + path);
                    if (!hubby) return real(url, opt);
                    window.__calls.push(m + ' ' + path + (opt.body ? ' ' + opt.body : ''));
                    if (path === '/api/account') return json(200, { team_link_dialog: window.__flag === true });
                    if (path === '/api/sessions/live') return window.__live === 'fail' ? json(500, {}) : json(200, ${JSON.stringify(LIVE)});
                    if (path === '/api/relay/links' && m === 'GET') return json(200, { links: window.__links, relay_artifacts_available: true, relay_artifacts_enabled: true });
                    if (path === '/api/relay/links' && m === 'POST') return json(window.__post.status, window.__post.status === 200 ? { ok: true } : { error: window.__post.code || 'not_found' });
                    if (/^\\/api\\/relay\\/links\\/\\d+$/.test(path) && m === 'DELETE') { window.__links = window.__links.filter(l => String(l.id) !== path.split('/').pop()); return json(200, { ok: true }); }
                    if (path === '/api/servers') return json(200, { servers: window.__localRow ? [...${JSON.stringify(SERVERS)}, { id: 'local', label: 'Here', online: false, effective_mode: 'launch' }] : ${JSON.stringify(SERVERS)} });
                    if (/^\\/api\\/remote\\/[\\w-]+\\/api\\/board\\/projects$/.test(path)) return json(200, ${JSON.stringify(PROJECTS)});
                    return json(404, {});
                };
                return true; })()`);

            // 1. the menu item: absent until the account says so, then after Team settings
            await ev(`(() => { window.switchNavTab('agents'); window._coralSetLiveSessions([{ session_id: 'a-dev', name: 'dev-1', agent_type: 'claude', working_directory: '/tmp/alpha', sleeping: false, board_project: 'alpha', display_name: 'Frontend Dev' }]); return true; })()`);
            await waitFor(`document.querySelectorAll('.session-board-card').length >= 1`, 'the team card', 10000);
            const menu = () => ev(`[...document.querySelectorAll('.session-board-card .sidebar-kebab-menu button[data-on-click]')].map(b => b.dataset.onClick)`);
            assert.ok(!(await menu()).includes('team-link'), `${label}: no Link team item while the account says nothing`);
            await ev(`(async () => { window.__flag = true; window.__localRow = false; const m = await import((window.__coralStatic || '/static/') + 'team_link_flag.js'); await m.initTeamLinkFlag(); return true; })()`);
            assert.ok(!(await menu()).includes('team-link'), `${label}: the switch is on but this team's computer is not one of the viewer's own (a share grantee): no Link team item`);
            await ev(`(async () => { window.__localRow = true; const m = await import((window.__coralStatic || '/static/') + 'team_link_flag.js'); await m.initTeamLinkFlag(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('.session-board-card .sidebar-kebab-menu button[data-on-click]')].some(b => b.dataset.onClick === 'team-link')`, 'the Link team item', 6000);
            const order = await menu();
            assert.ok(order.indexOf('team-link') === order.indexOf('team-working-mode') + 1, `${label}: Link team... is right after Team settings: ${order}`);
            assert.equal(await ev(`[...document.querySelectorAll('.session-board-card .sidebar-kebab-menu button[data-on-click="team-link"]')][0].textContent.replace(/\\s+/g, ' ').trim()`), 'Link team...');
            await ev(`window.__asked = null; window.__realLink = window.showTeamLinkDialog; window.showTeamLinkDialog = (b) => { window.__asked = b; }; true`);
            await ev(`document.querySelector('.session-board-card .sidebar-kebab-menu button[data-on-click="team-link"]').click(); true`);
            assert.equal(await ev(`window.__asked`), 'alpha', `${label}: the item opens the dialog for its team`);
            await ev(`window.showTeamLinkDialog = window.__realLink; true`);

            // 2. the dialog, for a team with four links on other computers
            await ev(`window.showTeamLinkDialog(${JSON.stringify(OWN)}, { cloud: true }); true`);
            await waitFor(`!!document.querySelector('#team-link-dialog .team-link-row')`, 'the links', 8000);
            assert.equal(await dlg(`d.querySelector('h3').textContent`), 'Link a team');
            assert.match(await dlg(`d.querySelector('.team-link-body h4').textContent`), /^Teams linked to /);
            assert.equal(await dlg(`d.querySelector('.team-link-group').textContent`), 'Other computers');
            const rows = await dlg(`[...d.querySelectorAll('.team-link-row')].map(r => ({ name: r.querySelector('.team-link-name').textContent, where: r.querySelector('.team-link-where').textContent, state: r.querySelector('.team-link-state').textContent, sentence: (r.querySelector('.team-link-sentence') || {}).textContent || '', revoke: !!r.querySelector('.team-link-revoke') }))`);
            assert.equal(rows.length, 4, `${label}: four links name this team (one is another pair's): ${JSON.stringify(rows)}`);
            assert.deepEqual(rows.map(r => r.where), ['Studio Mac · May message this team', 'Studio Mac · This team may message it', 'Studio Mac · May message this team', 'Studio Mac · May message this team'], 'each direction is its own row');
            assert.deepEqual(rows.map(r => r.state), ['Active', 'Active', 'Not delivered', 'Old-style, create again']);
            assert.ok(rows.every(r => r.revoke), 'Revoke on every row, Not delivered and Old-style included');
            assert.deepEqual(rows.map(r => r.sentence), ['', '', SENTENCE, ''], 'only the Not delivered row carries the Security sentence, word for word');
            assert.deepEqual(await dlg(`[...d.querySelectorAll('.team-link-row .team-link-files')].map(c => c.textContent)`), ['Files allowed', 'Files allowed', 'Files allowed', 'Files allowed'], 'the account-wide Files setting, read-only, on every row');
            assert.ok((await dlg(`d.textContent`)).includes('Files follow the account setting in Coral Hub.'));
            assert.ok(!(await ev(`document.body.innerHTML`)).includes('HOSTILE-SESSION'), `${label}: sessions[] of the live answer appears nowhere`);
            assert.deepEqual(await dlg(`[...d.querySelectorAll('#team-link-computer option')].map(o => o.textContent)`), ['Studio Mac'], `${label}: no View-only, offline, older or own computer`);
            assert.equal(await dlg(`[...d.querySelectorAll('.team-link-update')].map(p => p.textContent).join('|')`), 'Old Mac needs Coral 2.0.3 or later to be linked. Update Coral there.|Low Mac is below the Coral version Coral Hub allows (2.0.5 or later). Update Coral there.', `${label}: an older or below-minimum computer is said to need an update, not offered`);
            await waitFor(`document.querySelectorAll('#team-link-team option').length >= 1`, 'the teams', 5000);
            assert.deepEqual(await dlg(`[...d.querySelectorAll('#team-link-team option')].map(o => o.textContent)`), ['research-crew'], 'a name that is not a generated team id is not offered');
            assert.equal(await dlg(`d.querySelector('#team-link-direction').value`), 'both', 'Both ways is the default');
            const fits = await dlg(`({ over: d.scrollWidth - d.clientWidth, targets: [...d.querySelectorAll('button, select')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)) })`);
            assert.ok(fits.over <= 0, `${label}: no sideways scroll ${JSON.stringify(fits)}`);
            if (mobile) assert.ok(fits.targets.every(x => x >= 44), `390: every control is 44 px ${JSON.stringify(fits.targets)}`);
            // each row is laid out the same: its Files chip, state word and Revoke are one line under (or beside) the name, Revoke at the row's right edge, and the chip is quiet (F4, #9905)
            const lay = await dlg(`[...d.querySelectorAll('.team-link-row')].map(r => { const q = s => r.querySelector(s), rr = r.getBoundingClientRect(), rv = q('.team-link-revoke').getBoundingClientRect(), st = q('.team-link-state').getBoundingClientRect(), fc = q('.team-link-files'), tx = q('.team-link-text').getBoundingClientRect();
                return { revokeRight: Math.round(rr.right - rv.right), sameLine: Math.abs(rv.top - st.top) <= rv.height, revokeBelowName: rv.top >= q('.team-link-name').getBoundingClientRect().bottom - 2 || (rv.left > tx.right - 1), chipWeight: Number(getComputedStyle(fc).fontWeight), endOneLine: q('.team-link-end').getBoundingClientRect().height < q('.team-link-revoke').getBoundingClientRect().height * 1.6, belowText: rv.top >= tx.bottom - 2 || rv.left > tx.right - 1 }; })`);
            assert.ok(lay.every(x => x.revokeRight === lay[0].revokeRight && x.sameLine && x.endOneLine && x.chipWeight === 400), `${label}: Revoke is in one place on every row, with the chip and the state on its line, and the chip is quiet (400) ${JSON.stringify(lay)}`);
            if (mobile) assert.ok(lay.every(x => x.belowText), `390: the chip, state and Revoke are one line under the text, on every row ${JSON.stringify(lay)}`);
            await shot(`team-link-dialog-${label}`);

            // 3. link: the confirm names both directions, the POST says both_directions explicitly
            await click('#team-link-dialog .team-link-link');
            await waitFor(`!!document.querySelector('#team-link-dialog .team-link-confirm')`, 'the confirm', 4000);
            assert.match(await dlg(`d.querySelector('.team-link-confirm').textContent`), /will be able to message each other, starting now\./, 'plain words for both directions');
            await shot(`team-link-confirm-${label}`);
            await ev(`window.__post = { status: 404 }; true`);
            await click('#team-link-dialog .team-link-go');
            await waitFor(`!!document.querySelector('#team-link-dialog .team-link-error')`, 'the refusal', 4000);
            assert.equal(await dlg(`d.querySelector('.team-link-error').textContent`), 'Could not link. Check that both computers are online and not View-only.');
            await ev(`window.__post = { status: 429, code: 'rate_limited' }; true`);
            await click('#team-link-dialog .team-link-link'); await waitFor(`!!document.querySelector('#team-link-dialog .team-link-go')`, 'confirm again', 4000);
            await click('#team-link-dialog .team-link-go');
            await waitFor(`/Too many changes/.test((document.querySelector('#team-link-dialog .team-link-error') || {}).textContent || '')`, 'the rate limit words', 4000);
            await ev(`window.__post = { status: 409, code: 'link_limit' }; true`);
            await click('#team-link-dialog .team-link-link'); await waitFor(`!!document.querySelector('#team-link-dialog .team-link-go')`, 'confirm again', 4000);
            await click('#team-link-dialog .team-link-go');
            await waitFor(`/Both ways link uses two/.test((document.querySelector('#team-link-dialog .team-link-error') || {}).textContent || '')`, 'the link limit words', 4000);
            await ev(`window.__post = { status: 200 }; true`);
            await click('#team-link-dialog .team-link-link'); await waitFor(`!!document.querySelector('#team-link-dialog .team-link-go')`, 'confirm again', 4000);
            await click('#team-link-dialog .team-link-go');
            await waitFor(`!!document.querySelector('#team-link-dialog .team-link-row')`, 'the list again', 4000);
            const posts = await ev(`window.__calls.filter(c => c.startsWith('POST '))`);
            const body = JSON.parse(posts[posts.length - 1].replace('POST /api/relay/links ', ''));
            assert.deepEqual(body, { src_server_id: 's-own', src_team: 'b-aaaaaaaaaa', dst_server_id: 's-two', dst_team: 'b-dddddddddd', both_directions: true }, `${label}: both_directions is sent explicitly`);

            // 4. revoke one row (the Not delivered one): a confirm that says at once and what stays, then one DELETE
            await ev(`document.querySelectorAll('#team-link-dialog .team-link-row')[2].querySelector('.team-link-revoke').click(); true`);
            await waitFor(`!!document.querySelector('#team-link-dialog .team-link-confirm')`, 'the revoke confirm', 4000);
            const rc = await dlg(`d.querySelector('.team-link-confirm').textContent`);
            assert.ok(/build-bots/.test(rc) && /at once/.test(rc) && /already received stays/.test(rc), rc);
            await shot(`team-link-revoke-${label}`);
            await click('#team-link-dialog .team-link-go');
            await waitFor(`document.querySelectorAll('#team-link-dialog .team-link-row').length === 3`, 'three rows left', 4000);
            assert.ok((await ev(`window.__calls`)).includes('DELETE /api/relay/links/13'), `${label}: one DELETE for that link`);
            assert.equal(await dlg(`d.querySelectorAll('.team-link-row').length`), 3);

            // 5. only the listed routes were called
            const calls = (await ev(`window.__calls`)).map(c => c.split(' ').slice(0, 2).join(' '));
            assert.deepEqual(calls.filter(c => !ALLOWED.some(rx => rx.test(c))), [], 'a route the dialog may not call');
            assert.equal((await ev(`window.__paths`)).filter(p => p === 'GET /api/sessions/live').length, 1, `${label}: sessions/live is read once when the dialog opens, never polled`);
            assert.deepEqual((await ev(`window.__paths`)).filter(p => /cross-team-state/.test(p)), [], `${label}: cloud mode never reads cross-team-state`);
            await click('#team-link-dialog .team-link-close');
            assert.equal(await ev(`document.getElementById('team-link-dialog').open`), false, 'Close closes it');
            // a failed live read is "version unknown" and does not block the form (the Hub's own minimum still applies)
            await ev(`window.__live = 'fail'; window.showTeamLinkDialog(${JSON.stringify(OWN)}, { cloud: true }); true`);
            await waitFor(`document.querySelectorAll('#team-link-computer option').length >= 1`, 'the form after a failed live read', 6000);
            assert.deepEqual(await dlg(`[...d.querySelectorAll('#team-link-computer option')].map(o => o.textContent)`), ['Studio Mac', 'Old Mac', 'Low Mac'], `${label}: a failed read leaves every online, non-View computer offered`);
            await ev(`window.__live = ''; true`); await click('#team-link-dialog .team-link-close');
            // local mode reads this computer's own state, and only there
            await ev(`window.__paths = []; window.showTeamLinkDialog(${JSON.stringify(OWN)}, { cloud: false }); true`);
            await waitFor(`!!document.querySelector('#team-link-dialog .team-link-manage')`, 'the local view', 6000);
            assert.ok((await ev(`window.__paths`)).some(p => /^GET \/api\/board\/[^/]+\/cross-team-state$/.test(p)), `${label}: local mode reads its own cross-team-state`);
            assert.deepEqual((await ev(`window.__paths`)).filter(p => /\/api\/relay\//.test(p)), [], 'and calls no relay route');
            await click('#team-link-dialog .team-link-close');
            console.log(`PASS ${label}: Link team... after Team settings, the dialog, Both ways, Revoke per row, the Security sentence`);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
