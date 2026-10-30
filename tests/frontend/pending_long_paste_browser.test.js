// A long multi-line paste sent from the chat (#11166, the operator's bug report with log lines and a box-drawing screen) is ONE pending bubble with all of its text, and it goes when the transcript has the message.
// The live row's pending_sends lists the same message cut at 1000 characters (the second screens' copy): this screen took that for another message, drew it as a second bubble (the one that showed the text cut off
// mid-word), and the first bubble used up the transcript's text, so the cut one stayed 'Sent' (a yellow dot) for ever. A second screen, which has only the cut copy, shows it and settles it when the transcript has
// the message, wrapped as Claude Code wraps a paste (<pasted_content id="N">...</pasted_content id="N">). Run against an isolated dev server.
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    try {
        await Page.enable();
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired();
        const S = `(window.__coralStatic || '/static/')`;
        await waitFor(`!!window.__coralReady`, 'the page');
        await ev(`(async () => { const pm = await import(${S} + 'pending_messages.js'); const lc = await import(${S} + 'live_chat.js');
            window.__pm = pm; window.__lc = lc; const box = document.createElement('div'); box.id = 'lp-box'; box.className = 'chat-messages chat-prose'; document.body.appendChild(box); return true; })()`);
        // about 3 KB: paragraphs, a log with <...> and quotes, a box-drawing screen, tabs and trailing spaces, a last line that is the one that was lost
        const para = (n) => `Describe the bug ${n}: In a team with Pi workers, Coral pastes each board notification ("You have N unread messages on the message board. Run 'coral-board read' to see them.") into the agent's editor, but never presses Enter.`;
        const TEXT = ['Bug report for coral', '', para(1), '', 'To Reproduce', '', para(2), 'Launch a team with POST /api/sessions/launch-team: a claude Orchestrator and two pi workers.', '', 'Logs (session ids shortened)',
            '05:30:35 INFO automation: job <b1c2> started (cwd="/tmp/x", args=[--model "a b"])', '05:30:36 WARN pty:  paste  \t sent 412 bytes <pasted_content id="7"> to pi-1', '05:30:37 INFO nudge: deliver err=<nil> retry=2',
            '┌──────────────────────────────┐', '│ editor                       │', '│ You have 3 unread messages…  │', '└──────────────────────────────┘',
            para(3), para(4), para(5), para(6), para(7), para(8), para(9), 'THE LAST LINE: coral-board read, then reply with ZEBRA-9.'].join('\n');
        check(`the paste is long and multi-line (${TEXT.length} chars)`, TEXT.length > 2500 && TEXT.split('\n').length > 15);
        const box = `document.getElementById('lp-box')`;
        const sync = sid => ev(`(() => { window.__pm.syncPendingBubbles(${box}, ${JSON.stringify(sid)}); return true; })()`);
        const pendingTexts = async sid => { await sync(sid); return ev(`[...${box}.querySelectorAll('.chat-bubble.pending')].map(e => e.textContent.replace(/\\s+/g, ' ').trim())`); };
        // the server's copy in the live row: the first 1000 characters (pendingSendsRunes), cut mid-word
        const CUT = Array.from(TEXT).slice(0, 1000).join('');
        const row = (sid, id) => `window.__pm.syncSendsFromRow({ session_id: ${JSON.stringify(sid)}, pending_sends: [{ id: ${JSON.stringify(id)}, text: ${JSON.stringify(CUT)}, at: new Date(Date.now() - 500).toISOString() }] })`;
        // as Claude Code records a paste: wrapped, the lines' trailing spaces and tabs changed, CRLF line ends
        const recorded = `<pasted_content id="1">\n` + TEXT.split('\n').map(l => l.replace(/\t/g, '    ').replace(/ +$/, '')).join('\r\n') + `\n</pasted_content id="1">`;
        const bring = sid => ev(`(() => { const msg = { type: 'user', content: ${JSON.stringify(recorded)}, timestamp: new Date().toISOString() }; window.__pm.rememberUserMessage(${JSON.stringify(sid)}, msg); window.__lc.renderTranscript([msg], ${box}, 'claude'); window.__pm.syncPendingBubbles(${box}, ${JSON.stringify(sid)}); return true; })()`);

        console.log('1. This screen sent it: the live row lists the same message, cut');
        await ev(`window.__pm.addPendingMessage('lp-1', ${JSON.stringify(TEXT)}, Date.now() - 1000); ${row('lp-1', 'r1')}; true`);
        let pend = await pendingTexts('lp-1');
        check('ONE pending bubble, not the cut copy as a second one', pend.length === 1, JSON.stringify(pend.map(t => t.length)));
        check('it shows the whole paste, to its last line', pend.length > 0 && pend[0].includes('ZEBRA-9.'), pend.length ? pend[0].slice(-100) : '');
        await bring('lp-1');
        check('the transcript has it: no pending bubble is left', (await pendingTexts('lp-1')).length === 0, JSON.stringify((await pendingTexts('lp-1')).map(t => t.slice(-40))));
        const shown = await ev(`${box}.textContent.replace(/\\s+/g, ' ').trim()`);
        check('the chat shows the whole of the transcript text, to its last line, without the paste tags', shown.includes('ZEBRA-9.') && shown.includes('05:30:37 INFO nudge') && !/pasted_content/.test(shown), shown.slice(-100));

        console.log('2. Another screen sent it: this one has only the live row\'s cut copy');
        await ev(`${row('lp-2', 'r2')}; true`);
        pend = await pendingTexts('lp-2');
        check('one pending bubble with the words the row has', pend.length === 1 && pend[0].startsWith('Bug report for coral') && !pend[0].includes('ZEBRA-9.'), JSON.stringify(pend.map(t => t.length)));
        await bring('lp-2');
        check('the transcript has the whole message: the cut copy is settled', (await pendingTexts('lp-2')).length === 0, JSON.stringify((await pendingTexts('lp-2')).map(t => t.slice(-40))));

        console.log('3. The transcript came first, then the live row still lists it');
        await bring('lp-3');
        await ev(`${row('lp-3', 'r3')}; true`);
        check('nothing is drawn as pending', (await pendingTexts('lp-3')).length === 0, JSON.stringify(await pendingTexts('lp-3')));

        console.log('4. A short message another screen sent is still adopted next to a long one');
        await ev(`window.__pm.syncSendsFromRow({ session_id: 'lp-4', pending_sends: [{ id: 'r4', text: 'ok', at: new Date(Date.now() - 500).toISOString() }] }); true`);
        check('the short message is a pending bubble', (await pendingTexts('lp-4')).length === 1);
    } finally { try { await client.close(); } catch (_) {} }
})().catch(e => { console.error(e); process.exit(1); });
