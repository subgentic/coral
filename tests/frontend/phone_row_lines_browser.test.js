// With Show summary and Show model on, a phone Agents row keeps Option A's grid (#10872, the phone pass on ci/2.0.4: #10816's lines met #10691's rows): the summary and model lines start under the name, as the status line does
// (within 1 px), a long summary ends in an ellipsis inside the row, and the rows keep their dividers and add no page scrollbar. 390 px, touch; both lines on against both off.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const LONG = 'Ship the release plan for the quarter, with every dependency listed, the owners named, the dates agreed and the risks written down in one place for the review';
    const ROWS = [
        { session_id: 'l1', name: 'coral-go', display_name: 'Orchestrator', agent_type: 'claude', summary: LONG, model: 'claude-opus-5-5', working_directory: '/work/coral', repo_name: 'coral' },
        { session_id: 'l2', name: 'coral-two', display_name: 'Backend Dev', agent_type: 'claude', summary: 'Short one', model: 'claude-opus-5-5', working_directory: '/work/coral', repo_name: 'coral' },
    ];
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        const draw = async (summary, model) => {
            await ev(`try { localStorage.setItem('coral-show-summary', '${summary}'); localStorage.setItem('coral-show-model', '${model}'); } catch (e) {} true`);
            await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(ROWS)}; T.render.renderLiveSessions(T.state.liveSessions); const m = await import((window.__coralStatic || '/static/') + 'mobile.js'); m.syncMobileAgentList(); return true; })()`);
            await waitFor(`document.querySelectorAll('#mobile-session-list .session-group-item').length === 2`, 'the rows', 6000);
            return ev(`(() => { const rows = [...document.querySelectorAll('#mobile-session-list .session-group-item')]; const de = document.documentElement;
                const left = e => e ? Math.round(e.getBoundingClientRect().left * 10) / 10 : null;
                const textLeft = e => { if (!e) return null; const r = document.createRange(); r.selectNodeContents(e); const b = r.getClientRects()[0]; return b ? Math.round(b.left * 10) / 10 : null; };
                return { rows: rows.map(li => { const info = li.querySelector('.session-info'), s = li.querySelector('.session-line2'), m = li.querySelector('.session-model'), name = li.querySelector('.session-label-name') || li.querySelector('.session-label');
                    const ss = s && getComputedStyle(s), cs = getComputedStyle(info, '::after'), lr = li.getBoundingClientRect(), sr = s && s.getBoundingClientRect();
                    return { name: textLeft(name), summary: textLeft(s), model: textLeft(m), statusMargin: cs.marginLeft, infoLeft: left(info), nameBoxLeft: left(name), overflow: ss ? ss.textOverflow + '/' + ss.overflow + '/' + ss.whiteSpace : null, summaryFits: sr ? sr.right <= lr.right + 0.5 : null, clipped: s ? s.scrollWidth > s.clientWidth : null, border: getComputedStyle(li).borderBottomWidth + ' ' + getComputedStyle(li, '::after').height, h: Math.round(lr.height) }; }),
                    pageH: de.scrollHeight - innerHeight, pageW: de.scrollWidth - innerWidth, bodyScrolls: document.scrollingElement.scrollHeight > innerHeight + 1 }; })()`);
        };
        const off = await draw('false', 'false');
        const on = await draw('true', 'true');
        console.log(JSON.stringify({ off, on }));
        for (const [i, r] of on.rows.entries()) {
            const status = r.infoLeft + parseFloat(r.statusMargin) + 0; // the status line's left: the info's own margin-left (Option A's --row-dot-block)
            if (Math.abs(r.summary - r.name) > 1) problems.push(`row ${i}: the summary starts at ${r.summary}, the name at ${r.name}`);
            if (Math.abs(r.model - r.name) > 1) problems.push(`row ${i}: the model line starts at ${r.model}, the name at ${r.name}`);
            if (!r.summaryFits) problems.push(`row ${i}: the summary runs past the row`);
        }
        const long = on.rows[0];
        if (!/^ellipsis\/hidden\/nowrap$/.test(long.overflow) || !long.clipped) problems.push(`the long summary does not end in an ellipsis inside the row: ${long.overflow}, clipped ${long.clipped}`);
        if (on.pageW > 0) problems.push(`the page is ${on.pageW} px wider than the screen`);
        if (on.bodyScrolls && !off.bodyScrolls) problems.push('the page itself scrolls with both lines on (a page scrollbar), it did not with both off');
        for (const [i, r] of on.rows.entries()) if (r.border !== off.rows[i].border) problems.push(`row ${i}: its divider changed with the lines on: ${off.rows[i].border} to ${r.border}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'a phone row with Show summary and Show model on:\n  ' + problems.join('\n  '));
    console.log('PASS a phone row keeps its grid with Show summary and Show model on');
})().catch(e => { console.error(e); process.exit(1); });
