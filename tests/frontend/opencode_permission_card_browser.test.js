// opencode's permission card (#11395, Security's MUST): the card shows the WHOLE request the server sends (up to 4,000 bytes) as text in a wrapped, scrolling, monospace box, so the person cannot approve what
// they cannot see. A request the server says can only be rejected (only_reject, with its note) offers Reject alone, whatever the answers list says. The patterns and "and N more patterns" are shown, and the
// Allow always label carries what it stops asking about. Stub of the server's shape (pending.input and prompt_options), at 1280 and 390.
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
            const card = (input, labels) => ev(`(async () => { const NI = await import(${S} + 'needs_input_card.js'), st = (await import(${S} + 'state.js')).state; const sid = 'oc-sid';
                const row = { session_id: sid, name: 'work', agent_type: 'opencode', waiting_for_input: true, waiting_summary: 'Wants to use bash' }; st.liveSessions = [row];
                NI.pendingToolBySession.clear(); NI.promptOptionsBySession.clear(); NI.loginBySession.clear();
                NI.pendingToolBySession.set(sid, { tool_use_id: 'perm_1', tool_name: 'bash', input: ${JSON.stringify(input)} });
                NI.promptOptionsBySession.set(sid, { question: 'Allow opencode to run this command?', options: ${JSON.stringify(labels)}.map((label, i) => ({ n: i + 1, label, action: 'select', selected: i === 0 })), ask_id: 'perm_1' });
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
            // 1. a request of 4,000 bytes: all of it is in the box, wrapped, in a box that scrolls, as text
            let r = await card({ command: LONG, patterns: ['ls *'] }, ['Allow once', ALWAYS, 'Reject']);
            assert.equal(r.target, LONG, at + 'the whole 4,000 bytes are in the box, none cut');
            assert.equal(r.wrapsX, true, at + 'the box wraps: nothing to scroll sideways'); assert.ok(r.scrolls && /auto|scroll/.test(r.overflowY) && r.h <= 320, at + `the box scrolls and stays short (${r.h}px, ${r.overflowY})`);
            assert.ok(r.mono, at + 'the box is monospace'); assert.ok(r.focusable && /request|command/i.test(r.named), at + `a keyboard can scroll the box and it is named: ${r.named}`);
            assert.ok(r.pageFits, at + 'the page does not grow sideways');
            // 2. 600 bytes with the marker written out and markup in it: text, never elements
            r = await card({ command: HOSTILE }, ['Allow once', ALWAYS, 'Reject']);
            assert.equal(r.target, HOSTILE, at + 'the marker and the markup are shown as written'); assert.ok(!r.img && !r.pwn, at + 'markup in the request is text');
            // 3. only_reject: the note's words and Reject alone, whatever the answers list says
            const NOTE = 'This request is longer than the 4000 bytes shown, so it cannot be allowed from here. Read it in the terminal, or reject it.';
            r = await card({ command: LONG.slice(0, 4000), only_reject: true, note: NOTE }, ['Allow once', ALWAYS, 'Reject']);
            assert.ok(r.text.includes(NOTE), at + 'the note is on the card');
            assert.deepEqual(r.buttons.map(b => b.label), ['Reject'], at + `Reject alone: ${JSON.stringify(r.buttons.map(b => b.label))}`);
            await shot(`opencode-only-reject-${w}`);
            // 4. a clean 400-byte request: three answers, the patterns and "and N more patterns", the Allow always label whole
            r = await card({ command: CLEAN, patterns: ['ls *', 'git status*'], more_patterns: 'and 2 more patterns' }, ['Allow once', ALWAYS, 'Reject']);
            assert.equal(r.target, CLEAN, at + 'the clean command is shown whole');
            assert.deepEqual(r.buttons.map(b => b.label).sort(), ['Allow once', ALWAYS, 'Reject'].sort(), at + 'three answers (a phone sets the standing one apart): ' + JSON.stringify(r.buttons.map(b => b.label)));
            const always = r.buttons.find(b => b.label === ALWAYS);
            assert.ok(always.text.includes('ls *, git status* and 2 more patterns') && r.buttons.every(b => b.fits), at + `Allow always says what it stops asking about, and fits: ${JSON.stringify(always)}`);
            assert.ok(r.text.includes('ls *') && r.text.includes('and 2 more patterns'), at + 'the patterns and the count of the rest are on the card');
            await shot(`opencode-clean-${w}`);
        }
        console.log('PASS opencode permission card: the whole request, Reject alone when it must be, the scope of Allow always');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
