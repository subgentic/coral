// The Skills list's Show filter wears the shared field look (#12990, UI Reviewer's sweep S1): it was a bare select (13.33 px font, no padding, square corners) beside fields that are 13 px, padded and rounded. It is
// the shared .field now: the same font, padding and radius as the list's other fields, 32 px with a mouse and 44 px on a phone or touch, in both themes. The route is stood in at /api/skills.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const ROW = { id: '3'.repeat(32), name: 'pdf-forms', version: 2, digest: 'c'.repeat(64), description: 'Fill PDF forms.', status: 'approved', has_scripts: false, not_reviewable: false, publisher_kind: 'operator', file_count: 1, created_at: '2026-11-02T08:00:00Z', decided_at: '' };
const ROWS = ['release-notes','database-review','pdf-forms','phone-accessibility','security-review','write-docs'].map((name,i)=>({...ROW,id:String(i+1).repeat(32),name,description:'Instructions for '+name}));
const STUB = `(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin).pathname; if (p === '/api/skills' && (o.method || 'GET') === 'GET') return Promise.resolve(new Response(JSON.stringify({ skills: ${JSON.stringify(ROWS)} }), { status: 200, headers: { 'content-type': 'application/json' } })); return R(u, o); }; })();`;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = []; const check = (l, c, d) => { if (!c) problems.push(`${l}${d !== undefined ? ': ' + d : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true], [320,844,true]]) for (const theme of ['dark', 'light']) for (const zoom of mobile ? [100,200] : [100]) {
            const tag = `${w} px ${theme} ${zoom}%`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/skills' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize='${zoom}%';true`);
            await waitFor(`!!document.querySelector('#skills-view select[aria-label="Show"]')`, `${tag}: the filter`, 10000);
            const f = await ev(`(() => { const s = document.querySelector('#skills-view select[aria-label="Show"]'), c = getComputedStyle(s), b = document.body; const ref = document.createElement('input'); ref.className = 'field field-dense'; document.body.append(ref); const r = getComputedStyle(ref); const out = { font: c.fontSize, fam: c.fontFamily === r.fontFamily, padL: parseFloat(c.paddingLeft), radius: parseFloat(c.borderTopLeftRadius), refRadius: parseFloat(r.borderTopLeftRadius), h: Math.round(s.getBoundingClientRect().height), border: c.borderTopWidth, refFont: r.fontSize }; ref.remove(); return out; })()`);
            check(`${tag}: the field font, not the browser's 13.33 px`, f.font === f.refFont && f.fam, JSON.stringify(f));
            check(`${tag}: padded and rounded like the shared field`, f.padL >= 8 && f.radius === f.refRadius && f.radius >= 4, JSON.stringify(f));
            check(`${tag}: ${mobile ? '44 px on a phone' : '32 px with a mouse'}`, mobile ? f.h >= 44 : (f.h >= 30 && f.h <= 36), JSON.stringify(f));
            if (mobile) {
                await waitFor(`document.querySelectorAll('#skills-view .dt-mailed').length===6`,tag+' six skills');
                const phone = await ev(`(()=>{const title=document.querySelector('#top-phone-bar .phone-bar-title'), search=document.querySelector('#top-phone-bar .phone-bar-search'), box=document.querySelector('#top-phone-bar'), rect=e=>e.getBoundingClientRect(), swatch=document.createElement('span');swatch.style.color='var(--text-secondary)';document.body.append(swatch);const grey=getComputedStyle(swatch).color;swatch.remove();return {title:title.textContent.trim(),search:!!search,below:!!search&&rect(search).top>=rect(title).bottom-1,insideTitle:!!search&&title.contains(search),icons:[...document.querySelectorAll('#skills-view .dt-mail-avatar:not(.dt-mail-tick)')].map(e=>({fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor})),grey,overflow:document.documentElement.scrollWidth>innerWidth+1};})()`);
                check(tag+' Skills title and separate search row',phone.title==='Skills'&&phone.search&&phone.below&&!phone.insideTitle,JSON.stringify(phone));
                check(tag+' grey icons without tiles',phone.icons.length===6&&phone.icons.every(i=>i.fg===phone.grey&&i.bg==='rgba(0, 0, 0, 0)'),JSON.stringify(phone));
                check(tag+' no horizontal overflow',!phone.overflow,JSON.stringify(phone));
                const dir=process.env.CORAL_SCREENSHOT_DIR;
                if(dir){const fs=require('node:fs');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(`${dir}/skills-${w}-${theme}-${zoom}-header.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));if(zoom===200){await ev(`document.querySelector('#skills-view .dt-mailed').scrollIntoView({block:'start'});true`);fs.writeFileSync(`${dir}/skills-${w}-${theme}-${zoom}-cards.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64'));}}
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Skills filter field:\n  ' + problems.join('\n  '));
    console.log('PASS the Skills filter is the shared field: font, padding, radius, 32 px (44 on a phone), both themes');
})().catch(e => { console.error(e); process.exit(1); });
