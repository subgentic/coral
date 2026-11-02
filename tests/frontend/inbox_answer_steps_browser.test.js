// #11981 (from #11946, found with a real two-question AskUserQuestion): answering a multi-question dialog from the Inbox row now goes to its end. The route answers 409 "prompt still open" after a question because the
// dialog moved on; the row reads the screen again and draws the next question's choices (saying which question they are for), and the last step, "Ready to submit your answers?", gets a Submit answers button that says
// exactly what will be sent. A Submit is sent only while the screen still shows the same review step with the same answers; if it changed nothing is sent and the row is drawn again. Hidden characters in the dialog's
// words are written out of the line. The chat reply and the answer route are stubbed with a three-step dialog; 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`window.__posts = []; window.__step = 0; window.__answers = 'Red · Small';
            const SCREENS = [
                () => ({ question: 'Which colour?', ask_id: 'a1', options: [{ n: 1, label: 'Red', action: 'select' }, { n: 2, label: 'Blue', action: 'select' }, { n: 3, label: 'Type something.', action: 'text' }, { n: 4, label: 'Chat about this', action: 'chat' }] }),
                () => ({ question: 'Which size?', ask_id: 'a2', options: [{ n: 1, label: 'Small', action: 'select' }, { n: 2, label: 'Large', action: 'select' }, { n: 3, label: 'Type something.', action: 'text' }, { n: 4, label: 'Chat about this', action: 'chat' }] }),
                () => ({ question: 'Ready to submit your answers?', ask_id: 'a3', options: [{ n: 1, label: 'Submit answers', action: 'select' }, { n: 2, label: 'Cancel', action: 'select' }], review: [{ question: 'Which colour?', answer: window.__answers.split(' · ')[0] }, { question: 'Which size?\\u202e', answer: window.__answers.split(' · ')[1] }] }),
                // #11997 (QA): a review step whose FIRST option is Cancel (then Edit, then Submit answers): only the option that says Submit is the button, whatever its number; and one with no Submit at all has no button
                () => ({ question: 'Ready to submit your answers?', ask_id: 'a5', options: [{ n: 1, label: 'Cancel', action: 'select' }, { n: 2, label: 'Edit answers', action: 'select' }, { n: 3, label: 'Submit answers', action: 'select' }], review: [{ question: 'Which colour?', answer: 'Red' }] }),
                () => ({ question: 'Ready to submit your answers?', ask_id: 'a6', options: [{ n: 1, label: 'Cancel', action: 'select' }, { n: 2, label: 'Edit answers', action: 'select' }], review: [{ question: 'Which colour?', answer: 'Red' }] }),
                // the Mobile Beta Tester's phone check: a question whose second choice has a word the permission filter holds back ("Switch to ..."): a partial list that does not say so reads as the whole
                () => ({ question: 'Which signup flow should the new customers see first?', ask_id: 'a7', options: [{ n: 1, label: 'Short form: name and email only', action: 'select' }, { n: 2, label: 'Switch to the long form with company and role', action: 'select' }, { n: 3, label: 'Type something.', action: 'text' }, { n: 4, label: 'Chat about this', action: 'chat' }] }),
                () => ({ question: 'Ready to submit your answers?', ask_id: 'a8', options: [{ n: 1, label: 'Submit answers', action: 'select' }, { n: 2, label: 'Cancel', action: 'select' }], review: [{ question: 'Which signup flow should the new customers see first?', answer: 'Short form: name and email only' }, { question: 'Which plan should the guide recommend to a small team?', answer: 'Team plan billed yearly, with priority support' }] }),
            ];
            const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase(), json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
                if (m === 'POST' && /\\/answer-prompt$/.test(url)) { const body = JSON.parse(o.body); window.__posts.push(body); const was = window.__step; if (window.__step < 2) { window.__step++; return json({ code: 'answer_sent_prompt_open', error: 'The answer was sent, but the agent prompt is still open. Check the terminal.' }, 409); } return json({ answered: body.label, ok: true }); }
                if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return json({ messages: [], total: 0, prompt_options: SCREENS[window.__step]() });
                return real(u, o); };
            true`);
        let n = 0;
        const draw = async () => ev(`(async () => { const m = await import(${MOD} + 'inbox_answer.js'); const cell = m.answerCell({ name: 'claude-st${++n}', session_id: 'sess-st${n}', agent_type: 'claude', waiting_since: 't${n}', waiting_summary: 'Wants to know: Which colour', waiting_kind: 'question' }); document.body.append(cell); window.__cell = cell; return true; })()`);
        const buttons = () => ev(`[...window.__cell.querySelectorAll('button:not(.inbox-dismiss)')].map(b => b.textContent)`);
        const words = () => ev(`(window.__cell.querySelector('.inbox-answer-step') || {}).textContent || ''`);
        await draw();
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 2`, 'step 1: Red and Blue', 6000);
        assert.deepEqual(await buttons(), ['Red', 'Blue'], 'step 1 is the first question: its two choices');
        // step 1 -> 2: the route says "still open" because the dialog moved on; the next question's choices are drawn, saying which question they are for
        await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')].find(b => b.textContent === 'Red').click(); true`);
        await waitFor(`!!window.__cell.querySelector('.inbox-answer-step') && window.__cell.querySelectorAll('button.inbox-answer').length === 2`, 'step 2 is drawn', 6000);
        assert.deepEqual(await buttons(), ['Small', 'Large'], 'step 2: the next question\'s choices');
        assert.equal(await words(), 'Which size?', 'and it says which question these are for');
        // step 2 -> 3: "Ready to submit": one Submit button that says what it sends; no Cancel; hidden characters are out of the line
        await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')].find(b => b.textContent === 'Small').click(); true`);
        await waitFor(`[...window.__cell.querySelectorAll('button.inbox-answer')].some(b => b.textContent === 'Submit answers')`, 'step 3: Submit answers', 6000);
        assert.deepEqual(await buttons(), ['Submit answers'], 'the review step offers Submit answers and nothing else (no Cancel)');
        const said = await words();
        assert.equal(said.trim(), 'Submit these answers? Which colour?: Red Which size?: Small', 'it says exactly what will be sent, one line for the heading and one for each question with its answer, with no hidden character: ' + said);
        // the screen changes under the row (another answer): nothing is sent, the row is drawn again with the new review
        const sentBefore = await ev(`window.__posts.length`);
        await ev(`window.__answers = 'Red · Large'; true`);
        await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')].find(b => b.textContent === 'Submit answers').click(); true`);
        await waitFor(`/That question changed/.test(document.body.textContent)`, 'a changed review is said', 6000);
        assert.equal(await ev(`window.__posts.length`), sentBefore, 'nothing was sent for the review that changed');
        await waitFor(`/Red: ?Large|Which size\\?: Large/.test((window.__cell.querySelector('.inbox-answer-step') || {}).textContent || '')`, 'the row shows the new review', 6000);
        // now the review is stable: one press sends Submit answers, once, for that screen
        await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')].find(b => b.textContent === 'Submit answers').click(); true`);
        await waitFor(`window.__posts.length === ${sentBefore} + 1`, 'the Submit is sent', 6000);
        const last = await ev(`window.__posts.at(-1)`);
        assert.deepEqual([last.n, last.label, last.ask_id, last.agent_type], [1, 'Submit answers', 'a3', 'claude'], 'one fixed choice of the screen it read: ' + JSON.stringify(last));
        await waitFor(`/Answered: Submit answers/.test(window.__cell.textContent)`, 'the row says Answered', 6000);
        // #11997 (Security): two reviews that differ only AFTER the 80th character of an answer are different reviews: the click compares the whole uncut text, so nothing is sent; a cut field wears an ellipsis and its
        // hover is the uncut text
        const LONG = 'x'.repeat(100);
        await ev(`window.__step = 2; window.__answers = 'Red · ${LONG}A'; true`);
        const draw2 = await draw();
        await waitFor(`!!window.__cell.querySelector('.inbox-answer-step')`, 'the long review is drawn', 6000);
        const line = await ev(`(() => { const t = window.__cell.querySelector('.inbox-answer-step'); return { text: t.textContent, title: t.title }; })()`);
        assert.ok(/x{79}…/.test(line.text), 'a cut field wears an ellipsis: ' + line.text);
        assert.ok(line.title.includes('x'.repeat(100) + 'A'), 'the hover is the uncut text, to its last character: ' + line.title);
        const before2 = await ev(`window.__posts.length`);
        await ev(`window.__answers = 'Red · ${LONG}B'; true`); // the same ask id, the same first 80 characters: only the tail differs
        await ev(`[...window.__cell.querySelectorAll('button.inbox-answer')].find(b => b.textContent === 'Submit answers').click(); true`);
        await waitFor(`/That question changed/.test(document.body.textContent)`, 'a review that changed after character 80 is said', 6000);
        assert.equal(await ev(`window.__posts.length`), before2, 'nothing was sent for it');
        // #11997 (QA's SHOULD): Cancel or Edit first in the review step is never drawn as Submit
        await ev(`window.__step = 3; true`); await draw();
        await waitFor(`!!window.__cell.querySelector('.inbox-answer-step')`, 'the review with Cancel first is drawn', 6000);
        assert.deepEqual(await buttons(), ['Submit answers'], 'only the option that says Submit is a button, though Cancel is first');
        const nBefore = await ev(`window.__posts.length`);
        await ev(`window.__step = 3; [...window.__cell.querySelectorAll('button.inbox-answer')].find(b => b.textContent === 'Submit answers').click(); true`);
        await waitFor(`window.__posts.length === ${nBefore} + 1`, 'the Submit is sent', 6000);
        const sent3 = await ev(`window.__posts.at(-1)`);
        assert.deepEqual([sent3.n, sent3.label], [3, 'Submit answers'], 'it sends the number of the Submit option, not the first option: ' + JSON.stringify(sent3));
        await ev(`window.__step = 4; true`); await draw();
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the row has read the screen; nothing is to be drawn
        assert.equal(await ev(`window.__cell.querySelectorAll('button.inbox-answer').length`), 0, 'a review step with no Submit option has no button: Cancel and Edit are never taken for it');
        // the phone check (Mobile Beta Tester): a question one of whose choices the permission filter holds back says so (More choices than these) instead of reading as a whole list; its first question is named when the row's own words do not say it; the
        // review's pairs are each on their own line on a phone
        await ev(`window.__step = 5; true`); await draw();
        await new Promise(r => setTimeout(r, 400)); // sleep-ok: the row has read the screen
        assert.deepEqual(await buttons(), ['Short form: name and email only'], 'the one-time choice stays a button, as before (a lasting choice is left to Open)');
        assert.match(await ev(`window.__cell.textContent`), /More choices: open the agent/, 'and the row says that some choices were left out: a partial list must not read as the whole list');
        await ev(`window.__step = 0; true`); await draw();
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 2`, 'step 1 again', 6000);
        await ev(`window.__cell.remove(); (async () => { const m = await import(${MOD} + 'inbox_answer.js'); const cell = m.answerCell({ name: 'claude-nw', session_id: 'sess-nw', agent_type: 'claude', waiting_since: 'tnw', waiting_kind: 'question' }); document.body.append(cell); window.__cell = cell; })(); true`);
        await waitFor(`window.__cell.querySelectorAll('button.inbox-answer').length === 2`, 'a row with no words of its own', 6000);
        assert.equal(await words(), 'Which colour?', 'the question is named when the row\'s own words do not carry it');
        await ev(`window.__step = 6; window.__cell.remove(); (async () => { const m = await import(${MOD} + 'inbox_answer.js'); const cell = m.answerCell({ name: 'claude-rv', session_id: 'sess-rv', agent_type: 'claude', waiting_since: 'trv', waiting_summary: 'Wants to know: x', waiting_kind: 'question' }); document.body.append(cell); window.__cell = cell; })(); true`);
        await waitFor(`window.__cell.querySelectorAll('.inbox-answer-step-line').length === 3`, 'the review is three lines', 6000);
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const ys = await ev(`[...window.__cell.querySelectorAll('.inbox-answer-step-line')].map(l => Math.round(l.getBoundingClientRect().top))`);
        assert.ok(ys[0] < ys[1] && ys[1] < ys[2], 'on a phone the heading and each question with its answer are on their own lines: ' + JSON.stringify(ys));
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        console.log('PASS a multi-question dialog is answered from the Inbox row to its end: next question, Submit with its words, a changed review refused');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
