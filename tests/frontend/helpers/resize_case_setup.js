// Actual production builders used by #12754's per-table resize contract checks.
const ROWS = [1, 2].map(n => ({ id: String(n).padStart(64, '0'), name: `report-${n}.md`, media_type: 'text/markdown', size: n * 1024, created_at: '2026-11-01T00:00:00Z', available: true, starred: true, board_id: 'team-a', team: 'Team A', uri: 'coral://artifacts/' + String(n).padStart(64, '0') }));
const SETUP = `const S = window.__coralStatic || '/static/'; const host = document.createElement('main'); host.id = 'resize-fixture'; host.style.cssText = 'width:940px;max-width:100%;margin:auto'; document.body.append(host); const real = window.fetch; const json = d => Promise.resolve(new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } }));`;

module.exports = { ROWS, SETUP };
const { DATA_WORLD, JOB, WF, RUN, RUN_OK } = require('./census_world');
const jobs = [0,1].map(n=>({...JOB,id:5+n,name:'Daily check '+n,last_run:{status:'failed',exit_code:1,started_at:'2026-11-01T00:00:00Z'}}));
const workflows = [0,1].map(n=>({...WF,id:7+n,name:'Workflow '+n,last_run:RUN}));
const workflow = {...WF,steps:[WF.steps[0],{name:'s2',type:'shell',command:'echo done'}]};
const AUTO = `${SETUP} ${DATA_WORLD}; host.remove(); const world=window.fetch; window.fetch=(u,o)=>{const p=new URL(String(u),location.origin).pathname;
    if(p==='/api/scheduled/jobs')return json({jobs:${JSON.stringify(jobs)}});
    if(p==='/api/workflows')return json({workflows:${JSON.stringify(workflows)}});
    if(p==='/api/workflows/7')return json(${JSON.stringify(workflow)});
    if(p==='/api/scheduled/runs/recent')return json({runs:[{id:101,job_id:5,job_name:'Daily check',status:'running',started_at:'2026-11-01T01:00:00Z'},{id:102,job_id:5,job_name:'Daily check',status:'failed',exit_code:1,started_at:'2026-11-01T00:00:00Z'}]});
    if(p==='/api/automations/runs')return json({runs:[{kind:'job',id:101,job_id:5,job_name:'Daily check',status:'running',started_at:'2026-11-01T01:00:00Z'},{kind:'job',id:102,job_id:5,job_name:'Daily check',status:'failed',exit_code:1,started_at:'2026-11-01T00:00:00Z'},{kind:'workflow',...${JSON.stringify(RUN)}},{kind:'workflow',...${JSON.stringify(RUN_OK)}}],has_more:false,next_cursor:'',total:4});
    if(p==='/api/workflows/runs/recent')return json({runs:[${JSON.stringify(RUN)},${JSON.stringify(RUN_OK)}]});
    if(p==='/api/scheduled/jobs/5/runs')return json({runs:[{id:101,scheduled_at:'2026-11-01T01:00:00Z',status:'completed',session_id:'one'},{id:102,scheduled_at:'2026-11-01T00:00:00Z',status:'failed',session_id:'two'}],total:2});return world(u,o);};`;
module.exports.AUTO = AUTO;
