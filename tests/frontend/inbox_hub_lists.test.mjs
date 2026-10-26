// #8694: a self-hosted hub's Inbox combines local and registered online machines.
// Colliding board/task/goal ids remain distinct and item reads use their origin.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({mode:'local'});
try {
    const { state } = await importUi('state');
    state.hub = true;
    state.servers = [{id:'local',status:'online'},{id:'box-2',status:'online'},{id:'down',status:'offline'},{id:'broken',status:'online'}];
    const calls = []; let localEmpty = false;
    globalThis.fetch = window.fetch = async url => {
        const path = new URL(url,'https://hub.example').pathname; calls.push(path);
        if(path.includes('/broken/'))throw new Error('unreachable');
        const remote = path.startsWith('/api/remote/box-2/');
        if(localEmpty && !remote && (path==='/api/goals'||path==='/api/board/tasks'))return Response.json({goals:[],tasks:[]});
        if(path.endsWith('/api/board/tasks'))return Response.json({tasks:[{id:1,board_id:'same-team',board_label:remote?'Remote team':'Local team',title:remote?'Remote task':'Local task',status:'pending',priority:'medium',updated_at:'2026-10-26T00:00:00Z'}]});
        if(path.endsWith('/api/goals'))return Response.json({goals:[{id:1,board_id:'same-team',title:remote?'Remote goal':'Local goal',state:'active',rollup:{total:1,done:0}}]});
        if(path.endsWith('/api/board/same-team/tasks/1'))return Response.json({id:1,title:remote?'Remote task':'Local task'});
        return Response.json({});
    };
    const inbox = await importUi('inbox_coral');
    const tasks = await inbox.coralInboxAdapter.listTasks();
    assert.deepEqual(tasks.map(t=>t.project).sort(),['@box-2/same-team','same-team'],'remote tasks must not disappear or collide with local ones');
    assert.equal(tasks.find(t=>t.project.startsWith('@')).board,'Remote team');
    assert.equal((await inbox.coralInboxAdapter.getTask('@box-2/same-team',1)).title,'Remote task');
    const goals = await inbox.listInboxGoals();
    assert.deepEqual(goals.map(g=>g.board_id).sort(),['@box-2/same-team','same-team'],'remote goals retain their origin');
    assert.ok(calls.includes('/api/remote/box-2/api/goals'));
    assert.ok(calls.includes('/api/remote/box-2/api/board/tasks'));
    assert.ok(!calls.some(p=>p.includes('/down/')),'offline registered machines are skipped');
    localEmpty = true;
    assert.equal((await inbox.coralInboxAdapter.listTasks()).length,1,'a hub with no local tasks still lists remote tasks');
    assert.equal((await inbox.listInboxGoals()).length,1,'a hub with no local goals still lists remote goals');
    localEmpty = false; state.hub = false; calls.length = 0;
    assert.equal((await inbox.coralInboxAdapter.listTasks()).length,1);
    assert.equal((await inbox.listInboxGoals()).length,1);
    assert.ok(!calls.some(p=>p.startsWith('/api/remote/')),'standalone Coral stays local');
    console.log('inbox_hub_lists: PASS');
} finally { dom.window.close(); }
