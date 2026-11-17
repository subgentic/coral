import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({mode: 'local'});
try {
    const {readCostTasks} = await importUi('analytics_cost_tasks');
    const urls = [], first = Array.from({length: 100}, (_, id) => ({id, cost_usd: id}));
    const tasks = await readCostTasks(async url => {
        urls.push(url);
        return Response.json(url.includes('&cursor=') ? {tasks: [{id: 100, cost_usd: 0}]} : {tasks: first, next_cursor: 'opaque/+='});
    });
    assert.equal(tasks.length, 101);
    assert.equal(tasks[100].cost_usd, 0);
    assert.ok(!urls[0].includes('has_cost'));
    assert.equal(new URL(urls[1], 'http://localhost').searchParams.get('cursor'), 'opaque/+=');
    await assert.rejects(readCostTasks(async () => Response.json({tasks: [], next_cursor: 'same'})), /repeated/);
    let calls = 0;
    await assert.rejects(readCostTasks(async () => ++calls === 1 ? Response.json({tasks: first, next_cursor: 'next'}) : new Response('', {status: 500})), /unavailable/);
    console.log('analytics_cost_tasks: ok');
} finally {dom.close?.();}
