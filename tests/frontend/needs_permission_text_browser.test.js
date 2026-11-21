// #20101 (final walk, mock 390): a permission row whose words are "Wants to run: <command>" reads the same at 390 as at 1280: the lead "Wants to run", the command in its own block. Failing-first at 390.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const AGENT = { name: 'be', session_id: '00000001-0000-4000-8000-000000000001', agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Backend Dev', working_directory: '/repo/be', waiting_for_input: true, waiting_kind: 'permission', waiting_summary: 'Wants to run: rm -rf build', waiting_since: new Date(Date.now() - 120000).toISOString(), waits_on_this: { count: 1, top_title: 'Tag v2.1.1' } };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const seen = {};
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(INBOX_WORLD);
            await ev(`window.__asks = [{ board: 'team-a', kind: 'ask', id: 1, asker: 'Writer', text: 'Q-end', at: new Date(Date.now() - 60000).toISOString() }]; (() => { const original = window.fetch; window.fetch = (url, opts = {}) => { if (new URL(String(url), location.origin).pathname === '/api/operator-asks') return Promise.resolve(new Response(JSON.stringify(window.__asks), { headers: { 'Content-Type': 'application/json' } })); return original(url, opts); }; })(); true`); // a second row makes the list cards, as a real inbox is
            await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const m = await import(${S} + 'inbox_tab.js'); state.liveSessions = [${JSON.stringify(AGENT)}]; m.updateInboxTab(); window.switchNavTab('hub-inbox'); await m.selectInboxTab('needs'); return true; })()`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 2`, w + ': the permission row and the question', 15000); await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`); await ev(framesJs(8));
            await shot(`perm-${w}`);
            seen['x' + w] = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => /Backend Dev/.test(r.textContent)), vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; return { waits: /waits on this/.test(tr.innerText), blocks: [...tr.querySelectorAll('.inbox-blocks')].filter(vis).length, helper: /Yes lets it run/.test(tr.innerText) }; })()`); // mock v3: a permission row has no 'waits on this' chip and no helper line (#20146)
            seen[w] = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => /Backend Dev/.test(r.textContent)); const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; const code = tr.querySelector('.inbox-cmd-code'), lead = tr.querySelector('.inbox-cmd-lead'); return { box: code ? getComputedStyle(code).borderTopWidth : null, onOwnLine: !!lead && !!code && lead.getBoundingClientRect().bottom <= code.getBoundingClientRect().top + 1, once: [...tr.querySelectorAll('.inbox-review-name, .inbox-row-command')].filter(vis).length, lead: vis(lead), code: vis(code) ? code.textContent : null, text: tr.textContent.replace(/\\s+/g, ' ') }; })()`);
        }
        assert.ok(seen[1280].lead && seen[1280].code === 'rm -rf build', '1280: the lead and the command in its own block: ' + JSON.stringify(seen[1280]));
        assert.ok(seen[390].lead && seen[390].code === 'rm -rf build' && seen[390].box === '1px' && seen[390].onOwnLine && seen[390].once === 1, '390: the same lead, then the command in its box, said once, as at 1280 (mock 390): ' + JSON.stringify(seen[390]));
        for (const w of [1280, 390]) assert.ok(!seen['x' + w].waits && seen['x' + w].blocks === 0 && !seen['x' + w].helper, w + ': no waits-on-this chip and no Yes helper line on a permission row: ' + JSON.stringify(seen['x' + w]));
        console.log('PASS needs_permission_text');
    } catch (e) { console.error(e); process.exitCode = 1; } finally { try { await client.close(); } catch (_) {} }
})();
