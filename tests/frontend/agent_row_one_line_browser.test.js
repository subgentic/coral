// An agent is one line in the sidebar (#9686, UI/UX's #9358, Goal #79 item 26): the state dot, the name (13/500) and at most one chip, 36 px a row on a desktop and 44 px on a phone. The goal, the provider and
// model, the branch and the held-message lines are not on the row (the hover tip and the agent's page have them); the one chip is "Needs input" for an agent that asks, else "Message held" for an agent whose
// paste was held, else none. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const base = o => Object.assign({ name: 'coral-go', display_name: '', agent_type: 'claude', summary: 'Ship the release plan', model: 'claude-opus-5-5', branch: 'feat/long-branch-name', repo_name: 'coral', working_directory: '/work/coral-project', context_pct: 10, working: false, waiting_for_input: false, not_started: false, stuck: false, sleeping: false, awaiting_user: false, done: false, board_project: '', board_unread: 0 }, o);
    const ROWS = [
        base({ session_id: 'o1', display_name: 'Worker', working: true, thinking_actual: 'high' }), // the newest turn ran at High: the header's model line and Details say it (#9826)
        base({ session_id: 'o2', display_name: 'Asker', waiting_for_input: true, waiting_kind: 'permission' }),
        base({ session_id: 'o3', display_name: 'Held', board_project: 'team-a', board_unread: 2, skipped_send: { why: 'a prompt is open', what: 'nudge' } }),
        base({ session_id: 'o4', display_name: 'Asker and held', waiting_for_input: true, waiting_kind: 'question', board_project: 'team-a', board_unread: 1, skipped_send: { why: 'a prompt is open', what: 'nudge' } }),
        base({ session_id: 'o5', display_name: 'Idler' }),
        base({ session_id: 'o6', display_name: 'Jammed', stuck: true }),
        base({ session_id: 'o7', display_name: 'Silent', not_started: true }),
    ];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, root, rowH] of [['1280', 1280, 800, false, '#live-sessions-list', [34, 38]], ['390', 390, 844, true, '#mobile-session-list', [55, 57]]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`(async () => { T.state.liveSessions = ${JSON.stringify(ROWS)}; T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            await waitFor(`document.querySelectorAll('${root} .session-group-item').length >= 7`, `${label}: the rows`, 6000);
            const rows = await ev(`[...document.querySelectorAll('${root} .session-group-item')].map(li => { const r = li.getBoundingClientRect(), name = li.querySelector('.session-label'); return { id: li.dataset.sessionId, h: Math.round(r.height), weight: name ? getComputedStyle(name).fontWeight : null, nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '16')) : 0, chips: [...li.querySelectorAll('.chip')].filter(c => c.getClientRects().length).map(c => c.textContent.trim()), label: li.getAttribute('aria-label') || '', status: (st => st ? st.textContent.trim() : null)(li.querySelector('.session-status-line')), statusDrawn: (st => !!st && st.getClientRects().length > 0)(li.querySelector('.session-status-line')), statusColor: (st => st ? getComputedStyle(st).color : '')(li.querySelector('.session-status-line')), dotDrawn: (d => !!d && getComputedStyle(d).visibility === 'visible' && d.getBoundingClientRect().width >= 6)(li.querySelector('.session-dot')), dotBg: (d => d ? getComputedStyle(d).backgroundColor : '')(li.querySelector('.session-dot')), chipWrap: [...li.querySelectorAll('.chip')].filter(c => c.getClientRects().length).map(c => { const g = document.createRange(); g.selectNodeContents(c); return new Set([...g.getClientRects()].map(x => Math.round(x.top))).size; }), chipPx: (c => c ? parseFloat(getComputedStyle(c).fontSize) : 0)(li.querySelector('.session-state-pill')), chipColor: (c => c ? getComputedStyle(c).color : '')(li.querySelector('.session-state-pill')), extra: ['.session-goal', '.session-model', '.session-worktree-line', '.session-line2', '.session-held-line', '.session-mobile-meta', '.session-mobile-banner-row', '.session-ctx-pill'].filter(s => li.querySelector(s)), dot: !!li.querySelector('.session-dot') }; })`);
            if (!mobile) { // the hover tile fills the 36 px row with the name's line in the middle, and does not touch the row above or the header (#9822); no native title (it covered the next row)
                const geo = await ev(`[...document.querySelectorAll('${root} .session-group-item')].map(li => { const r = li.getBoundingClientRect(), nr = li.querySelector('.session-name-row').getBoundingClientRect(), prev = li.previousElementSibling && li.previousElementSibling.getBoundingClientRect(); return { above: Math.round(nr.top - r.top), below: Math.round(r.bottom - nr.bottom), gap: prev ? Math.round(r.top - prev.bottom) : 2, title: li.querySelector('.session-label').hasAttribute('title') }; })`);
                assert.ok(geo.length >= 7 && geo.every(g => Math.abs(g.above - g.below) <= 1), label + ': the name is centred in its row (space above equals space below): ' + JSON.stringify(geo));
                assert.ok(geo.every(g => g.gap >= 2), label + ': a row\'s tile has at least 2 px above it (not touching the header or the row above): ' + JSON.stringify(geo));
                assert.ok(geo.every(g => !g.title), label + ': the label has no native title: ' + JSON.stringify(geo));
                { const c = await ev(`(() => { const r = document.querySelector('${root} .session-group-item').getBoundingClientRect(); return [Math.round(r.left + 80), Math.round(r.top + r.height / 2)]; })()`); await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: c[0], y: c[1] }); await waitFor(`!!document.querySelector('${root} .session-group-item:hover')`, label + ': the first row is hovered', 3000); await shot('agent-row-hover-' + label); await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 }); } // the hover tile, for the picture
            }
            const by = id => rows.find(r => r.id === id);
            for (const r of rows) {
                assert.ok(r.h >= rowH[0] && r.h <= rowH[1], `${label}: ${r.id} is one line, ${rowH[0]} to ${rowH[1]} px (${r.h}) ${JSON.stringify(r)}`);
                assert.deepEqual(r.extra, [], `${label}: ${r.id} has no goal, model, branch, held or phone-card line ${JSON.stringify(r)}`);
                assert.ok(r.dot && r.chips.length <= (mobile ? 0 : 1), `${label}: ${r.id} is a dot, a name and at most one chip ${JSON.stringify(r)}`);
                assert.ok([400, 600].includes(Number(r.weight)), `${label}: the name is the sidebar row style, 400 (600 on the current agent), nothing bolder (${r.weight}; #9926)`);
            }
            assert.ok(by('o5').dotDrawn && by('o5').dotBg && by('o5').dotBg !== 'rgba(0, 0, 0, 0)', `${label}: an idle agent draws its grey dot (a row with no dot has no state, #9784) ${JSON.stringify(by('o5'))}`);
            if (!mobile) {
                assert.deepEqual(by('o1').chips.concat(by('o5').chips), [], `${label}: a working agent and an idle one have no chip`);
                for (const r of rows) assert.ok(r.chipWrap.every(n => n === 1), `${label}: ${r.id}'s chip words are on one line ${JSON.stringify(r.chipWrap)}`);
                assert.deepEqual([by('o2').chips[0], by('o4').chips[0]], ['Needs input', 'Needs input'], `${label}: one chip, one word: the reason (Permission, Question) is not in the pill ${JSON.stringify([by('o2').chips, by('o4').chips])}`);
                assert.match(by('o2').chips[0] || '', /Needs input/, `${label}: an agent that asks has the Needs input chip`);
                if (mobile) assert.equal(by('o2').chipPx, 13, `${label}: the phone's chip is 13 px (the one thing that says an agent waits), the row still one line ${JSON.stringify(by('o2'))}`);
                assert.deepEqual(by('o3').chips, ['Message held'], `${label}: an agent whose message was held has "Message held"`);
                assert.match(by('o4').chips[0] || '', /Needs input/, `${label}: Needs you wins over the hold`);
                assert.equal(by('o4').chips.length, 1, `${label}: one chip`);
                assert.match(by('o6').chips.join(), /^Stuck$/, `${label}: a stuck agent has the Stuck chip: a state that asks something of a person is a word on the row (UI/UX, #9700) ${JSON.stringify(by('o6'))}`);
                assert.ok(by('o6').chipColor && by('o6').chipColor === by('o2').chipColor && by('o7').chipColor === by('o2').chipColor, `${label}: Stuck and Check terminal are the same amber as Needs input ${JSON.stringify([by('o2').chipColor, by('o6').chipColor, by('o7').chipColor])}`);
                assert.match(by('o7').chips.join(), /^Check terminal$/, `${label}: an agent with nothing yet has the Check terminal chip ${JSON.stringify(by('o7'))}`);
            } else { // a phone has no chips (#10691, Option A): the state is the row's second line, a real span, one muted sentence; Needs input, Stuck and Check terminal are the warning colour
                const st = id => by(id).status;
                assert.ok(rows.every(r => r.statusDrawn), `${label}: every row draws its status line ${JSON.stringify(rows.map(r => [r.id, r.status, r.statusDrawn]))}`);
                assert.equal(st('o1'), 'Working', `${label}: a working agent says Working`); assert.equal(st('o5'), 'Idle', `${label}: an idle agent says Idle`);
                assert.match(st('o2') || '', /^Needs input/, `${label}: an agent that asks says Needs input (the reason follows it)`); assert.match(st('o4') || '', /^Needs input/, `${label}: Needs you wins over the hold`);
                assert.equal(st('o6'), 'Stuck', `${label}: a stuck agent says Stuck (#9700)`); assert.equal(st('o7'), 'Check terminal', `${label}: an agent with nothing yet says Check terminal`);
                assert.ok(by('o2').statusColor === by('o6').statusColor && by('o7').statusColor === by('o2').statusColor && by('o2').statusColor !== by('o1').statusColor, `${label}: Needs input, Stuck and Check terminal share the warning colour, the others are muted ${JSON.stringify([by('o1').statusColor, by('o2').statusColor, by('o6').statusColor, by('o7').statusColor])}`);
            }
            assert.match(by('o3').label, /, message held$/, `${label}: the held row's name says it too ${JSON.stringify(by('o3').label)}`); assert.ok(!/message held/.test(by('o4').label) && !/message held/.test(by('o1').label), `${label}: and only that row's name does`);
            await shot(`agent-rows-${label}`);
            if (!mobile) { // at 200% text the held chip wraps under its name instead of squeezing it (the look pass, #9804: "Held" was drawn as "H.")
                await ev(`window.__fs0 = document.documentElement.style.fontSize; document.documentElement.style.fontSize = '32px'; true`); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the layout settles at the new size
                const h = await ev(`(() => { const li = document.querySelector('${root} .session-group-item[data-session-id="o3"]'), l = li.querySelector('.session-label'), c = li.querySelector('.session-held-chip'); return { whole: l.scrollWidth <= l.clientWidth + 1, text: l.textContent.trim(), labelW: Math.round(l.getBoundingClientRect().width), chipBelow: c.getBoundingClientRect().top >= l.getBoundingClientRect().bottom - 1, chipInRow: c.getBoundingClientRect().bottom <= li.getBoundingClientRect().bottom + 1 }; })()`);
                await ev(`document.documentElement.style.fontSize = window.__fs0 || ''; true`);
                assert.ok(h.whole && h.chipBelow && h.chipInRow, `${label}: at 200% text the name is whole, the held chip is under it and inside its own row (not over the next one): ${JSON.stringify(h)}`);
            }
            console.log(`PASS ${label}: one line, a dot, a name, at most one chip`);
            if (mobile) { // a phone's header has no room: one tap on Details shows the folder, branch and model
                await ev(`window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
                await waitFor(`document.getElementById('agent-phone-details') && !document.getElementById('agent-phone-details').hidden && document.getElementById('agent-bar-more').getClientRects().length > 0`, 'the ⋯ button for the Details on a phone', 8000);
                const sum = await ev(`(() => { const d = document.getElementById('agent-phone-details'), m = document.getElementById('agent-bar-more'), r = m.getBoundingClientRect(); return { open: d.open, w: Math.round(r.width), h: Math.round(r.height), name: m.getAttribute('aria-label'), controls: m.getAttribute('aria-controls'), summaryHidden: getComputedStyle(d.querySelector('summary')).display === 'none' }; })()`);
                assert.equal(sum.open, false, 'closed until asked'); assert.ok(sum.w >= 44 && sum.h >= 44 && sum.controls === 'agent-phone-details' && sum.summaryHidden, `a 44 px button in the header row opens the Details, which have no row of their own (#11056): ${JSON.stringify(sum)}`);
                await ev(`document.getElementById('agent-bar-more').click(); true`);
                const dd = await ev(`[...document.querySelectorAll('#agent-phone-details .facts-row')].filter(r => !r.hidden).map(r => r.querySelector('dt').textContent + ': ' + r.querySelector('dd').textContent)`);
                await shot('agent-details-390');
                assert.ok(dd.some(x => /^Context: ctx 10%/.test(x)) && dd.some(x => /^Folder: .*coral-project/.test(x)) && dd.some(x => /^Branch: .*long-branch-name/.test(x)) && dd.some(x => /^Model: .*Opus/.test(x)) && dd.some(x => /^Thinking[a-z ]*: High$/.test(x)), `Details has the folder, the branch and the model ${JSON.stringify(dd)}`);
                console.log('PASS 390: Details shows the folder, branch and model');
            }
            if (!mobile) { // the header is the state, the name (whole), the branch, the buttons and, last, the Chat/Terminal toggle at the right; the folder is the name's tip, the model is in Details (#9836, #9837, the operator)
                await ev(`window.selectLiveSession('coral-go', 'claude', 'o1'); true`);
                await waitFor(`!document.getElementById('terminal-header-branch')?.hidden && !document.getElementById('agent-phone-details')?.hidden`, 'the header: branch and Details', 8000);
                const hd = await ev(`(() => { const h = document.querySelector('#live-session-view .terminal-header'), id = document.getElementById('terminal-header-identity'), lab = document.getElementById('terminal-header-label'), tg = h.querySelector('.live-view-toggle'), acts = h.querySelector('.terminal-header-actions'), r = e => e.getBoundingClientRect();
                    return { noFolder: !document.getElementById('terminal-header-folder'), noModel: !document.getElementById('terminal-header-model'), text: (c => { const d = c.querySelector('#agent-phone-details'); if (d) d.remove(); return c.textContent.replace(/\\s+/g, ' '); })(h.cloneNode(true)), nameWhole: lab.scrollWidth <= lab.clientWidth, name: lab.textContent, branch: document.querySelector('#terminal-header-branch .terminal-branch-text').textContent, folderOnHeader: h.dataset.folder,
                        toggleInActions: tg.parentElement === acts, toggleAfterName: r(tg).left >= r(id).right, toggleLast: [...acts.children].filter(c => c.getClientRects().length).slice(-1)[0] === tg, toggleFarRight: [...acts.children].filter(c => c !== tg && c.getClientRects().length).every(c => r(c).right <= r(tg).left + 1), toggleRight: Math.round(r(h).right - r(tg).right), tabOrder: [...h.querySelectorAll('button, a[href], [tabindex="0"]')].filter(e => e.getClientRects().length).map(e => e.id || e.className.toString().slice(0, 24)), stateWord: !!document.getElementById('terminal-state-word') || /Idle|Working|Task assigned/.test(h.textContent), dotName: document.getElementById('terminal-status-dot').getAttribute('aria-label') }; })()`);
                await shot('agent-header-model-1280');
                assert.ok(hd.noFolder && hd.noModel && !/Opus|\/work\//.test(hd.text), `the header has no folder and no model line ${JSON.stringify(hd)}`);
                assert.ok(hd.nameWhole && hd.name === 'Worker', `the name is whole ${JSON.stringify(hd)}`);
                assert.ok(hd.branch.includes('long-branch-name') && hd.folderOnHeader === '/work/coral-project', `the branch stays; the folder is the header's tip text ${JSON.stringify(hd)}`);
                assert.ok(hd.toggleInActions && hd.toggleAfterName && hd.toggleLast && hd.toggleFarRight && hd.toggleRight >= 0 && hd.toggleRight <= 24, `the Chat/Terminal toggle is the last of the actions, at the far right after Search and Pop out ${JSON.stringify(hd)}`);
                assert.ok(!hd.stateWord && /\S/.test(hd.dotName || ''), `the header draws only the dot: no state word, the dot named for the state ${JSON.stringify(hd)}`);
                assert.equal(hd.tabOrder[0], 'terminal-header-identity', `the Tab order starts at the name ${JSON.stringify(hd.tabOrder)}`); assert.ok(/^live-view-btn-/.test(hd.tabOrder[hd.tabOrder.length - 1]), `and ends in the Chat/Terminal toggle, as it is drawn ${JSON.stringify(hd.tabOrder)}`);
                // the folder's full path is a tip on the name: on keyboard focus, and on hover at a mouse (not a native title)
                await ev(`document.getElementById('terminal-header-identity').focus(); true`);
                const tip = await ev(`(() => { const h = document.querySelector('#live-session-view .terminal-header'); return { content: getComputedStyle(h, '::after').content, native: [...h.querySelectorAll('[title]')].filter(e => !e.closest('#agent-phone-details') && /work/.test(e.title)).length }; })()`);
                assert.equal(tip.content, '"/work/coral-project"', `focus on the name shows the folder as a tip ${JSON.stringify(tip)}`); assert.equal(tip.native, 0, 'and it is not a native title');
                await shot('agent-header-folder-tip-1280');
                await ev(`document.getElementById('terminal-header-identity').blur(); document.querySelector('#agent-phone-details > summary').click(); true`);
                const dd = await ev(`[...document.querySelectorAll('#agent-phone-details .facts-row')].filter(r => !r.hidden).map(r => r.querySelector('dt').textContent + ': ' + r.querySelector('dd').textContent)`);
                await shot('agent-details-1280');
                assert.ok(dd.some(x => /^Folder: .*coral-project/.test(x)) && dd.some(x => /^Branch: .*long-branch-name/.test(x)) && dd.some(x => /^Model: .*Opus 5\.5/.test(x)) && dd.some(x => /^Thinking[a-z ]*: High$/.test(x)) && dd.some(x => /^Context: ctx 10%/.test(x)), `Details has the folder, the branch, the model, the thinking level and the context at 1280 ${JSON.stringify(dd)}`);
                console.log('PASS 1280: the header is the state, the name, the branch and the buttons; Details has the rest');
                await Emulation.setDeviceMetricsOverride({ width: 1024, height: 800, deviceScaleFactor: 1, mobile: false });
                assert.equal(await ev(`(() => { const h = document.querySelector('#live-session-view .terminal-header'); return h.scrollWidth - h.clientWidth <= 1; })()`), true, '1024: the header does not overflow');
                console.log('PASS 1024: the header does not overflow');
            }
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
