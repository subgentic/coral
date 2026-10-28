// Mobile pass 40 (#10776, #10783) at 390 px: New job's folder that is not a git repo is one "Make it a git repo" button under the folder's error, in view and a 44 px target; Create job with a field missing scrolls to it, focuses and marks it;
// and the Settings sheet shows its title once when a group is open ("<- Settings" is the way back, not a second title above General). Touch emulation, stubbed answers; isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__refusal = ''; const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u), m = (o.method || 'GET').toUpperCase(); if (m === 'POST' && /\\/api\\/scheduled\\/jobs$/.test(url)) return Promise.resolve(new Response(JSON.stringify({ error: window.__refusal }), { status: 400, headers: { 'content-type': 'application/json' } })); return real(u, o); }; true`);
        await ev(`Promise.resolve(window.showJobModal()).then(() => true)`);
        await waitFor(`!!document.getElementById('job-modal-name') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, 'the New job dialog', 8000);
        const set = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const type = t => ev(`document.querySelector('.job-type-btn[data-type=${t}]').click(); true`);
        const inBody = id => ev(`(() => { const body = document.querySelector('#job-modal .modal-body') || document.querySelector('#job-modal .modal-content'), m = body.getBoundingClientRect(), e = document.getElementById(${JSON.stringify(id)}), r = (e.closest('.sv-row') || e).getBoundingClientRect(); return r.height > 0 && r.top >= m.top - 1 && r.bottom <= m.bottom + 1; })()`);
        // a missing Folder, then a missing Workflow: each is focused, in view and marked
        await type('prompt'); await set('job-modal-name', 'nightly'); await set('job-modal-prompt', 'do it'); await set('job-modal-repo', '');
        await ev(`document.getElementById('job-modal-submit').click(); true`); await sleep(700); /* sleep-ok: the form scrolls to the field */
        if (!await ev(`document.activeElement && document.activeElement.id === 'job-modal-repo'`)) problems.push('a missing Folder: the focus is not on it');
        if (!await inBody('job-modal-repo')) problems.push('a missing Folder: it is not scrolled into view');
        if (await ev(`document.getElementById('job-modal-repo').getAttribute('aria-invalid')`) !== 'true') problems.push('a missing Folder: it is not marked invalid');
        await type('workflow'); await set('job-modal-name', 'nightly');
        await ev(`document.getElementById('job-modal-submit').click(); true`); await sleep(700); /* sleep-ok: the form scrolls to the field */
        if (!await ev(`document.activeElement && document.activeElement.id === 'job-modal-workflow'`)) problems.push('a missing Workflow: the focus is not on it');
        if (!await inBody('job-modal-workflow')) problems.push('a missing Workflow: it is not scrolled into view');
        if (await ev(`document.getElementById('job-modal-workflow').getAttribute('aria-invalid')`) !== 'true') problems.push('a missing Workflow: it is not marked invalid');
        // the folder that is not a repo: one button under the folder's error
        await type('prompt'); await set('job-modal-repo', '/work/plain');
        await ev(`window.__refusal = 'repo_path is not a git repository: /work/plain'; document.getElementById('job-modal-submit').click(); true`);
        await waitFor(`!!document.getElementById('job-repo-offer') && document.getElementById('job-repo-offer').getClientRects().length > 0`, 'the offer', 5000);
        await sleep(500); /* sleep-ok: the dialog scrolls to the button */
        const offer = await ev(`(() => { const o = document.getElementById('job-repo-offer'), bs = [...o.querySelectorAll('button')], body = document.querySelector('#job-modal .modal-body') || document.querySelector('#job-modal .modal-content'), m = body.getBoundingClientRect(), r = bs[0].getBoundingClientRect(); const err = document.getElementById('job-modal-repo').closest('.sv-row').getBoundingClientRect(); return { scroller: (() => { for (let p = o.parentElement; p; p = p.parentElement) { const c = getComputedStyle(p).overflowY; if ((c === 'auto' || c === 'scroll') && p.scrollHeight > p.clientHeight) return p.className + ' top=' + Math.round(p.getBoundingClientRect().top) + ' bottom=' + Math.round(p.getBoundingClientRect().bottom) + ' st=' + p.scrollTop; } return 'none'; })(), btnTop: Math.round(r.top), btnBottom: Math.round(r.bottom), vh: innerHeight, n: bs.length, text: bs[0] && bs[0].textContent.trim(), h: Math.round(r.height), inView: r.top >= m.top - 1 && r.bottom <= m.bottom + 1, below: r.top >= err.top }; })()`);
        if (offer.n !== 1 || offer.text !== 'Make it a git repo') problems.push(`the offer is not one "Make it a git repo" button: ${JSON.stringify(offer)}`);
        if (offer.h < 44) problems.push(`the button is not a 44 px target: ${JSON.stringify(offer)}`);
        if (!offer.inView || !offer.below) problems.push(`the button is not in view under the folder's error: ${JSON.stringify(offer)}`);
        await ev(`window.hideJobModal(); true`);
        // Settings: a group open shows "Settings" once
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`!!document.querySelector('#settings-modal .settings-tab') && document.querySelector('#settings-modal .settings-tab').getClientRects().length > 0`, 'the Settings sections', 8000);
        await ev(`document.querySelector('#settings-modal .settings-tab').click(); true`); await sleep(600); /* sleep-ok: the group screen draws */
        const titles = await ev(`[...document.querySelectorAll('#settings-modal #settings-title, #settings-modal .settings-back')].filter(e => { const r = e.getBoundingClientRect(), c = getComputedStyle(e); return r.width > 1 && r.height > 1 && c.visibility !== 'hidden'; }).map(e => e.textContent.replace(/arrow_back/, '').trim())`);
        if (titles.length !== 1 || titles[0] !== 'Settings') problems.push(`the Settings sheet shows its title ${titles.length} times with a group open: ${JSON.stringify(titles)}`);
        assert.deepEqual(problems, [], 'Mobile pass 40 at 390:\n  ' + problems.join('\n  '));
        console.log('PASS phone pass 40');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
