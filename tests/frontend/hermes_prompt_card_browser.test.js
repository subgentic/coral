// Hermes's approval and clarify prompts on the card (#12170, goal #192, the Hermes tester's #12042): an approval shows "Permission needed", the command it runs and its four answers (Allow once, for this session, to
// the permanent allowlist, Deny); a clarify is headed "Question" with the question and its options, never "Allow clarify?" under Permission. The server reads each from Hermes's own box on the screen (hermes_prompt_test.go
// holds the captured screens); here the chat reply carries what it read. At 1280 and 390 px. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const COMMAND = 'rm -rf /home/tester/dangerdir';
const APPROVAL = { kind: 'approval', title: 'Dangerous command: recursive delete', question: 'Allow this command to run?', target: COMMAND, options: [
    { n: 1, label: 'Allow once', selected: true, action: 'select', kind: 'allow_once' }, { n: 2, label: 'Allow for this session', action: 'select', kind: 'allow_always' },
    { n: 3, label: 'Add to permanent allowlist', action: 'select', kind: 'allow_always' }, { n: 4, label: 'Deny', action: 'select', kind: 'reject' }] };
const CLARIFY = { kind: 'question', question: 'Which colour should the report use?', options: [
    { n: 1, label: 'blue (Recommended)', selected: true, action: 'select' }, { n: 2, label: 'green', action: 'select' }, { n: 3, label: 'red', action: 'select' }] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            // the stand-in terminal: the chat reply of the Hermes agent carries whichever prompt is open
            await ev(`(() => {
                const inner = window.__innerFetch || (window.__innerFetch = window.fetch);
                window.__screen = null;
                window.fetch = (url, opts = {}) => {
                    if (/\\/api\\/sessions\\/live\\/hermes-q[^/?]*\\/chat\\?/.test(String(url))) return inner(url, opts).then(async r => { const d = await r.clone().json().catch(() => null); if (!d) return r;
                        d.pending = null; if (window.__screen) d.prompt_options = window.__screen; return new Response(JSON.stringify(d), { status: r.status, headers: { 'content-type': 'application/json' } }); });
                    return inner(url, opts);
                };
                return true; })()`);
            await ev(`window.__m.add('hermes-q', 'H', 0, { sleeping: false, agent_type: 'hermes' }); true`);
            await sleep(600); // sleep-ok: the first live list renders from several answers; no single completion event
            const open = async (screen, summary) => {
                await ev(`window.__screen = ${JSON.stringify(screen)}; import(${S} + 'state.js').then(st => { const row = st.state.liveSessions.find(s => s.session_id === 'hermes-q-id' || s.name === 'hermes-q'); Object.assign(row, { waiting_for_input: true, waiting_kind: 'permission', waiting_summary: ${JSON.stringify(summary)} }); return true; })`);
                await ev(`window.selectLiveSession('hermes-q', 'hermes', 'hermes-q-id', 'local'); true`);
                await waitFor(`!!document.querySelector('#live-history-messages .chat-needs-input .cni-answer')`, `${tag}: the card with its answers`, 8000);
                return ev(`(() => { const c = document.querySelector('#live-history-messages .chat-needs-input'); return { kicker: c.querySelector('.cni-kicker').textContent, text: c.textContent.replace(/\\s+/g, ' '), answers: [...c.querySelectorAll('.cni-answer-label')].map(x => x.textContent), target: (c.querySelector('.cni-target') || {}).textContent || '' }; })()`);
            };

            const a = await open(APPROVAL, 'Waiting for the user: approval');
            check(`${tag}: an approval is headed Permission needed`, /Permission needed/.test(a.kicker), a.kicker);
            check(`${tag}: it shows the command it would run`, a.target === COMMAND, a.target);
            check(`${tag}: and the four answers, Deny among them (a phone sets the standing ones apart, above)`, JSON.stringify([...a.answers].sort()) === JSON.stringify(['Add to permanent allowlist', 'Allow for this session', 'Allow once', 'Deny']), JSON.stringify(a.answers));

            const q = await open(CLARIFY, 'Waiting for the user: approval');
            check(`${tag}: a clarify is headed Question, not Permission needed`, /^Question$/.test(q.kicker), q.kicker);
            check(`${tag}: it shows the question and its options`, /Which colour should the report use\?/.test(q.text) && JSON.stringify(q.answers) === JSON.stringify(['blue (Recommended)', 'green', 'red']), JSON.stringify(q.answers));
            check(`${tag}: and no "Allow clarify?"`, !/Allow /.test(q.text), q.text.slice(0, 160));
        }
    } finally { /* the harness closes the browser */ }
    const failed = results.filter(r => !r).length;
    console.log(failed ? `${failed} FAILED` : `all ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
