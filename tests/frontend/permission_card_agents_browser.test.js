// #11399: every agent's permission card shows the whole request or says it cannot, and offers only the refusing answers then. Claude and Pi send the tool they are about to run (pending.input); Codex, agy and Gemini
// send the prompt read from the screen (prompt_options.target, only_reject, note). A request the server marks only_reject offers No or Reject alone whatever the answers list, Claude's "No" included (the first
// version kept only "Reject"); a hidden character that reaches the card is written out; a clean request keeps every answer. Stub of the server's shapes, at 1280 and 390.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const CLEAN = ('git status && ls -la && ').padEnd(400, 'echo ok; ').slice(0, 400); // 400 clean bytes
const HOSTILE = 'echo start; ' + 'a'.repeat(560) + ' <U+202E>gnirts<img src=x onerror="window.__pwn=1">'; // ~600 bytes with the marker written out and markup that must stay text
const LONG = ('x'.repeat(99) + ' ').repeat(40).slice(0, 4000); // 4,000 bytes of wrappable text
const ALWAYS = 'Allow always: do not ask again for ls *, git status* and 2 more patterns';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const card = (agentType, input, labels, extra) => ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state; const sid = 'oc-sid';
                const row = { session_id: sid, name: 'work', agent_type: ${JSON.stringify(agentType)}, waiting_for_input: true, waiting_summary: 'Wants to use bash' }; st.liveSessions = [row];
                NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
                if (${JSON.stringify(input)}) NI.pendingToolBySession.set(sid, { tool_use_id: 'perm_1', tool_name: 'Bash', input: ${JSON.stringify(input)} });
                NI.promptOptionsBySession.set(sid, { ...${JSON.stringify(extra || {})}, question: 'Do you want to proceed?', options: ${JSON.stringify(labels)}.map((label, i) => ({ n: i + 1, label, action: 'select', selected: i === 0 })), ask_id: 'perm_1' });
                document.getElementById('q-box')?.remove(); const box = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'q-box', className: 'chat-messages chat-prose' }));
                box.style.cssText = 'position:fixed;left:0;top:0;width:' + Math.min(innerWidth, 560) + 'px;max-height:100vh;overflow:auto;z-index:99999;background:var(--bg-primary);padding:12px;box-sizing:border-box';
                NI.syncNeedsInputCard(box, row);
                const c = box.querySelector('.chat-needs-input'), t = c.querySelector('.cni-target');
                const cs = t && getComputedStyle(t), code = t && t.querySelector('code');
                return { text: c.textContent, target: t ? t.textContent : null, wrapsX: t ? t.scrollWidth <= t.clientWidth + 1 : null, h: t ? Math.round(t.getBoundingClientRect().height) : null, scrolls: t ? t.scrollHeight > t.clientHeight + 1 : null,
                    overflowY: cs && cs.overflowY, mono: code ? /mono|courier|consolas|menlo/i.test(getComputedStyle(code).fontFamily) : null, focusable: t ? t.tabIndex >= 0 : null, named: t ? (t.getAttribute('aria-label') || '') : '',
                    img: !!c.querySelector('img'), pwn: !!window.__pwn, buttons: [...c.querySelectorAll('button[data-n][data-action=select]')].map(b => ({ label: b.dataset.label, text: b.textContent.replace(/^\\d+/, ''), fits: b.scrollWidth <= b.clientWidth + 1 })), pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
                    note: c.querySelector('.cni-note') ? c.querySelector('.cni-note').textContent : null }; })()`);
            const at = `${w}: `;
            const CLEAN = 'git status && ' + 'echo ok; '.repeat(40);              // ~400 clean bytes
            const NOTE = 'This request is longer than the 4000 bytes shown, so it cannot be allowed from here. Read it in the terminal, or reject it.';
            const YNA = ['Yes', "Yes, and don't ask again for this command", 'No'];
            const names = r => r.buttons.map(b => b.label);
            // 1. Claude: a clean request keeps all its answers; only_reject keeps "No" alone (the first version kept only a label that starts "Reject": Claude's refusal is "No")
            let r = await card('claude', { command: CLEAN }, YNA);
            assert.equal(r.target, CLEAN, at + 'a clean request is shown whole'); assert.deepEqual(names(r).sort(), [...YNA].sort(), at + 'and keeps every answer');
            r = await card('claude', { command: 'echo start <U+202E>gnirts', only_reject: true, note: NOTE }, YNA);
            assert.deepEqual(names(r), ['No'], at + 'only_reject: "No" alone, not nothing: ' + JSON.stringify(names(r))); assert.ok(r.text.includes(NOTE), at + 'with the words that say why');
            // 2. Pi: the same, with Reject
            r = await card('pi', { command: 'x'.repeat(4000), only_reject: true, note: NOTE }, ['Allow', 'Reject']);
            assert.deepEqual(names(r), ['Reject'], at + 'Pi: Reject alone');
            // 3. a hidden character that reaches the card (an older server, or a field the server did not review) is written out, never drawn raw
            r = await card('claude', { command: 'echo ok \u202e rm' }, YNA);
            assert.ok(!r.target.includes('\u202e') && r.target.includes('<U+202E>'), at + 'written out: ' + JSON.stringify(r.target));
            // 4. Codex, agy, Gemini: the screen's target is the request on the card, and screen.only_reject offers No alone
            for (const agent of ['codex', 'agy', 'gemini']) {
                r = await card(agent, null, YNA, { target: CLEAN });
                assert.equal(r.target, CLEAN, at + agent + ': the lines above the question are the request on the card'); assert.deepEqual(names(r).sort(), [...YNA].sort(), at + agent + ': a clean one keeps every answer');
                r = await card(agent, null, YNA, { target: 'echo <U+202E>gnirts', only_reject: true, note: NOTE });
                assert.deepEqual(names(r), ['No'], at + agent + ': only_reject: No alone'); assert.ok(r.text.includes(NOTE), at + agent + ': the note is on the card');
                assert.equal(r.target, 'echo <U+202E>gnirts', at + agent + ': the marker the server wrote is shown as written');
            }
            // 5. no target on the screen and no pending tool: nothing is invented
            r = await card('codex', null, YNA, {});
            assert.equal(r.target, null, at + 'no request text, no box');
            await shot(`permission-card-${w}`);
        }
        console.log('PASS permission cards: the whole request or only the refusing answers, for every agent type');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
