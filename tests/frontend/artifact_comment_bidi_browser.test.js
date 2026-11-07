// A comment drawer shows another person's words safely (#14113, coral-hub's Security: the Hub passes bidirectional controls through so Arabic and Hebrew work, so a reversed-text spoof in a Hub comment is answered only by
// our display). In the artifact viewer's comments (the goal and diff drawers are the same panel): an override, embedding or isolate control in a comment's text or in its quoted text is NOT applied: a visible mark
// names its code point (as the markdown editor shows hidden characters) and the character is gone from the text the page draws; real Hebrew and Arabic text is left exactly as written and reads right to left by itself;
// every piece of comment text is its own isolate (dir=auto, unicode-bidi: isolate). 1280 and 390 px. The comments are stubbed at the page's fetch. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'e'.repeat(64);
const MD = ['# Release plan', '', 'Ship the report on Thursday, then the other files.', ''].join('\n');
const RLO = '\u202E', PDF = '\u202C', LRI = '\u2066', PDI = '\u2069';
const HEBREW = 'שלום עולם, האם התוכנית נכונה?';
const COMMENTS = [
    { id: 1, parent_id: null, anchor: { quote: 'Ship the report' }, body: `Please open report${RLO}fdp.exe${PDF} first.`, author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-3f2a' }, created_at: new Date(Date.now() - 600000).toISOString() },
    { id: 2, parent_id: null, anchor: { quote: `then the${RLO} other${PDF} files` }, body: HEBREW, author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-9c11' }, created_at: new Date(Date.now() - 500000).toISOString() },
    { id: 3, parent_id: null, anchor: { whole: true }, body: `A fine plan ${LRI}and nothing odd${PDI} about it.`, author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-4d0e' }, created_at: new Date(Date.now() - 400000).toISOString() },
    { id: 4, parent_id: null, anchor: { whole: true }, body: 'Plain English, nothing to mark.', author: { kind: 'hub', issuer: 'coral-hub', subject: 'hub-user-7a21' }, created_at: new Date(Date.now() - 300000).toISOString() },
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.clear(); (() => { const real = window.fetch, json = (o, s = 200) => Promise.resolve(new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })); const cs = ${JSON.stringify(COMMENTS)};
                window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (url.includes('/api/artifacts/${HEX}/comments') && m === 'GET') return json({ comments: cs.map(c => ({ ...c, deleted: false, mine: false, can: { reply: false, edit: false, delete: false, resolve: false } })), locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                    if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                    return real(u, o); }; return true; })()`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'ask-team' }); return true; })()`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown')`, `${at}the document`, 8000);
            await waitFor(`!!document.querySelector('.ac-toggle')`, `${at}the comments toggle`, 8000);
            await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#artifact-viewer .ac-card').length >= 4`, `${at}the four comments`, 8000);
            const m = await ev(`(() => { const card = id => document.querySelector('#artifact-viewer .ac-card[data-id="' + id + '"]'), info = (c, sel) => { const e = c.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e); return { text: e.textContent, dir: e.getAttribute('dir'), ub: cs.unicodeBidi, direction: cs.direction, marks: [...e.querySelectorAll('.bidi-mark')].map(x => ({ text: x.textContent, title: x.title, w: Math.round(x.getBoundingClientRect().width), ub: getComputedStyle(x).unicodeBidi, dir: getComputedStyle(x).direction })) }; };
                return [1, 2, 3, 4].map(id => ({ id, body: info(card(id), '.ac-body'), quote: info(card(id), '.ac-quote'), within: (() => { const c = card(id).getBoundingClientRect(), b = card(id).querySelector('.ac-body').getBoundingClientRect(); return b.left >= c.left - 1 && b.right <= c.right + 1; })() })); })()`);
            const [c1, c2, c3, c4] = m;
            // the spoof: the override is shown, not applied
            check(c1.body.text.includes('⟦U+202E⟧') && c1.body.text.includes('⟦U+202C⟧') && !/[\u202A-\u202E\u2066-\u2069]/.test(c1.body.text), `${at}an override and its pop are shown by code point and gone from the drawn text: ` + JSON.stringify(c1.body.text));
            check(c1.body.marks.length === 2 && c1.body.marks.every(x => x.w > 0 && x.ub === 'isolate' && x.dir === 'ltr') && /right-to-left override/.test(c1.body.marks[0].title) && /not applied/.test(c1.body.marks[0].title), `${at}each mark is visible, left to right, an isolate, and says what it is: ` + JSON.stringify(c1.body.marks));
            check(c1.body.text.replace(/⟦U\+[0-9A-F]{4}⟧/g, '') === 'Please open reportfdp.exe first.', `${at}the words around the marks are untouched: ` + JSON.stringify(c1.body.text));
            // an isolate pair is marked the same way
            check(c3.body.marks.length === 2 && /isolate/.test(c3.body.marks[0].title) && !/[\u2066-\u2069]/.test(c3.body.text), `${at}an isolate control is shown too: ` + JSON.stringify(c3.body));
            // the quoted text is the commenter's as well
            check(c2.quote && c2.quote.marks.length === 2 && !/[\u202A-\u202E]/.test(c2.quote.text), `${at}the quoted text's controls are shown, not applied: ` + JSON.stringify(c2.quote));
            // real right-to-left text is left exactly as written and reads right to left by itself
            check(c2.body.text === HEBREW && c2.body.marks.length === 0 && c2.body.direction === 'rtl', `${at}Hebrew is untouched, unmarked and reads right to left: ` + JSON.stringify([c2.body.text === HEBREW, c2.body.marks.length, c2.body.direction]));
            check(c4.body.text === 'Plain English, nothing to mark.' && c4.body.marks.length === 0 && c4.body.direction === 'ltr', `${at}plain English is untouched and reads left to right: ` + JSON.stringify(c4.body));
            // every piece of comment text is its own isolate
            check([c1, c2, c3, c4].every(c => c.body.dir === 'auto' && c.body.ub === 'isolate' && (!c.quote || c.quote.dir === 'auto' && c.quote.ub === 'isolate')) && [c1, c2, c3, c4].every(c => c.within), `${at}each comment text is its own isolate (dir=auto, unicode-bidi: isolate) and stays inside its card: ` + JSON.stringify(m.map(c => [c.id, c.body.dir, c.body.ub, c.within])));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a comment drawer shows another person\'s bidirectional controls by code point, leaves real Hebrew alone, and isolates every comment');
})().catch(e => { console.error(e); process.exit(1); });
