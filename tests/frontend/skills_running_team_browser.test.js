// #17166: an approved skill can be attached to an existing team or member and
// its instruction sent now. Partial failures name the member; pending skills have no action.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const id = '1'.repeat(32);
    const shot = require('./helpers/scene_shots')(Page);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`(() => {
            const row = { id: '${id}', name: 'release-notes', description: 'Write release notes.', status: 'approved', version: 1, digest: 'a'.repeat(64), publisher_kind: 'coral' };
            window.__skillRow = row; window.__skillCalls = []; window.__skillFail = false;
            const original = window.fetch;
            window.fetch = (u,o={}) => { const p = new URL(String(u),location.href).pathname;
                const json = (d,status=200) => Promise.resolve(new Response(JSON.stringify(d), {status,headers:{'content-type':'application/json'}}));
                if(p==='/api/skills')return json({skills:[row]});
                if(p==='/api/skills/${id}')return json({skill:row,files:[],contents:{}});
                if(p.endsWith('/skills') && p.includes('/sessions/live/')) { window.__skillCalls.push({p,body:JSON.parse(o.body)}); if(window.__skillFail && p.includes('member-b'))return json({error:'not approved'},409);return json({attached:true,line:'Use the skill release-notes (coral-agent skills get --id ${id}).'}); }
                if(p.endsWith('/send')) {window.__skillCalls.push({p,body:JSON.parse(o.body)}); return json({ok:true});}
                return original(u,o);
            };
            T.state.liveSessions = ['a','b'].map(x=>({session_id:'member-'+x,name:'claude-member-'+x,agent_type:'claude',display_name:'Member '+x,board_project:'bakery',server:'local'}));
            T.state.liveSessions.push({session_id:'remote',name:'Remote',agent_type:'claude',board_project:'other',server:'remote-host'});
        })()`);
        for(const width of [1280,390]) {
            await Emulation.setDeviceMetricsOverride({width,height:844,deviceScaleFactor:1,mobile:width===390});
            await ev(`window.switchNavTab('skills'); true`);
            await waitFor(`!!document.querySelector('#skills-view tr.dt-row')`,'approved skill row',8000);
            await ev(`document.querySelector('#skills-view tr.dt-row .dt-primary').click(); true`);
            await waitFor(`[...document.querySelectorAll('#skills-view button')].some(b=>b.textContent==='Use in a team')`,'Use in a team action',5000);
            await ev(`[...document.querySelectorAll('#skills-view button')].find(b=>b.textContent==='Use in a team').click(); true`);
            await waitFor(`!!document.getElementById('skill-use-target')`,'team and member picker',5000);
            assert.equal(await ev(`document.getElementById('skill-use-target').textContent.includes('remote-host')`),false,'remote agents excluded');
            await ev(`document.getElementById('skill-use-target').value='team:bakery'; document.getElementById('skill-use-submit').click(); true`);
            await waitFor(`document.getElementById('skill-use-results').textContent.includes('2 agents')`,'team attached and told',5000);
            const calls=await ev(`window.__skillCalls.splice(0)`);
            assert.equal(calls.filter(c=>c.p.endsWith('/skills')).length,2,'both members attached');
            assert.deepEqual(calls.filter(c=>c.p.endsWith('/send')).map(c=>c.body.session_id).sort(),['member-a','member-b']);
            assert.ok(calls.filter(c=>c.p.endsWith('/send')).every(c=>c.body.command.includes('coral-agent skills get --id '+id)),'agents receive route instruction');
            assert.equal(await ev(`document.getElementById('skills-view').scrollWidth<=innerWidth`),true,'fits viewport');
            await shot('skills-running-team-' + width);
            await ev(`[...document.querySelectorAll('#skills-view button')].find(b=>b.textContent.startsWith('Back to')).click(); true`);
        }
        await waitFor(`!!document.querySelector('#skills-view tr.dt-row')`,'list again',5000);
        await ev(`document.querySelector('#skills-view tr.dt-row .dt-primary').click(); true`);
        await waitFor(`[...document.querySelectorAll('#skills-view button')].some(b=>b.textContent==='Use in a team')`,'action again',5000);
        await ev(`window.__skillFail=true; [...document.querySelectorAll('#skills-view button')].find(b=>b.textContent==='Use in a team').click(); true`);
        await waitFor(`!!document.getElementById('skill-use-target')`,'partial failure picker',5000);
        await ev(`document.getElementById('skill-use-target').value='team:bakery'; document.getElementById('skill-use-submit').click(); true`);
        await waitFor(`document.getElementById('skill-use-results').textContent.includes('Member b: not attached')`,'failed attachment named',5000);
        assert.equal(await ev(`window.__skillCalls.filter(c=>c.p.endsWith('/send')).length`),1,'failed attachment sends nothing');
        await ev(`window.__skillCalls=[]; const s=document.getElementById('skill-use-target');s.value='member:member-a';s.dispatchEvent(new Event('change'));document.getElementById('skill-use-submit').click();true`);
        await waitFor(`document.getElementById('skill-use-results').textContent.includes('Attached and told 1 agent.')`,'single member notified',5000);
        assert.equal(await ev(`window.__skillCalls.length`),2,'single member only: attachment and send');
        await ev(`window.__skillRow.status='pending'; [...document.querySelectorAll('#skills-view button')].find(b=>b.textContent.startsWith('Back to')).click(); true`);
        await waitFor(`!!document.querySelector('#skills-view tr.dt-row')`,'pending list',5000);
        await ev(`document.querySelector('#skills-view tr.dt-row .dt-primary').click(); true`);
        await waitFor(`document.querySelector('#skills-view .skills-banner')`,'pending skill detail',5000);
        assert.equal(await ev(`[...document.querySelectorAll('#skills-view button')].some(b=>b.textContent==='Use in a team')`),false,'unapproved skill cannot be attached');
        console.log('PASS skill attachment and notification for a running team at desktop and phone widths');
    } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
