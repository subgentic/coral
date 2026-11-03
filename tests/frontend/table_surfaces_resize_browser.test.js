// #12754: every opted-in production table uses the same drag, reload and keyboard behavior.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const { CASES } = require('./helpers/column_resize_surfaces');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    let select = '#resize-fixture';
    const failures = [];
    const widths = () => ev(`Object.fromEntries([...document.querySelectorAll('${select} th[data-key]')].filter(h=>h.getClientRects().length).map(h=>[h.dataset.key,Math.round(h.getBoundingClientRect().width)]))`);
    const sort = () => ev(`JSON.stringify([...document.querySelectorAll('${select} th[aria-sort]')].map(h=>[h.dataset.key,h.getAttribute('aria-sort')]))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [name, entry] of Object.entries(CASES)) {
            const setup = typeof entry === 'string' ? entry : entry.setup; select = typeof entry === 'string' ? '#resize-fixture' : entry.selector;
            if (process.env.CORAL_RESIZE_CASE && !process.env.CORAL_RESIZE_CASE.split(',').includes(name)) continue;
            try {
            const mount = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await ev(`(async()=>{${setup} return true;})()`); await waitFor(`document.querySelectorAll('${select} tbody tr').length >= 2`, name + ' production rows'); await ev(framesJs(6)); };
            await Emulation.setDeviceMetricsOverride({width:1280,height:800,deviceScaleFactor:1,mobile:false}); await Emulation.setTouchEmulationEnabled({enabled:false});
            await mount();
            const edge = await ev(`(() => { const h = [...document.querySelectorAll('${select} .dt-resize')].find(h=>{const th=h.closest('th');return !h.hidden && h.getClientRects().length && th.getBoundingClientRect().width > Math.max(+h.getAttribute('aria-valuemin'),th.classList.contains('dt-grow')?120:0)+32;}); if (!h) return null; const r=h.getBoundingClientRect(); return {key:h.dataset.key,x:r.left+r.width/2,y:r.top+r.height/2};})()`);
            assert.ok(edge,name+': movable shared separator'); const before=await widths(), order=await sort();
            for(const [type,x] of [['mouseMoved',edge.x],['mousePressed',edge.x],['mouseMoved',edge.x-24],['mouseReleased',edge.x-24]]) await client.Input.dispatchMouseEvent({type,x,y:edge.y,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
            await ev(framesJs(5)); const moved=await widths(); assert.ok(moved[edge.key]<=before[edge.key]-20,name+': drag changes width'); assert.equal(await sort(),order,name+': drag keeps sort');
            await mount(); const restored=await widths(); assert.ok(Math.abs(restored[edge.key]-moved[edge.key])<=2,name+': width remembered on reload');
            await ev(`document.querySelector('${select} th[data-key="${edge.key}"] .dt-resize').focus(); true`); await client.Input.dispatchKeyEvent({type:'keyDown',key:'ArrowRight'}); await client.Input.dispatchKeyEvent({type:'keyUp',key:'ArrowRight'}); await ev(framesJs(5));
            assert.ok((await widths())[edge.key]>=restored[edge.key]+14,name+': keyboard changes width');
            await Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:1,mobile:true}); await Emulation.setTouchEmulationEnabled({enabled:true}); await ev(framesJs(6));
            assert.equal(await ev(`[...document.querySelectorAll('${select} .dt-resize')].filter(h=>!h.hidden&&h.getClientRects().length).length`),0,name+': phone has no handles'); assert.ok(await ev(`document.documentElement.scrollWidth<=innerWidth`),name+': phone fits');
            console.log('[PASS] resize surface: '+name);
            } catch (e) { failures.push(name + ': ' + e.message); console.error('[FAIL] resize surface: ' + name + ': ' + e.message); }
        }
        assert.deepEqual(failures, [], 'production resize contracts');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
