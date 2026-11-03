// The Skills list's Show filter wears the shared field look (#12990, UI Reviewer's sweep S1): it was a bare select (13.33 px font, no padding, square corners) beside fields that are 13 px, padded and rounded. It is
// the shared .field now: the same font, padding and radius as the list's other fields, 32 px with a mouse and 44 px on a phone or touch, in both themes. The route is stood in at /api/skills.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const ROW = { id: '3'.repeat(32), name: 'pdf-forms', version: 2, digest: 'c'.repeat(64), description: 'Fill PDF forms.', status: 'approved', has_scripts: false, not_reviewable: false, publisher_kind: 'operator', file_count: 1, created_at: '2026-11-02T08:00:00Z', decided_at: '' };
const STUB = `(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin).pathname; if (p === '/api/skills' && (o.method || 'GET') === 'GET') return Promise.resolve(new Response(JSON.stringify({ skills: [${JSON.stringify(ROW)}] }), { status: 200, headers: { 'content-type': 'application/json' } })); return R(u, o); }; })();`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) for (const theme of ['dark', 'light']) {
            const tag = `${w} px ${theme}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/skills' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
            await waitFor(`!!document.querySelector('#skills-view select[aria-label="Show"]')`, `${tag}: the filter`, 10000);
            const f = await ev(`(() => { const s = document.querySelector('#skills-view select[aria-label="Show"]'), c = getComputedStyle(s), b = document.body; const ref = document.createElement('input'); ref.className = 'field field-dense'; document.body.append(ref); const r = getComputedStyle(ref); const out = { font: c.fontSize, fam: c.fontFamily === r.fontFamily, padL: parseFloat(c.paddingLeft), radius: parseFloat(c.borderTopLeftRadius), refRadius: parseFloat(r.borderTopLeftRadius), h: Math.round(s.getBoundingClientRect().height), border: c.borderTopWidth, refFont: r.fontSize }; ref.remove(); return out; })()`);
            check(`${tag}: the field font, not the browser's 13.33 px`, f.font === f.refFont && f.fam, JSON.stringify(f));
            check(`${tag}: padded and rounded like the shared field`, f.padL >= 8 && f.radius === f.refRadius && f.radius >= 4, JSON.stringify(f));
            check(`${tag}: ${mobile ? '44 px on a phone' : '32 px with a mouse'}`, mobile ? f.h >= 44 : (f.h >= 30 && f.h <= 36), JSON.stringify(f));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Skills filter field:\n  ' + problems.join('\n  '));
    console.log('PASS the Skills filter is the shared field: font, padding, radius, 32 px (44 on a phone), both themes');
})().catch(e => { console.error(e); process.exit(1); });
