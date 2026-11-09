// #14743: through the Hub with no computer shown (Goals, Agents: no team selected), Chief's entry does not ask for a bare /api/chief: at the Hub's own origin that path is the Hub's (a 404, one in every page's console). The entry is
// hidden, the look read answers nothing, and no request for /api/chief (or any bare /api/chief/...) leaves the page; with a computer shown the request still goes through /api/remote/<id>/. Through the stubbed Hub world (helpers/hub_world.js).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { setupHubWorld } = require('./helpers/hub_world');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { window.__chiefReqs = []; const f = window.fetch.bind(window); window.fetch = (u, o) => { try { const p = new URL(String(u && u.url || u), location.href).pathname; if (/\\/api\\/chief(\\/|$)/.test(p)) window.__chiefReqs.push(p); } catch { /* not a URL */ } return f(u, o); }; })();` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            // Goals and Agents with no team selected: the pages that paint Chief's entry (the sidebar slot, the menu)
            for (const tab of ['hub-inbox', 'agents']) { await ev(`window.switchNavTab(${JSON.stringify(tab)}); true`); await new Promise(r => setTimeout(r, 700)); } // sleep-ok: the page paints and asks what it asks
            const st = await ev(`import((window.__coralStatic || '/static/') + 'chief_entry.js').then(async m => ({ state: await m.chiefState(), known: m.chiefStateKnown() === null }))`);
            const look = await ev(`import((window.__coralStatic || '/static/') + 'chief_look.js').then(async m => (await m.readChief()) === null)`);
            const reqs = await ev(`window.__chiefReqs`);
            check(`${at}no team selected: no bare /api/chief request leaves the page`, reqs.length === 0, JSON.stringify(reqs));
            check(`${at}the Chief entry has nothing to show (state null) and the look read answers null`, st.state === null && st.known && look === true, JSON.stringify([st, look]));
            check(`${at}no Chief entry is drawn in the sidebar`, await ev(`!document.querySelector('#sidebar-chief-slot a, #sidebar-chief-slot button')`));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
