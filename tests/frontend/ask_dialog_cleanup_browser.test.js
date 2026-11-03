// #12722: the approved question dialog, at desktop and phone widths, before and after attachments.
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
const fs = require('node:fs');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], check = (ok, msg) => { if (!ok) failures.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js'); window.__question = 'The release is ready. May DevOps retry the last macOS step?\\nFirst detail stays on its own line.\\nSecond detail stays on its own line.\\n\\n1. Apple accepted the app.\\n2. Other builds are green.'; await m.openAskDialog({ board: 'coral-go-team', asker: 'Orchestrator', kind: 'ask', id: 7, at: new Date(Date.now() - 60000).toISOString(), text: '@Operator ' + window.__question, goal_id: 196, goal_title: 'A very long goal title '.repeat(8), task_id: 12473, task_title: 'A very long task title '.repeat(8), buttons: [{ id: 1, label: 'Yes, add the retry', action: 'reply', state: 'pending' }, { id: 2, label: 'No', action: 'reply', state: 'pending' }] }, undefined, { goal() {}, task() {} }); return true; })()`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog .ac-add-image')`, 'image picker'); await ev(framesJs(5));
            const m = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), text = d.querySelector('.inbox-ask-text'), box = d.querySelector('textarea'), foot = d.querySelector('.inbox-ask-foot'), hint = d.querySelector('.ac-images-hint'), links = [...d.querySelectorAll('.inbox-ask-subject')]; const r = e => e.getBoundingClientRect(); return { title: d.querySelector('h2').textContent, body: text.textContent, bodyScroll: text.scrollHeight > text.clientHeight + 1, breaks: [...text.querySelectorAll('p')].some(p => getComputedStyle(p).whiteSpace === 'pre-line'), links: links.map(e => e.textContent), linkTitles: links.map(e => e.title), aboutHeight: r(d.querySelector('.inbox-ask-subjects')).height, whatHidden: [...d.querySelectorAll('.inbox-ask-offer-what')].every(e => r(e).width <= 1), rows: box.rows, boxHeight: r(box).height, hintHidden: !hint || !hint.getClientRects().length, pickerIcon: !d.querySelector('.ac-add-image').textContent.includes('Add image'), foot: [...foot.querySelectorAll('button')].map(b => ({ name: b.getAttribute('aria-label') || b.textContent, top: r(b).top, left: r(b).left, right: r(b).right, height: r(b).height })), overflow: d.scrollWidth > d.clientWidth + 1 }; })()`);
            check(m.title === 'Orchestrator · coral-go-team' && m.body.includes('The release is ready.') && m.breaks && !m.bodyScroll, width + ' question appears once, preserves breaks and has no inner scroller: ' + JSON.stringify(m));
            check(m.links.join('|') === 'Goal #196|Task #12473' && m.linkTitles.every(s => /very long/.test(s)) && m.aboutHeight <= 50, width + ' compact subject links with full hover titles');
            check(m.whatHidden && m.rows <= 3 && m.boxHeight < 120 && !m.hintHidden && m.pickerIcon && !m.overflow, width + ' compact offers, reply, image picker and visible sharing note: ' + JSON.stringify(m));
            check(m.foot.every(b => b.height >= 44 && b.left >= 0 && b.right <= width + 1), width + ' footer targets fit');
            const send = m.foot.at(-1), close = m.foot.find(b => b.name === 'Close');
            check(width === 1280 ? Math.abs(send.top - close.top) <= 1 : send.top > close.top, width + ' footer row on desktop, stacked Send on phone');
            const growth = await ev(`(() => { const b = document.querySelector('dialog.inbox-ask-dialog textarea'), old = b.getBoundingClientRect().height; b.value = 'Another line\\n'.repeat(8); b.dispatchEvent(new Event('input', { bubbles: true })); return { old, height: b.getBoundingClientRect().height, overflow: b.scrollHeight > b.clientHeight + 2 }; })()`);
            check(growth.height > growth.old && !growth.overflow, width + ' reply grows with typing');
            // A failed upload is still an added image and must show the sharing hint; no real upload is needed.
            await ev(`(() => { const real = window.fetch; window.fetch = (u,o) => String(u).includes('comment-images') ? Promise.resolve(new Response('{}', { status: 503 })) : real(u,o); const dt = new DataTransfer(); dt.items.add(new File(['test'], 'mock.png', { type: 'image/png' })); document.querySelector('dialog.inbox-ask-dialog textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog .ac-thumb')`, 'added picture');
            check(await ev(`document.querySelector('dialog.inbox-ask-dialog .ac-images-hint').getClientRects().length > 0`), width + ' sharing hint stays visible after image');
            await ev(`document.querySelector('dialog.inbox-ask-dialog .ac-thumb-remove').click(); document.querySelector('dialog.inbox-ask-dialog textarea').value = ''; document.querySelector('dialog.inbox-ask-dialog textarea').dispatchEvent(new Event('input')); document.querySelector('dialog.inbox-ask-dialog').scrollTop = 0; true`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR + '/ask-cleanup-' + width + '.png', Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const long = await ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), t = d.querySelector('.inbox-ask-text'); for (let i = 0; i < 50; i++) { const p = document.createElement('p'); p.textContent = 'Another detail of the question, kept visible in the dialog.'; t.append(p); } return { nested: t.scrollHeight > t.clientHeight + 1, scrolls: (innerWidth >= 1000 ? d.querySelector('.inbox-ask-reading') : d).scrollHeight > (innerWidth >= 1000 ? d.querySelector('.inbox-ask-reading') : d).clientHeight + 1 }; })()`);
            check(!long.nested && long.scrolls, width + ' long question scrolls the wide reader or narrow dialog, not the question body');
        }
    } finally { await client.close(); }
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('ask_dialog_cleanup_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
