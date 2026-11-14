// A file for review names its team on the meta line under the headline, on a computer, and nowhere else in the row (#16752, Option B: slice 2 had left the team in a right-hand column; the first try showed it twice). Real isolated team; only artifact storage
// and the question list are mocked, as inbox_kind_groups does. 1440 px (and 390 px, where the card already says it), dark and light; before/after shots go to CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const TEAM = 'team-meta-' + Date.now().toString(36);

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const api = (method, path, body) => ev(`fetch('/api/board/${TEAM}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // the table top to bottom: a kind heading is its words, a row is the name it carries
    const SEQ = `[...document.querySelectorAll('#group-table-view tbody tr')].filter(tr => tr.getClientRects().length).map(tr => tr.classList.contains('dt-group') ? { head: tr.textContent.replace(/\\s+/g, ' ').trim() } : { row: tr.textContent.replace(/\\s+/g, ' ').trim() })`;
    const at = (seq, test) => seq.findIndex(test);
    const opened = async (mode, mobile) => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.setItem('coral-inbox-group-mode', ${JSON.stringify(mode)}); localStorage.removeItem('coral-inbox-needs-filters'); true`);
        await ev(`(() => { const items = [['Plain review.md', []], ['Pinned review.md', [], true], ['Waiting review.md', ['changes requested']]].map(([name, more, star], i) => ({ id: (i + 1).toString(16).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (30 - i) * 60000).toISOString(), tags: ['for review', ...more], starred: !!star, produced_by: 'Writer', available: true }));
            const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href);
                if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${TEAM}': items }));
                if (u.pathname === '/api/operator-asks') return json([{ board: '${TEAM}', board_label: 'Kind groups', kind: 'ask', id: 71, asker: 'Dev', text: '@Operator May I delete the old table and start again?', at: new Date(Date.now() - 5 * 60000).toISOString() }]);
                return original(url, opts); }; return true; })()`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)').length >= 3 && /Plain review/.test(document.getElementById('group-table-view').textContent)`, `${mode}: the five rows of Needs you`, 20000);
    };
    const ROW = `(() => { const tr = [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].find(t => /Plain review/.test(t.textContent) && t.getClientRects().length); if (!tr) return null; const meta = tr.querySelector('.inbox-meta'), cells = [...tr.querySelectorAll('td')].filter(c => c.dataset.key === 'team' && c.getClientRects().length);
        const count = (tr.textContent.match(new RegExp('${TEAM}', 'g')) || []).length; return { meta: meta ? meta.textContent.replace(/\\s+/g, ' ').trim() : null, metaTeam: !!(meta && meta.textContent.includes('${TEAM}')), teamCell: cells.map(c => c.textContent.trim()), count, text: tr.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) }; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        assert.ok((await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator' })).status < 300);
        for (const [width, mobile] of [[1440, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await opened('none', mobile);
            for (const theme of ['dark', 'light']) {
                const at = `${width} px, ${theme}: `;
                await ev(`import((window.__coralStatic || '/static/') + 'settings_core.js').then(m => m.applyTheme('${theme}')).then(() => true)`);
                const r = await ev(ROW);
                check(!!r, `${at}the file's row is on screen`);
                if (r) {
                    check(r.count === 1, `${at}the team is named once in the row, not twice: ${JSON.stringify(r)}`);
                    if (!mobile) {
                        check(r.metaTeam, `${at}the team is on the meta line under the headline: ${JSON.stringify(r)}`);
                        check(r.teamCell.every(t => !t), `${at}no right-hand Team column is left for it: ${JSON.stringify(r)}`);
                    }
                }
                await shot(`inbox-team-meta-${width}-${theme}`);
            }
        }
    } finally { try { await removeBoards(ev, [TEAM]); } catch (e) {} await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('inbox_team_meta_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
