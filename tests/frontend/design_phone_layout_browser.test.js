// #12896: large phone text keeps navigation and form actions inside their own area.
// Production entries, isolated server; desktop retains its one-line/shared layout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, message, detail) => { if (!ok) failures.push(message + ': ' + JSON.stringify(detail)); };
    const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // Horizontal bounds of every clipping ancestor matter: document overflow alone misses nested forms.
    const bounds = selector => ev(`(() => { const bs=[...document.querySelectorAll(${JSON.stringify(selector)})];return bs.map(b=>{const r=b.getBoundingClientRect();let left=0,right=innerWidth;for(let p=b.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),c=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,c.left);right=Math.min(right,c.right);}}return {name:b.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,clipLeft:left,clipRight:right,fit:r.left>=left-1&&r.right<=right+1};});})()`);
    const settled = () => ev(framesJs(2));
    const load = async (width, theme, font) => {
        await Emulation.setDeviceMetricsOverride({ width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
        await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`import((window.__coralStatic||'/static/')+'settings_core.js').then(m=>{m.clearCustomThemeVars();m.applyTheme('${theme}');document.documentElement.style.fontSize='${font}px';return true;})`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, theme, font] of [[1440,'dark',16],[390,'dark',16],[390,'light',16],[390,'dark',32],[390,'light',32]]) {
            const at = `${width}-${theme}-${font}`;
            await load(width,theme,font);
            await ev(`window.switchNavTab('hub-inbox');true`); await settled();
            if (width === 390) {
                const labels = await ev(`(()=>{const nav=document.querySelector('.phone-nav'),n=nav.getBoundingClientRect();return [...nav.querySelectorAll('.phone-nav-slot')].map(s=>{const a=s.getBoundingClientRect(),label=s.querySelector('.phone-nav-label'),b=label.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(label);const lines=[...range.getClientRects()];return {text:s.textContent.trim(),fit:b.left>=a.left-1&&b.right<=a.right+1&&b.bottom<=n.bottom+1,wholeLine:lines.length>0&&lines.every(r=>Math.abs(r.top-lines[0].top)<1),fullName:(s.getAttribute('aria-label')||'').includes(label.textContent),w:b.width,slot:a.width};});})()`);
                check(labels.length === 4 && labels.every(x=>x.fit),at+' nav labels fit their slots',labels);
                check(labels.every(x=>x.wholeLine&&x.fullName),at+' nav labels stay on one line with full accessible text',labels);
                await shot(at+'-nav');
            }
            await ev(`window.showDefaultPromptsModal().then(()=>true)`); await settled();
            const resets = await bounds('.prompt-field-reset');
            check(resets.length >= 4 && resets.every(x=>x.fit),at+' prompt resets fit their clipping ancestors',resets);
            await shot(at+'-prompts');
            await load(width,theme,font);
            await ev(`window.showSettingsModal('chief').then(()=>true)`);
            await waitFor(`!!document.querySelector('.chief-setup .sv-save')`,'Chief form',8000);
            await ev(`document.querySelector('.chief-setup .sv-save').scrollIntoView({block:'end'});true`); await settled();
            const chief = await bounds('.chief-setup .sv-bar-buttons > button');
            check(chief.length === 2 && chief.every(x=>x.fit),at+' Chief buttons fit their clipping ancestors',chief);
            await shot(at+'-chief');
            await load(width,theme,font);
            await ev(`import((window.__coralStatic||'/static/')+'goal_editor.js').then(m=>m.openGoalEditor({project:'layout-audit'})).then(()=>true)`); await settled();
            const actions = await bounds('.goal-editor .goals-actions > button');
            check(actions.length === 3 && actions.every(x=>x.fit && x.top>=0 && x.bottom<=(width===390?844:900)+1),at+' goal footer actions fit',actions);
            if(width===1440) check(actions.every(x=>x.top<100),at+' desktop goal actions remain in the top bar',actions);
            await shot(at+'-goal');
            for (const kind of ['driver','move']) {
                await load(width,theme,font);
                await ev(`import((window.__coralStatic||'/static/')+'goal_operator_dialogs.js').then(m=>{const opts={project:'layout-audit',goal:{id:1,title:'Keep every saved draft',driver:'Orchestrator'},openTasks:2,onDone(){},onMoved(){},onClose(){}};m.${kind==='driver'?'openChangeDriver':'openMoveGoal'}(opts);return true;})`); await settled();
                const form = await ev(`(()=>{const d=document.querySelector('.goals-operator-dialog'),r=d.getBoundingClientRect(),t=d.querySelector('h3').getBoundingClientRect(),f=d.querySelector('.goals-field').getBoundingClientRect(),a=d.querySelector('.goals-actions').getBoundingClientRect();return {inset:t.left-r.left,fieldInset:f.left-r.left,top:t.top-r.top,actionBottom:a.bottom,dialogBottom:r.bottom,wide:r.width};})()`);
                check(form.inset>=12 && form.fieldInset>=12,at+' '+kind+' has shared content insets',form);
                if(width===390) check(Math.abs(form.actionBottom-form.dialogBottom)<=2,at+' '+kind+' footer stays pinned',form);
                else check(form.wide<1000,at+' '+kind+' desktop remains a compact dialog',form);
                await shot(at+'-'+kind);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(failures, [], failures.join('\n'));
    console.log('design_phone_layout_browser: 5 viewport/theme/text cases, all four layout groups ok');
})().catch(e=>{console.error(e);process.exit(1);});
