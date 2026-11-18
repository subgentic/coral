// #19470: the production Needs-you toolbar's six kind choices fit one line or become one Kind menu.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { coralReady, nextFrame } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`(async () => {
            const root = window.__coralStatic || '/static/';
            await import(root + 'inbox_sidebar.js');
            const { folderToolbar } = await import(root + 'inbox_toolbar.js');
            const labels = ['All', 'Permission', 'Question', 'Needs input', 'For review', 'Goal looks done'];
            const tb = folderToolbar({idp:'inbox-needs', noun:'item', searchLabel:'Search needs you', fields:[], model:{EMPTY:{},clean:x=>x,chips:()=>[],isFiltered:()=>false}}, () => {});
            window.drawKind = current => {
                tb.draw({filters:{},pills:{label:'Kind',current,items:labels.map((label,i)=>({key:String(i),label,count:[5,0,0,0,4,1][i]})),onPick:key=>{window.pickedKind=key;window.drawKind(key);}}});
                const row = tb.bar.node.querySelector('.list-bar-search-row');
                let head=row.querySelector('.inbox-folder-head');if(!head){head=document.createElement('div');head.className='inbox-folder-head';head.textContent='Needs you 5';row.prepend(head);const more=document.createElement('span');more.className='needs-more';more.textContent='More';row.append(more);}
            };
            const host=document.createElement('main');host.id='kind-fixture';host.style.cssText='position:fixed;inset:0 auto 0 0;overflow:auto;background:var(--bg-primary);z-index:999';host.append(tb.bar.node);document.body.append(host);window.drawKind('0');
        })()`);
        for (const scale of [1, 2]) for (const width of [1440, 1280, 1100, 1000, 900, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await ev(`document.getElementById('kind-fixture').style.width = ${width < 768 ? width : width - 320} + 'px'; document.documentElement.style.fontSize = ${scale * 100} + '%';`);
            await waitFor(`(() => {const r=document.querySelector('#kind-fixture .team-tb-pills');return r && (getComputedStyle(r).display==='none' || r.querySelectorAll('button').length===6)})()`, 'kind controls rendered');
            // Wait for layout/ResizeObserver without a fixed timer.
            await nextFrame();
            assert.equal(await ev(`!!document.querySelector('#kind-fixture .team-tb-action')`), false, 'Kind is a filter, not a create action');
            const g = await ev(`(() => {const host=document.getElementById('kind-fixture'),p=host.querySelector('.team-tb-pills'),b=[...p.querySelectorAll('button')],m=host.querySelector('#inbox-kind');const visible=e=>e&&e.getClientRects().length>0;return {strip:visible(p),tops:b.map(e=>Math.round(e.getBoundingClientRect().top)),cut:p.scrollWidth-p.clientWidth,menu:visible(m),right:m?.getBoundingClientRect().right,overflow:host.scrollWidth-host.clientWidth};})()`);
            assert.ok(g.strip ? new Set(g.tops).size===1 && g.cut<=1 : g.menu, `${width}/${scale}: one full strip or Kind menu: ${JSON.stringify(g)}`);
            assert.ok(g.overflow <= 1, `${width}/${scale}: controls fit their host: ${JSON.stringify(g)}`);
            if (width === 390) assert.ok(g.menu, 'phone uses Kind menu');
            if (g.menu) {
                await ev(`document.querySelector('#kind-fixture #inbox-kind').click()`);
                await waitFor(`document.querySelector('#inbox-kind-menu')?.hidden===false`, 'Kind menu opens');
                assert.equal(await ev(`document.querySelectorAll('#inbox-kind-menu [role=menuitemcheckbox]').length`), 6, 'every kind and its count remains available');
                await ev(`document.querySelectorAll('#inbox-kind-menu button')[4].click()`);
                await waitFor(`window.pickedKind==='4' && document.querySelector('#inbox-kind')?.getAttribute('aria-label')==='Kind: For review'`, 'menu selection redraws and names the active kind');
                await ev(`window.drawKind('0')`);
            }
        }
        console.log('PASS Needs you kind strip stays on one row or becomes a working Kind menu at 390–1440 and 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
