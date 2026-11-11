// #15372 (user feedback): typing a long prompt grew the message box upward over the bottom of the output. The output area shrinks as the box grows and, pinned at the bottom, stays pinned: the newest line is still in view
// after ten lines are typed (and after they are cleared). The chat on a computer (1280) and a phone (390), a real chat page (the agent's transcript is served by an in-page mock).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const C = `document.getElementById('live-history-messages')`;
    const frames = framesJs(3); // bounded: a hidden page falls back to a timeout
    const problems = [];
    const dist = () => ev(`Math.round(${C}.scrollHeight - ${C}.scrollTop - ${C}.clientHeight)`);
    const type = n => ev(`(async () => { const i = document.getElementById('command-input'); i.focus(); i.value = ${JSON.stringify(n > 1 ? 'a long paragraph of words that wraps. '.repeat(n * 5) : n ? 'line' : '')}; i.dispatchEvent(new Event('input', { bubbles: true })); await ${frames}; return { box: Math.round(i.offsetHeight), area: ${C}.clientHeight }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [1280, 560, false], [390, 844, true], [390, 520, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('jl', 'jl', 150, { sleeping: false }); true`);
            await ev(`window.selectLiveSession('jl', 'claude', 'jl-id', 'local'); true`);
            await waitFor(`${C}.scrollHeight > ${C}.clientHeight * 3 && ${C}.scrollHeight - ${C}.scrollTop - ${C}.clientHeight < 50`, at + 'the chat at the bottom', 8000);
            await waitFor(`!!${C}._keepGap`, at + 'the chat keeps its gap (its module is loaded when the chat opens, before anyone types)', 8000);
            await ev(`(async () => { ${C}.scrollTop = ${C}.scrollHeight; ${C}.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 300)); return true; })()`); // sleep-ok: the scroll handlers run
            const before = await type(1), d0 = await dist();
            const grown = await type(10), d10 = await dist();
            if (grown.box <= before.box + 20) problems.push(`${at}the box did not grow with ten lines: ${JSON.stringify([before, grown])}`);
            if (d0 > 2) problems.push(`${at}not at the bottom before typing: ${d0} px`);
            if (d10 > 2) problems.push(`${at}ten lines typed: the newest output is ${d10} px under the box (area ${before.area} to ${grown.area})`);
            await type(0);
            // typed the way a person types: a line at a time with Shift+Enter, the page painting between
            await ev(`document.getElementById('command-input').focus(); true`);
            for (let k = 1; k <= 10; k++) {
                await client.Input.insertText({ text: 'line ' + k });
                if (k < 10) await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }), await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }), await client.Input.insertText({ text: '\n' });
                await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`); // raf-ok: the page paints between two keys
            }
            const typed = await dist(); if (typed > 2) problems.push(`${at}typed key by key: the newest output is ${typed} px under the box`);
            await type(0); const back = await dist();
            if (back > 2) problems.push(`${at}box cleared: ${back} px short of the bottom`);
            // not at the bottom (a little above it, and a long way above it): the box pushes the chat up, the text just above the box stays just above it (#15401: it covered the chat)
            for (const away of [120, 600]) {
                await ev(`(async () => { ${C}.scrollTop = Math.max(0, ${C}.scrollHeight - ${C}.clientHeight - ${away}); ${C}.dispatchEvent(new Event('scroll')); await new Promise(r => setTimeout(r, 300)); return true; })()`); // sleep-ok: the scroll handlers run
                const up = await dist(); await type(10); const up2 = await dist();
                if (Math.abs(up2 - up) > 2) problems.push(`${at}${away} px above the bottom, ten lines typed: the text above the box moved from ${up} to ${up2} px above the bottom (the box covered the chat)`);
                await type(0); const up3 = await dist();
                if (Math.abs(up3 - up) > 2) problems.push(`${at}${away} px above the bottom, the box cleared: ${up} then ${up3}`);
            }
            // the terminal view: its screen ends above the box as the box grows, and when it is cleared
            await ev(`localStorage.setItem('coral-live-view-mode', 'terminal'); window.selectLiveSession('jl', 'claude', 'jl-id', 'local'); true`);
            await ev(`new Promise(r => setTimeout(r, 1200))`); // sleep-ok: the terminal view mounts
            const gap = () => ev(`(() => { const s = document.querySelector('.xterm-screen, #terminal-container, .terminal-pane'), i = document.getElementById('command-input'); if (!s || !i || !i.offsetParent) return null; return Math.round(i.getBoundingClientRect().top - s.getBoundingClientRect().bottom); })()`);
            const g0 = await gap(); await type(10); await ev(`new Promise(r => setTimeout(r, 500))`); // sleep-ok: the terminal refits
            const g10 = await gap();
            if (g10 !== null && g10 < -2) problems.push(`${at}terminal: its screen runs ${-g10} px under the box after ten lines (${g0} before)`);
            await type(0);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the output stays in view as the box grows:\n  ' + problems.join('\n  '));
    console.log('PASS the newest output stays in view above a growing message box');
})().catch(e => { console.error(e); process.exit(1); });
