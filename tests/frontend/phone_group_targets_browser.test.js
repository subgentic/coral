// A regression guard, not failing-first: current main already holds it. The note's 24 px collapse control is the decorative .group-chevron-deco (aria-hidden, pointer-events none), and the inline Generate goal button went with the one-line row (#9686).
// #10842 (UI/UX's note via coral-hub): on a phone the agent list's team-group collapse control and every button on an agent row (the kebab's 44 px hit area is its ::after, components.css) are 44 px targets, at 320 and 390 px with touch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[320, 640], [390, 844]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`(async () => { T.state.liveSessions = []; window.__m.agents = {}; window.__m.add('lead', 'Boss', 3, { sleeping: false, board_project: 'team-a' }); window.__m.add('w1', 'Worker', 3, { sleeping: false, board_project: 'team-a' }); window.__m.add('solo', 'Solo', 3, { sleeping: false }); T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            await waitFor(`document.querySelectorAll('#mobile-agent-list .group-chevron').length > 0`, `${w}: the team group's chevron`, 8000);
            const found = await ev(`(() => { const vis = e => e.getClientRects().length > 0; const hs = sel => [...document.querySelectorAll('#mobile-agent-list ' + sel)].filter(vis).map(e => ({ cls: e.className, txt: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30), par: e.parentElement.className.slice(0, 40), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }));
                return { chevrons: hs('.group-chevron:not(.group-chevron-deco)'), headers: hs('.session-group-header[aria-expanded]'), rowButtons: hs('li.session-group-item button:not(.btn-xs), li.session-group-item [role="button"]') }; })()`);
            for (const c of found.chevrons) if (c.h < 44) problems.push(`${w}: team group collapse control is ${c.h} px tall`);
            for (const g of found.headers) if (g.h < 44) problems.push(`${w}: a group header that is itself the collapse control is ${g.h} px tall`); // the decorative chevron (.group-chevron-deco) is the header's picture, not a target
            for (const b of found.rowButtons) if (b.h < 44) problems.push(`${w}: row control .${String(b.cls).split(' ')[0]} "${b.txt}" in .${String(b.par).split(' ')[0]} is ${b.h} px tall`);
            console.log(w, JSON.stringify(found));
        }
    } finally { try { await client.close(); } catch (e) {} }
    assert.deepEqual(problems, [], 'phone targets:\n  ' + problems.join('\n  '));
    console.log('PASS the agent list on a phone has 44 px group and row controls');
})().catch(e => { console.error(e); process.exit(1); });
