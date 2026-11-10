// #15030 (the Operator): a document's comment thread jumped on hover (each card's Edit/Delete row folded to nothing and opened under the pointer, moving every comment below it), and the comments column could not be resized.
// 1280 px: the cards' tops are the same at rest, with the pointer on the first card and with it on another (real mouse events), and the row shows on hover and on keyboard focus. The separator between the document and the
// comments: role=separator with a value, a drag with the pointer widens and narrows the column within its bounds, the arrow keys, Shift, Home and End move it, a double-click resets it, the width is kept (a reload
// opens at it). 390 px: the comments are a sheet and there is no separator.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { H3, STUB } = require('./helpers/artifact_versions_stub');
const { coralReady, framesJs } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`, problems = [];
    const frames = n => ev(framesJs(n));
    const check = (ok, text) => { if (!ok) problems.push(text); console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`try { localStorage.setItem('coral-artifact-comments-earlier', 'show'); } catch (e) {} true`);
        await ev(STUB);
        await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
        await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') && document.querySelector('.artifact-viewer-body').textContent.includes('Release plan')`, 'viewer', 8000);
        await waitFor(`(() => { const t = document.querySelector('.ac-toggle'); if (!t || t.hidden) return false; if (t.getAttribute('aria-expanded') !== 'true') t.click(); return t.getAttribute('aria-expanded') === 'true'; })()`, 'comments open', 6000);
        await frames(12);
    };
    const tops = () => ev(`[...document.querySelectorAll('.artifact-viewer .ac-card')].map(c => Math.round(c.getBoundingClientRect().top * 10) / 10)`);
    const mouse = async (x, y) => Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    const centre = sel => ev(`(() => { const b = document.querySelectorAll('${sel}')[0].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 12 }; })()`);
    const panelW = () => ev(`Math.round(document.querySelector('.artifact-viewer .ac-panel').getBoundingClientRect().width)`);
    const sepVal = () => ev(`(() => { const s = document.querySelector('.artifact-viewer .ac-resizer'); return s ? { now: +s.getAttribute('aria-valuenow'), min: +s.getAttribute('aria-valuemin'), max: +s.getAttribute('aria-valuemax'), role: s.getAttribute('role'), vis: s.getClientRects().length > 0 } : null; })()`);
    const key = async k => { for (const type of ['keyDown', 'keyUp']) await Input.dispatchKeyEvent({ type, key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 }[k] }); await frames(3); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); true`);
        // 1280: hover moves nothing
        await open(1280, 800, false);
        await mouse(5, 5); await frames(4);
        const rest = await tops();
        check(rest.length >= 2, `the thread has at least two cards (${rest.length})`);
        const first = await centre('.artifact-viewer .ac-card'); await mouse(first.x, first.y); await frames(6);
        const onFirst = await tops();
        check(JSON.stringify(onFirst) === JSON.stringify(rest), `no card moves with the pointer on the first: ${JSON.stringify(rest)} -> ${JSON.stringify(onFirst)}`);
        const shown = await ev(`(() => { const c = document.querySelectorAll('.artifact-viewer .ac-card')[0], a = c.querySelector('.ac-actions'); return a ? Math.round(getComputedStyle(a).opacity * 10) : null; })()`);
        check(shown === 10 || shown === null, `the first card's row is shown under the pointer (${shown})`);
        const second = await ev(`(() => { const b = document.querySelectorAll('.artifact-viewer .ac-card')[1].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 12 }; })()`); await mouse(second.x, second.y); await frames(6);
        const onSecond = await tops();
        check(JSON.stringify(onSecond) === JSON.stringify(rest), `no card moves with the pointer on another: ${JSON.stringify(onSecond)}`);
        await mouse(5, 5); await frames(4);
        check(JSON.stringify(await tops()) === JSON.stringify(rest), 'and none moves when it leaves');
        // the row shows on hover and on focus
        const hiddenAtRest = await ev(`(() => { const c = [...document.querySelectorAll('.artifact-viewer .ac-card')].find(c => c.querySelector('.ac-actions button') && !c.matches(':hover, :focus-within, .ac-active, .ac-composing')); return c ? getComputedStyle(c.querySelector('.ac-actions')).opacity : null; })()`);
        check(hiddenAtRest === null || hiddenAtRest === '0', `a resting card's row is invisible but takes its room (opacity ${hiddenAtRest})`);
        const focusShows = await ev(`(() => { const b = [...document.querySelectorAll('.artifact-viewer .ac-card .ac-actions button')].find(b => !b.closest('.ac-card').matches(':hover, .ac-active, .ac-composing')); if (!b) return 'none'; b.focus(); return getComputedStyle(b.closest('.ac-actions')).opacity; })()`);
        check(focusShows === 'none' || focusShows === '1', `keyboard focus on a button shows its row (${focusShows})`);
        // the separator
        let v = await sepVal();
        check(!!v && v.role === 'separator' && v.vis && v.now >= v.min && v.now <= v.max, `a visible separator with a value: ${JSON.stringify(v)}`);
        const w0 = await panelW();
        check(w0 === v.now, `its value is the column's width (${v.now} / ${w0})`);
        const r = await ev(`(() => { const b = document.querySelector('.artifact-viewer .ac-resizer').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 200 }; })()`);
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: r.x - 100, y: r.y, button: 'left' });
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x - 100, y: r.y, button: 'left', clickCount: 1 }); await frames(4);
        const w1 = await panelW();
        check(Math.abs(w1 - (w0 + 100)) <= 2, `a drag 100 px left widens the comments by 100 (${w0} -> ${w1})`);
        await key('ArrowRight'); check(Math.abs((await panelW()) - (w1 - 16)) <= 1, 'ArrowRight narrows by 16');
        await key('ArrowLeft'); await key('ArrowLeft'); check(Math.abs((await panelW()) - (w1 + 16)) <= 1, 'ArrowLeft widens by 16');
        await key('End'); v = await sepVal(); check((await panelW()) === v.max, `End goes to the widest (${v.max})`);
        await key('Home'); v = await sepVal(); check((await panelW()) === v.min, `Home goes to the narrowest (${v.min})`);
        await ev(`(() => { const s = document.querySelector('.artifact-viewer .ac-resizer'); s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`); await frames(3);
        check((await panelW()) === 340, 'a double-click resets it to 340');
        await key('ArrowLeft'); await key('ArrowLeft'); const kept = await panelW();
        await ev(`location.reload(); true`).catch(() => {}); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(STUB); await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
        await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') && document.querySelector('.artifact-viewer-body').textContent.includes('Release plan')`, 'viewer again', 8000);
        await waitFor(`(() => { const t = document.querySelector('.ac-toggle'); if (!t || t.hidden) return false; if (t.getAttribute('aria-expanded') !== 'true') t.click(); return t.getAttribute('aria-expanded') === 'true'; })()`, 'comments open again', 6000); await frames(10);
        check(Math.abs((await panelW()) - kept) <= 1, `the width is kept for the viewer (${kept} -> ${await panelW()})`);
        // 390: a sheet, no separator
        await open(390, 844, true);
        v = await sepVal();
        check(!v || !v.vis, `no separator on the phone (${JSON.stringify(v)})`);
        check(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), 'no sideways scroll on the phone');
        // a tablet (touch, 1024 px): the 8 px handle has a 24 px hit strip around it (#15046)
        await open(1024, 768, true);
        const strip = await ev(`(() => { const h = document.querySelector('.artifact-viewer .ac-resizer'), r = h && h.getBoundingClientRect(); if (!r || !r.width) return null; const at = x => document.elementFromPoint(x, r.top + r.height / 2) === h; return { w: Math.round(r.width), left: at(r.left - 6), right: at(r.right + 6), far: at(r.left - 20) }; })()`);
        check(strip && strip.left && strip.right && !strip.far, `a finger 6 px beside the handle still lands on it (a 24 px strip), 20 px away does not: ${JSON.stringify(strip)}`);
        // the resize listener of a closed viewer does not accumulate (#15046): three viewers opened and closed, then one resize
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`(() => { window.__rs = new Set(); const add = window.addEventListener.bind(window), rem = window.removeEventListener.bind(window); window.addEventListener = (t, f, o) => { if (t === 'resize') window.__rs.add(f); return add(t, f, o); }; window.removeEventListener = (t, f, o) => { if (t === 'resize') window.__rs.delete(f); return rem(t, f, o); }; window.__rs0 = window.__rs.size; return true; })()`);
        await ev(STUB);
        for (let i = 0; i < 3; i++) {
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${H3}', { filename: 'release-plan.md', board: 'team-a' })).then(() => true)`);
            await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') && !!document.querySelector('.ac-toggle')`, `viewer ${i + 1}`, 8000);
            await ev(`document.querySelector('.artifact-viewer-close').click(); true`);
            await waitFor(`!document.querySelector('.artifact-viewer:not([hidden])')`, `viewer ${i + 1} closed`, 6000);
        }
        await ev(`window.dispatchEvent(new Event('resize')); true`); await frames(4);
        const held = await ev(`window.__rs.size - window.__rs0`);
        check(held <= 1, `after three viewers were opened and closed and one resize, at most one resize listener of theirs is left (${held})`);
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('artifact_comments_hover_resize_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
