// #13863: Wake must stay on the question's computer, including duplicate agent/session IDs.
import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'cloud'});const {state}=await importUi('state');const {wakeMember}=await importUi('operator_asks');
let calls=[];const name='Planner',id='same-id',member={subscriber_id:name,session_name:'claude-'+id};
const agent=(server,sleeping=true)=>({server,agent_type:'claude',session_id:id,sleeping});
const mock=(source,refusal=false)=>{calls=[];globalThis.fetch=window.fetch=async(url,opts={})=>{calls.push({url:String(url),method:opts.method||'GET'});if(String(url)===source+'/api/board/team%20a/subscribers')return Response.json([member]);if(String(url)===source+'/api/sessions/live/'+id+'/wake')return refusal?Response.json({error:'This computer needs a configured CLI.'},{status:409}):Response.json({ok:true});return Response.json({error:'Wrong computer'},{status:403});};};
test('remote question reads its own team and wakes its own sleeping member',async()=>{state.selectedTeam='@m2/other';state.liveSessions=[agent('local',false),agent('m2',false),agent('m1')];mock('/api/remote/m1');await wakeMember({server:'m1',board:'team a'},name);assert.deepEqual(calls,[{url:'/api/remote/m1/api/board/team%20a/subscribers',method:'GET'},{url:'/api/remote/m1/api/sessions/live/'+id+'/wake',method:'POST'}]);});
test('explicit local question stays local with another computer selected',async()=>{state.selectedTeam='@m1/other';state.liveSessions=[agent('m1',false),agent('local')];mock('');await wakeMember({server:'local',board:'team a'},name);assert.equal(calls[1].url,'/api/sessions/live/'+id+'/wake');});
test('legacy untagged question means local, independent of selected computer',async()=>{state.liveSessions=[agent(undefined)];mock('');await wakeMember({board:'team a'},name);assert.equal(calls[1].url,'/api/sessions/live/'+id+'/wake');});
test('remote wake refusal keeps the source computer reason',async()=>{state.liveSessions=[agent('m1')];mock('/api/remote/m1',true);await assert.rejects(wakeMember({server:'m1',board:'team a'},name),/Could not wake Planner: This computer needs a configured CLI/);assert.equal(calls[1]?.url,'/api/remote/m1/api/sessions/live/'+id+'/wake');});
test('another computer with the same session ID is never a fallback wake target',async()=>{state.liveSessions=[agent('local')];mock('/api/remote/m1');await assert.rejects(wakeMember({server:'m1',board:'team a'},name),/not running on this computer/);assert.equal(calls.length,2,'the member read, then the earlier chat read (#14172), both on the question\'s own computer');assert.ok(calls.every(c=>c.url.startsWith('/api/remote/m1/')),'nothing went to this computer or to a wake: '+JSON.stringify(calls));});
test('a refused member read reports the read failure, not false non-membership',async()=>{calls=[];globalThis.fetch=window.fetch=async url=>{calls.push(String(url));return Response.json({error:'Denied'},{status:403});};await assert.rejects(wakeMember({server:'m1',board:'team a'},name),/Could not read this team's members \(HTTP 403\)/);assert.deepEqual(calls,['/api/remote/m1/api/board/team%20a/subscribers']);});

// #14172: an agent Kill All (or its own exit) ended has no live row. Restart from the question resumes its chat in its own folder, on the question's computer, the way History's Resume does it.
test('an ended agent is resumed from its chat in its own folder, joined to the question\'s team', async () => {
    state.liveSessions = []; calls = [];
    const sent = [];
    globalThis.fetch = window.fetch = async (url, opts = {}) => {
        const u = String(url); calls.push({ url: u, method: opts.method || 'GET' });
        if (u === '/api/board/team%20a/subscribers') return Response.json([member]);
        if (u === '/api/sessions/history/' + id + '/resume-info') return Response.json({ working_dir: '/work/crew', working_dir_exists: true, agent_type: 'claude', display_name: 'Planner', permission_mode: 'default', resume_session_id: id });
        if (u === '/api/sessions/launch' && opts.method === 'POST') { sent.push(JSON.parse(opts.body)); return Response.json({ ok: true, session_id: id }); }
        return Response.json({}, { status: 404 });
    };
    await wakeMember({ board: 'team a' }, name);
    assert.deepEqual(sent, [{ working_dir: '/work/crew', agent_type: 'claude', resume_session_id: id, display_name: 'Planner', board_id: 'team a', board_name: 'team a', permission_mode: 'default' }]);
    assert.equal(calls.some(c => c.url.endsWith('/wake')), false, 'nothing to wake: it is not asleep, it ended');
});
test('an ended agent whose folder is gone, or whose chat cannot be read, says so and starts nothing', async () => {
    state.liveSessions = [];
    const launches = [];
    const run = info => { globalThis.fetch = window.fetch = async (url, opts = {}) => { const u = String(url); if (u === '/api/board/team%20a/subscribers') return Response.json([member]); if (u.endsWith('/resume-info')) return info === null ? Response.json({}, { status: 404 }) : Response.json(info); if (u === '/api/sessions/launch') { launches.push(1); return Response.json({ ok: true }); } return Response.json({}, { status: 404 }); }; return wakeMember({ board: 'team a' }, name); };
    await assert.rejects(run({ working_dir: '/gone', working_dir_exists: false, agent_type: 'claude' }), /folder it worked in is gone/);
    await assert.rejects(run({ agent_type: 'claude' }), /does not know the folder/);
    await assert.rejects(run(null), /not running on this computer, and its earlier chat could not be read here \(HTTP 404\)/);
    assert.deepEqual(launches, [], 'nothing was started');
});
test.after(()=>dom.window.close());
