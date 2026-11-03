// The New goal screen, part 1: the Writing room's layout and editor (#12724, direction A). A near-full-screen sheet on a desktop (title in large type, a roomy "What should be true" editor, Done when, the team and
// the driver as chips in the bar, Create goal at the right of the bar), a phone's own screen (a 56 px bar, the chips first in the body, the actions pinned), and a Markdown-lite toolbar (bold, italic, heading,
// bullets, checklist, code, link; Ctrl+B and Ctrl+I; Enter continues a list) that edits the text. It creates the same goal the old dialog did. 1280, 390 and 200% text. The two routes are stood in in the page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => { window.__posts = []; const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const url = new URL(String(u), location.href);
        if (/\\/api\\/board\\/[^/]+\\/subscribers/.test(url.pathname)) return json([{ subscriber_id: 'Lead-agent', job_title: 'Orchestrator', session_name: 'lead' }, { subscriber_id: 'Worker', job_title: 'Dev', session_name: 'w' }]);
        if (/\\/api\\/board\\/[^/]+\\/goals$/.test(url.pathname) && o && o.method === 'POST') { window.__posts.push(JSON.parse(o.body)); return json({ id: 77 }, 201); }
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const box = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
    const area = (value, from = value.length, to = from) => ev(`(() => { const t = document.getElementById('goal-new-description'); t.focus(); t.value = ${JSON.stringify(value)}; t.setSelectionRange(${from}, ${to}); return true; })()`);
    const tool = k => ev(`document.querySelector('.goal-tb[data-tool="${k}"]').click(); true`);
    const state = () => ev(`(() => { const t = document.getElementById('goal-new-description'); return { v: t.value, a: t.selectionStart, b: t.selectionEnd }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile, fs] of [[1280, 900, false, 16], [390, 844, true, 16], [1280, 900, false, 32], [390, 844, true, 32]]) {
            const tag = `${w} px ${fs === 32 ? '200% text' : '100%'}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; true`);
            await ev(`window.__created = []; import((window.__coralStatic || '/static/') + 'goal_editor.js').then(m => { m.openGoalEditor({ project: 'team-a', onCreated: (p, told) => { window.__created.push([p, told]); } }); return true; })`);
            await waitFor(`!!document.querySelector('dialog.goal-editor[open] #goal-new-title') && !document.querySelector('#goal-new-driver').disabled`, `${tag}: the screen and its drivers`, 8000);
            const dlg = await box('dialog.goal-editor'), ttl = await ev(`getComputedStyle(document.getElementById('goal-new-title')).fontSize`), out = await box('#goal-new-description');
            const chips = await ev(`[...document.querySelectorAll('.goal-scope')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`);
            if (!mobile && fs === 16) {
                check(`${tag}: a roomy sheet`, dlg.w >= 1100 && dlg.h >= 800, JSON.stringify(dlg));
                check(`${tag}: the editor is large`, out.h >= 300 && out.w >= 600, JSON.stringify(out));
                check(`${tag}: the title is in large type`, parseFloat(ttl) >= 28, ttl);
                const bar = await box('.goals-form-head'), act = await box('.goals-actions'), ch = await box('.goal-scopes');
                check(`${tag}: the chips and Create goal are in the bar`, ch.b <= bar.b + 2 && act.t <= bar.t + 4 && act.r > dlg.r - 60, JSON.stringify({ bar, act, ch }));
            }
            if (mobile && fs === 16) {
                const back = await box('.goals-form-back'), head = await box('.goals-form-head'), act = await box('.goals-actions'), ch = await box('.goal-scopes');
                check(`${tag}: a phone's screen: a 56 px bar, the chips first in the body, the actions pinned`, head.h <= 60 && back.w >= 44 && ch.t >= head.b && act.b >= h - 8 && dlg.w >= w - 1 && dlg.h >= h - 1, JSON.stringify({ head, back, ch, act, dlg }));
                const tb = await ev(`[...document.querySelectorAll('.goal-tb')].map(b => Math.round(b.getBoundingClientRect().height))`);
                check(`${tag}: the toolbar's buttons are 44 px`, tb.every(x => x >= 44), JSON.stringify(tb));
            }
            check(`${tag}: Team and Driver chips`, chips.length === 2 && /^Team/.test(chips[0]) && /^Driver/.test(chips[1]), JSON.stringify(chips));
            check(`${tag}: the page does not scroll sideways`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0 && (await ev(`(() => { const d = document.querySelector('dialog.goal-editor'); return d.scrollWidth - d.clientWidth; })()`)) <= 1);
            if (fs === 32) { const go = await box('.goals-actions .btn-primary'); check(`${tag}: Create goal is on screen at 200%`, go && go.r <= w + 1 && go.l >= 0 && go.t >= 0 && go.b <= h + 1, JSON.stringify(go)); }

            await shot(`editor-${w}-${fs}`);
            // the toolbar edits the text
            if (fs === 16) {
                await area('make it fast', 8, 12); await tool('bold');
                let s = await state(); check(`${tag}: Bold wraps the selection`, s.v === 'make it **fast**' && s.b - s.a === 4, JSON.stringify(s));
                await tool('bold'); s = await state(); check(`${tag}: Bold again takes the marks off`, s.v === 'make it fast', JSON.stringify(s));
                await area('make it fast', 8, 12); await tool('italic'); s = await state(); check(`${tag}: Italic`, s.v === 'make it *fast*', JSON.stringify(s));
                await area('one\ntwo', 0, 7); await tool('bullets'); s = await state(); check(`${tag}: Bullets go on every selected line`, s.v === '- one\n- two', JSON.stringify(s));
                await tool('bullets'); s = await state(); check(`${tag}: and come off again`, s.v === 'one\ntwo', JSON.stringify(s));
                await area('ship it', 0, 7); await tool('checks'); s = await state(); check(`${tag}: Checklist`, s.v === '- [ ] ship it', JSON.stringify(s));
                await area('Plan', 0, 4); await tool('heading'); s = await state(); check(`${tag}: Heading`, s.v === '## Plan', JSON.stringify(s));
                await area('run x', 4, 5); await tool('code'); s = await state(); check(`${tag}: Code`, s.v === 'run `x`', JSON.stringify(s));
                await area('see docs', 4, 8); await tool('link'); s = await state(); check(`${tag}: Link selects the address for typing`, s.v === 'see [docs](https://)' && s.v.slice(s.a, s.b) === 'https://', JSON.stringify(s));
                await area('a b', 2, 3);
                await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: process.platform === 'darwin' ? 4 : 2 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
                s = await state(); check(`${tag}: Ctrl or Cmd+B is Bold`, s.v === 'a **b**', JSON.stringify(s));
                await area('- one'); await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
                s = await state(); check(`${tag}: Enter on a bullet starts the next one`, s.v === '- one\n- ', JSON.stringify(s));
                await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
                s = await state(); check(`${tag}: Enter on an empty one ends the list`, s.v === '- one\n', JSON.stringify(s));
                const roles = await ev(`(() => { const b = document.querySelector('.goal-toolbar'); return { role: b.getAttribute('role'), names: [...b.querySelectorAll('.goal-tb')].map(x => x.getAttribute('aria-label')) }; })()`);
                check(`${tag}: a toolbar with named buttons`, roles.role === 'toolbar' && roles.names.length === 8 && roles.names.every(Boolean), JSON.stringify(roles));
                await ev(`document.querySelector('.goal-tb[data-tool="bold"]').focus(); true`);
                await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
                check(`${tag}: the arrow keys move along the toolbar`, (await ev(`document.activeElement.dataset.tool`)) === 'italic', await ev(`document.activeElement.dataset.tool`));

                // it creates the same goal the old dialog did
                await ev(`(() => { const t = document.getElementById('goal-new-title'); t.focus(); t.value = 'Importer is live'; document.getElementById('goal-new-done').value = 'A customer imports a CSV in a minute'; return true; })()`);
                await area('Customers can import **a CSV**.');
                await ev(`document.querySelector('.goals-actions .btn-primary').click(); true`);
                await waitFor(`window.__posts.length === 1`, `${tag}: the goal is created`, 6000);
                const post = await ev(`window.__posts[0]`);
                check(`${tag}: the same body as the old dialog`, post.title === 'Importer is live' && post.outcome === 'Customers can import **a CSV**.' && post.done_when === 'A customer imports a CSV in a minute' && post.driver === 'Lead-agent' && !!post.subscriber_id, JSON.stringify(post));
                await waitFor(`!document.querySelector('dialog.goal-editor') && window.__created.length === 1`, `${tag}: closed and reported`, 6000);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the New goal screen, layout and editor:\n  ' + problems.join('\n  '));
    console.log('PASS the New goal screen: layout, toolbar and create, at 1280, 390 and 200% text');
})().catch(e => { console.error(e); process.exit(1); });
