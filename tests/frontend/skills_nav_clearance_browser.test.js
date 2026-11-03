// A skill's Approve and Reject buttons are not under the phone's bottom bar when the page is scrolled to its end (#13063: UI Reviewer's sweep #13060 found elementFromPoint at their centres returning .phone-nav at 390,
// 100% and 200% text, both themes). The page reserves the shared clearance the other pages do (data: the Inbox, Docs). Failing first: measured on both buttons at max scroll.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SK = { id: '3'.repeat(32), name: 'db-review', version: 1, digest: '3'.repeat(64), description: 'db-review does a thing.', status: 'pending', has_scripts: false, not_reviewable: false, publisher_kind: 'agent', publisher_agent: 'Backend Dev', publisher_team: 'coral-go-team', created_at: '2026-11-03T10:00:00Z' };
const LONG = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the skill's instructions.`).join('\n\n');
const STUB = `(() => { const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })); const sk = ${JSON.stringify(SK)};
    window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/skills' && m === 'GET') return json({ skills: [sk] });
        if (p === '/api/skills/' + sk.id && m === 'GET') return json({ skill: sk, files: [{ path: 'SKILL.md', size: 3000, kind: 'instructions', sha256: '9'.repeat(64) }], contents: { 'SKILL.md': ${JSON.stringify(LONG)} }, warnings: [], hosts: [] });
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [fs, theme] of [[16, 'dark'], [16, 'light'], [32, 'dark'], [32, 'light']]) {
            const tag = `390 px ${fs === 32 ? '200% text' : '100%'} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/skills' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 1`, `${tag}: the list`, 8000);
            await ev(`document.querySelector('#skills-view tr.dt-row').click(); true`);
            await waitFor(`document.querySelectorAll('#skills-view .skills-actions button').length >= 2`, `${tag}: the buttons`, 8000);
            await ev(`(() => { const v = document.getElementById('skills-view'); v.scrollTop = v.scrollHeight; return true; })()`);
            await new Promise(r => setTimeout(r, 150)); // sleep-ok: scroll settle has no event
            const hits = await ev(`[...document.querySelectorAll('#skills-view .skills-actions button')].map(b => { const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, t = document.elementFromPoint(x, y); return { text: b.textContent.trim(), y: Math.round(y), onTop: !!t && (t === b || b.contains(t)), over: t ? (t.closest('.phone-nav') ? 'phone-nav' : t.tagName) : null }; })`);
            if (theme === 'light') await shot(`skills-end-${fs}`);
            check(`${tag}: the page has a bottom bar`, await ev(`!!document.querySelector('.phone-nav') && getComputedStyle(document.querySelector('.phone-nav')).display !== 'none'`));
            check(`${tag}: every action button is on top at the end of the page (none under the bar)`, hits.length >= 2 && hits.every(h => h.onTop), JSON.stringify(hits));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Skills detail at the end of the page:\n  ' + problems.join('\n  '));
    console.log('PASS the Skills approval buttons are clear of the phone bar at the end of the page, 390 px, 100% and 200% text, both themes');
})().catch(e => { console.error(e); process.exit(1); });
