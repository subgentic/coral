// The ask and the Operator's decision side by side (#14445, U5 of goal #233): in a task's story an ask entry and the decision that answered it (the decision's ask_id is the ask's message_id) are ONE block: the ask, then "You decided" with the decision chip and your words
// under it; the decision is not drawn again on its own. A decision whose ask is not on the page stays on its own and still names its question. Oldest first. Drawn by the real story module (thread_story.js) over the real page,
// with /api/thread answered by the page. Words are text (hidden characters written out). 1280 and 390 px.
const assert = require('node:assert/strict');
const { touchTap } = require('./helpers/touch_tap');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(async () => { const prev = window.fetch.bind(window), at = n => new Date(Date.now() - n * 60000).toISOString();
                const E = [ { kind: 'task_event', id: 'e1', event: 'created', at: at(120) },
                    { kind: 'ask', id: 'a1', message_id: 71, asker: 'Reviewer', line: 'Which docs format do you want?', state: 'answered', at: at(100) },
                    { kind: 'file', id: 'f1', name: 'Docs draft.md', by: 'Reviewer', state: 'in review', at: at(90) },
                    { kind: 'ask', id: 'a2', message_id: 72, asker: 'Reviewer', line: 'Ship it tonight or wait?', state: 'open', at: at(80) },
                    { kind: 'decision', id: 'd1', action: 'answer', actor: 'operator', item_kind: 'question', item_id: '71', ask_id: 71, title: 'Which docs format do you want?', asker: 'Reviewer', note: '@Reviewer Markdown please', at: at(70) },
                    { kind: 'decision', id: 'd2', action: 'approve', actor: 'operator', item_kind: 'file', item_id: 'a'.repeat(64), title: 'Docs draft.md', note: '', at: at(60) },
                    { kind: 'decision', id: 'd3', action: 'answer', actor: 'operator', item_kind: 'question', item_id: '55', ask_id: 55, title: 'An older question about colours', asker: 'Reviewer', note: '@Reviewer Blue', at: at(50) },
                    { kind: 'ask', id: 'a3', message_id: 73, asker: 'Rev\u202eiewer', line: 'Merge the s\u200bpike branch?', state: 'answered', at: at(45) },
                    { kind: 'decision', id: 'd4', action: 'answer', actor: 'operator', item_kind: 'question', item_id: '73', ask_id: 73, title: 'Merge the spike branch?', asker: 'Reviewer', note: '@Reviewer Not yet, wait for the \u202eflag', at: at(40) },
                    { kind: 'decision', id: 'd5', action: 'answer', actor: 'operator', item_kind: 'question', item_id: '73', ask_id: 73, title: 'Merge the spike branch?', asker: 'Reviewer', note: '@Reviewer Go ahead now', at: at(30) },
                    { kind: 'task_event', id: 'e2', event: 'done', at: at(5) } ];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href); if (u.pathname !== '/api/thread') return prev(url, opts); const desc = [...E].reverse(), after = u.searchParams.get('after'); window.__threadReads = (window.__threadReads || 0) + 1; return Promise.resolve(Response.json(after ? { entries: desc.slice(7), more: false, cursor: '' } : { entries: desc.slice(0, 7), more: true, cursor: 'c1' })); };
                const { storyNode } = await import((window.__coralStatic || '/static/') + 'thread_story.js');
                const host = document.createElement('div'); host.id = 'pair-host'; host.className = 'inbox-needs-results'; host.style.cssText = 'position: fixed; inset: 64px 0 0 0; overflow: auto; background: var(--bg-primary, #111); z-index: 99999; padding: 8px 0;';
                document.body.append(host); host.append(storyNode('pair-team', 12)); return true; })()`);
            await waitFor(`document.querySelectorAll('#pair-host .thread-list li').length > 0`, `${at}the story is drawn`, 10000);
            // the first page holds only the newest seven: the answer to ask 71 is on it, its ask is not: the decision stands on its own for now; 'Show earlier' brings the ask and the two join
            const firstPage = await ev(`[...document.querySelectorAll('#pair-host .thread-list > li')].map(li => li.textContent.replace(/\\s+/g, ' ').trim())`);
            assert.ok(firstPage.some(t => /Markdown please/.test(t)) && !firstPage.some(t => /You decided/.test(t) && /Markdown please/.test(t)), `${at}on the first page a decision whose ask is on the earlier page stands on its own: ${JSON.stringify(firstPage)}`);
            await ev(`(() => { const b = document.querySelector('#pair-host .thread-earlier'); b.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`);
            const eb = await ev(`(() => { const b = document.querySelector('#pair-host .thread-earlier'), r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: Math.round(r.height) }; })()`);
            if (mobile) await touchTap(client, { x: eb.x, y: eb.y }); else { await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: eb.x, y: eb.y }); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: eb.x, y: eb.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: eb.x, y: eb.y, button: 'left', clickCount: 1 }); }
            await waitFor(`document.querySelectorAll('#pair-host .thread-list > li').length >= 8 && !document.querySelector('#pair-host .thread-earlier:not([hidden])')`, `${at}the earlier page is read`, 8000);
            await new Promise(r => setTimeout(r, 300)); // sleep-ok: the list settles
            const out = await ev(`(() => { const lis = [...document.querySelectorAll('#pair-host .thread-list > li')].map(li => ({ text: li.textContent.replace(/\\s+/g, ' ').trim(), paired: li.classList.contains('thread-paired'), decided: [...li.querySelectorAll('.thread-decided')].map(d => d.textContent.replace(/\\s+/g, ' ').trim()), chips: [...li.querySelectorAll('.thread-decision')].map(c => c.textContent.trim()), inside: !!li.querySelector('.thread-decided') })); const r = document.querySelector('#pair-host').getBoundingClientRect(); return { lis, hs: document.documentElement.scrollWidth - document.documentElement.clientWidth, over: document.querySelector('#pair-host').scrollWidth - document.querySelector('#pair-host').clientWidth }; })()`);
            const ask1 = out.lis.find(l => /Which docs format do you want\?/.test(l.text) && l.paired), ask2 = out.lis.find(l => /Ship it tonight/.test(l.text));
            assert.ok(ask1 && ask1.inside && ask1.chips.includes('Answered') && /Your answer: Markdown please/.test(ask1.decided.join(' ')) && /You decided/.test(ask1.decided.join(' ')), `${at}the answered ask holds its decision, with the chip and your words: ${JSON.stringify(ask1)}`);
            assert.ok(!/@Reviewer/.test(ask1.decided.join(' ')), `${at}and the answer is clean, without the @mention`);
            assert.ok(ask2 && !ask2.paired && !ask2.inside, `${at}an ask nobody answered stays a plain ask: ${JSON.stringify(ask2)}`);
            const standalone = out.lis.filter(l => !l.paired && l.chips.length && !l.inside);
            assert.equal(out.lis.filter(l => /Markdown please/.test(l.text)).length, 1, `${at}the answered decision is drawn once, not again on its own: ${JSON.stringify(out.lis.map(l => l.text.slice(0, 50)))}`);
            assert.ok(standalone.some(l => /Approved/.test(l.text) && /Docs draft\.md/.test(l.text)) && standalone.some(l => /An older question about colours/.test(l.text) && /Your answer: Blue/.test(l.text)), `${at}a decision with no ask on the page stays on its own and names its question: ${JSON.stringify(standalone.map(l => l.text))}`);
            const ask3 = out.lis.find(l => /Merge the s.{0,8}pike branch/.test(l.text) && l.paired);
            assert.ok(ask3 && ask3.decided.length === 2 && /Not yet, wait for the/.test(ask3.decided.join(' ')) && /Go ahead now/.test(ask3.decided.join(' ')), `${at}an ask decided twice holds both decisions, in order: ${JSON.stringify(ask3)}`);
            assert.ok(ask3.decided.join(' ').indexOf('Not yet') < ask3.decided.join(' ').indexOf('Go ahead now'), `${at}the earlier decision first`);
            assert.ok(/<U\+202E>/.test(ask3.text) && /<U\+200B>/.test(ask3.text) && !/[\u202e\u200b]/.test(ask3.text), `${at}a paired block with hidden characters in the asker, the ask line and a decision writes them out and draws none: ${ask3.text}`);
            assert.ok(out.lis.filter(l => /Markdown please/.test(l.text)).length === 1 && out.lis.find(l => /Which docs format/.test(l.text) && l.paired), `${at}after 'Show earlier' the decision joined its ask, once`);
            const order = out.lis.map(l => l.text);
            assert.ok(/Task created/.test(order[0]) && /Task done/.test(order[order.length - 1]), `${at}oldest first, ending on Task done`);
            assert.ok(out.hs <= 0 && out.over <= 0, `${at}no sideways scroll: ${JSON.stringify([out.hs, out.over])}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/story-pairing-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS in a task story the ask and the decision that answered it are one block, joined by ask_id, at 1280 and 390');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
