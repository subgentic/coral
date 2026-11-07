// A comment sent to an agent says where the agent has it (#14129, the Operator: "I'd like this to tell me when the agent has read the message"): Sent to A -> Read by A, <time> (the server saw the agent's own read call
// return the comment: asks[].read_at) -> A replied. Never "unread": a view with no read_at (a guest's, or an older server's) says only Sent. The line moves on by itself while the panel is open (the panel's own poll).
// 1280 and 390 px. The comments are stubbed at the page's fetch, with the asks the server's view carries. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const HEX = 'f'.repeat(64);
const MD = ['# Plan', '', 'A plan to read.', ''].join('\n');
const ago = ms => new Date(Date.now() - ms).toISOString();
const ASK = (agent, extra = {}) => ({ agent, open: true, replies: 0, seen: false, nudged: false, ...extra });
const COMMENTS = [
    { id: 1, parent_id: null, anchor: { whole: true }, body: 'Sent, no sign yet.', asks: [ASK('Writer A', { read_at: '' })] },
    { id: 2, parent_id: null, anchor: { whole: true }, body: 'Read three minutes ago.', asks: [ASK('Writer B', { seen: true, read_at: ago(3 * 60000) })] },
    { id: 3, parent_id: null, anchor: { whole: true }, body: 'Answered twice.', asks: [ASK('Writer C', { seen: true, replies: 2, read_at: ago(10 * 60000) })] },
    { id: 4, parent_id: null, anchor: { whole: true }, body: 'Not sent to anyone.', asks: [] },
    { id: 5, parent_id: null, anchor: { whole: true }, body: 'A view with no read_at at all.', asks: [ASK('Writer D', { nudged: true })] },
    { id: 6, parent_id: null, anchor: { whole: true }, body: 'An older server: seen, no read_at key at all.', asks: [ASK('Writer E', { seen: true })] },
    { id: 7, parent_id: null, anchor: { whole: true }, body: 'One comment, three agents, three states.', asks: [ASK('Writer F'), ASK('Writer G', { seen: true, read_at: ago(5 * 60000) }), ASK('Writer H', { seen: true, replies: 1, read_at: ago(8 * 60000) })] },
].map(c => ({ ...c, author: { kind: 'owner', issuer: 'local', subject: 'Operator' }, created_at: ago(20 * 60000) }));

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
            await ev(`localStorage.clear(); globalThis.__coralCommentsPollMs = 300; window.__cs = ${JSON.stringify(COMMENTS)}; (() => { const real = window.fetch, json = (o, s = 200) => Promise.resolve(new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (url.includes('/api/artifacts/${HEX}/comments') && m === 'GET') return json({ comments: window.__cs.map(c => ({ ...c, deleted: false, mine: true, can: { reply: true, edit: false, delete: false, resolve: true } })), locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} });
                    if (url.includes('/api/artifacts/${HEX}')) return Promise.resolve(new Response(${JSON.stringify(MD)}, { status: 200, headers: { 'Content-Type': 'text/markdown' } }));
                    return real(u, o); }; return true; })()`);
            await ev(`(async () => { const v = await import(${S} + 'artifact_viewer.js'); v.openArtifactViewer(${JSON.stringify(HEX)}, { filename: 'plan.md', board: 'ask-team' }); return true; })()`);
            await waitFor(`!!document.querySelector('.ac-toggle')`, `${at}the comments toggle`, 8000);
            await ev(`(() => { const t = document.querySelector('.ac-toggle'); if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); return true; })()`);
            await waitFor(`document.querySelectorAll('#artifact-viewer .ac-card').length >= 7`, `${at}the seven comments`, 8000);
            const line = id => ev(`(() => { const p = document.querySelector('#artifact-viewer .ac-card[data-id="${id}"] .ac-ask-status'); return p && { text: p.textContent.replace(/\\s+/g, ' ').trim(), names: [...p.children].map(e => e.textContent.trim()), times: [...p.querySelectorAll('[title]')].map(e => e.title).filter(t => /^\\d{4}-\\d\\d-\\d\\dT/.test(t)) }; })()`);
            const [l1, l2, l3, l4, l5, l6, l7] = [await line(1), await line(2), await line(3), await line(4), await line(5), await line(6), await line(7)];
            check(l1 && /^Sent to Writer A\b/.test(l1.text) && !/\bread\b|\breplied\b/i.test(l1.text), `${at}an ask with no sign yet says Sent to the agent: ` + JSON.stringify(l1));
            check(l2 && l2.text === 'Read by Writer B, 3 minutes ago' && l2.times.length === 1 && Date.parse(l2.times[0]), `${at}an ask the agent has read says Read by it with the time, the exact time in the tooltip: ` + JSON.stringify(l2));
            check(l3 && l3.text === 'Writer C replied (2 times)', `${at}an ask the agent answered says it replied: ` + JSON.stringify(l3));
            check(l4 && l4.text === 'Not sent to an agent yet', `${at}a comment sent to no one says so: ` + JSON.stringify(l4));
            check(l5 && /^Sent to Writer D\b/.test(l5.text) && /reminded/.test(l5.text) && !/\bread\b|unread|not read/i.test(l5.text), `${at}no read_at in the view is unknown: it says Sent and never claims unread or read: ` + JSON.stringify(l5));
            // an older server: 'seen' (the comments-GET stamp) and no read_at key: read, without a time, never a guessed one
            check(l6 && l6.text === 'Read by Writer E' && l6.times.length === 0, `${at}an older server's seen with no read_at says Read by the agent with no time: ` + JSON.stringify(l6));
            // one comment sent to several agents, each in its own state, in the server's order
            check(l7 && l7.text === 'Sent to Writer F (already asked); Read by Writer G, 5 minutes ago; Writer H replied' && l7.names.includes('Writer F') && l7.names.includes('Writer G') && l7.names.includes('Writer H'), `${at}one comment sent to three agents says each agent's own state (sent / read with its time / replied): ` + JSON.stringify(l7));
            // the three move on independently: F reads it, G replies
            await ev(`window.__cs[6].asks[0].read_at = new Date().toISOString(); window.__cs[6].asks[1].replies = 2; true`);
            await waitFor(`(document.querySelector('#artifact-viewer .ac-card[data-id="7"] .ac-ask-status')?.textContent || '').replace(/\\s+/g, ' ').trim() === 'Read by Writer F, just now; Writer G replied (2 times); Writer H replied'`, `${at}each of the three agents moves on by itself`, 8000);
            check(l1.names.includes('Writer A') && l2.names.includes('Writer B') && l3.names.includes('Writer C'), `${at}each agent's name is its own element (the link to its chat, or its label when it is not running): ` + JSON.stringify([l1.names, l2.names, l3.names]));
            // the line moves on by itself while the panel is open: the agent reads the comment, the next poll draws it
            await ev(`window.__cs[0].asks[0].read_at = new Date().toISOString(); true`);
            await waitFor(`/^Read by Writer A, just now$/.test((document.querySelector('#artifact-viewer .ac-card[data-id="1"] .ac-ask-status')?.textContent || '').trim())`, `${at}the line moves from Sent to Read by itself`, 8000);
            // ... and then to replied
            await ev(`window.__cs[0].asks[0].replies = 1; true`);
            await waitFor(`/^Writer A replied$/.test((document.querySelector('#artifact-viewer .ac-card[data-id="1"] .ac-ask-status')?.textContent || '').trim())`, `${at}and from Read to replied by itself`, 8000);
            check(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `${at}no horizontal overflow`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a comment sent to an agent says Sent, then Read (with the time), then replied, and never claims unread');
})().catch(e => { console.error(e); process.exit(1); });
