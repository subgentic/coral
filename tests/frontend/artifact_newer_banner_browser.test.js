// A viewer open on an older version says so where it cannot be missed (#18767, the Operator's ask): v2 is open, a comment is sent on it, v3 is uploaded; the viewer then shows a full-width warning banner above the
// content, "You're looking at v2, an older version. v3 is the newest.", with a primary "Open v3" button, with no reload; the comment thread stays visible; the header pill no longer says the same thing; Open v3 switches.
// Real files uploaded by a stood-in terminal session of a real board on the isolated dev server (the next upload names the one before with X-Artifact-New-Version-Of), the real comment route, the Inbox's own re-read. 1440 and 390.
const os = require('node:os');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'nbanner-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (method, path, body, headers) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers || { 'Content-Type': 'application/json' })}, body: ${body === undefined ? 'undefined' : typeof body === 'string' ? JSON.stringify(body) : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const S = `(window.__coralStatic || '/static/')`;
    const hexOf = up => String((up.body && (up.body.digest || up.body.id || up.body.hex)) || '').replace(/^sha256:/, '').replace(/^coral:\/\/artifacts\//, '');
    let sid = null, sname = null;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const at = `${w} px: `, name = `banner-${w}.md`, hdr = { 'X-Artifact-Name': name, 'X-Artifact-Media-Type': 'text/markdown' };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (!sid) {
                const launch = await api('POST', '/api/sessions/launch', { working_dir: os.tmpdir(), agent_type: 'terminal', display_name: 'Banner Writer' });
                sid = launch.body.session_id; sname = launch.body.session_name || launch.body.name;
                if (!sid) throw new Error('no session: ' + JSON.stringify(launch));
                check((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Banner Writer', job_title: 'Writer', session_name: sname })).status < 300, 'subscribed');
            }
            const q = `&tag=for+review&question=Approve+this%3F`;
            const up1 = await api('POST', `/api/agent/artifacts?session_id=${sid}${q}`, `plan v1 ${Date.now()}`, hdr), hex1 = hexOf(up1);
            const up2 = await api('POST', `/api/agent/artifacts?session_id=${sid}${q}`, `plan v2 ${Date.now()}`, { ...hdr, 'X-Artifact-New-Version-Of': hex1 }), hex2 = hexOf(up2);
            check(up1.status < 300 && up2.status < 300 && hex1 && hex2, at + 'uploaded v1 and v2');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(hex2)}, { board: ${JSON.stringify(B)}, filename: ${JSON.stringify(name)} })).then(() => true)`);
            await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden]) .artifact-review-approve:not([hidden])')`, at + 'the viewer has Approve on v2', 15000);
            const c = await api('POST', `/api/artifacts/${hex2}/comments?board=${B}`, { body: 'Please add a section.', anchor: { whole: true } });
            check(c.status < 300, at + 'a comment was sent on v2: ' + c.status + ' ' + JSON.stringify(c.body).slice(0, 120));
            const banner = () => ev(`(() => { const v = document.querySelector('#artifact-viewer'), b = v.querySelector('.artifact-newer-banner'); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(), main = v.querySelector('.artifact-viewer-body').getBoundingClientRect(), dlg = Math.round(v.querySelector('.artifact-viewer-content').getBoundingClientRect().width), btn = b.querySelector('.artifact-review-newest'); return { text: b.textContent.replace(/\\s+/g, ' ').trim(), w: Math.round(r.width), dlg, above: r.bottom <= main.top + 1, role: b.getAttribute('role'), primary: !!btn && /btn-primary/.test(btn.className) && !btn.hidden, btn: btn ? btn.textContent : '', color: getComputedStyle(b).backgroundColor, pill: (v.querySelector('.artifact-review-state') || {}).textContent || '' }; })()`);
            check(await banner() === null, at + 'no banner while v2 is the newest');
            const up3 = await api('POST', `/api/agent/artifacts?session_id=${sid}${q}`, `plan v3 ${Date.now()}`, { ...hdr, 'X-Artifact-New-Version-Of': hex2 }), hex3 = hexOf(up3);
            check(up3.status < 300 && hex3, at + 'uploaded v3');
            await ev(`document.dispatchEvent(new CustomEvent('coral:reviews-changed', { detail: {} })); true`);
            let ok = true; try { await waitFor(`(() => { const b = document.querySelector('#artifact-viewer .artifact-newer-banner'); return !!b && !b.hidden; })()`, at + 'the banner', 15000); } catch { ok = false; }
            const b = await banner();
            check(ok && b && b.text.startsWith("You're looking at v2, an older version. v3 is the newest.") && b.btn === 'Open v3', at + 'the banner says v2 is older and v3 the newest, with Open v3, with no reload: ' + JSON.stringify(b));
            if (b) {
                check(b.primary, at + 'Open v3 is the primary button in the banner');
                check(b.above, at + 'the banner is above the content');
                check(b.w >= b.dlg - 4, at + 'the banner is the full width of the viewer: ' + b.w + ' of ' + b.dlg);
                check(!/^An older version/.test(b.pill), at + 'the header pill does not say it twice: ' + JSON.stringify(b.pill));
                const [r, g, bl] = (b.color.match(/\d+(\.\d+)?/g) || []).map(Number); check(r > g && r >= bl || r > 150 && g > 100 && bl < 140, at + 'the banner is in the warning colour, not grey: ' + b.color);
            }
            check(await ev(`(() => { const t = document.querySelector('#artifact-viewer .ac-toggle'); return !!t && t.getClientRects().length > 0; })()`), at + 'the comments button is still there');
            await ev(`document.querySelector('#artifact-viewer .artifact-newer-banner .artifact-review-newest')?.click(); true`);
            let sw = true; try { await waitFor(`(() => { const v = document.querySelector('#artifact-viewer'); return !!v && !v.querySelector('.artifact-newer-banner:not([hidden])') && /v3/.test((v.querySelector('.artifact-viewer-chips') || {}).textContent || '') ; })()`, at + 'v3 open', 10000); } catch { sw = false; }
            check(sw, at + 'Open v3 switched to v3 and the banner went');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
        }
    } finally {
        if (sname) await api('POST', `/api/sessions/live/${encodeURIComponent(sname)}/kill`, { session_id: sid, agent_type: 'terminal' }).catch(() => {}); // the terminal it launched: a board with a running agent is not deleted (board_has_running_agents)
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
    }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('artifact_newer_banner_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
