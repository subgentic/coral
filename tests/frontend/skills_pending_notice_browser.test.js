// The Skills approval view's two notices (#12943, found by UI Reviewer's coverage repair #12937): the shared .notice lays its children in a row, so the pending skill's banner (a heading, the words about who published it
// and a count of files not opened) had its three text blocks side by side and the last one ran off the panel at 390 px with 200% text (panel right 371, text right 395, 1,075 px tall); the "Second step" notice had the same
// row. Each notice is a column of its own parts now. 1280 and 390 px, 100% and 200% text, both themes; the routes are stood in at /api/skills. Nothing may be clipped by the panel or by the page, and the parts
// are stacked: each starts under the one before.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const ID = '2'.repeat(32);
const ROW = { id: ID, name: 'db-review', version: 1, digest: 'b'.repeat(64), description: 'Checks a SQL migration.', status: 'pending', has_scripts: true, not_reviewable: true, publisher_kind: 'agent', publisher_agent: 'Backend Dev', publisher_team: 'alpha', file_count: 3, created_at: '2026-11-02T09:00:00Z', decided_at: '' };
const DETAIL = { skill: ROW, files: [
    { path: 'SKILL.md', size: 120, kind: 'instructions', sha256: 'f'.repeat(64) },
    { path: 'scripts/check.sh', size: 40, kind: 'script', sha256: 'e'.repeat(64) },
    { path: 'assets/logo.png', size: 2048, kind: 'not_reviewable', sha256: 'd'.repeat(64) }],
    contents: { 'SKILL.md': '# DB review\nrun the checker', 'scripts/check.sh': '#!/bin/sh\necho hi\n' }, warnings: [], hosts: [] };
const STUB = `(() => { const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin), p = url.pathname;
        if (p === '/api/skills' && (o.method || 'GET') === 'GET') return json({ skills: [${JSON.stringify(ROW)}] });
        if (p === '/api/skills/${ID}') return json(${JSON.stringify(DETAIL)});
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const measure = sel => ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; const nb = n.getBoundingClientRect(), kids = [...n.children].filter(k => k.getClientRects().length).map(k => { const b = k.getBoundingClientRect(); return { tag: k.tagName, t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; });
        const panel = document.getElementById('skills-view').getBoundingClientRect(); return { box: { t: Math.round(nb.top), b: Math.round(nb.bottom), l: Math.round(nb.left), r: Math.round(nb.right), w: Math.round(nb.width), h: Math.round(nb.height) }, panelRight: Math.round(panel.right), vw: innerWidth, kids, sx: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile, fs] of [[1280, 900, false, 16], [390, 844, true, 16], [390, 844, true, 32]]) for (const theme of ['dark', 'light']) {
            const tag = `${w} px ${fs === 32 ? '200% text' : '100%'} ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/skills/' + ID }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            await waitFor(`!!document.querySelector('#skills-view .skills-banner')`, `${tag}: the approval view`, 10000);
            const m = await measure('#skills-view .skills-banner');
            check(`${tag}: the banner has its parts`, m.kids.length >= 3, JSON.stringify(m));
            check(`${tag}: the parts are stacked, each under the one before`, m.kids.every((k, i) => i === 0 || k.t >= m.kids[i - 1].b - 1), JSON.stringify(m.kids));
            check(`${tag}: nothing runs past the banner, the panel or the page`, m.kids.every(k => k.r <= m.box.r + 1 && k.r <= m.panelRight + 1 && k.r <= m.vw) && m.sx <= 0, JSON.stringify(m));
            check(`${tag}: each part uses the banner's width (not a third of it)`, m.kids.every(k => k.w >= (m.box.w - 40) * 0.8), JSON.stringify(m.kids));
            // the second step: a notice of the same kind, with a list
            await ev(`(() => { const b = document.querySelector('#skills-view .skills-ack'); if (b) b.scrollIntoView(); return true; })()`);
            const a = await measure('#skills-view .skills-ack');
            check(`${tag}: the Second step notice is there`, !!a);
            const deep = await ev(`(() => { const n = document.querySelector('#skills-view .skills-ack'), nb = n.getBoundingClientRect(); const range = document.createRange(); let over = 0; for (const li of n.querySelectorAll('li, p, strong, label')) { range.selectNodeContents(li); for (const r of range.getClientRects()) if (r.right > nb.right + 1) over = Math.max(over, Math.round(r.right - nb.right)); } return { over, noticeRight: Math.round(nb.right), vw: innerWidth }; })()`);
            check(`${tag}: the long SHA-256 in the list wraps inside the notice`, deep.over === 0, JSON.stringify(deep));
            if (a) {
                check(`${tag}: its parts are stacked and inside`, a.kids.every((k, i) => i === 0 || k.t >= a.kids[i - 1].b - 1) && a.kids.every(k => k.r <= a.box.r + 1 && k.r <= a.vw) && a.sx <= 0, JSON.stringify(a));
            }
            if (theme === 'dark' && fs === 16) await shot(`skills-notice-${w}`);
            if (fs === 32 && theme === 'dark') await shot('skills-notice-390-200');
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Skills approval notices:\n  ' + problems.join('\n  '));
    console.log('PASS the Skills approval notices stack and fit, at 1280, 390 and 200% text, in both themes');
})().catch(e => { console.error(e); process.exit(1); });
